import fs from 'fs-extra';
import path from 'node:path';

import { resolveInside, validateProfileName } from '../platform/windows-path';
import { profileConfigSchema, type ProfileConfig } from '../schemas/profile';
import { CcpsError } from '../utils/errors';
import { getProfileTemplatePaths, type ProfileTemplatePaths } from './profile-template';

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
  ['mcp.json', 'mcpConfigPath'],
] as const;

const requiredDirectories = [
  ['claude-home', 'claudeHomePath'],
  ['skills', 'skillsPath'],
  ['agents', 'agentsPath'],
  ['plugins', 'pluginsPath'],
] as const;

const jsonFiles = [
  ['profile.json', 'profileConfigPath'],
  ['settings.json', 'settingsPath'],
  ['mcp.json', 'mcpConfigPath'],
] as const;

const highRiskSensitiveNames = ['.claude.json', 'token', 'secret', 'credential', 'credentials', 'session', 'oauth'];
const mediumRiskSensitiveNames = ['history', 'cache', 'log', 'transcript'];

export async function validateProfile(options: ValidateProfileOptions): Promise<ProfileValidationResult> {
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
      validateLaunchPaths(paths.profileRootPath, config, findings);
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

  await scanSensitiveNames(paths.profileRootPath, findings);

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

  if ((expectedType === 'file' && !stats.isFile()) || (expectedType === 'directory' && !stats.isDirectory())) {
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

function validateLaunchPaths(profileRootPath: string, config: ProfileConfig, findings: ValidationFinding[]): void {
  for (const pluginDir of config.launch.pluginDirs) {
    try {
      resolveInside(profileRootPath, pluginDir);
    } catch (error) {
      if (error instanceof CcpsError && error.code === 'PATH_OUTSIDE_BASE') {
        findings.push({
          severity: 'error',
          code: 'PROFILE_PATH_TRAVERSAL',
          message: 'Profile launch plugin directory escapes the profile root.',
          path: pluginDir,
          suggestion: 'Use a relative plugin directory inside the profile.',
        });
        continue;
      }

      throw error;
    }
  }
}

async function scanSensitiveNames(rootPath: string, findings: ValidationFinding[]): Promise<void> {
  if (!(await fs.pathExists(rootPath))) {
    return;
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.win32.join(rootPath, entry.name);
    const lowerName = entry.name.toLowerCase();

    if (matchesSensitiveName(lowerName, highRiskSensitiveNames)) {
      findings.push({
        severity: 'error',
        code: 'SENSITIVE_FILENAME_HIGH',
        message: 'High-risk sensitive filename found in the profile.',
        path: entryPath,
        suggestion: 'Remove credentials, tokens, OAuth data, sessions, and real Claude state from ccps profiles.',
      });
    } else if (matchesSensitiveName(lowerName, mediumRiskSensitiveNames)) {
      findings.push({
        severity: 'warning',
        code: 'SENSITIVE_FILENAME_MEDIUM',
        message: 'Medium-risk sensitive filename found in the profile.',
        path: entryPath,
        suggestion: 'Review whether history, cache, logs, or transcripts should be kept in this profile.',
      });
    }

    if (entry.isDirectory()) {
      await scanSensitiveNames(entryPath, findings);
    }
  }
}

function matchesSensitiveName(name: string, keywords: string[]): boolean {
  return keywords.some((keyword) => name.includes(keyword));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
