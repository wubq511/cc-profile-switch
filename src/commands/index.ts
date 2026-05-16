import { Command } from 'commander';

type PlaceholderCommand = {
  nameAndArgs: string;
  description: string;
  options?: Array<[flags: string, description: string]>;
};

const placeholderCommands: PlaceholderCommand[] = [
  {
    nameAndArgs: 'init',
    description: 'Create the ccps app home and default profiles.',
  },
  {
    nameAndArgs: 'list',
    description: 'List available profiles and their validation status.',
  },
  {
    nameAndArgs: 'create <name>',
    description: 'Create a profile from a template.',
    options: [['--template <template>', 'Profile template to use.']],
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

export function registerPlaceholderCommands(program: Command): void {
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
