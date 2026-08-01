/**
 * Launch configuration resource service — inspect, preview, search, edit, diff
 * for `profile.json` launch configuration.
 *
 * Contract (spec §6.3, §6.5):
 * - Inspect/Preview/Search show launch config values (not secret-class).
 * - `name` field is edited only via lifecycle Rename (refused here).
 * - Security-sensitive fields (skipPermissions, claudeArgs) show consequence warnings
 *   before editing.
 * - Diff shows values with inline warnings on sensitive fields.
 */

import fs from 'fs-extra';

import { getProfileTemplatePaths } from './profile-template';
import {
  diffLaunchConfig,
  SENSITIVE_LAUNCH_FIELDS,
  type LaunchConfigDiffEntry,
} from './diff';
import { writeJsonFile, type Clock } from './app-config';
import { profileConfigSchema, type ProfileConfig } from '../schemas/profile';
import { CcpsError } from '../utils/errors';

// ─── Types ───────────────────────────────────────────────────────────────

export type LaunchConfigInspectResult = {
  /** Flattened launch config keys and their values. */
  entries: LaunchConfigEntry[];
  /** Whether profile.json is malformed or missing. */
  malformed: boolean;
};

export type LaunchConfigEntry = {
  key: string;
  value: unknown;
  /** True if this field requires a consequence warning before editing. */
  sensitive: boolean;
};

export type LaunchConfigPreviewResult = {
  /** Raw profile.json content (for preview display). */
  rawJson: string | null;
  malformed: boolean;
};

export type LaunchConfigSearchResult = {
  /** Matching key names. */
  matches: string[];
};

export type LaunchConfigEditResult = {
  key: string;
  /** Whether the edit was refused and why. */
  refused?: 'name' | 'sensitive';
  /** Whether a consequence warning should be shown before proceeding. */
  requiresWarning: boolean;
  /** The warning message if requiresWarning is true. */
  warningMessage?: string;
};

export type LaunchConfigValidateResult = {
  valid: boolean;
  finding?: {
    severity: 'error';
    code: string;
    message: string;
    path: string;
    suggestion: string;
  };
};

// ─── Consequence warnings ────────────────────────────────────────────────

const SENSITIVE_FIELD_WARNINGS: Record<string, string> = {
  skipPermissions:
    'Enabling skipPermissions passes --dangerously-skip-permissions to Claude Code, ' +
    'which disables all permission prompts. This gives Claude unrestricted access to ' +
    'your system. Only enable this if you understand the security implications.',
  claudeArgs:
    'Editing claudeArgs changes the arguments passed directly to Claude Code on launch. ' +
    'Incorrect arguments may cause Claude to fail or behave unexpectedly. ' +
    'Review the Claude Code CLI documentation before changing these.',
};

// ─── Read helpers ────────────────────────────────────────────────────────

async function readProfileConfig(
  profileConfigPath: string,
): Promise<{ ok: true; config: ProfileConfig } | { ok: false; malformed: boolean }> {
  try {
    const json = await fs.readJson(profileConfigPath);
    const parsed = profileConfigSchema.safeParse(json);
    if (parsed.success) {
      return { ok: true, config: parsed.data };
    }
    return { ok: false, malformed: true };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { ok: false, malformed: true };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, malformed: true };
    }
    throw error;
  }
}

/**
 * Launch configuration fields editable through this service (launch.* in profile.json).
 * Single source of truth for both the flattened inspect/search view and the edit allow-list.
 */
const EDITABLE_LAUNCH_KEYS = [
  'mcpMode',
  'pluginDirs',
  'disableAutoMemory',
  'skipPermissions',
  'claudeArgs',
] as const;

function flattenLaunchConfig(config: ProfileConfig): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const key of EDITABLE_LAUNCH_KEYS) {
    flat[key] = config.launch[key];
  }
  return flat;
}

// ─── Inspect ─────────────────────────────────────────────────────────────

export async function inspectLaunchConfig(
  appHomePath: string,
  profileName: string,
): Promise<LaunchConfigInspectResult> {
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  const result = await readProfileConfig(paths.profileConfigPath);

  if (!result.ok) {
    return { entries: [], malformed: true };
  }

  const flat = flattenLaunchConfig(result.config);
  const entries: LaunchConfigEntry[] = Object.keys(flat)
    .sort()
    .map((key) => ({
      key,
      value: flat[key],
      sensitive: SENSITIVE_LAUNCH_FIELDS.has(key),
    }));

  return { entries, malformed: false };
}

// ─── Preview ─────────────────────────────────────────────────────────────

export async function previewLaunchConfig(
  appHomePath: string,
  profileName: string,
): Promise<LaunchConfigPreviewResult> {
  const paths = getProfileTemplatePaths(appHomePath, profileName);

  try {
    const content = await fs.readFile(paths.profileConfigPath, 'utf8');
    // Validate that it's parseable.
    const parsed = profileConfigSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      return { rawJson: content, malformed: true };
    }
    return { rawJson: content, malformed: false };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { rawJson: null, malformed: true };
    }
    if (error instanceof SyntaxError) {
      return { rawJson: null, malformed: true };
    }
    throw error;
  }
}

// ─── Search ──────────────────────────────────────────────────────────────

