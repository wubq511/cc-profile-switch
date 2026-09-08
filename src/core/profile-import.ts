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
import { addMcpServer, deriveTransport, getClaudeJsonPath, readMcpServersMap } from './mcp-servers';
import { repairProfileIdentity } from './profile-identity';
import { sweepRuntimeEntriesFromStagedProfile } from './resource-policy';
import { cliVersion } from './version';
import { validateProfile, type ProfileValidationResult } from './validator';
import { resolveFilesystemPath, validateProfileName } from '../platform/path';
import type { CaptureProcess } from '../platform/process';
import { profileConfigSchema, type ProfileConfig } from '../schemas/profile';
import {
  parseBundleManifest,
  type BundleManifest,
  type BundleStrippedKeys,
} from '../schemas/profile-bundle';
import type { McpAddOptions } from '../schemas/mcp';
import { CcpsError } from '../utils/errors';
import { isNodeError, isRecord } from '../utils/type-guards';

/**
 * Profile import — creates a new Profile from a portable `.tar.gz` bundle
 * produced by `exportProfile`.
 *
 * Spec: docs/Spec-profile-workbench.md §11.2 Import (issue #74); boundary per
 * issue #105.
 *
 * Bundle layout (tar.gz root, produced by export):
 *   manifest.json   — authoritative index (BundleManifest, v1 or v2)
 *   profile/        — resource-selected profile tree
 *
 * Safety contract:
 *   - Manifests of the current version (2) and the previous version (1) are
 *     accepted; anything newer is refused. Historical artifacts are never
 *     rewritten — a v1 bundle imports as-is (minus the runtime sweep below).
 *   - The staged tree is swept through the shared resource policy before it
 *     is published: runtime entries an older bundle may carry (sessions,
 *     history, projects, caches, credentials, unknown top-level entries) are
 *     removed, so an old bundle's runtime data never lands in a new Profile.
 *     Manifest claims never override this content check.
 *   - Commit boundary (issue #109, spec Decision 6/12): every structural
 *     check and managed-field repair happens on the STAGED tree before the
 *     publish rename; the rename IS the commit point. Links are refused at
 *     the resource boundary, profile.json must match the profile schema, and
 *     settings.json is mandatory and must parse to a JSON object — a missing,
 *     linked, directory, corrupt, null/array/primitive settings.json rejects
 *     with NO empty-object fallback. A pre-commit failure leaves the target
 *     name free and removes only this staging root. After the rename, MCP
 *     re-registration failures are reported per server next to the actually
 *     published profile — never as a clean rollback, never deleting the
 *     published target.
 *   - Post-commit housekeeping failures (staging cleanup, auto-Validate I/O)
 *     degrade into `ImportResult.warnings` instead of throwing: the profile
 *     IS published, and an exception here would mask the success and make
 *     the caller retry the same now-occupied name (issue #109 AC). Before
 *     the commit point, cleanup is best-effort so it never masks the coded
 *     pre-commit failure; on the abort path (nothing published, tree already
 *     extracted) a cleanup failure still surfaces.
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
 *     key name that needs guided re-entry — env key names and MCP HTTP header
 *     key names alike. No stripped value is ever passed to the delegated CLI;
 *     MCP env/header values never pass through `claude mcp add` during import,
 *     so the secret-in-memory rule holds even for `--include-secrets` bundles.
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
  /** HTTP header key names the user must re-enter for this server. */
  headerKeysToReenter: string[];
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
  /** MCP HTTP header key names needing re-entry, grouped by server. */
  mcpHeaderKeysToReenter: { server: string; keys: string[] }[];
  validation: ProfileValidationResult;
  /**
   * Post-commit housekeeping warnings (issue #109 AC): the profile IS
   * published and usable; a staging-cleanup or auto-Validate I/O failure
   * after the commit point degrades into these instead of throwing and
   * masking the success. Never deletes the published target.
   */
  warnings: string[];
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
  const stagingRoot = await mkdtemp(path.join(appHomePath, '.ccps-import-'));
  // Shared by every result-carrying warning: runStagedImport embeds this
  // array in the ImportResult it returns, and the post-commit cleanup below
  // pushes into the same instance, so the caller sees both without a side
  // channel.
  const warnings: string[] = [];

  // runStagedImport throws ONLY before the publish rename (every post-commit
  // failure degrades into `warnings`), so the outcome below classifies the
  // commit state without a side flag.
  let outcome: ImportResult | ImportAborted;
  try {
    outcome = await runStagedImport(options, appHomePath, stagingRoot, warnings);
  } catch (error) {
    // Pre-commit: nothing was published. The coded failure is the contract —
    // a cleanup failure must not replace it (nor can it ride a result that
    // does not exist); at worst the staging dir lingers as residue.
    await fs.remove(stagingRoot).catch(() => undefined);
    throw error;
  }

  if ('aborted' in outcome) {
    // Nothing published; a cleanup failure still surfaces (the user declined,
    // so a leftover extracted tree is worth reporting).
    await fs.remove(stagingRoot);
    return outcome;
  }

  // Committed: the profile is published. A cleanup failure here must not mask
  // the success or send the caller into a blind same-name retry against the
  // now-occupied target (issue #109 AC) — it degrades into a result warning
  // and never touches the published profile. The staging root is empty by
  // now, so any residue is cosmetic.
  try {
    await fs.remove(stagingRoot);
  } catch (error) {
    warnings.push(describeStagingCleanupFailure(error));
  }
  return outcome;
}

