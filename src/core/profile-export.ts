import fs from 'fs-extra';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';

import { getAppHomePaths, loadAppConfig, type Clock } from './app-config';
import { atomicWriteJson } from './versioned-json';
import { getProfileTemplatePaths } from './profile-template';
import { cliVersion } from './version';
import { isPathInside, resolveFilesystemPath } from '../platform/path';
import {
  bundleManifestSchema,
  type BundleManifest,
  type BundleResourceCounts,
  type BundleStrippedKeys,
} from '../schemas/profile-bundle';
import { CcpsError } from '../utils/errors';

/**
 * Profile export — packages one Profile as a single portable `.tar.gz` file.
 *
 * Spec: docs/Spec-profile-workbench.md §11.2 Export.
 *
 * Bundle layout (tar.gz root):
 *   manifest.json   — authoritative index (BundleManifest)
 *   profile/        — verbatim profile file tree (profiles/<name>/ contents)
 *
 * Safety contract:
 *   - Default mode strips secret-class env values (settings.json env.ANTHROPIC_*,
 *     .claude.json and legacy mcp.json mcpServers[*].env). Key names are kept
 *     and reported; values become "<redacted>". If a secret-bearing file cannot
 *     be parsed, the export is refused rather than risk leaking secrets.
 *   - --includeSecrets writes the raw tree and the bundle file is chmod 0600.
 *   - The Recovery Bin lives at app-home level (sibling of profiles/); export
 *     only reads profiles/<name>/, so Bin items are never exported by structure.
 *   - Never reads or touches the real ~/.claude or ~/.claude.json.
 */

const REDACTED = '<redacted>';
const BUNDLE_PROFILE_DIR = 'profile';
const BUNDLE_MANIFEST_FILE = 'manifest.json';
const SETTINGS_REL = 'claude-home/settings.json';
const CLAUDE_JSON_REL = 'claude-home/.claude.json';
const MCP_JSON_REL = 'mcp.json';

export type ExportProfileOptions = {
  appHomePath?: string;
  name: string;
  outputPath: string;
  includeSecrets?: boolean;
  clock?: Clock;
};

export type ExportProfileResult = {
  profileName: string;
  bundlePath: string;
  manifest: BundleManifest;
  strippedKeys: BundleStrippedKeys[];
};

export async function exportProfile(
  options: ExportProfileOptions,
): Promise<ExportProfileResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  await loadAppConfig(appHomePath);

  const profilePaths = getProfileTemplatePaths(appHomePath, options.name);
  if (!(await fs.pathExists(profilePaths.profileRootPath))) {
    throw new CcpsError('PROFILE_NOT_FOUND', 'Profile does not exist.', {
      guidance: `Create the profile first: ccps create ${options.name}`,
    });
  }

  const outputPath = resolveFilesystemPath(options.outputPath);
  validateOutputPath(outputPath, profilePaths.profileRootPath);
  if (await fs.pathExists(outputPath)) {
    throw new CcpsError('EXPORT_PATH_EXISTS', 'A file already exists at the export path.', {
      guidance: `Remove the existing file or choose a different path: ${outputPath}`,
    });
  }
  const outputDir = path.dirname(outputPath);
  if (!(await fs.pathExists(outputDir))) {
    throw new CcpsError('EXPORT_DIR_MISSING', 'The output directory does not exist.', {
      guidance: `Create the directory first or choose an existing path: ${outputDir}`,
    });
  }

  const includeSecrets = options.includeSecrets === true;
  // Stage in the output directory (not os.tmpdir()) so the final move is a
  // same-volume rename — atomic on POSIX, and never degrades to copy+delete
  // across filesystems (spec §15.3 invariant 6). validateOutputPath above
  // guarantees outputPath is not inside the profile, so neither is outputDir.
  const stagingRoot = await mkdtemp(path.join(outputDir, '.ccps-export-'));
  if (includeSecrets) {
    await fs.chmod(stagingRoot, 0o700);
  }
  const stagingProfile = path.join(stagingRoot, BUNDLE_PROFILE_DIR);

  try {
    // Copy the profile tree into staging/profile/. The source profile is never
    // mutated; all redaction happens on the staging copy.
    await fs.copy(profilePaths.profileRootPath, stagingProfile, {
      overwrite: false,
      errorOnExist: true,
    });

    // Runtime internals are never exported (spec §6.4: OAuth/tokens/sessions/
    // history/caches/credentials "not in the matrix at all"; invariant 3).
    // Plugins (§7.6) are NOT runtime internals — they are a managed resource
    // category with delegated lifecycle, so plugins/ travels with the bundle.
    // The --include-secrets opt-in controls env VALUE redaction only; it never
    // permits exporting these.
    await pruneRuntimeInternals(stagingProfile);

    // Always scan for secret-class keys (to set `secretsPresent`); only redact
    // values in default mode. In includeSecrets mode strippedKeys stays empty
    // (nothing was stripped) but secretsPresent still records presence (#73).
    const { secretsPresent, strippedKeys } = await processSecrets(stagingProfile, {
      redact: !includeSecrets,
    });

    const mcpServerNames = await readMcpServerNames(stagingProfile);
    const resources = await countResources(stagingProfile, mcpServerNames);
    const manifest: BundleManifest = bundleManifestSchema.parse({
      version: 1,
      bundleFormat: 'ccps-profile-bundle',
      exporterVersion: cliVersion,
      exportedAt: (options.clock ?? (() => new Date()))().toISOString(),
      profileName: options.name,
      includeSecrets,
      secretsPresent,
      secretsStripped: !includeSecrets && strippedKeys.some((entry) => entry.keys.length > 0),
      strippedKeys,
      resources,
      mcpServerNames,
    });
    await atomicWriteJson(path.join(stagingRoot, BUNDLE_MANIFEST_FILE), manifest);

    const stagingBundle = path.join(stagingRoot, 'bundle.tar.gz');
    await tar.c(
      {
        gzip: true,
        file: stagingBundle,
        cwd: stagingRoot,
        portable: true,
      },
      [BUNDLE_MANIFEST_FILE, BUNDLE_PROFILE_DIR],
    );
    if (includeSecrets) {
      // Restrict the bundle file before it leaves the 0700 staging dir so it
      // never appears world-readable at the destination.
      await fs.chmod(stagingBundle, 0o600);
    }
    // Same-volume rename (stagingRoot is under outputDir).
    await fs.move(stagingBundle, outputPath, { overwrite: false });

    return {
      profileName: options.name,
      bundlePath: outputPath,
      manifest,
      strippedKeys,
    };
  } finally {
    await fs.remove(stagingRoot);
  }
}

