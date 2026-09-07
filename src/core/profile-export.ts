import fs from 'fs-extra';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';

import { getAppHomePaths, loadAppConfig, type Clock } from './app-config';
import { atomicWriteJson } from './versioned-json';
import { getProfileTemplatePaths } from './profile-template';
import { selectResourcesIntoStaging, type ResourceCopyFailure } from './resource-policy';
import { cliVersion } from './version';
import { isPathInside, resolveFilesystemPath } from '../platform/path';
import {
  BUNDLE_MANIFEST_VERSION,
  countStrippedKeys,
  bundleManifestV2Schema,
  type BundleManifest,
  type BundleResourceCounts,
  type BundleStrippedKeys,
} from '../schemas/profile-bundle';
import { CcpsError } from '../utils/errors';
import { isNodeError, isRecord } from '../utils/type-guards';

/**
 * Profile export — packages one Profile as a single portable `.tar.gz` file.
 *
 * Spec: docs/Spec-profile-workbench.md §11.2 Export; issue #105 boundary.
 *
 * Bundle layout (tar.gz root):
 *   manifest.json   — authoritative index (BundleManifest, version 2)
 *   profile/        — resource-selected profile tree (profiles/<name>/ contents)
 *
 * Safety contract:
 *   - Resources are selected into staging entry-by-entry through the shared
 *     resource policy (./resource-policy) — never a whole-tree copy followed
 *     by deletion. Known runtime data (sessions, history, projects, caches,
 *     credentials) and unknown top-level claude-home entries are never copied,
 *     in every mode including --include-secrets.
 *   - Default mode strips secret-class values: settings.json env.ANTHROPIC_*,
 *     .claude.json and legacy mcp.json mcpServers[*].env, and MCP HTTP header
 *     values (mcpServers[*].headers[*]). Key names are kept and reported;
 *     values become "<redacted>". A secret-bearing file that cannot be parsed
 *     refuses the export rather than risk leaking secrets.
 *   - --includeSecrets widens env/header VALUE redaction only — runtime data
 *     still never travels — and the bundle file is chmod 0600.
 *   - Symlinks/junctions inside the profile tree are refused before the linked
 *     content is read, including when a configuration file or one of its
 *     ancestor directories is itself a link to excluded content.
 *   - The Recovery Bin lives at app-home level (sibling of profiles/); export
 *     only reads profiles/<name>/, so Bin items are never exported by structure.
 *   - Never reads or touches the real ~/.claude or ~/.claude.json.
 */

/**
 * Placeholder left in place of stripped secret values in exported bundles and
 * imported profiles. It is a marker, never a real value — launch env
 * composition (./api-settings) must filter it out rather than inject it.
 */
export const REDACTED = '<redacted>';
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
  /** Manifest `resources` counts, mirrored for callers without re-parsing. */
  resources: BundleResourceCounts;
};

export async function exportProfile(options: ExportProfileOptions): Promise<ExportProfileResult> {
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
    // Select resources into staging entry-by-entry (spec #103 Implementation
    // Decision 1): the shared policy copies only supported resources, refuses
    // symlinks before their targets are read, and never copies a whole tree
    // for later pruning. Export keeps Auto Memory; templates exclude it.
    const selection = await selectResourcesIntoStaging({
      sourceProfileRoot: profilePaths.profileRootPath,
      stagingProfileRoot: stagingProfile,
      includeAutoMemory: true,
    });
    throwOnResourceFailures(selection.failures);

    // Defense in depth on the staged copy (never the source): .claude.json
    // keeps only its mcpServers inventory — non-MCP fields Claude Code may
    // have written under the profile (OAuth/account/project state) are
    // runtime data that never travel, in either mode (spec §6.4 invariant 3).
    // The selection already refused runtime directories, so this only prunes
    // the JSON; a malformed .claude.json still refuses the export rather than
    // risk carrying runtime content past the scan.
    await pruneRuntimeInternals(stagingProfile);

    // Always scan for secret-class keys (to set `secretsPresent`); only redact
    // values in default mode. In includeSecrets mode strippedKeys stays empty
    // (nothing was stripped) but secretsPresent still records presence (#73).
    const { secretsPresent, strippedKeys } = await processSecrets(stagingProfile, {
      redact: !includeSecrets,
    });

    const mcpServerNames = await readMcpServerNames(stagingProfile);
    const resources = await countResources(stagingProfile, mcpServerNames);
    const manifest: BundleManifest = bundleManifestV2Schema.parse({
      version: BUNDLE_MANIFEST_VERSION,
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
      topLevelEntries: selection.copiedTopLevelEntries,
      excludedTopLevelEntries: selection.skipped,
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
      resources,
    };
  } finally {
    await fs.remove(stagingRoot);
  }
}