/**
 * Extract the bundle, resolve the target through the confirm gate, and apply
 * the staged import. Throws only pre-commit: after the publish rename inside
 * applyImport, every post-commit failure (auto-Validate I/O) degrades into
 * `warnings` instead of throwing.
 */
async function runStagedImport(
  options: ImportProfileOptions,
  appHomePath: string,
  stagingRoot: string,
  warnings: string[],
): Promise<ImportResult | ImportAborted> {
  const { profilesPath } = getAppHomePaths(appHomePath);
  const { manifest, stagingProfile } = await extractBundle(stagingRoot, options.bundlePath);

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

  return applyImport({
    stagingProfile,
    manifest,
    targetName,
    appHomePath,
    captureProcess: options.captureProcess,
    clock: options.clock,
    warnings,
  });
}

function describeStagingCleanupFailure(error: unknown): string {
  return `Staging cleanup failed after the profile was published (${errorMessage(error)}). The imported profile is unaffected; the leftover staging directory under the app home can be removed manually.`;
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
    throw new CcpsError('IMPORT_BUNDLE_READ_FAILED', 'Bundle could not be extracted.', {
      guidance: `Ensure the file is a valid ccps profile bundle produced by ccps export: ${bundlePath}`,
      cause: error,
    });
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
    parsedManifest = parseBundleManifest(raw);
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
  /** Post-commit warning sink; embedded in the returned ImportResult. */
  warnings: string[];
};

