import { Command } from 'commander';

import { registerCommands, type CommandRuntime } from './commands';

export const cliVersion = '0.1.0';

export type CreateProgramOptions = Partial<CommandRuntime>;

export function createProgram(options: CreateProgramOptions = {}): Command {
  const program = new Command();

  program
    .name('ccps')
    .description('CC-Profile-Switch: Windows-only Claude Code profile launcher.')
    .version(cliVersion)
    .showHelpAfterError()
    .showSuggestionAfterError();

  registerCommands(program, options);

  return program;
}
