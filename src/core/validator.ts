import fs from 'fs-extra';

import { areSameFilesystemPath, resolveInside, validateProfileName } from '../platform/path';
import { profileConfigSchema, type ProfileConfig } from '../schemas/profile';
import { CcpsError } from '../utils/errors';
import {
  getProfileTemplatePaths,
  hasUnrepairableCcpsProfileRuleMarkers,
  type ProfileTemplatePaths,
} from './profile-template';
import { isLegacyMcpConfigured } from './mcp-servers';

export type ValidationSeverity = 'warning' | 'error';
export type ValidationStatus = 'valid' | 'warning' | 'error';

export type ValidationFinding = {
  severity: ValidationSeverity;
  code: string;
  message: string;
  path?: string;
  suggestion?: string;
};

export type ProfileValidationResult = {
  profileName: string;
  status: ValidationStatus;
  profileRootPath: string;
  claudeHomePath: string;
  paths: ProfileTemplatePaths;
  config?: ProfileConfig;
  findings: ValidationFinding[];
};

export type ValidateProfileOptions = {
  appHomePath: string;
  name: string;
};

const requiredFiles = [
  ['profile.json', 'profileConfigPath'],
  ['CLAUDE.md', 'claudeMdPath'],
  ['settings.json', 'settingsPath'],
  ['MEMORY.md', 'autoMemoryEntrypointPath'],
] as const;

const requiredDirectories = [
  ['claude-home', 'claudeHomePath'],
  ['memory', 'memoryPath'],
  ['memory/auto', 'autoMemoryPath'],
  ['skills', 'skillsPath'],
  ['agents', 'agentsPath'],
  ['plugins', 'pluginsPath'],
] as const;

const jsonFiles = [
  ['profile.json', 'profileConfigPath'],
  ['settings.json', 'settingsPath'],
  ['mcp.json', 'mcpConfigPath'],
] as const;

export async function validateProfile(
  options: ValidateProfileOptions,
): Promise<ProfileValidationResult> {
  const findings: ValidationFinding[] = [];
  let profileName = options.name;

  try {
    profileName = validateProfileName(options.name);
  } catch {
    findings.push({
      severity: 'error',
      code: 'INVALID_PROFILE_NAME',
      message: 'Profile name is not safe.',
      suggestion: 'Use letters, numbers, hyphen, or underscore without path separators.',
    });
  }

  const paths = getProfileTemplatePaths(options.appHomePath, profileName);

  for (const [label, key] of requiredDirectories) {
    await requirePath(paths[key], 'directory', label, findings);
  }

  for (const [label, key] of requiredFiles) {
    await requirePath(paths[key], 'file', label, findings);
  }

  await validateManagedProfileRule(paths.ccpsProfileRulePath, findings);

  const parsedJson = new Map<string, unknown>();
  for (const [, key] of jsonFiles) {
    const filePath = paths[key];
    if (!(await fs.pathExists(filePath))) {
      continue;
    }

    const parsed = await readJsonForValidation(filePath, findings);
    if (parsed.ok) {
      parsedJson.set(filePath, parsed.value);
    }
  }

  let config: ProfileConfig | undefined;
  const profileJson = parsedJson.get(paths.profileConfigPath);
  if (profileJson !== undefined) {
    const parsedProfile = profileConfigSchema.safeParse(profileJson);
    if (parsedProfile.success) {
      config = parsedProfile.data;
      validateLaunchPaths(paths.claudeHomePath, config, findings);
    } else {
      findings.push({
        severity: 'error',
        code: 'PROFILE_MANIFEST_INVALID',
        message: 'profile.json does not match the expected schema.',
        path: paths.profileConfigPath,
        suggestion: 'Fix profile.json fields and launch settings.',
      });
    }
  }

  const settingsJson = parsedJson.get(paths.settingsPath);
  if (settingsJson !== undefined) {
    validateProfileMemorySettings(paths, settingsJson, findings);
  }

  // Surface the legacy root `mcp.json` launch-flag path (spec §7.5, AC #6).
  // Non-blocking: the legacy `--mcp-config` flag still launches successfully;
  // the warning nudges toward the native user scope. Only fires when the legacy
  // flag is actually active (mcpMode !== 'none' AND configured servers present).
  if (config) {
    const legacyMcpJson = parsedJson.get(paths.mcpConfigPath);
    if (config.launch.mcpMode !== 'none' && isLegacyMcpConfigured(legacyMcpJson)) {
      findings.push({
        severity: 'warning',
        code: 'LEGACY_MCP_CONFIG_ACTIVE',
        message: 'This profile uses the legacy root mcp.json MCP configuration path.',
        path: paths.mcpConfigPath,
        suggestion:
          'Migrate servers to the native user scope with `claude mcp add --scope user` (CLAUDE_CONFIG_DIR set to this profile) and set launch.mcpMode to none.',
      });
    }
  }

  return {
    profileName,
    status: statusFromFindings(findings),
    profileRootPath: paths.profileRootPath,
    claudeHomePath: paths.claudeHomePath,
    paths,
    config,
    findings,
  };
}