async function applyImport(args: ApplyImportArgs): Promise<ImportResult> {
  const { manifest, targetName, appHomePath, captureProcess, warnings } = args;
  const targetPaths = getProfileTemplatePaths(appHomePath, targetName);
  const stagingProfile = args.stagingProfile;

  // ── Staging validation & preparation (pre-commit) ───────────────────────
  // Boundary first: the staging root, claude-home, and the sweep-reachable
  // plugins/ dir must be real directories — a link at one of these would make
  // the sweep below read or remove content outside the staging area. Then the
  // runtime sweep, then structural validation of everything that survives it.
  await assertImportStagingBoundary(stagingProfile);

  // Content-over-manifest sweep (issue #105): the manifest may claim anything,
  // so the staged tree itself is filtered through the shared resource policy
  // before it can become a Profile. Runtime entries carried by an older
  // exporter — sessions, history, projects, caches, credentials, unknown
  // top-level claude-home entries — are removed here, in every mode.
  await sweepRuntimeEntriesFromStagedProfile(stagingProfile);

  // Everything that survives the sweep must be a plain directory/file tree
  // (links are refused before any content read), and the mandatory
  // profile.json + settings.json must be present, regular, parseable, and
  // shaped like a Profile — all before anything is published.
  await validateImportStagedContent(stagingProfile);

  // Capture native MCP servers from the staged .claude.json, then clear them.
  // The profile's .claude.json must never carry ccps-direct server writes; each
  // server is re-registered through Claude Code's delegated add path after the
  // publish below.
  const nativeServers = await readStagedNativeMcpServers(stagingProfile);
  await clearNativeMcpServers(stagingProfile);

  // Shared identity/managed-path repair (M1, ./profile-identity), on the
  // staging tree with every value pointing at the FINAL location: profile
  // name, autoMemoryDirectory, auto-memory entrypoint, ccps boundary rule,
  // and this machine's claudeMdExcludes merge.
  await repairProfileIdentity({
    stagingPath: stagingProfile,
    finalPath: targetPaths.profileRootPath,
    profileName: targetName,
  });

  // New-profile contract backfills, in staging: settings.json claudeMdExcludes
  // must carry the real-user CLAUDE.md exclusion and the env defaults
  // (CLAUDE_CODE_ATTRIBUTION_HEADER=0). Idempotent; existing values preserved.
  // Run after the repair so both read the repaired settings.json.
  await ensureProfileClaudeMdExcludes(path.join(stagingProfile, 'claude-home', 'settings.json'));
  await ensureDefaultProfileSettingsEnv(path.join(stagingProfile, 'claude-home', 'settings.json'));

  // Import-only profile.json normalization (staging): force launch.mcpMode
  // 'none' — the AGENTS.md new-profile contract — and re-stamp the timestamps
  // so the import reads as the birth of this Profile.
  await normalizeImportedProfileConfig(stagingProfile, targetName, args.clock);

  // ── Publish: the commit point ───────────────────────────────────────────
  // Same-volume rename (staging is under app home), so atomic;
  // overwrite:false refuses any target that appeared after confirmation.
  await publishStagedProfile(stagingProfile, targetPaths.profileRootPath);

  // ── Post-commit: delegated MCP re-registration + auto-Validate ───────────
  // Failures are collected per server, never aborting the rest or the
  // Validate. The caller sees the ACTUAL published profile and per-server
  // outcomes; nothing here deletes or rolls back the published target.
  const mcpServers = await reRegisterMcpServers(
    targetPaths.profileRootPath,
    nativeServers,
    captureProcess,
  );

  // Auto-Validate is post-commit housekeeping: an unexpected I/O failure must
  // not replace the successful result (spec Decision 12, issue #109 AC — a
  // thrown error would send the caller into a blind same-name retry against
  // the now-occupied target). It degrades to a warning plus an error-marked
  // validation result the callers render like any other failed validation.
  let validation: ProfileValidationResult;
  try {
    validation = await validateProfile({ appHomePath, name: targetName });
  } catch (error) {
    warnings.push(describeAutoValidateFailure(error));
    validation = autoValidateFailedResult(targetPaths, targetName, error);
  }

  return {
    profileName: targetName,
    profileRootPath: targetPaths.profileRootPath,
    manifest,
    mcpServers,
    settingsSecretKeysToReenter: collectSettingsSecretKeys(manifest.strippedKeys),
    legacyMcpEnvKeysToReenter: collectLegacyMcpEnvKeys(manifest.strippedKeys),
    mcpHeaderKeysToReenter: collectMcpHeaderKeys(manifest.strippedKeys),
    validation,
    warnings,
  };
}

function describeAutoValidateFailure(error: unknown): string {
  return `Auto-validate could not complete after the profile was published (${errorMessage(error)}). The imported profile is unaffected; run "ccps validate <name>" to check it.`;
}

function autoValidateFailedResult(
  targetPaths: ProfileTemplatePaths,
  targetName: string,
  cause: unknown,
): ProfileValidationResult {
  const message = `Auto-validate could not complete: ${errorMessage(cause)}.`;
  return {
    profileName: targetName,
    status: 'error',
    profileRootPath: targetPaths.profileRootPath,
    claudeHomePath: targetPaths.claudeHomePath,
    paths: targetPaths,
    findings: [
      {
        severity: 'error',
        code: 'AUTO_VALIDATE_FAILED',
        message,
        suggestion: `Re-run validation for the imported profile: ccps validate ${targetName}`,
      },
    ],
  };
}

// ─── Pre-publish validation (issue #109 commit boundary) ─────────────────

/**
 * Pre-sweep resource boundary (spec Decision 11): the staging profile root,
 * claude-home, and the sweep-reachable plugins/ directory must be REAL
 * directories — never symlinks/junctions — or the sweep below would resolve
 * reads/removals through a link to content outside the staging area. All
 * checks are lstat-based; nothing is read through a link. Links deeper in the
 * tree are rejected by `validateImportStagedContent` once the sweep removed
 * runtime entries (a link inside swept-away content is itself removed, so it
 * never survives).
 */
