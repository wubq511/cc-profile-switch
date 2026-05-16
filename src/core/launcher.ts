import fs from 'fs-extra';
import path from 'node:path';

import { loadAppConfig } from './app-config';
import { resolveInside } from '../platform/windows-path';
import { type ProfileLaunchConfig } from '../schemas/profile';
import { CcpsError } from '../utils/errors';
import {
  isLaunchBlocking,
  validateProfile,
  type ValidationFinding,
  type ValidationStatus,
} from './validator';

export type LaunchPlanOptions = {
  appHomePath: string;
  profileName: string;
  cwd?: string;
  command?: string;
};

export type LaunchPlan = {
  profileName: string;
  profileRootPath: string;
  claudeHomePath: string;
  cwd: string;
  command: string;
  args: string[];
  envChanges: {
    CLAUDE_CONFIG_DIR: string;
  };
  mcpMode: ProfileLaunchConfig['mcpMode'];
  pluginDirs: string[];
  validationStatus: ValidationStatus;
  warnings: ValidationFinding[];
  validationFindings: ValidationFinding[];
};

export async function buildLaunchPlan(options: LaunchPlanOptions): Promise<LaunchPlan> {
  await loadAppConfig(options.appHomePath);

  const validation = await validateProfile({
    appHomePath: options.appHomePath,
    name: options.profileName,
  });

  if (isLaunchBlocking(validation)) {
    throw new CcpsError(
      'PROFILE_VALIDATION_FAILED',
      'Profile validation failed; refusing to build launch plan.',
      {
        guidance: `Run ccps validate ${validation.profileName} and fix error findings before launching.`,
      },
    );
  }

  if (!validation.config) {
    throw new CcpsError(
      'PROFILE_CONFIG_UNAVAILABLE',
      'Profile config could not be loaded after validation.',
      {
        guidance: `Run ccps validate ${validation.profileName} and fix profile.json.`,
      },
    );
  }

  const cwd = await resolveLaunchCwd(options.cwd);
  const args = buildClaudeArgs(validation.config.launch, validation.paths.mcpConfigPath);
  const pluginDirs = validation.config.launch.pluginDirs.map((pluginDir) =>
    resolveInside(validation.profileRootPath, pluginDir),
  );
  const warnings = validation.findings.filter((finding) => finding.severity === 'warning');

  return {
    profileName: validation.profileName,
    profileRootPath: validation.profileRootPath,
    claudeHomePath: validation.claudeHomePath,
    cwd,
    command: options.command ?? 'claude',
    args,
    envChanges: {
      CLAUDE_CONFIG_DIR: validation.claudeHomePath,
    },
    mcpMode: validation.config.launch.mcpMode,
    pluginDirs,
    validationStatus: validation.status,
    warnings,
    validationFindings: validation.findings,
  };
}

export function formatLaunchDryRun(plan: LaunchPlan): string {
  const lines = [
    `Launch dry-run for profile "${plan.profileName}"`,
    `Profile path: ${plan.profileRootPath}`,
    `Claude home: ${plan.claudeHomePath}`,
    `Cwd: ${plan.cwd}`,
    `MCP mode: ${plan.mcpMode}`,
    'Plugin dirs:',
    ...formatList(plan.pluginDirs),
    `Command: ${plan.command}`,
    'Args:',
    ...formatList(plan.args),
    'Env changes:',
    `  CLAUDE_CONFIG_DIR=${plan.envChanges.CLAUDE_CONFIG_DIR}`,
    `Validation: ${plan.validationStatus}`,
    'Warnings:',
    ...formatWarnings(plan.warnings),
    'Project config: preserved because Claude starts in the launch cwd.',
    'Dry run: Claude Code was not started.',
    '',
  ];

  return lines.join('\n');
}

function buildClaudeArgs(launch: ProfileLaunchConfig, mcpConfigPath: string): string[] {
  const args = [...launch.claudeArgs];

  if (launch.mcpMode === 'merge' || launch.mcpMode === 'strict') {
    args.push('--mcp-config', mcpConfigPath);
  }

  if (launch.mcpMode === 'strict') {
    args.push('--strict-mcp-config');
  }

  return args;
}

async function resolveLaunchCwd(cwd?: string): Promise<string> {
  const resolvedCwd = path.win32.resolve(cwd ?? process.cwd());

  try {
    const stats = await fs.stat(resolvedCwd);
    if (!stats.isDirectory()) {
      throw invalidLaunchCwd(resolvedCwd, 'Launch cwd is not a directory.');
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw invalidLaunchCwd(resolvedCwd, 'Launch cwd does not exist.');
    }

    throw error;
  }

  return resolvedCwd;
}

function formatList(values: string[]): string[] {
  if (values.length === 0) {
    return ['  (none)'];
  }

  return values.map((value) => `  - ${value}`);
}

function formatWarnings(warnings: ValidationFinding[]): string[] {
  if (warnings.length === 0) {
    return ['  (none)'];
  }

  return warnings.map((warning) => {
    const pathSuffix = warning.path ? ` (${warning.path})` : '';
    return `  [${warning.severity}] ${warning.code}: ${warning.message}${pathSuffix}`;
  });
}

function invalidLaunchCwd(cwd: string, message: string): CcpsError {
  return new CcpsError('INVALID_LAUNCH_CWD', message, {
    guidance: `Choose an existing project directory for --cwd: ${cwd}`,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
