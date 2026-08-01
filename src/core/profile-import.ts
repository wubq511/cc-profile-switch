import fs from 'fs-extra';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';

import { getAppHomePaths, loadAppConfig, type Clock } from './app-config';
import { atomicWriteJson } from './versioned-json';
import {
  ensureCcpsProfileRule,
  ensureDefaultProfileSettingsEnv,
  ensureProfileClaudeMdExcludes,
  getProfileTemplatePaths,
  type ProfileTemplatePaths,
} from './profile-template';
import {
  addMcpServer,
  deriveTransport,
  getClaudeJsonPath,
  readMcpServersMap,
} from './mcp-servers';
import { cliVersion } from './version';
import { validateProfile, type ProfileValidationResult } from './validator';
import { resolveFilesystemPath, validateProfileName } from '../platform/path';
import type { CaptureProcess } from '../platform/process';
import { profileConfigSchema, type ProfileConfig } from '../schemas/profile';
import {
  bundleManifestSchema,
  type BundleManifest,
} from '../schemas/profile-bundle';
import type { McpAddOptions } from '../schemas/mcp';
import { CcpsError } from '../utils/errors';

/**
 * Profile import — creates a new Profile from a portable `.tar.gz` bundle
 * produced by `exportProfile`.
 *
 * Spec: docs/Spec-profile-workbench.md §11.2 Import (issue #74).
 *
 * Bundle layout (tar.gz root, produced by export):
 *   manifest.json   — authoritative index (BundleManifest)
 *   profile/        — verbatim profile file tree (profiles/<name>/ contents)
 *
 * Safety contract:
 *   - A mandatory manifest preview is surfaced to the `confirm` callback before
 *     the profile directory is created. Nothing under `profiles/` is written
 *     until the caller confirms.
 *   - Exact-name collision refuses by default; the callback may offer
 *     import-as-new-name. The service re-checks any new name.
 *   - MCP servers are NEVER carried into the new profile via a direct
 *     `.claude.json` write. The staged `.claude.json` `mcpServers` are cleared
 *     before the tree lands, then each server is re-registered through the
 *     delegated `claude mcp add --scope user` path (reusing `addMcpServer`).
 *     Failures are collected and listed; they never abort the rest of the
 *     import or the post-import Validate.
 *   - Stripped secret values stay as `<redacted>` key-name placeholders in the
 *     imported settings.json (and legacy mcp.json). The result reports every
 *     key name that needs guided re-entry. MCP env values are never passed
 *     through `claude mcp add -e` during import — the user re-enters them — so
 *     the secret-in-memory rule holds even for `--include-secrets` bundles.
 *   - Validate runs automatically after import and its findings are surfaced.
 *   - Never reads or touches the real ~/.claude or ~/.claude.json; extraction
 *     happens in a staging dir under app home, and tar's default path
 *     sanitization blocks traversal entries.
 */

const BUNDLE_PROFILE_DIR = 'profile';
const BUNDLE_MANIFEST_FILE = 'manifest.json';

export type ImportPreview = {
  manifest: BundleManifest;
  targetName: string;
  /** True when `targetName` already exists as a profile. */
  collision: boolean;
};

export type ImportConfirmDecision =
  | { action: 'proceed' }
  | { action: 'proceed-as-new-name'; targetName: string }
  | { action: 'abort' };

export type ImportConfirmFn = (preview: ImportPreview) => Promise<ImportConfirmDecision>;

export type ImportMcpServerResult = {
  name: string;
  reRegistered: boolean;
  /** Env key names the user must re-enter for this server (values never travel). */
  envKeysToReenter: string[];
  /** Present when `reRegistered` is false. */
  failureMessage?: string;
};

export type ImportResult = {
  profileName: string;
  profileRootPath: string;
  manifest: BundleManifest;
  /** Per native `.claude.json` MCP server: delegated re-registration outcome. */
  mcpServers: ImportMcpServerResult[];
  /** settings.json `env.ANTHROPIC_*` placeholder keys needing re-entry. */
  settingsSecretKeysToReenter: string[];
  /** Legacy root `mcp.json` env key names needing re-entry, grouped by server. */
  legacyMcpEnvKeysToReenter: { server: string; keys: string[] }[];
  validation: ProfileValidationResult;
};

export type ImportAborted = { aborted: true };

