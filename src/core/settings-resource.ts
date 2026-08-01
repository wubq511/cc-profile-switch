/**
 * Settings resource service — inspect, preview, search, edit, diff, and validate
 * for `claude-home/settings.json`.
 *
 * Contract (spec §6.3, §6.5):
 * - Inspect/Preview/Search/Diff render credential-class values as key names only.
 * - `mcpServers` edits are refused outright (MCP contract).
 * - ccps-managed fields (autoMemoryDirectory, claudeMdExcludes, env.CLAUDE_CODE_ATTRIBUTION_HEADER)
 *   are read-only in the editor.
 * - Plain-key edits save atomically.
 * - Key-level removal produces a fragment Bin item; the whole resource is never removable.
 * - Create backfills managed fields without touching unrelated keys.
 * - Malformed settings.json surfaces as a Validate launch blocker.
 */

import fs from 'fs-extra';

import { getProfileTemplatePaths, getRealClaudeMdExcludePaths } from './profile-template';
import { diffSettings, flattenToKeyPaths, type SettingsDiffEntry } from './diff';
import { createFragmentItem, type RecoveryBinItem } from './recovery-bin';
import { writeJsonFile, type Clock } from './app-config';import { CcpsError } from '../utils/errors';

// ─── Managed field definitions ───────────────────────────────────────────

/** Top-level keys that ccps manages and are read-only in the Workbench editor. */
export const CCPS_MANAGED_SETTINGS_KEYS = new Set([
  'autoMemoryDirectory',
  'claudeMdExcludes',
]);

/** Dot-path keys that ccps manages (nested under env). */
export const CCPS_MANAGED_SETTINGS_KEY_PATHS = new Set([
  'autoMemoryDirectory',
  'claudeMdExcludes',
  'env.CLAUDE_CODE_ATTRIBUTION_HEADER',
]);

/** Key that is refused outright — MCP contract says use `claude mcp add --scope user`. */
export const REFUSED_SETTINGS_KEY = 'mcpServers';

/** Prefix for credential-class env keys (values are never rendered). */
const CREDENTIAL_ENV_PREFIX = 'ANTHROPIC_';

// ─── Types ───────────────────────────────────────────────────────────────

export type SettingsInspectResult = {
  /** Flattened key paths present in settings.json. */
  keys: string[];
  /** Which keys are ccps-managed (read-only). */
  managedKeys: string[];
  /** Whether mcpServers key is present (refused for editing). */
  hasMcpServers: boolean;
  /** Whether the file is malformed (parse failure). */
  malformed: boolean;
};

export type SettingsPreviewResult = {
  /** Key-value pairs with credential values redacted to key names only. */
  entries: SettingsPreviewEntry[];
  /** Whether any credential-class keys were found. */
  hasSecrets: boolean;
  malformed: boolean;
};

export type SettingsPreviewEntry = {
  keyPath: string;
  /** The value, or '<redacted>' for credential-class keys. */
  displayValue: string;
  isManaged: boolean;
  isSecret: boolean;
};

export type SettingsSearchResult = {
  /** Matching key paths (values never included). */
  matches: string[];
};

export type SettingsEditResult = {
  /** The key path that was edited. */
  keyPath: string;
  /** Whether the edit was refused and why. */
  refused?: 'mcpServers' | 'managed' | 'name';
};

export type SettingsKeyRemovalResult = {
  keyPath: string;
  binItem: RecoveryBinItem;
};

export type SettingsBackfillResult = {
  /** Keys that were backfilled. */
  backfilledKeys: string[];
  /** Whether the file was created (didn't exist). */
  created: boolean;
};

export type SettingsValidateResult = {
  valid: boolean;
  finding?: {
    severity: 'error';
    code: string;
    message: string;
    path: string;
    suggestion: string;
  };
};

// ─── Read helpers ────────────────────────────────────────────────────────

async function readSettingsJson(settingsPath: string): Promise<{
  ok: true;
  value: Record<string, unknown>;
} | {
  ok: false;
  malformed: boolean;
}> {
  try {
    const json = await fs.readJson(settingsPath);
    if (!isRecord(json)) {
      return { ok: false, malformed: true };
    }
    return { ok: true, value: json };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { ok: false, malformed: false };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, malformed: true };
    }
    throw error;
  }
}