function validateOutputPath(outputPath: string, profileRootPath: string): void {
  if (isPathInside(profileRootPath, outputPath)) {
    throw new CcpsError(
      'EXPORT_PATH_INSIDE_PROFILE',
      'Export path cannot be inside the profile being exported.',
      { guidance: 'Choose a path outside the profile directory.' },
    );
  }
}

/**
 * Scan the staged profile for secret-class keys; optionally redact their values.
 *
 * Always returns `secretsPresent` (true when any secret-class key was found, in
 * either mode — required by issue #73's "secrets presence" manifest field).
 * `strippedKeys` is populated only when `options.redact` is true: in
 * includeSecrets mode nothing is stripped, so the audit trail stays empty while
 * `secretsPresent` still records that the profile contained secrets.
 */
async function processSecrets(
  stagingProfile: string,
  options: { redact: boolean },
): Promise<{ secretsPresent: boolean; strippedKeys: BundleStrippedKeys[] }> {
  const strippedKeys: BundleStrippedKeys[] = [];
  let secretsPresent = false;

  const settingsKeys = await processSettingsEnv(
    path.join(stagingProfile, 'claude-home', 'settings.json'),
    options.redact,
  );
  if (settingsKeys.length > 0) {
    secretsPresent = true;
    if (options.redact) {
      strippedKeys.push({ file: SETTINGS_REL, scope: 'settings-env', keys: settingsKeys });
    }
  }

  const claudeJsonServers = await processMcpEnv(
    path.join(stagingProfile, 'claude-home', '.claude.json'),
    CLAUDE_JSON_REL,
    options.redact,
  );
  for (const [server, keys] of claudeJsonServers) {
    secretsPresent = true;
    if (options.redact) {
      strippedKeys.push({
        file: CLAUDE_JSON_REL,
        scope: 'mcp-env',
        mcpServer: server,
        keys,
      });
    }
  }

  const legacyMcpPath = path.join(stagingProfile, 'mcp.json');
  if (await fs.pathExists(legacyMcpPath)) {
    const legacyServers = await processMcpEnv(legacyMcpPath, MCP_JSON_REL, options.redact);
    for (const [server, keys] of legacyServers) {
      secretsPresent = true;
      if (options.redact) {
        strippedKeys.push({
          file: MCP_JSON_REL,
          scope: 'mcp-env',
          mcpServer: server,
          keys,
        });
      }
    }
  }

  return { secretsPresent, strippedKeys };
}

/**
 * Scan env.ANTHROPIC_* keys in settings.json; when `redact`, replace their
 * values with `<redacted>`. Returns the affected key names (sorted).
 */
async function processSettingsEnv(filePath: string, redact: boolean): Promise<string[]> {
  const json = await readJsonForRedaction(filePath, SETTINGS_REL);
  if (json === undefined || !isRecord(json) || !isRecord(json.env)) {
    return [];
  }
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(json.env)) {
    if (key.startsWith('ANTHROPIC_') && value !== REDACTED) {
      stripped.push(key);
      if (redact) {
        json.env[key] = REDACTED;
      }
    }
  }
  if (redact && stripped.length > 0) {
    await atomicWriteJson(filePath, json);
  }
  return stripped.sort((left, right) => left.localeCompare(right));
}

/**
 * Scan every value under mcpServers[*].env; when `redact`, replace each with
 * `<redacted>`. Returns a server→key-names map (insertion order preserved).
 * MCP env values are secret-class per issue #73 and spec §6.5.
 */