export type ImportProfileOptions = {
  appHomePath?: string;
  bundlePath: string;
  /** Override the target profile name; defaults to `manifest.profileName`. */
  targetName?: string;
  /** Mandatory gate: surfaces the preview and returns the user's decision. */
  confirm: ImportConfirmFn;
  captureProcess?: CaptureProcess;
  clock?: Clock;
};

export async function importProfile(
  options: ImportProfileOptions,
): Promise<ImportResult | ImportAborted> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  await loadAppConfig(appHomePath);

  const bundlePath = resolveFilesystemPath(options.bundlePath);
  if (!(await fs.pathExists(bundlePath)) || !(await fs.stat(bundlePath)).isFile()) {
    throw new CcpsError('IMPORT_BUNDLE_NOT_FOUND', 'Import bundle not found.', {
      guidance: `Pass a valid ccps profile bundle path: ${bundlePath}`,
    });
  }

  // Stage under app home so the final tree move is a same-volume rename into
  // profiles/ (spec §15.3 invariant 6 — atomic, never copy+delete across fs).
  const { profilesPath } = getAppHomePaths(appHomePath);
  const stagingRoot = await mkdtemp(path.join(appHomePath, '.ccps-import-'));

  try {
    const { manifest, stagingProfile } = await extractBundle(stagingRoot, bundlePath);

    // Resolve the target name through the confirm callback. A collision loops
    // until the caller aborts or supplies a free name; choosing a new name IS
    // the confirmation, so no extra y/N is asked after a collision is resolved.
    let targetName = options.targetName ?? manifest.profileName;
    validateProfileName(targetName);
    let collision = await profileNameExists(profilesPath, targetName);
    let resolvedViaCollision = false;
    while (collision) {
      const decision = await options.confirm({ manifest, targetName, collision: true });
      if (decision.action === 'abort') {
        return { aborted: true };
      }
      if (decision.action !== 'proceed-as-new-name') {
        // 'proceed' on a colliding name has no valid interpretation.
        throw new CcpsError(
          'IMPORT_COLLISION_UNRESOLVED',
          `A profile named "${targetName}" already exists.`,
          {
            guidance: `Choose a new name (import-as-new-name) or abort, then retry.`,
          },
        );
      }
      targetName = decision.targetName;
      validateProfileName(targetName);
      resolvedViaCollision = true;
      collision = await profileNameExists(profilesPath, targetName);
    }

    // Only ask for a final proceed/abort when no collision was ever present —
    // a collision resolution already committed the user to proceed.
    if (!resolvedViaCollision) {
      const finalDecision = await options.confirm({ manifest, targetName, collision: false });
      if (finalDecision.action === 'abort') {
        return { aborted: true };
      }
      if (finalDecision.action === 'proceed-as-new-name') {
        targetName = finalDecision.targetName;
        validateProfileName(targetName);
        if (await profileNameExists(profilesPath, targetName)) {
          throw new CcpsError(
            'IMPORT_COLLISION_UNRESOLVED',
            `A profile named "${targetName}" already exists.`,
            {
              guidance: `Choose a free profile name and retry.`,
            },
          );
        }
      }
    }

    return await applyImport({
      stagingProfile,
      manifest,
      targetName,
      appHomePath,
      captureProcess: options.captureProcess,
      clock: options.clock,
    });
  } finally {
    await fs.remove(stagingRoot);
  }
}