function throwOnResourceFailures(failures: ResourceCopyFailure[]): void {
  const first = failures[0];
  if (first === undefined) {
    return;
  }
  throw new CcpsError(first.code, first.message, { guidance: first.guidance });
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
 * Secret-class values live in settings.json `env.ANTHROPIC_*`, MCP server
 * `env` values, and MCP HTTP `headers` values (issue #105: header values obey
 * the same redaction and key-name reporting rules as env values).
 *
 * Always returns `secretsPresent` (true when any secret-class key was found, in
 * either mode — required by issue #73's "secrets presence" manifest field).
 * `strippedKeys` is populated only when `options.redact` is true: in
 * includeSecrets mode nothing is stripped, so the audit trail stays empty while
 * `secretsPresent` still records that the profile contained secrets.
 */
export async function processSecrets(
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

  const claudeJsonServers = await processMcpEnvAndHeaders(
    path.join(stagingProfile, 'claude-home', '.claude.json'),
    CLAUDE_JSON_REL,
    options.redact,
  );
  for (const entry of claudeJsonServers) {
    if (entry.envKeys.length > 0 || entry.headerKeys.length > 0) {
      secretsPresent = true;
    }
    if (options.redact && entry.envKeys.length > 0) {
      strippedKeys.push({
        file: CLAUDE_JSON_REL,
        scope: 'mcp-env',
        mcpServer: entry.server,
        keys: entry.envKeys,
      });
    }
    if (options.redact && entry.headerKeys.length > 0) {
      strippedKeys.push({
        file: CLAUDE_JSON_REL,
        scope: 'mcp-headers',
        mcpServer: entry.server,
        keys: entry.headerKeys,
      });
    }
  }

  const legacyMcpPath = path.join(stagingProfile, 'mcp.json');
  if (await fs.pathExists(legacyMcpPath)) {
    const legacyServers = await processMcpEnvAndHeaders(
      legacyMcpPath,
      MCP_JSON_REL,
      options.redact,
    );
    for (const entry of legacyServers) {
      if (entry.envKeys.length > 0 || entry.headerKeys.length > 0) {
        secretsPresent = true;
      }
      if (options.redact && entry.envKeys.length > 0) {
        strippedKeys.push({
          file: MCP_JSON_REL,
          scope: 'mcp-env',
          mcpServer: entry.server,
          keys: entry.envKeys,
        });
      }
      if (options.redact && entry.headerKeys.length > 0) {
        strippedKeys.push({
          file: MCP_JSON_REL,
          scope: 'mcp-headers',
          mcpServer: entry.server,
          keys: entry.headerKeys,
        });
      }
    }
  }

  return { secretsPresent, strippedKeys };
}

/**
 * Scan env.ANTHROPIC_* keys in settings.json; when `redact`, replace their
 * values with `<redacted>`. Returns the affected key names (sorted).
 *
 * A present-but-malformed `env` bag (non-object) cannot be verified clean, so
 * the export refuses: a tampered structure must never bypass the scan by
 * failing to look like an env bag.
 */
async function processSettingsEnv(filePath: string, redact: boolean): Promise<string[]> {
  const json = await readJsonForRedaction(filePath, SETTINGS_REL);
  if (json === undefined) {
    return [];
  }
  if (!isRecord(json)) {
    throw new CcpsError(
      'EXPORT_SECRET_FILE_UNREADABLE',
      `${SETTINGS_REL} is not a JSON object; cannot safely export.`,
      {
        // Mode-independent refusal: --include-secrets cannot bypass it, so it
        // is not offered as guidance.
        guidance: `Fix ${SETTINGS_REL} in the source profile, then retry the export.`,
      },
    );
  }
  if (json.env !== undefined && !isRecord(json.env)) {
    throw new CcpsError(
      'EXPORT_SECRET_FILE_UNREADABLE',
      `${SETTINGS_REL} env is not an object; cannot safely export.`,
      {
        guidance: `Fix env in ${SETTINGS_REL} of the source profile, then retry the export.`,
      },
    );
  }
  if (!isRecord(json.env)) {
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

type McpServerSecretKeys = {
  server: string;
  envKeys: string[];
  headerKeys: string[];
};

/**
 * Scan every value under mcpServers[*].env and every value under
 * mcpServers[*].headers; when `redact`, replace each with `<redacted>`.
 * Returns per-server key-name lists (sorted). Malformed shapes (env or
 * headers not an object, non-string entries) are stripped wholesale or fail
 * the export — a malformed structure must never bypass redaction by failing
 * to look like a secret bag, and never silently counts as a safe empty one.
 */
async function processMcpEnvAndHeaders(
  filePath: string,
  label: string,
  redact: boolean,
): Promise<McpServerSecretKeys[]> {
  const result: McpServerSecretKeys[] = [];
  const json = await readJsonForRedaction(filePath, label);
  if (json === undefined) {
    return result;
  }
  if (!isRecord(json)) {
    throw new CcpsError(
      'EXPORT_SECRET_FILE_UNREADABLE',
      `${label} is not a JSON object; cannot safely export.`,
      {
        guidance: `Fix ${label} in the source profile, then retry the export.`,
      },
    );
  }
  if (!isRecord(json.mcpServers)) {
    return result;
  }
  let mutated = false;
  for (const [serverName, serverDef] of Object.entries(json.mcpServers)) {
    if (!isRecord(serverDef)) {
      continue;
    }
    const envKeys = stripBag(serverDef, 'env', redact);
    const headerKeys = stripBag(serverDef, 'headers', redact);
    if (envKeys.mutated || headerKeys.mutated) {
      mutated = true;
    }
    if (envKeys.keys.length > 0 || headerKeys.keys.length > 0) {
      result.push({
        server: serverName,
        envKeys: envKeys.keys.sort((left, right) => left.localeCompare(right)),
        headerKeys: headerKeys.keys.sort((left, right) => left.localeCompare(right)),
      });
    }
  }
  if (redact && mutated) {
    await atomicWriteJson(filePath, json);
  }
  return result;
}

/**
 * Strip (or report) the values of one secret-class bag on a server entry.
 * A missing bag is empty. A present-but-malformed bag (non-object — e.g. a
 * raw string or array) cannot be verified clean: in redact mode it is
 * replaced wholesale and no key/value is reported or carried; in scan-only
 * mode the bag passes through untouched and nothing is reported either —
 * the enumerable "keys" of a non-object (character or array indices) are not
 * real key names. In redact mode every remaining value is replaced with the
 * `<redacted>` marker — including non-primitive values (nested objects/
 * arrays), which cannot be proven clean and must not be copied through the
 * scan. Scan-only mode surfaces key names for re-entry without touching the
 * values.
 */
function stripBag(
  serverDef: Record<string, unknown>,
  bagName: 'env' | 'headers',
  redact: boolean,
): { keys: string[]; mutated: boolean } {
  const bag = serverDef[bagName];
  if (bag === undefined) {
    return { keys: [], mutated: false };
  }
  if (!isRecord(bag)) {
    // Malformed: cannot prove it is clean. In redact mode the whole bag is
    // dropped (no content survives); nothing enumerable to report.
    if (redact) {
      serverDef[bagName] = {};
      return { keys: [], mutated: true };
    }
    return { keys: [], mutated: false };
  }
  const keys: string[] = [];
  let mutated = false;
  for (const [key, value] of Object.entries(bag)) {
    if (value === REDACTED) {
      continue;
    }
    keys.push(key);
    if (redact) {
      bag[key] = REDACTED;
      mutated = true;
    }
  }
  return { keys, mutated };
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
      {
        guidance: `Fix ${label} in the source profile, then retry the export.`,
        cause: error,
      },
    );
  }
}

/**
 * Remove runtime internals from a staged tree. Retained for callers that
 * stage a tree by other means (e.g. tests, or a future non-tar carrier):
 * the export path itself now selects resources through the shared policy
 * instead of copying first and pruning here.
 *
 * Per spec §6.4, runtime internals are OAuth/tokens/sessions/history/caches/
 * credentials — "not in the matrix at all". `sessions/` and `projects/` carry
 * that runtime state and are stripped in BOTH modes. `plugins/` is NOT
 * runtime internals (§7.6 — delegated lifecycle managed resource) and stays.
 * Non-MCP fields of `.claude.json` (OAuth/account) are also stripped.
 */
export async function pruneRuntimeInternals(stagingProfile: string): Promise<void> {
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
  const autoMemory = await countEntries(path.join(claudeHome, 'memory', 'auto'), (e) => e.isFile());
  const skills = await countEntries(
    path.join(claudeHome, 'skills'),
    (e) =>
      // a Linked Skill is a symlink (§7.2) — count it alongside files and dirs.
      // The selection pipeline refuses symlinks before export, so a staged
      // symlink here can only come from a caller that bypassed the pipeline.
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

// Re-export so existing import sites (CLI, tests) keep a single module to use.
export { countStrippedKeys };
