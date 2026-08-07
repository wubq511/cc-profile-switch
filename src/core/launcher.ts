import fs from 'fs-extra';

import { loadAppConfig, saveAppConfig, type Clock } from './app-config';
import { recordRecentProjectDir } from './app-state';
import { resolveApiSettings, type ApiSettingsSource } from './api-settings';
import { extractAnthropicApiEnv, getClaudeSettingsPath } from './claude-settings';
import { resolveLaunchProfile } from './profile-management';
import {
  ensureCcpsProfileRule,
  ensureProfileClaudeMdExcludes,
  getRealClaudeMdExcludePaths,
} from './profile-template';
import { spawnProcess as defaultSpawnProcess, type SpawnProcess } from '../platform/process';
import { resolveFilesystemPath, resolveInside } from '../platform/path';
import { type ProfileLaunchConfig } from '../schemas/profile';
import { CcpsError } from '../utils/errors';
import { isNodeError, isRecord } from '../utils/type-guards';
import {
  isLaunchBlocking,
  validateProfile,
  type ValidationFinding,
  type ValidationStatus,
} from './validator';

export type LaunchPlanOptions = {
  appHomePath: string;
  profileName?: string;
  cwd?: string;
  command?: string;
};

export type LaunchProfileOptions = LaunchPlanOptions & {
  spawnProcess?: SpawnProcess;
  clock?: Clock;
};

export type LaunchProfileResult = {
  plan: LaunchPlan;
  exitCode: number | null;
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
  memoryConfig: {
    userMemoryPath: string;
    autoMemoryDirectory: string;
    autoMemoryEntrypointPath: string;
  };
  apiConfig: {
    common: ApiSettingsSource;
    profile: ApiSettingsSource;
    keys: string[];
  };
  apiEnv: Record<string, string>;
  realClaudeEnv: Record<string, string>;
  mcpMode: ProfileLaunchConfig['mcpMode'];
  userMcpConfigPath: string;
  legacyMcpConfigPath: string;
  legacyMcpConfigActive: boolean;
  pluginDirs: string[];
  claudeMdExcludes: string[];
  validationStatus: ValidationStatus;
  warnings: ValidationFinding[];
  validationFindings: ValidationFinding[];
};