async function extractBundle(
  stagingRoot: string,
  bundlePath: string,
): Promise<{ manifest: BundleManifest; stagingProfile: string }> {
  // tar's default (`preservePaths: false`) strips leading '/' and '..' segments
  // from entry paths, blocking traversal out of stagingRoot.
  try {
    await tar.x({ file: bundlePath, cwd: stagingRoot });
  } catch (error) {
    throw new CcpsError(
      'IMPORT_BUNDLE_READ_FAILED',
      'Bundle could not be extracted.',
      {
        guidance: `Ensure the file is a valid ccps profile bundle produced by ccps export: ${bundlePath}`,
        cause: error,
      },
    );
  }

  const manifestPath = path.join(stagingRoot, BUNDLE_MANIFEST_FILE);
  const stagingProfile = path.join(stagingRoot, BUNDLE_PROFILE_DIR);
  if (!(await fs.pathExists(manifestPath)) || !(await fs.pathExists(stagingProfile))) {
    throw new CcpsError(
      'IMPORT_BUNDLE_INVALID',
      'Bundle is missing manifest.json or the profile/ tree.',
      {
        guidance: `Use a bundle produced by ccps export: ${bundlePath}`,
      },
    );
  }

  let parsedManifest: BundleManifest;
  try {
    const raw = await fs.readJson(manifestPath);
    parsedManifest = bundleManifestSchema.parse(raw);
  } catch (error) {
    throw new CcpsError(
      'IMPORT_MANIFEST_INVALID',
      'Bundle manifest is invalid or from an incompatible ccps version.',
      {
        guidance: `Re-export the profile with this ccps version (${cliVersion}).`,
        cause: error,
      },
    );
  }

  if (parsedManifest.bundleFormat !== 'ccps-profile-bundle') {
    throw new CcpsError(
      'IMPORT_MANIFEST_INVALID',
      `Unrecognized bundle format: ${parsedManifest.bundleFormat}`,
      {
        guidance: 'Use a bundle produced by ccps export.',
      },
    );
  }

  return { manifest: parsedManifest, stagingProfile };
}

type ApplyImportArgs = {
  stagingProfile: string;
  manifest: BundleManifest;
  targetName: string;
  appHomePath: string;
  captureProcess?: CaptureProcess;
  clock?: Clock;
};

async function applyImport(args: ApplyImportArgs): Promise<ImportResult> {
  const { manifest, targetName, appHomePath, captureProcess } = args;
  const targetPaths = getProfileTemplatePaths(appHomePath, targetName);
  const stagingProfile = args.stagingProfile;

  // Capture native MCP servers from the staged .claude.json, then clear them.
  // The profile's .claude.json must never carry ccps-direct server writes; each
  // server is re-registered through Claude Code's delegated add path below.
  const nativeServers = await readMcpServersMap(stagingProfile);
  await clearNativeMcpServers(stagingProfile);

  // Move the staged tree into profiles/<name>/. Same-volume rename (staging is
  // under app home), so atomic; overwrite:false refuses any pre-existing dir.
  await fs.move(stagingProfile, targetPaths.profileRootPath, { overwrite: false });

  // Repair managed fields so the imported profile points at its own locations
  // (the bundle's settings.json still references the exporter's paths).
  await repairImportedProfile(targetPaths, targetName, args.clock);

  // Re-register each native MCP server via delegated `claude mcp add --scope
  // user`. Failures are collected, never aborting the rest or the Validate.
  const mcpServers = await reRegisterMcpServers(
    targetPaths.profileRootPath,
    nativeServers,
    captureProcess,
  );

  const validation = await validateProfile({ appHomePath, name: targetName });

  return {
    profileName: targetName,
    profileRootPath: targetPaths.profileRootPath,
    manifest,
    mcpServers,
    settingsSecretKeysToReenter: collectSettingsSecretKeys(manifest),
    legacyMcpEnvKeysToReenter: collectLegacyMcpEnvKeys(manifest),
    validation,
  };
}

async function clearNativeMcpServers(stagingProfile: string): Promise<void> {
  const claudeJsonPath = getClaudeJsonPath(stagingProfile);
  if (!(await fs.pathExists(claudeJsonPath))) {
    return;
  }
  // The export prunes .claude.json to just `{ mcpServers }`; reset to empty so
  // the only writes that populate it come from `claude mcp add --scope user`.
  await atomicWriteJson(claudeJsonPath, { mcpServers: {} });
}