// ─── Inspect ─────────────────────────────────────────────────────────────

export async function inspectSettings(
  appHomePath: string,
  profileName: string,
): Promise<SettingsInspectResult> {
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  const result = await readSettingsJson(paths.settingsPath);

  if (!result.ok) {
    return { keys: [], managedKeys: [], hasMcpServers: false, malformed: result.malformed };
  }

  const flat = flattenToKeyPaths(result.value);
  const keys = Object.keys(flat).sort();
  const managedKeys = keys.filter((k) => CCPS_MANAGED_SETTINGS_KEY_PATHS.has(k));
  const hasMcpServers = REFUSED_SETTINGS_KEY in result.value;

  return { keys, managedKeys, hasMcpServers, malformed: false };
}

// ─── Preview (redacted) ──────────────────────────────────────────────────

export function redactValue(keyPath: string, value: unknown): string {
  // Credential-class env keys: show key name only, never the value.
  if (isCredentialKeyPath(keyPath)) {
    return '<redacted>';
  }
  // Non-credential values: render as JSON string for display.
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function isCredentialKeyPath(keyPath: string): boolean {
  // env.ANTHROPIC_* keys are credential-class.
  if (keyPath.startsWith('env.')) {
    const envKey = keyPath.slice(4); // strip 'env.'
    if (envKey.startsWith(CREDENTIAL_ENV_PREFIX)) {
      return true;
    }
  }
  return false;
}

export async function previewSettings(
  appHomePath: string,
  profileName: string,
): Promise<SettingsPreviewResult> {
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  const result = await readSettingsJson(paths.settingsPath);

  if (!result.ok) {
    return { entries: [], hasSecrets: false, malformed: result.malformed };
  }

  const flat = flattenToKeyPaths(result.value);
  const entries: SettingsPreviewEntry[] = [];
  let hasSecrets = false;

  for (const keyPath of Object.keys(flat).sort()) {
    const isSecret = isCredentialKeyPath(keyPath);
    if (isSecret) hasSecrets = true;

    entries.push({
      keyPath,
      displayValue: redactValue(keyPath, flat[keyPath]),
      isManaged: CCPS_MANAGED_SETTINGS_KEY_PATHS.has(keyPath),
      isSecret,
    });
  }

  return { entries, hasSecrets, malformed: false };
}

// ─── Search (key names only, never values) ───────────────────────────────

export async function searchSettings(
  appHomePath: string,
  profileName: string,
  query: string,
): Promise<SettingsSearchResult> {
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  const result = await readSettingsJson(paths.settingsPath);

  if (!result.ok) {
    return { matches: [] };
  }

  const flat = flattenToKeyPaths(result.value);
  const lowerQuery = query.toLowerCase();
  const matches = Object.keys(flat)
    .filter((k) => k.toLowerCase().includes(lowerQuery))
    .sort();

  return { matches };
}

// ─── Edit (restricted) ───────────────────────────────────────────────────

export type EditSettingsOptions = {
  appHomePath: string;
  profileName: string;
  keyPath: string;
  value: unknown;
  clock?: Clock;
};

export async function editSettingsKey(options: EditSettingsOptions): Promise<SettingsEditResult> {
  // Refuse mcpServers outright.
  if (options.keyPath === REFUSED_SETTINGS_KEY || options.keyPath.startsWith(`${REFUSED_SETTINGS_KEY}.`)) {
    return { keyPath: options.keyPath, refused: 'mcpServers' };
  }

  // Refuse ccps-managed fields.
  if (CCPS_MANAGED_SETTINGS_KEY_PATHS.has(options.keyPath)) {
    return { keyPath: options.keyPath, refused: 'managed' };
  }

  const paths = getProfileTemplatePaths(options.appHomePath, options.profileName);
  const result = await readSettingsJson(paths.settingsPath);

  if (!result.ok) {
    throw new CcpsError(
      'SETTINGS_MALFORMED',
      'Cannot edit: settings.json is malformed or missing.',
      { guidance: 'Fix settings.json syntax before editing.' },
    );
  }

  // Apply the edit atomically.
  const updated = setNestedValue(result.value, options.keyPath, options.value);
  await writeJsonFile(paths.settingsPath, updated, { overwrite: true });

  return { keyPath: options.keyPath };
}

// ─── Key-level removal → fragment Bin item ───────────────────────────────

export type RemoveSettingsKeyOptions = {
  appHomePath: string;
  profileName: string;
  keyPath: string;
  clock?: Clock;
};

export async function removeSettingsKey(
  options: RemoveSettingsKeyOptions,
): Promise<SettingsKeyRemovalResult> {
  // Refuse removal of mcpServers (use MCP delegation).
  if (options.keyPath === REFUSED_SETTINGS_KEY || options.keyPath.startsWith(`${REFUSED_SETTINGS_KEY}.`)) {
    throw new CcpsError(
      'SETTINGS_MCPSERVERS_REFUSED',
      'mcpServers key cannot be removed through Settings. Use MCP delegation instead.',
      { guidance: 'Use `claude mcp remove --scope user <name>` to remove MCP servers.' },
    );
  }

  // Refuse removal of managed fields.
  if (CCPS_MANAGED_SETTINGS_KEY_PATHS.has(options.keyPath)) {
    throw new CcpsError(
      'SETTINGS_MANAGED_FIELD_READONLY',
      'ccps-managed settings fields cannot be removed.',
      { guidance: 'This field is managed by ccps and is read-only.' },
    );
  }

  const paths = getProfileTemplatePaths(options.appHomePath, options.profileName);
  const result = await readSettingsJson(paths.settingsPath);

  if (!result.ok) {
    throw new CcpsError(
      'SETTINGS_MALFORMED',
      'Cannot remove key: settings.json is malformed or missing.',
      { guidance: 'Fix settings.json syntax before removing keys.' },
    );
  }

  const currentValue = getNestedValue(result.value, options.keyPath);
  if (currentValue === undefined) {
    throw new CcpsError(
      'SETTINGS_KEY_NOT_FOUND',
      'The key path does not exist in settings.json.',
      { guidance: `Key "${options.keyPath}" was not found.` },
    );
  }

  // Create a fragment Bin item before removing.
  const relativeFilePath = 'claude-home/settings.json';
  const binItem = await createFragmentItem({
    appHomePath: options.appHomePath,
    origin: 'remove',
    kind: 'settings-field',
    profile: options.profileName,
    coordinates: {
      file: relativeFilePath,
      keyPath: options.keyPath,
      value: currentValue,
    },
    secretBearing: isCredentialKeyPath(options.keyPath),
    clock: options.clock,
  });

  // Remove the key from settings.json and save atomically.
  const updated = deleteNestedValue(result.value, options.keyPath);
  await writeJsonFile(paths.settingsPath, updated, { overwrite: true });

  return { keyPath: options.keyPath, binItem };
}

// ─── Create / Backfill ───────────────────────────────────────────────────

export type BackfillSettingsOptions = {
  appHomePath: string;
  profileName: string;
  clock?: Clock;
};

export async function backfillSettings(
  options: BackfillSettingsOptions,
): Promise<SettingsBackfillResult> {
  const paths = getProfileTemplatePaths(options.appHomePath, options.profileName);
  const backfilledKeys: string[] = [];
  let created = false;

  let settings: Record<string, unknown>;
  const result = await readSettingsJson(paths.settingsPath);

  if (!result.ok) {
    if (result.malformed) {
      // Malformed file — refuse to backfill to avoid data loss.
      throw new CcpsError(
        'SETTINGS_MALFORMED',
        'Cannot backfill: settings.json is malformed.',
        { guidance: 'Fix settings.json syntax, then run ccps init or ccps validate.' },
      );
    }
    // File doesn't exist — create with managed fields.
    settings = {};
    created = true;
  } else {
    settings = result.value;
  }

  // Backfill autoMemoryDirectory.
  if (!Object.hasOwn(settings, 'autoMemoryDirectory')) {
    settings.autoMemoryDirectory = paths.autoMemoryPath;
    backfilledKeys.push('autoMemoryDirectory');
  }

  // Backfill claudeMdExcludes.
  if (!Object.hasOwn(settings, 'claudeMdExcludes')) {
    settings.claudeMdExcludes = getRealClaudeMdExcludePaths();
    backfilledKeys.push('claudeMdExcludes');
  }

  // Backfill env.CLAUDE_CODE_ATTRIBUTION_HEADER.
  const env = (settings.env ?? {}) as Record<string, unknown>;
  if (!isRecord(settings.env)) {
    settings.env = {};
  }
  if (!Object.hasOwn(env, 'CLAUDE_CODE_ATTRIBUTION_HEADER')) {
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    settings.env = env;
    backfilledKeys.push('env.CLAUDE_CODE_ATTRIBUTION_HEADER');
  }

  if (backfilledKeys.length > 0 || created) {
    await writeJsonFile(paths.settingsPath, settings, { overwrite: !created });
  }

  return { backfilledKeys, created };
}

// ─── Diff ────────────────────────────────────────────────────────────────

export async function diffProfileSettings(
  appHomePath: string,
  profileNameA: string,
  profileNameB: string,
): Promise<SettingsDiffEntry[]> {
  const pathsA = getProfileTemplatePaths(appHomePath, profileNameA);
  const pathsB = getProfileTemplatePaths(appHomePath, profileNameB);

  const [resultA, resultB] = await Promise.all([
    readSettingsJson(pathsA.settingsPath),
    readSettingsJson(pathsB.settingsPath),
  ]);

  const settingsA = resultA.ok ? resultA.value : {};
  const settingsB = resultB.ok ? resultB.value : {};

  return diffSettings(settingsA, settingsB);
}

// ─── Validate ────────────────────────────────────────────────────────────

export async function validateSettings(
  settingsPath: string,
): Promise<SettingsValidateResult> {
  try {
    const json = await fs.readJson(settingsPath);
    if (!isRecord(json)) {
      return {
        valid: false,
        finding: {
          severity: 'error',
          code: 'SETTINGS_INVALID',
          message: 'settings.json is not a valid JSON object.',
          path: settingsPath,
          suggestion: 'Replace settings.json with a valid JSON object.',
        },
      };
    }
    return { valid: true };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        valid: false,
        finding: {
          severity: 'error',
          code: 'SETTINGS_MISSING',
          message: 'Required settings.json is missing.',
          path: settingsPath,
          suggestion: 'Run ccps init or recreate the profile from a template.',
        },
      };
    }

    if (error instanceof SyntaxError) {
      return {
        valid: false,
        finding: {
          severity: 'error',
          code: 'SETTINGS_MALFORMED',
          message: 'settings.json cannot be parsed.',
          path: settingsPath,
          suggestion: 'Fix the JSON syntax before launching with this profile.',
        },
      };
    }

    throw error;
  }
}

// ─── Nested value helpers ────────────────────────────────────────────────

function getNestedValue(obj: unknown, keyPath: string): unknown {
  const keys = keyPath.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): Record<string, unknown> {
  const result = { ...obj };
  const keys = keyPath.split('.');
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = current[keys[i]];
    if (next === null || next === undefined || typeof next !== 'object') {
      current[keys[i]] = {};
    } else {
      current[keys[i]] = { ...(next as Record<string, unknown>) };
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return result;
}

function deleteNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
): Record<string, unknown> {
  const result = { ...obj };
  const keys = keyPath.split('.');
  let current: unknown = result;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return result;
    }
    const key = keys[i];
    const next = (current as Record<string, unknown>)[key];
    if (typeof next === 'object' && next !== null) {
      (current as Record<string, unknown>)[key] = { ...(next as Record<string, unknown>) };
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (current !== null && current !== undefined && typeof current === 'object') {
    delete (current as Record<string, unknown>)[keys[keys.length - 1]];
  }
  return result;
}

// ─── Utility ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
