#!/usr/bin/env node
import { createProgram } from './cli';
import { formatError } from './utils/errors';

async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