async function repairImportedProfile(
  paths: ProfileTemplatePaths,
  targetName: string,
  clock: Clock = () => new Date(),
): Promise<void> {
  // profile.json: re-stamp name + timestamps for the new profile (mirrors
  // copyProfile). The bundled config is re-validated so a tampered manifest
  // never silently lands an invalid profile.json.
  if (!(await fs.pathExists(paths.profileConfigPath))) {
    throw new CcpsError(
      'IMPORT_PROFILE_INVALID',
      'Bundled profile.json is missing.',
      {
        guidance: 'Re-export the source profile with a current ccps version.',
      },
    );
  }
  const profileJson = await fs.readJson(paths.profileConfigPath);
  const parsed = profileConfigSchema.safeParse(profileJson);
  if (!parsed.success) {
    throw new CcpsError(
      'IMPORT_PROFILE_INVALID',
      'Bundled profile.json does not match the profile schema.',
      {
        guidance: 'Re-export the source profile with a current ccps version.',
        cause: parsed.error,
      },
    );
  }
  const timestamp = clock().toISOString();
  // Force mcpMode 'none': import creates a new profile, and the AGENTS.md
  // new-profile contract requires 'none'. 'strict' is an explicit opt-in that
  // must not travel silently across machines; the importer re-opts-in if wanted.
  const repaired: ProfileConfig = {
    ...parsed.data,
    name: targetName,
    launch: { ...parsed.data.launch, mcpMode: 'none' },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await atomicWriteJson(paths.profileConfigPath, profileConfigSchema.parse(repaired));

  // settings.json: point autoMemoryDirectory at this profile's own auto path
  // (the bundled value references the exporter's profile root).
  const settingsJson: unknown = await fs.readJson(paths.settingsPath);
  const settings = isRecord(settingsJson) ? settingsJson : {};
  await atomicWriteJson(paths.settingsPath, {
    ...settings,
    autoMemoryDirectory: paths.autoMemoryPath,
  });

  // Managed-field backfill (idempotent; AGENTS.md profile contract).
  await ensureProfileClaudeMdExcludes(paths.settingsPath);
  await ensureDefaultProfileSettingsEnv(paths.settingsPath);
  await ensureCcpsProfileRule(paths.ccpsProfileRulePath);
}

async function reRegisterMcpServers(
  profileRootPath: string,
  servers: Map<string, Record<string, unknown>>,
  captureProcess?: CaptureProcess,
): Promise<ImportMcpServerResult[]> {
  const results: ImportMcpServerResult[] = [];
  const entries = [...servers.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [name, entry] of entries) {
    const envKeysToReenter = isRecord(entry.env)
      ? Object.keys(entry.env).sort((a, b) => a.localeCompare(b))
      : [];

    const transport = deriveTransport(entry);
    if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
      results.push({
        name,
        reRegistered: false,
        envKeysToReenter,
        failureMessage: 'MCP server transport could not be determined.',
      });
      continue;
    }

    const addOptions: McpAddOptions = { name, transport };
    if (transport === 'stdio' && typeof entry.command === 'string') {
      addOptions.command = entry.command;
      if (Array.isArray(entry.args)) {
        addOptions.args = entry.args.filter((a): a is string => typeof a === 'string');
      }
    } else if ((transport === 'sse' || transport === 'http') && typeof entry.url === 'string') {
      addOptions.url = entry.url;
    }
    // env is intentionally never passed: secret-class values never travel
    // through `claude mcp add -e` during import (secret-in-memory rule). The
    // key names are returned above for guided re-entry.

    try {
      await addMcpServer(profileRootPath, addOptions, { captureProcess });
      results.push({ name, reRegistered: true, envKeysToReenter });
    } catch (error) {
      results.push({
        name,
        reRegistered: false,
        envKeysToReenter,
        failureMessage: errorMessage(error),
      });
    }
  }

  return results;
}

function collectSettingsSecretKeys(manifest: BundleManifest): string[] {
  // In default mode, settings.json env.ANTHROPIC_* values are `<redacted>`
  // placeholders; list their key names for guided re-entry. In includeSecrets
  // mode strippedKeys is empty (values traveled raw), so nothing to re-enter.
  const keys: string[] = [];
  for (const entry of manifest.strippedKeys) {
    if (entry.scope === 'settings-env') {
      keys.push(...entry.keys);
    }
  }
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

function collectLegacyMcpEnvKeys(
  manifest: BundleManifest,
): { server: string; keys: string[] }[] {
  // Legacy root mcp.json travels as-is with `<redacted>` env placeholders; list
  // per-server key names so the user can re-enter them.
  const out: { server: string; keys: string[] }[] = [];
  for (const entry of manifest.strippedKeys) {
    if (entry.scope === 'mcp-env' && entry.file === 'mcp.json' && entry.mcpServer) {
      out.push({ server: entry.mcpServer, keys: [...entry.keys] });
    }
  }
  return out;
}

async function profileNameExists(profilesPath: string, name: string): Promise<boolean> {
  const target = path.join(profilesPath, name);
  return fs.pathExists(target);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
