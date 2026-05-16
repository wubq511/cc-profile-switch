import { Command } from 'commander';
import fs from 'fs-extra';

import { getAppHomePaths, loadAppConfig } from '../core/app-config';
import { createProfile, initProfiles } from '../core/profile';
import { validateProfile, type ValidationFinding } from '../core/validator';
import { profileConfigSchema, profileTemplateSchema, type ProfileTemplateName } from '../schemas/profile';
import { CcpsError } from '../utils/errors';

export type CommandOutput = {
  writeOut: (value: string) => void;
};

type PlaceholderCommand = {
  nameAndArgs: string;
  description: string;
  options?: Array<[flags: string, description: string]>;
};

const placeholderCommands: PlaceholderCommand[] = [
  {
    nameAndArgs: 'edit <name> [file]',
    description: 'Open a profile file or directory with the default editor.',
  },
  {
    nameAndArgs: 'backup <name>',
    description: 'Copy a profile to a timestamped backup directory.',
  },
  {
    nameAndArgs: 'launch <profile>',
    description: 'Start Claude Code with the selected user-level profile.',
    options: [['--dry-run', 'Print the launch plan without starting Claude Code.']],
  },
];

export function registerCommands(program: Command, output: CommandOutput = defaultOutput): void {
  program
    .command('init')
    .description('Create the ccps app home and default profiles.')
    .action(async () => {
      const result = await initProfiles();
      const created = result.createdProfiles.length > 0 ? result.createdProfiles.join(', ') : 'none';
      const preserved = result.preservedProfiles.length > 0 ? result.preservedProfiles.join(', ') : 'none';

      output.writeOut(`Initialized ccps app home: ${result.appHomePath}\n`);
      output.writeOut(`Created default profiles: ${created}\n`);
      output.writeOut(`Preserved existing profiles: ${preserved}\n`);
      output.writeOut('Next: ccps list\n');
    });

  program
    .command('create <name>')
    .description('Create a profile from a template.')
    .requiredOption('--template <template>', 'Profile template to use.')
    .action(async (name: string, options: { template: string }) => {
      const template = parseTemplateName(options.template);
      const result = await createProfile({ name, template });

      output.writeOut(`Created profile "${result.name}" from template "${result.template}".\n`);
      output.writeOut(`Path: ${result.paths.profileRootPath}\n`);
      output.writeOut(`Next: ccps launch ${result.name} --dry-run\n`);
    });

  program
    .command('list')
    .description('List available profiles and their validation status.')
    .action(async () => {
      const appPaths = getAppHomePaths();

      if (!(await fs.pathExists(appPaths.appHomePath)) || !(await fs.pathExists(appPaths.profilesPath))) {
        output.writeOut(`No ccps app home found: ${appPaths.appHomePath}\n`);
        output.writeOut('Next: ccps init\n');
        return;
      }

      const config = await loadAppConfig(appPaths.appHomePath);
      const profileNames = await listProfileNames(appPaths.profilesPath);

      if (profileNames.length === 0) {
        output.writeOut(`No profiles found: ${appPaths.profilesPath}\n`);
        output.writeOut('Next: ccps init\n');
        return;
      }

      output.writeOut(`Profiles in ${appPaths.profilesPath}\n`);
      output.writeOut('Name\tStatus\tLast Used\tDescription\n');

      for (const profileName of profileNames) {
        const validation = await validateProfile({ appHomePath: appPaths.appHomePath, name: profileName });
        const description = validation.config?.description ?? '(invalid profile.json)';
        const lastUsed = config.lastUsedProfile === profileName ? 'last-used' : '-';

        output.writeOut(`${profileName}\t${validation.status}\t${lastUsed}\t${description}\n`);
      }
    });

  program
    .command('show <name>')
    .description('Display profile structure and file status.')
    .action(async (name: string) => {
      const appPaths = getAppHomePaths();
      const validation = await validateProfile({ appHomePath: appPaths.appHomePath, name });
      const paths = validation.paths;

      output.writeOut(`Profile: ${validation.profileName}\n`);
      output.writeOut(`Profile path: ${validation.profileRootPath}\n`);
      output.writeOut(`Claude home: ${validation.claudeHomePath}\n`);
      output.writeOut('Required files:\n');
      output.writeOut(`  profile.json: ${await pathStatus(paths.profileConfigPath, 'file')}\n`);
      output.writeOut(`  CLAUDE.md: ${await pathStatus(paths.claudeMdPath, 'file')}\n`);
      output.writeOut(`  settings.json: ${await jsonStatus(paths.settingsPath)}\n`);
      output.writeOut(`  mcp.json: ${await jsonStatus(paths.mcpConfigPath)}\n`);
      output.writeOut('Required directories:\n');
      output.writeOut(`  claude-home: ${await pathStatus(paths.claudeHomePath, 'directory')}\n`);
      output.writeOut(`  skills: ${await pathStatus(paths.skillsPath, 'directory')}\n`);
      output.writeOut(`  agents: ${await pathStatus(paths.agentsPath, 'directory')}\n`);
      output.writeOut(`  plugins: ${await pathStatus(paths.pluginsPath, 'directory')}\n`);
      output.writeOut(`JSON validation: ${validation.status}\n`);
      output.writeOut('Project config: preserved from the launch cwd\n');
      output.writeOut('Real user config: never copied from or written to the real ~/.claude\n');

      if (validation.findings.length > 0) {
        output.writeOut(formatFindings(validation.findings));
      }
    });

  program
    .command('validate <name>')
    .description('Check profile JSON, required files, and sensitive filenames.')
    .action(async (name: string) => {
      const appPaths = getAppHomePaths();
      const validation = await validateProfile({ appHomePath: appPaths.appHomePath, name });

      output.writeOut(`Profile: ${validation.profileName}\n`);
      output.writeOut(`Status: ${validation.status}\n`);

      if (validation.findings.length === 0) {
        output.writeOut('No findings.\n');
      } else {
        output.writeOut(formatFindings(validation.findings));
      }
    });

  for (const spec of placeholderCommands) {
    const command = program.command(spec.nameAndArgs).description(spec.description);

    for (const [flags, description] of spec.options ?? []) {
      command.option(flags, description);
    }

    command.action(() => {
      program.error(`Command "${command.name()}" is not implemented in the project skeleton yet.`, {
        code: 'ccps.notImplemented',
        exitCode: 1,
      });
    });
  }
}

export const registerPlaceholderCommands = registerCommands;

const defaultOutput: CommandOutput = {
  writeOut: (value) => {
    process.stdout.write(value);
  },
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
