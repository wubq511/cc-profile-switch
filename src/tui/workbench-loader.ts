// CJS lazy loader for the Workbench ESM bundle.
// dist/index.js dynamically imports the sibling ESM bundle;
// nothing Ink-related loads on any other code path.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function launchWorkbench(): Promise<void> {
  const bundleUrl = pathToFileURL(join(__dirname, 'workbench.mjs')).href;
  await import(bundleUrl);
}
