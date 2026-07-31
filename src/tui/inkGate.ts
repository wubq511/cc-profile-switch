// PROTOTYPE (throwaway) — issue #36
// CJS lazy loader for the Ink gate Workbench: the production mechanism for
// shipping ESM Ink inside this CommonJS package. dist/index.js dynamically
// imports the sibling ESM bundle; nothing Ink-related loads on any other
// code path.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function launchInkGateWorkbench(): Promise<void> {
  const bundleUrl = pathToFileURL(join(__dirname, 'ink-gate-workbench.mjs')).href;
  await import(bundleUrl);
}
