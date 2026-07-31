// PROTOTYPE (throwaway) — issue #36
// Entry for the Ink packaging gate. .mts so Ink (ESM-only) imports cleanly
// from this CommonJS package; bundled to dist/ink-gate-workbench.mjs and
// lazy-loaded via dynamic import() from the CJS bin.
//
// Headless CI mode: CCPS_INK_GATE_AUTORUN=1 renders one deterministic frame
// without TTY input or raw mode, prints INK-GATE:* sentinels, runs the full
// cleanup sequence, and exits 0. INK_SCREEN_READER=true exercises Ink's
// native screen-reader switch and prints INK-GATE:SCREEN-READER.

import { spawn } from 'node:child_process';

import React from 'react';
import { render } from 'ink';

import { CJK_END, CJK_TEXT, InkGateApp } from './app';

const ALT_ON = '\x1b[?1049h'; // enter alternate screen
const ALT_OFF = '\x1b[?1049l'; // leave alternate screen
const CURSOR_SHOW = '\x1b[?25h';
const FOCUS_ON = '\x1b[?1004h'; // enable focus-event reporting
const FOCUS_OFF = '\x1b[?1004l'; // disable focus-event reporting

const out = process.stdout;

function writeCleanup(): void {
  out.write(FOCUS_OFF + CURSOR_SHOW + ALT_OFF);
}

// The handoff simulates the VS Code suspend/resume cycle: leave the
// alternate screen, run a child that inherits stdio (no VS Code needed —
// any process proves the stdio handoff), then re-enter and re-render.
function runHandoffChild(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', "console.log('INK-GATE-HANDOFF-CHILD')"], {
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
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

if (process.env.CCPS_INK_GATE_AUTORUN === '1') {
  // Headless gate: piped stdio on hosted runners. Ink auto-detects
  // non-interactive and writes the final frame at unmount.
  out.write(FOCUS_ON);
  const instance = render(React.createElement(InkGateApp, { headless: true }), {
    exitOnCtrlC: false,
  });
  await instance.waitUntilRenderFlush();
  out.write('INK-GATE:RENDERED\n');
  out.write(`INK-GATE:CJK:${CJK_TEXT}${CJK_END}\n`);
  if (process.env.INK_SCREEN_READER === 'true') {
    out.write('INK-GATE:SCREEN-READER\n');
  }
  await new Promise((resolve) => setTimeout(resolve, 50)); // one frame+
  instance.unmount();
  await instance.waitUntilExit(); // settles after unmount-time stdout writes
  writeCleanup();
  out.write('INK-GATE:CLEANUP-OK\n');
  process.exit(0);
}

let handoffs = 0;
for (;;) {
  out.write(ALT_ON + FOCUS_ON);
  let handoffRequested = false;
  const instance = render(
    React.createElement(InkGateApp, {
      handoffs,
      onHandoff: () => {
        handoffRequested = true;
        setImmediate(() => instance.unmount());
      },
    }),
    // Force interactive: CI detection would otherwise suppress live frames
    // even on a real PTY, which is exactly what the smoke test drives.
    { exitOnCtrlC: false, interactive: true },
  );
  await instance.waitUntilExit();
  if (!handoffRequested) break;
  out.write(FOCUS_OFF + CURSOR_SHOW + ALT_OFF);
  await runHandoffChild();
  handoffs += 1;
}
writeCleanup();
process.exit(0);
