// Profile Workbench ESM entry — issue #54
// Loaded via dynamic import() from the CJS bin when stdin.isTTY && stdout.isTTY.
// Manages alternate screen, signal handlers, Ink render loop, and cleanup.

import React from 'react';
import { render } from 'ink';

import { loadWorkbenchData } from './profile-data';
import { WorkbenchApp } from './app';
import { resolveLocale, type Locale } from './i18n/react';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_SHOW = '\x1b[?25h';
const FOCUS_ON = '\x1b[?1004h';
const FOCUS_OFF = '\x1b[?1004l';

const out = process.stdout;

function writeCleanup(): void {
  out.write(FOCUS_OFF + CURSOR_SHOW + ALT_OFF);
}

let halted = false;
function halt(): void {
  if (halted) return;
  halted = true;
  writeCleanup();
  process.exit(0);
}

process.on('SIGINT', halt);
process.on('SIGTERM', halt);

async function main(): Promise<void> {
  const data = await loadWorkbenchData();

  let currentLocale: Locale = resolveLocale();

  function onLocaleChange(locale: Locale): void {
    currentLocale = locale;
  }

  out.write(ALT_ON + FOCUS_ON);

  const instance = render(
    React.createElement(WorkbenchApp, {
      data,
      initialLocale: currentLocale,
      onLocaleChange,
    }),
    { exitOnCtrlC: false, interactive: true },
  );

  await instance.waitUntilExit();
  writeCleanup();
  process.exit(0);
}

main().catch((error: unknown) => {
  writeCleanup();
  if (error instanceof Error) {
    process.stderr.write(`WORKBENCH_ERROR: ${error.message}\n`);
  } else {
    process.stderr.write(`WORKBENCH_ERROR: ${String(error)}\n`);
  }
  process.exit(1);
});