async function validateManagedProfileRule(
  rulePath: string,
  findings: ValidationFinding[],
): Promise<void> {
  try {
    const stats = await fs.stat(rulePath);
    if (!stats.isFile()) {
      findings.push({
        severity: 'error',
        code: 'CCPS_PROFILE_RULE_INVALID',
        message: 'The ccps-managed profile boundary path is not a file.',
        path: rulePath,
        suggestion: 'Replace this path with a file, then run ccps init.',
      });
      return;
    }

    const content = await fs.readFile(rulePath, 'utf8');
    if (hasUnrepairableCcpsProfileRuleMarkers(content)) {
      findings.push({
        severity: 'error',
        code: 'CCPS_PROFILE_RULE_CORRUPT',
        message: 'The ccps-managed profile boundary markers are malformed.',
        path: rulePath,
        suggestion: 'Repair or remove the malformed managed markers, then run ccps init.',
      });
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      findings.push({
        severity: 'warning',
        code: 'CCPS_PROFILE_RULE_MISSING',
        message: 'The ccps-managed profile boundary rule is missing.',
        path: rulePath,
        suggestion: 'Run ccps init to restore the rule; real launch also repairs it.',
      });
      return;
    }

    throw error;
  }
}

function validateProfileMemorySettings(
  paths: ProfileTemplatePaths,
  settingsJson: unknown,
  findings: ValidationFinding[],
): void {
  if (!isRecord(settingsJson)) {
    return;
  }

  const configuredPath = settingsJson.autoMemoryDirectory;
  const expectedPath = paths.autoMemoryPath;

  if (typeof configuredPath !== 'string' || !areSameFilesystemPath(configuredPath, expectedPath)) {
    findings.push({
      severity: 'error',
      code: 'PROFILE_MEMORY_DIRECTORY_MISMATCH',
      message: 'Profile settings must point Claude Code auto memory to this profile.',
      path: paths.settingsPath,
      suggestion: `Set autoMemoryDirectory to ${expectedPath}.`,
    });
  }
}

export function isLaunchBlocking(result: ProfileValidationResult): boolean {
  return result.findings.some((finding) => finding.severity === 'error');
}

function statusFromFindings(findings: ValidationFinding[]): ValidationStatus {
  if (findings.some((finding) => finding.severity === 'error')) {
    return 'error';
  }

  if (findings.some((finding) => finding.severity === 'warning')) {
    return 'warning';
  }

  return 'valid';
}

async function requirePath(
  targetPath: string,
  expectedType: 'file' | 'directory',
  label: string,
  findings: ValidationFinding[],
): Promise<void> {
  let stats: fs.Stats;

  try {
    stats = await fs.stat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      findings.push({
        severity: 'error',
        code: expectedType === 'file' ? 'REQUIRED_FILE_MISSING' : 'REQUIRED_DIRECTORY_MISSING',
        message: `Required ${expectedType} is missing: ${label}.`,
        path: targetPath,
        suggestion: 'Run ccps init or recreate the profile from a template.',
      });
      return;
    }

    throw error;
  }

  if (
    (expectedType === 'file' && !stats.isFile()) ||
    (expectedType === 'directory' && !stats.isDirectory())
  ) {
    findings.push({
      severity: 'error',
      code: expectedType === 'file' ? 'REQUIRED_FILE_INVALID' : 'REQUIRED_DIRECTORY_INVALID',
      message: `Required ${expectedType} has the wrong filesystem type: ${label}.`,
      path: targetPath,
      suggestion: `Replace it with a ${expectedType}.`,
    });
  }
}

async function readJsonForValidation(
  filePath: string,
  findings: ValidationFinding[],
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await fs.readJson(filePath) };
  } catch {
    findings.push({
      severity: 'error',
      code: 'JSON_INVALID',
      message: 'JSON file cannot be parsed.',
      path: filePath,
      suggestion: 'Fix the JSON syntax before launching with this profile.',
    });
    return { ok: false };
  }
}

function validateLaunchPaths(
  claudeHomePath: string,
  config: ProfileConfig,
  findings: ValidationFinding[],
): void {
  for (const pluginDir of config.launch.pluginDirs) {
    try {
      resolveInside(claudeHomePath, pluginDir);
    } catch (error) {
      if (error instanceof CcpsError && error.code === 'PATH_OUTSIDE_BASE') {
        findings.push({
          severity: 'error',
          code: 'PROFILE_PATH_TRAVERSAL',
          message: 'Profile launch plugin directory escapes the profile Claude home.',
          path: pluginDir,
          suggestion: 'Use a relative plugin directory inside the profile claude-home.',
        });
        continue;
      }

      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
