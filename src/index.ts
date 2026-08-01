#!/usr/bin/env node
import { createProgram } from './cli';
import { formatError } from './utils/errors';

async function main(): Promise<void> {
  // PROTOTYPE (throwaway) — issue #36 packaging-gate hook. When CCPS_INK_GATE=1
  // the CJS bin lazy-loads the shipped ESM Ink bundle and skips the CLI.
  // With the env var absent this path is unreachable and behavior is unchanged.
  if (process.env.CCPS_INK_GATE === '1') {
    const { launchInkGateWorkbench } = await import('./tui/inkGate');
    await launchInkGateWorkbench();
    return;
  }

  const isDualTty = process.stdin.isTTY && process.stdout.isTTY;
  const hasSubcommand = extractSubcommand() !== undefined;

  // Interactive dual-TTY bare `ccps` opens Profile Workbench (issue #54 §3.1).
  if (isDualTty && !hasSubcommand) {
    const { launchWorkbench } = await import('./tui/workbench-loader');
    await launchWorkbench();
    return;
  }

  // Non-TTY bare `ccps` prints help to stderr, exit 1 (issue #54 §3.1).
  if (!isDualTty && !hasSubcommand) {
    const program = createProgram();
    process.stderr.write(program.helpInformation());
    process.exitCode = 1;
    return;
  }

  const program = createProgram();
  await program.parseAsync(process.argv);
}

function extractSubcommand(): string | undefined {
  // argv = [node, ccps, ...args]
  const args = process.argv.slice(2);
  if (args.length === 0) return undefined;
  const first = args[0];
  // Flags like --help, --version are not subcommands
  if (first.startsWith('-')) return undefined;
  return first;
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
