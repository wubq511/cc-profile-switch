import { Command } from 'commander';
import chalk from 'chalk';

import { registerCommands, type CommandRuntime } from './commands';
import { getAppHomePaths, loadAppConfigSync } from './core/app-config';
import { cliVersion } from './core/version';
import { renderWelcomeBanner, resolveBannerOptions } from './tui/workbench/welcome-banner/render';

export type CreateProgramOptions = Partial<CommandRuntime>;

function resolveWelcomeBannerEnabled(): boolean {
  try {
    const config = loadAppConfigSync(getAppHomePaths().appHomePath);
    return config.welcomeBanner !== false;
  } catch {
    return true;
  }
}

export function buildCliBanner(deps: {
  isTTY: boolean;
  columns: number;
  platform: string;
  env: NodeJS.ProcessEnv;
  chalkLevel: 0 | 1 | 2 | 3;
  configEnabled: boolean;
}): string {
  const options = resolveBannerOptions(deps);
  if (options === null) return '';
  return renderWelcomeBanner(options);
}

export function createProgram(options: CreateProgramOptions = {}): Command {
  const program = new Command();

  const configEnabled = resolveWelcomeBannerEnabled();
  const banner = buildCliBanner({
    isTTY: !!process.stdout.isTTY,
    columns: process.stdout.columns ?? 80,
    platform: process.platform,
    env: process.env,
    chalkLevel: chalk.level,
    configEnabled,
  });

  program
    .name('ccps')
    .description('CC-Profile-Switch: Windows, macOS, and Linux Claude Code profile launcher.')
    .version(banner ? `${banner}\n${cliVersion}` : cliVersion)
    .showHelpAfterError()
    .showSuggestionAfterError();

  if (banner) {
    program.addHelpText('beforeAll', `${banner}\n`);
  }

  registerCommands(program, options);

  return program;
}
