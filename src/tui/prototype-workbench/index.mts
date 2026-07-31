// PROTOTYPE (throwaway) — run: npm run prototype
// .mts so Ink (ESM-only) imports cleanly from this CommonJS package.
// Issue #32: the launch variants (J/K) actually leave the alternate screen and
// spawn a stand-in for Claude Code. The render loop below is what makes the
// exit/suspend/resume question demonstrable: after the stand-in exits, a
// resume request re-enters the alternate screen and re-renders the Workbench;
// an exit request lands back in the shell with a reopen hint.
import React from 'react';
import { render } from 'ink';
import { App } from './shell';
import { bridge, runFakeClaude } from './launchBridge.mts';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';

while (true) {
  process.stdout.write(ALT_ON);
  const app = render(React.createElement(App), { exitOnCtrlC: false });
  await app.waitUntilExit();
  process.stdout.write(ALT_OFF);

  const req = bridge.pending;
  if (!req) break;
  bridge.pending = null;

  const code = await runFakeClaude(req);
  bridge.lastExit = { code, profileName: req.profileName };

  if (!req.resume) {
    console.log('');
    console.log('Back in your shell. Reopen Profile Workbench with: ccps');
    break;
  }
  console.log('Resuming Profile Workbench…');
}