async function assertImportStagingBoundary(stagingProfileRoot: string): Promise<void> {
  await assertStagingRealDirectory(stagingProfileRoot, '');
  const claudeHome = path.join(stagingProfileRoot, 'claude-home');
  await assertStagingRealDirectory(claudeHome, 'claude-home');
  await assertStagingRealDirectory(path.join(claudeHome, 'plugins'), 'claude-home/plugins');
}

async function assertStagingRealDirectory(dirPath: string, relativePath: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = await fs.lstat(dirPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw importLinkForbidden(relativePath === '' ? 'profile tree root' : relativePath);
  }
  if (!stats.isDirectory()) {
    throw new CcpsError(
      'IMPORT_BUNDLE_INVALID',
      relativePath === ''
        ? "The bundle's profile/ entry is not a directory."
        : `The bundle's ${relativePath}/ entry is not a directory.`,
      {
        guidance: `Re-export the source profile with a current ccps version (${cliVersion}).`,
      },
    );
  }
}

/**
 * Post-sweep structural validation: everything that survives the runtime sweep
 * must be a plain directory/file tree — any symlink/junction is refused at
 * the resource boundary BEFORE its content could be read — and the mandatory
 * files must be present, regular, and shaped like a Profile:
 *
 * - profile.json must parse and match the profile schema. The old flow
 *   validated it AFTER the publish, so an IMPORT_PROFILE_INVALID left the
 *   target directory behind occupying the name (the observed #109 defect).
 * - settings.json is mandatory for Import: a missing, linked, non-file
 *   (directory), unparseable, or non-object value (null/array/primitive)
 *   rejects with NO empty-object fallback — garbage must never mint a
 *   plausible new Profile.
 *
 * No staged content is read before the link scan completes.
 */
async function validateImportStagedContent(stagingProfileRoot: string): Promise<void> {
  await rejectLinksInTree(stagingProfileRoot, '');

  const profileConfigPath = path.join(stagingProfileRoot, 'profile.json');
  const profileStats = await lstatOrNull(profileConfigPath);
  if (profileStats === null) {
    throw importProfileInvalid('Bundled profile.json is missing.');
  }
  if (!profileStats.isFile()) {
    throw importProfileInvalid('Bundled profile.json is not a file.');
  }
  let profileRaw: unknown;
  try {
    profileRaw = await fs.readJson(profileConfigPath);
  } catch (error) {
    throw importProfileInvalid('Bundled profile.json cannot be parsed as JSON.', error);
  }
  const parsedProfile = profileConfigSchema.safeParse(profileRaw);
  if (!parsedProfile.success) {
    throw importProfileInvalid(
      'Bundled profile.json does not match the profile schema.',
      parsedProfile.error,
    );
  }

  const settingsPath = path.join(stagingProfileRoot, 'claude-home', 'settings.json');
  const settingsStats = await lstatOrNull(settingsPath);
  if (settingsStats === null) {
    throw importSettingsInvalid('Bundled claude-home/settings.json is missing.');
  }
  if (!settingsStats.isFile()) {
    throw importSettingsInvalid('Bundled claude-home/settings.json is not a file.');
  }
  let settingsRaw: unknown;
  try {
    settingsRaw = await fs.readJson(settingsPath);
  } catch (error) {
    throw importSettingsInvalid(
      'Bundled claude-home/settings.json cannot be parsed as JSON.',
      error,
    );
  }
  if (!isRecord(settingsRaw)) {
    throw importSettingsInvalid('Bundled claude-home/settings.json is not a JSON object.');
  }
}

/** Refuse the first symlink/junction found under `dir` (never follows links). */
async function rejectLinksInTree(dir: string, relativePath: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new CcpsError('IMPORT_BUNDLE_READ_FAILED', 'The staged profile tree could not be read.', {
      guidance: `Re-export the source profile with a current ccps version (${cliVersion}).`,
      cause: error,
    });
  }
  for (const entry of entries) {
    const relativeEntry = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw importLinkForbidden(relativeEntry);
    }
    if (entry.isDirectory()) {
      await rejectLinksInTree(path.join(dir, entry.name), relativeEntry);
    }
  }
}

