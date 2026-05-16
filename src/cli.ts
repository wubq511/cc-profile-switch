import { Command } from 'commander';

import { registerCommands, type CommandOutput } from './commands';

export const cliVersion = '0.1.0';

export type CreateProgramOptions = Partial<CommandOutput>;

export function createProgram(options: CreateProgramOptions = {}): Command {
  const program = new Command();

  program
    .name('ccps')
    .description('CC-Profile-Switch: Windows-only Claude Code profile launcher.')
    .version(cliVersion)
    .showHelpAfterError()
    .showSuggestionAfterError();

  registerCommands(program, {
    writeOut: options.writeOut ?? ((value) => process.stdout.write(value)),
  });

  return program;
}