export async function buildLaunchPlan(options: LaunchPlanOptions): Promise<LaunchPlan> {
  await loadAppConfig(options.appHomePath);
  const profileName = await resolveLaunchProfile({
    appHomePath: options.appHomePath,
    requestedProfile: options.profileName,
  });

  const validation = await validateProfile({
    appHomePath: options.appHomePath,
    name: profileName,
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

  const pluginDirs = validation.config.launch.pluginDirs.map((pluginDir) =>
    resolveInside(validation.claudeHomePath, pluginDir),
  );
  const cwd = await resolveLaunchCwd(options.cwd);
  const legacyMcpConfigActive =
    validation.config.launch.mcpMode !== 'none' &&
    (await hasConfiguredLegacyMcpServers(validation.paths.mcpConfigPath));
  const args = buildClaudeArgs(
    validation.config.launch,
    legacyMcpConfigActive ? validation.paths.mcpConfigPath : undefined,
    pluginDirs,
  );
  const apiSettings = await resolveApiSettings({
    appHomePath: options.appHomePath,
    profileName: validation.profileName,
  });
  const realClaudeEnv = await loadRealClaudeSettingsEnv();
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
    memoryConfig: {
      userMemoryPath: validation.paths.claudeMdPath,
      autoMemoryDirectory: validation.paths.autoMemoryPath,
      autoMemoryEntrypointPath: validation.paths.autoMemoryEntrypointPath,
    },
    apiConfig: {
      common: apiSettings.common,
      profile: apiSettings.profile,
      keys: apiSettings.keys,
    },
    apiEnv: apiSettings.env,
    realClaudeEnv,
    mcpMode: validation.config.launch.mcpMode,
    userMcpConfigPath: validation.paths.claudeUserConfigPath,
    legacyMcpConfigPath: validation.paths.mcpConfigPath,
    legacyMcpConfigActive,
    pluginDirs,
    claudeMdExcludes: getRealClaudeMdExcludePaths(),
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
    `MCP mode: native user scope (${plan.userMcpConfigPath})`,
    `Legacy MCP mode: ${plan.mcpMode}`,
    `Legacy MCP config: ${plan.legacyMcpConfigActive ? `active (${plan.legacyMcpConfigPath})` : 'inactive'}`,
    'Plugin dirs:',
    ...formatList(plan.pluginDirs),
    'CLAUDE.md excludes:',
    ...formatList(plan.claudeMdExcludes),
    `Command: ${plan.command}`,
    'Args:',
    ...formatList(plan.args),
    'Env changes:',
    `  CLAUDE_CONFIG_DIR=${plan.envChanges.CLAUDE_CONFIG_DIR}`,
    'Memory:',
    `  user: ${plan.memoryConfig.userMemoryPath}`,
    `  auto: ${plan.memoryConfig.autoMemoryDirectory}`,
    `  auto entrypoint: ${plan.memoryConfig.autoMemoryEntrypointPath}`,
    'API config:',
    `  common: ${formatApiSource(plan.apiConfig.common)}`,
    `  profile: ${formatApiSource(plan.apiConfig.profile)}`,
    '  env keys:',
    ...formatList(plan.apiConfig.keys),
    'Real Claude settings env:',
    ...formatList(sortedKeys(plan.realClaudeEnv)),
    `Validation: ${plan.validationStatus}`,
    'Warnings:',
    ...formatWarnings(plan.warnings),
    'Project config: preserved because Claude starts in the launch cwd.',
    'Dry run: Claude Code was not started.',
    '',
  ];

  return lines.join('\n');
}

export async function launchProfile(options: LaunchProfileOptions): Promise<LaunchProfileResult> {
  const plan = await buildLaunchPlan(options);
  const runProcess = options.spawnProcess ?? defaultSpawnProcess;

  // Ensure claudeMdExcludes is present before spawning Claude Code.
  // This is done here (not in buildLaunchPlan) so dry-run remains side-effect-free.
  await ensureProfileClaudeMdExcludes(resolveInside(plan.claudeHomePath, 'settings.json'));
  await ensureCcpsProfileRule(resolveInside(plan.claudeHomePath, 'rules', 'ccps-profile.md'));

  let result: { exitCode: number | null };
  try {
    // On macOS, wrap with `script` to allocate a PTY so Claude Code stays in interactive mode.
    // Without this, Claude Code detects non-TTY stdout and auto-enters --print mode.
    const isMac = process.platform === 'darwin';
    const spawnCommand = isMac ? 'script' : plan.command;
    const spawnArgs = isMac ? ['-q', '/dev/null', plan.command, ...plan.args] : plan.args;

    result = await runProcess(spawnCommand, spawnArgs, {
      cwd: plan.cwd,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        ...plan.apiEnv,
        ...plan.realClaudeEnv,
        ...plan.envChanges,
      },
    });
  } catch (error) {
    throw new CcpsError('CLAUDE_LAUNCH_FAILED', 'Failed to start Claude Code.', {
      guidance: 'Confirm Claude Code is installed and available on PATH, then retry the launch.',
      cause: error,
    });
  }

  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new CcpsError('CLAUDE_EXITED_WITH_ERROR', 'Claude Code exited with a non-zero status.', {
      guidance: `Claude Code exited with status ${result.exitCode}. Review the Claude Code output above.`,
    });
  }

  // Recents and last-used profile record a successful real launch only
  // (exit 0, spec §13.3): non-zero exits throw above, and signal exits (null)
  // record nothing — mirroring the Workbench launch path.
  if (result.exitCode === 0) {
    const config = await loadAppConfig(options.appHomePath);
    await saveAppConfig(
      options.appHomePath,
      {
        ...config,
        lastUsedProfile: plan.profileName,
      },
      { clock: options.clock },
    );

    await recordRecentProjectDir(options.appHomePath, plan.cwd, { clock: options.clock });
  }

  return { plan, exitCode: result.exitCode };
}

function buildClaudeArgs(
  launch: ProfileLaunchConfig,
  legacyMcpConfigPath: string | undefined,
  pluginDirs: string[],
): string[] {
  const args: string[] = [];

  if (launch.skipPermissions && !launch.claudeArgs.includes('--dangerously-skip-permissions')) {
    args.push('--dangerously-skip-permissions');
  }

  args.push(...launch.claudeArgs);

  if (legacyMcpConfigPath) {
    args.push('--mcp-config', legacyMcpConfigPath);
  }

  if (legacyMcpConfigPath && launch.mcpMode === 'strict') {
    args.push('--strict-mcp-config');
  }

  for (const pluginDir of pluginDirs) {
    args.push('--plugin-dir', pluginDir);
  }

  return args;
}

async function hasConfiguredLegacyMcpServers(filePath: string): Promise<boolean> {
  if (!(await fs.pathExists(filePath))) {
    return false;
  }

  const config = await fs.readJson(filePath);
  if (!isRecord(config) || !isRecord(config.mcpServers)) {
    return false;
  }

  return Object.keys(config.mcpServers).length > 0;
}

async function resolveLaunchCwd(cwd?: string): Promise<string> {
  const resolvedCwd = resolveFilesystemPath(cwd ?? process.cwd());

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

function formatApiSource(source: ApiSettingsSource): string {
  const status = source.present ? 'present' : 'missing';
  const keySummary = source.keys.length === 0 ? 'no env keys' : `${source.keys.length} env key(s)`;

  return `${status} (${keySummary})`;
}

function invalidLaunchCwd(cwd: string, message: string): CcpsError {
  return new CcpsError('INVALID_LAUNCH_CWD', message, {
    guidance: `Choose an existing project directory for --cwd: ${cwd}`,
  });
}

function sortedKeys(value: Record<string, string>): string[] {
  return Object.keys(value).sort((a, b) => a.localeCompare(b));
}

async function loadRealClaudeSettingsEnv(): Promise<Record<string, string>> {
  const settingsPath = getClaudeSettingsPath();

  try {
    const settings = await fs.readJson(settingsPath);
    return extractAnthropicApiEnv(settings);
  } catch {
    return {};
  }
}
