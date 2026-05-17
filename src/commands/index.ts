import { Command } from 'commander';
import fs from 'fs-extra';

import { getAppHomePaths, loadAppConfig } from '../core/app-config';
import { buildLaunchPlan, formatLaunchDryRun, launchProfile } from '../core/launcher';
import { backupProfile, createProfile, initProfiles, type Clock } from '../core/profile';
import { getProfileTemplatePaths } from '../core/profile-template';
import { validateProfile, type ValidationFinding } from '../core/validator';
import { openWithDefaultEditor, type OpenTarget } from '../platform/editor';
import { spawnProcess, type SpawnProcess } from '../platform/process';
import {
  profileConfigSchema,
  profileTemplateSchema,
  type ProfileTemplateName,
} from '../schemas/profile';
import { CcpsError } from '../utils/errors';

export type CommandRuntime = {
  writeOut: (value: string) => void;
  openTarget: OpenTarget;
  spawnProcess: SpawnProcess;
  clock: Clock;
};

export function registerCommands(program: Command, options: Partial<CommandRuntime> = {}): void {
  const runtime: CommandRuntime = {
    ...defaultRuntime,
    ...options,
  };

  program
    .command('init')
    .description('Create the ccps app home and default profiles.')
    .action(async () => {
      const result = await initProfiles({ clock: runtime.clock });
      const created =
        result.createdProfiles.length > 0 ? result.createdProfiles.join(', ') : 'none';
      const preserved =
        result.preservedProfiles.length > 0 ? result.preservedProfiles.join(', ') : 'none';

      runtime.writeOut(`Initialized ccps app home: ${result.appHomePath}\n`);
      runtime.writeOut(`Created default profiles: ${created}\n`);
      runtime.writeOut(`Preserved existing profiles: ${preserved}\n`);
      runtime.writeOut('Next: ccps list\n');
    });

  program
    .command('create <name>')
    .description('Create a profile from a template.')
    .requiredOption('--template <template>', 'Profile template to use.')
    .action(async (name: string, options: { template: string }) => {
      const template = parseTemplateName(options.template);
      const result = await createProfile({ name, template, clock: runtime.clock });

      runtime.writeOut(`Created profile "${result.name}" from template "${result.template}".\n`);
      runtime.writeOut(`Path: ${result.paths.profileRootPath}\n`);
      runtime.writeOut(`Next: ccps launch ${result.name} --dry-run\n`);
    });

  program
    .command('list')
    .description('List available profiles and their validation status.')
    .action(async () => {
      const appPaths = getAppHomePaths();

      if (
        !(await fs.pathExists(appPaths.appHomePath)) ||
        !(await fs.pathExists(appPaths.profilesPath))
      ) {
        runtime.writeOut(`No ccps app home found: ${appPaths.appHomePath}\n`);
        runtime.writeOut('Next: ccps init\n');
        return;
      }

      const config = await loadAppConfig(appPaths.appHomePath);
      const profileNames = await listProfileNames(appPaths.profilesPath);

      if (profileNames.length === 0) {
        runtime.writeOut(`No profiles found: ${appPaths.profilesPath}\n`);
        runtime.writeOut('Next: ccps init\n');
        return;
      }

      runtime.writeOut(`Profiles in ${appPaths.profilesPath}\n`);
      runtime.writeOut('Name\tStatus\tLast Used\tDescription\n');

      for (const profileName of profileNames) {
        const validation = await validateProfile({
          appHomePath: appPaths.appHomePath,
          name: profileName,
        });
        const description = validation.config?.description ?? '(invalid profile.json)';
        const lastUsed = config.lastUsedProfile === profileName ? 'last-used' : '-';

        runtime.writeOut(`${profileName}\t${validation.status}\t${lastUsed}\t${description}\n`);
      }
    });

  program
    .command('show <name>')
    .description('Display profile structure and file status.')
    .action(async (name: string) => {
      const appPaths = getAppHomePaths();
      const validation = await validateProfile({ appHomePath: appPaths.appHomePath, name });
      const paths = validation.paths;

      runtime.writeOut(`Profile: ${validation.profileName}\n`);
      runtime.writeOut(`Profile path: ${validation.profileRootPath}\n`);
      runtime.writeOut(`Claude home: ${validation.claudeHomePath}\n`);
      runtime.writeOut('Required files:\n');
      runtime.writeOut(`  profile.json: ${await pathStatus(paths.profileConfigPath, 'file')}\n`);
      runtime.writeOut(`  CLAUDE.md: ${await pathStatus(paths.claudeMdPath, 'file')}\n`);
      runtime.writeOut(`  settings.json: ${await jsonStatus(paths.settingsPath)}\n`);
      runtime.writeOut(`  mcp.json: ${await jsonStatus(paths.mcpConfigPath)}\n`);
      runtime.writeOut('Required directories:\n');
      runtime.writeOut(`  claude-home: ${await pathStatus(paths.claudeHomePath, 'directory')}\n`);
      runtime.writeOut(`  skills: ${await pathStatus(paths.skillsPath, 'directory')}\n`);
      runtime.writeOut(`  agents: ${await pathStatus(paths.agentsPath, 'directory')}\n`);
      runtime.writeOut(`  plugins: ${await pathStatus(paths.pluginsPath, 'directory')}\n`);
      runtime.writeOut(`JSON validation: ${validation.status}\n`);
      runtime.writeOut('Project config: preserved from the launch cwd\n');
      runtime.writeOut('Real user config: never copied from or written to the real ~/.claude\n');

      if (validation.findings.length > 0) {
        runtime.writeOut(formatFindings(validation.findings));
      }
    });

  program
    .command('validate <name>')
    .description('Check profile JSON, required files, and sensitive filenames.')
    .action(async (name: string) => {
      const appPaths = getAppHomePaths();
      const validation = await validateProfile({ appHomePath: appPaths.appHomePath, name });

      runtime.writeOut(`Profile: ${validation.profileName}\n`);
      runtime.writeOut(`Status: ${validation.status}\n`);

      if (validation.findings.length === 0) {
        runtime.writeOut('No findings.\n');
      } else {
        runtime.writeOut(formatFindings(validation.findings));
      }
    });

  program
    .command('backup <name>')
    .description('Copy a profile to a timestamped backup directory.')
    .action(async (name: string) => {
      const result = await backupProfile({ name, clock: runtime.clock });

      runtime.writeOut(`Backup created: ${result.backupPath}\n`);
      runtime.writeOut(`Source profile unchanged: ${result.sourcePath}\n`);
    });

  program
    .command('edit <name> [file]')
    .description('Open a profile file or directory with the default editor.')
    .action(async (name: string, file?: string) => {
      const appPaths = getAppHomePaths();
      await loadAppConfig(appPaths.appHomePath);

      const targetPath = resolveEditTarget(appPaths.appHomePath, name, file);
      await runtime.openTarget(targetPath);

      runtime.writeOut(`Opened: ${targetPath}\n`);
    });

  program
    .command('launch <profile>')
    .description('Start Claude Code with the selected user-level profile.')
    .option('--dry-run', 'Print the launch plan without starting Claude Code.')
    .option('--cwd <path>', 'Project directory to launch Claude Code from.')
    .action(async (profile: string, options: { dryRun?: boolean; cwd?: string }) => {
      const appPaths = getAppHomePaths();
      if (options.dryRun) {
        const plan = await buildLaunchPlan({
          appHomePath: appPaths.appHomePath,
          profileName: profile,
          cwd: options.cwd,
        });

        runtime.writeOut(formatLaunchDryRun(plan));
        return;
      }

      const result = await launchProfile({
        appHomePath: appPaths.appHomePath,
        profileName: profile,
        cwd: options.cwd,
        spawnProcess: runtime.spawnProcess,
        clock: runtime.clock,
      });

      runtime.writeOut(`Launching Claude Code with profile "${result.plan.profileName}".\n`);
      runtime.writeOut(`Cwd: ${result.plan.cwd}\n`);
      runtime.writeOut(`CLAUDE_CONFIG_DIR=${result.plan.envChanges.CLAUDE_CONFIG_DIR}\n`);
    });
}