async function processMcpEnv(
  filePath: string,
  label: string,
  redact: boolean,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const json = await readJsonForRedaction(filePath, label);
  if (json === undefined || !isRecord(json) || !isRecord(json.mcpServers)) {
    return result;
  }
  let mutated = false;
  for (const [serverName, serverDef] of Object.entries(json.mcpServers)) {
    if (!isRecord(serverDef) || !isRecord(serverDef.env)) {
      continue;
    }
    const stripped: string[] = [];
    for (const [key, value] of Object.entries(serverDef.env)) {
      if (value !== REDACTED) {
        stripped.push(key);
        if (redact) {
          serverDef.env[key] = REDACTED;
          mutated = true;
        }
      }
    }
    if (stripped.length > 0) {
      result.set(
        serverName,
        stripped.sort((left, right) => left.localeCompare(right)),
      );
    }
  }
  if (redact && mutated) {
    await atomicWriteJson(filePath, json);
  }
  return result;
}

/**
 * Read JSON for redaction. Returns undefined when the file is absent. Throws
 * CcpsError on a parse failure — a malformed secret-bearing file cannot be
 * safely stripped, so the export must refuse rather than risk leaking secrets.
 */
async function readJsonForRedaction(filePath: string, label: string): Promise<unknown | undefined> {
  try {
    return await fs.readJson(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw new CcpsError(
      'EXPORT_SECRET_FILE_UNREADABLE',
      `${label} could not be parsed; cannot safely export.`,
      { guidance: `Fix ${label} or export with --include-secrets.`, cause: error },
    );
  }
}

/**
 * Remove runtime internals from the staged tree. Per spec §6.4, runtime
 * internals are OAuth/tokens/sessions/history/caches/credentials — "not in the
 * matrix at all". `sessions/` and `projects/` carry that runtime state and are
 * stripped in BOTH modes. `plugins/` is NOT runtime internals (§7.6 — delegated
 * lifecycle managed resource) and travels with the bundle. Non-MCP fields of
 * `.claude.json` (OAuth/account) are also stripped.
 */
async function pruneRuntimeInternals(stagingProfile: string): Promise<void> {
  const claudeHome = path.join(stagingProfile, 'claude-home');
  for (const dir of ['sessions', 'projects']) {
    await fs.remove(path.join(claudeHome, dir));
  }
  await pruneClaudeJson(path.join(claudeHome, '.claude.json'));
}

/** Keep only `mcpServers` in `.claude.json`; drop OAuth/account and other
 * Claude-managed runtime fields so they never travel with the bundle. */
async function pruneClaudeJson(filePath: string): Promise<void> {
  const json = await readJsonForRedaction(filePath, CLAUDE_JSON_REL);
  if (json === undefined) {
    return;
  }
  const mcpServers = isRecord(json) && isRecord(json.mcpServers) ? json.mcpServers : {};
  await atomicWriteJson(filePath, { mcpServers });
}

async function countResources(
  stagingProfile: string,
  mcpServerNames: string[],
): Promise<BundleResourceCounts> {
  const claudeHome = path.join(stagingProfile, 'claude-home');

  const countEntries = async (
    dir: string,
    predicate: (entry: fs.Dirent) => boolean,
  ): Promise<number> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter(predicate).length;
    } catch (error) {
      // A missing resource directory is not corruption (count 0); any other
      // errno is surfaced so corruption is never silently masked (§13.4 rule 4).
      if (isNodeError(error) && error.code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  };

  const userMemory = (await fs.pathExists(path.join(claudeHome, 'CLAUDE.md'))) ? 1 : 0;
  const autoMemory = await countEntries(path.join(claudeHome, 'memory', 'auto'), (e) =>
    e.isFile(),
  );
  const skills = await countEntries(path.join(claudeHome, 'skills'), (e) =>
    // a Linked Skill is a symlink (§7.2) — count it alongside files and dirs
    e.isFile() || e.isDirectory() || e.isSymbolicLink(),
  );
  const agents = await countEntries(path.join(claudeHome, 'agents'), (e) => e.isFile());
  const settings = (await fs.pathExists(path.join(claudeHome, 'settings.json'))) ? 1 : 0;
  const launchConfig = (await fs.pathExists(path.join(stagingProfile, 'profile.json'))) ? 1 : 0;

  return {
    userMemory,
    autoMemory,
    skills,
    agents,
    mcpServers: mcpServerNames.length,
    settings,
    launchConfig,
  };
}

async function readMcpServerNames(stagingProfile: string): Promise<string[]> {
  const claudeHome = path.join(stagingProfile, 'claude-home');
  let value: unknown;
  try {
    value = await fs.readJson(path.join(claudeHome, '.claude.json'));
  } catch (error) {
    // Missing .claude.json = no MCP servers; any other errno is surfaced.
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (!isRecord(value) || !isRecord(value.mcpServers)) {
    return [];
  }
  return Object.keys(value.mcpServers).sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