function importLinkForbidden(relativePath: string): CcpsError {
  return new CcpsError(
    'IMPORT_LINK_FORBIDDEN',
    `The bundle's profile tree contains a link at ${relativePath}; it cannot be imported.`,
    {
      guidance: `Portable ccps bundles cannot carry links. Re-export the source profile with a current ccps version (${cliVersion}).`,
    },
  );
}

function importProfileInvalid(message: string, cause?: unknown): CcpsError {
  return new CcpsError('IMPORT_PROFILE_INVALID', message, {
    guidance: `Re-export the source profile with a current ccps version (${cliVersion}).`,
    cause,
  });
}

function importSettingsInvalid(message: string, cause?: unknown): CcpsError {
  return new CcpsError('IMPORT_SETTINGS_INVALID', message, {
    guidance: `Re-export the source profile with a current ccps version (${cliVersion}).`,
    cause,
  });
}

async function lstatOrNull(targetPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Read the staged native MCP inventory. A staged .claude.json that cannot be
 * read (corrupt JSON, directory entry, I/O error) is a pre-commit failure —
 * its servers could not be re-registered and silently clearing it would drop
 * them without a trace.
 */
async function readStagedNativeMcpServers(
  stagingProfileRoot: string,
): Promise<Map<string, Record<string, unknown>>> {
  try {
    return await readMcpServersMap(stagingProfileRoot);
  } catch (error) {
    throw new CcpsError(
      'IMPORT_CLAUDE_JSON_INVALID',
      'Bundled claude-home/.claude.json could not be read.',
      {
        guidance: `Re-export the source profile with a current ccps version (${cliVersion}).`,
        cause: error,
      },
    );
  }
}

/**
 * Import-only profile.json normalization, applied to the staging tree before
 * the publish: force launch.mcpMode 'none' (AGENTS.md new-profile contract —
 * 'strict'/'merge' from the exporter must not travel silently across
 * machines) and re-stamp createdAt/updatedAt so the imported Profile reads as
 * new (mirrors copyProfile).
 */
async function normalizeImportedProfileConfig(
  stagingProfileRoot: string,
  targetName: string,
  clock: Clock = () => new Date(),
): Promise<void> {
  const profileConfigPath = path.join(stagingProfileRoot, 'profile.json');
  const raw: unknown = await fs.readJson(profileConfigPath);
  const parsed = profileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Unreachable after validateImportStagedContent + repairProfileIdentity;
    // kept so a future repair regression still fails pre-commit, not after.
    throw importProfileInvalid(
      'Bundled profile.json does not match the profile schema.',
      parsed.error,
    );
  }
  const timestamp = clock().toISOString();
  const normalized: ProfileConfig = {
    ...parsed.data,
    name: targetName,
    launch: { ...parsed.data.launch, mcpMode: 'none' },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await atomicWriteJson(profileConfigPath, profileConfigSchema.parse(normalized));
}

/**
 * The publish step — the import's commit point (spec Decision 12). The staged
 * tree is fully validated and repaired; this same-volume rename into
 * profiles/<name> either lands the complete Profile or fails with no effect.
 * overwrite:false keeps the never-overwrite semantics against a target that
 * appeared after the confirm gate.
 */
async function publishStagedProfile(
  stagingProfileRoot: string,
  finalProfileRoot: string,
): Promise<void> {
  if (await fs.pathExists(finalProfileRoot)) {
    throw importTargetExists(path.basename(finalProfileRoot));
  }
  try {
    await fs.move(stagingProfileRoot, finalProfileRoot, { overwrite: false });
  } catch (error) {
    if (await fs.pathExists(finalProfileRoot)) {
      throw importTargetExists(path.basename(finalProfileRoot));
    }
    throw new CcpsError(
      'IMPORT_PUBLISH_FAILED',
      'The validated profile could not be published to its final location.',
      {
        guidance: 'No profile was created; check the app home directory and retry the import.',
        cause: error,
      },
    );
  }
}

function importTargetExists(profileName: string): CcpsError {
  return new CcpsError('IMPORT_TARGET_EXISTS', `A profile named "${profileName}" already exists.`, {
    guidance: 'Choose a new profile name (import-as-new-name) and retry the import.',
  });
}

export async function clearNativeMcpServers(stagingProfile: string): Promise<void> {
  const claudeJsonPath = getClaudeJsonPath(stagingProfile);
  if (!(await fs.pathExists(claudeJsonPath))) {
    return;
  }
  // The export prunes .claude.json to just `{ mcpServers }`; reset to empty so
  // the only writes that populate it come from `claude mcp add --scope user`.
  await atomicWriteJson(claudeJsonPath, { mcpServers: {} });
}

/**
 * Post-publish managed-field repair for a tree that was ALREADY placed at its
 * final location — the commit point of create-from-custom-template
 * (./custom-template), whose copy into profiles/<name> is its publish.
 *
 * Import (issue #109) deliberately does NOT use this path: it validates and
 * repairs the STAGED tree before the publish rename (see applyImport), so a
 * failed import never leaves a final directory behind.
 */
export async function repairImportedProfile(
  paths: ProfileTemplatePaths,
  targetName: string,
  clock: Clock = () => new Date(),
): Promise<void> {
  // profile.json: re-stamp name + timestamps for the new profile (mirrors
  // copyProfile). The bundled config is re-validated so a tampered manifest
  // never silently lands an invalid profile.json.
  if (!(await fs.pathExists(paths.profileConfigPath))) {
    throw new CcpsError('IMPORT_PROFILE_INVALID', 'Bundled profile.json is missing.', {
      guidance: 'Re-export the source profile with a current ccps version.',
    });
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

export async function reRegisterMcpServers(
  profileRootPath: string,
  servers: Map<string, Record<string, unknown>>,
  captureProcess?: CaptureProcess,
): Promise<ImportMcpServerResult[]> {
  const results: ImportMcpServerResult[] = [];
  const entries = [...servers.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [name, entry] of entries) {
    const envKeysToReenter = stringKeyNames(entry.env);
    const headerKeysToReenter = stringKeyNames(entry.headers);

    const transport = deriveTransport(entry);
    if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
      results.push({
        name,
        reRegistered: false,
        envKeysToReenter,
        headerKeysToReenter,
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
    // env and headers are intentionally never passed: secret-class values
    // never travel through `claude mcp add -e`/`--header` during import
    // (secret-in-memory rule). The key names are returned above for guided
    // re-entry.
    try {
      await addMcpServer(profileRootPath, addOptions, { captureProcess });
      results.push({ name, reRegistered: true, envKeysToReenter, headerKeysToReenter });
    } catch (error) {
      results.push({
        name,
        reRegistered: false,
        envKeysToReenter,
        headerKeysToReenter,
        failureMessage: errorMessage(error),
      });
    }
  }

  return results;
}

/**
 * Sorted key names of a server entry bag. Malformed bags (non-object values)
 * still surface their enumerable key names — a malformed structure must not
 * hide re-entry requirements, and no value is ever read beyond key names.
 */
function stringKeyNames(bag: unknown): string[] {
  if (!isRecord(bag)) {
    return [];
  }
  return Object.keys(bag).sort((left, right) => left.localeCompare(right));
}

export function collectSettingsSecretKeys(strippedKeys: BundleStrippedKeys[]): string[] {
  // In default mode, settings.json env.ANTHROPIC_* values are `<redacted>`
  // placeholders; list their key names for guided re-entry. In includeSecrets
  // mode strippedKeys is empty (values traveled raw), so nothing to re-enter.
  const keys: string[] = [];
  for (const entry of strippedKeys) {
    if (entry.scope === 'settings-env') {
      keys.push(...entry.keys);
    }
  }
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

export function collectLegacyMcpEnvKeys(
  strippedKeys: BundleStrippedKeys[],
): { server: string; keys: string[] }[] {
  // Legacy root mcp.json travels as-is with `<redacted>` env placeholders; list
  // per-server key names so the user can re-enter them.
  const out: { server: string; keys: string[] }[] = [];
  for (const entry of strippedKeys) {
    if (entry.scope === 'mcp-env' && entry.file === 'mcp.json' && entry.mcpServer) {
      out.push({ server: entry.mcpServer, keys: [...entry.keys] });
    }
  }
  return out;
}

/**
 * MCP HTTP header key names needing guided re-entry (issue #105): header
 * values are stripped under the same rules as env values, and the v2
 * `mcp-headers` stripped-key scope records their names per server.
 */
export function collectMcpHeaderKeys(
  strippedKeys: BundleStrippedKeys[],
): { server: string; keys: string[] }[] {
  const out: { server: string; keys: string[] }[] = [];
  for (const entry of strippedKeys) {
    if (entry.scope === 'mcp-headers' && entry.mcpServer) {
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
