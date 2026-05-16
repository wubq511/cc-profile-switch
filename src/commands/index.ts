import { Command } from 'commander';

import { createProfile, initProfiles } from '../core/profile';
import { profileTemplateSchema, type ProfileTemplateName } from '../schemas/profile';
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
    nameAndArgs: 'list',
    description: 'List available profiles and their validation status.',
  },
  {
    nameAndArgs: 'show <name>',
    description: 'Display profile structure and file status.',
  },
  {
    nameAndArgs: 'edit <name> [file]',
    description: 'Open a profile file or directory with the default editor.',
  },
  {
    nameAndArgs: 'validate <name>',
    description: 'Check profile JSON, required files, and sensitive filenames.',
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