export async function searchLaunchConfig(
  appHomePath: string,
  profileName: string,
  query: string,
): Promise<LaunchConfigSearchResult> {
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  const result = await readProfileConfig(paths.profileConfigPath);

  if (!result.ok) {
    return { matches: [] };
  }

  const flat = flattenLaunchConfig(result.config);
  const lowerQuery = query.toLowerCase();
  const matches = Object.keys(flat)
    .filter((k) => k.toLowerCase().includes(lowerQuery))
    .sort();

  return { matches };
}

// ─── Edit (restricted) ───────────────────────────────────────────────────

export type EditLaunchConfigOptions = {
  appHomePath: string;
  profileName: string;
  key: string;
  value: unknown;
  clock?: Clock;
  /** Required for security-sensitive fields (skipPermissions, claudeArgs):
   *  the caller must show the consequence warning and re-invoke with confirmed=true. */
  confirmed?: boolean;
};

export async function editLaunchConfigKey(
  options: EditLaunchConfigOptions,
): Promise<LaunchConfigEditResult> {
  // `name` is owned by lifecycle Rename.
  if (options.key === 'name') {
    return { key: options.key, refused: 'name', requiresWarning: false };
  }

  // Only launch.* fields are editable through this service.
  if (!(EDITABLE_LAUNCH_KEYS as readonly string[]).includes(options.key)) {
    throw new CcpsError(
      'LAUNCH_CONFIG_KEY_INVALID',
      `Key "${options.key}" is not an editable launch configuration field.`,
      { guidance: 'Editable launch fields: mcpMode, pluginDirs, disableAutoMemory, skipPermissions, claudeArgs.' },
    );
  }

  const isSensitive = SENSITIVE_LAUNCH_FIELDS.has(options.key);
  const warningMessage = isSensitive ? SENSITIVE_FIELD_WARNINGS[options.key] : undefined;

  // Security-sensitive fields require the consequence warning to be shown and
  // confirmed first — the edit is refused until the caller re-invokes with
  // confirmed=true (spec §6.3: "show consequence warnings before editing").
  if (isSensitive && options.confirmed !== true) {
    return { key: options.key, requiresWarning: true, warningMessage };
  }

  const paths = getProfileTemplatePaths(options.appHomePath, options.profileName);
  const result = await readProfileConfig(paths.profileConfigPath);

  if (!result.ok) {
    throw new CcpsError(
      'LAUNCH_CONFIG_MALFORMED',
      'Cannot edit: profile.json is malformed or missing.',
      { guidance: 'Fix profile.json syntax before editing.' },
    );
  }

  // Apply the edit to the launch config.
  const updatedConfig: ProfileConfig = {
    ...result.config,
    launch: {
      ...result.config.launch,
      [options.key]: options.value,
    },
    updatedAt: (options.clock ?? (() => new Date()))().toISOString(),
  };

  // Validate the result before saving.
  const validated = profileConfigSchema.safeParse(updatedConfig);
  if (!validated.success) {
    throw new CcpsError(
      'LAUNCH_CONFIG_INVALID',
      `Setting "${options.key}" to the provided value would make profile.json invalid.`,
      { guidance: 'Check the value matches the expected type for this field.', cause: validated.error },
    );
  }

  await writeJsonFile(paths.profileConfigPath, validated.data, { overwrite: true });

  return {
    key: options.key,
    requiresWarning: false,
    warningMessage: undefined,
  };
}

// ─── Diff ────────────────────────────────────────────────────────────────

export async function diffProfileLaunchConfig(
  appHomePath: string,
  profileNameA: string,
  profileNameB: string,
): Promise<LaunchConfigDiffEntry[]> {
  const pathsA = getProfileTemplatePaths(appHomePath, profileNameA);
  const pathsB = getProfileTemplatePaths(appHomePath, profileNameB);

  const [resultA, resultB] = await Promise.all([
    readProfileConfig(pathsA.profileConfigPath),
    readProfileConfig(pathsB.profileConfigPath),
  ]);

  const configA = resultA.ok ? flattenLaunchConfig(resultA.config) : {};
  const configB = resultB.ok ? flattenLaunchConfig(resultB.config) : {};

  return diffLaunchConfig(configA, configB);
}

// ─── Validate ────────────────────────────────────────────────────────────

export async function validateLaunchConfig(
  profileConfigPath: string,
): Promise<LaunchConfigValidateResult> {
  try {
    const json = await fs.readJson(profileConfigPath);
    const parsed = profileConfigSchema.safeParse(json);
    if (!parsed.success) {
      return {
        valid: false,
        finding: {
          severity: 'error',
          code: 'PROFILE_MANIFEST_INVALID',
          message: 'profile.json does not match the expected schema.',
          path: profileConfigPath,
          suggestion: 'Fix profile.json fields and launch settings.',
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
          code: 'REQUIRED_FILE_MISSING',
          message: 'Required profile.json is missing.',
          path: profileConfigPath,
          suggestion: 'Run ccps init or recreate the profile from a template.',
        },
      };
    }

    if (error instanceof SyntaxError) {
      return {
        valid: false,
        finding: {
          severity: 'error',
          code: 'JSON_INVALID',
          message: 'profile.json cannot be parsed.',
          path: profileConfigPath,
          suggestion: 'Fix the JSON syntax before launching with this profile.',
        },
      };
    }

    throw error;
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