export const registerPlaceholderCommands = registerCommands;

const defaultRuntime: CommandRuntime = {
  writeOut: (value) => {
    process.stdout.write(value);
  },
  openTarget: openWithDefaultEditor,
  spawnProcess,
  clock: () => new Date(),
};

function parseTemplateName(value: string): ProfileTemplateName {
  const parsed = profileTemplateSchema.safeParse(value);

  if (!parsed.success) {
    throw new CcpsError('INVALID_PROFILE_TEMPLATE', 'Profile template is not supported.', {
      guidance: 'Use one of: coding, study, work, research, general, blank.',
      cause: parsed.error,
    });
  }

  return parsed.data;
}

function resolveEditTarget(appHomePath: string, name: string, file?: string): string {
  const paths = getProfileTemplatePaths(appHomePath, name);

  if (!fs.pathExistsSync(paths.profileRootPath)) {
    throw new CcpsError('PROFILE_NOT_FOUND', 'Profile does not exist.', {
      guidance: `Create the profile first: ccps create ${name} --template blank`,
    });
  }

  if (file === undefined) {
    return paths.profileRootPath;
  }

  const targets: Record<string, string> = {
    'CLAUDE.md': paths.claudeMdPath,
    'settings.json': paths.settingsPath,
    'mcp.json': paths.mcpConfigPath,
    'profile.json': paths.profileConfigPath,
  };
  const targetPath = targets[file];

  if (!targetPath) {
    throw new CcpsError('INVALID_EDIT_TARGET', 'Edit target is not approved.', {
      guidance: 'Use one of: CLAUDE.md, settings.json, mcp.json, profile.json.',
    });
  }

  return targetPath;
}

async function listProfileNames(profilesPath: string): Promise<string[]> {
  const entries = await fs.readdir(profilesPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function pathStatus(targetPath: string, expectedType: 'file' | 'directory'): Promise<string> {
  try {
    const stats = await fs.stat(targetPath);

    if (expectedType === 'file' && stats.isFile()) {
      return 'present';
    }

    if (expectedType === 'directory' && stats.isDirectory()) {
      return 'present';
    }

    return 'wrong type';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return 'missing';
    }

    throw error;
  }
}

async function jsonStatus(targetPath: string): Promise<string> {
  const present = await pathStatus(targetPath, 'file');
  if (present !== 'present') {
    return present;
  }

  try {
    const value = await fs.readJson(targetPath);
    if (targetPath.endsWith('profile.json')) {
      return profileConfigSchema.safeParse(value).success ? 'valid JSON' : 'invalid schema';
    }

    return 'valid JSON';
  } catch {
    return 'invalid JSON';
  }
}

function formatFindings(findings: ValidationFinding[]): string {
  const lines = ['Findings:'];

  for (const finding of findings) {
    const pathSuffix = finding.path ? ` (${finding.path})` : '';
    lines.push(`  [${finding.severity}] ${finding.code}: ${finding.message}${pathSuffix}`);
    if (finding.suggestion) {
      lines.push(`    Next: ${finding.suggestion}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
