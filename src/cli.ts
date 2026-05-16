import { Command } from 'commander';

import { registerPlaceholderCommands } from './commands';

export const cliVersion = '0.1.0';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('ccps')
    .description('CC-Profile-Switch: Windows-only Claude Code profile launcher.')
    .version(cliVersion)
    .showHelpAfterError()
    .showSuggestionAfterError();

  registerPlaceholderCommands(program);

  return program;
}
