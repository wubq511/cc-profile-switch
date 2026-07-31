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

  const program = createProgram();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
