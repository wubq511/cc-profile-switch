// NO_COLOR support for the Ink/chalk color pipeline (issue #100, spec §14).
//
// https://no-color.org: when NO_COLOR is present, ANSI color must be
// suppressed. picocolors — used by the CLI path — honors it natively; chalk,
// which backs Ink's colorize, does not (its supports-color probe checks argv
// flags and FORCE_COLOR only). Setting chalk.level = 0 before the first
// render turns every color/weight style into a pass-through.
//
// The truthiness check matches picocolors (!!env.NO_COLOR) so the CLI and the
// Workbench agree: an empty NO_COLOR= does not disable color.

import chalk from 'chalk';

export function applyNoColorPreference(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NO_COLOR) {
    chalk.level = 0;
  }
}
