// PROTOTYPE (throwaway) — ad-hoc smoke: renderToString one frame + drive the
// session reducer through the ticket's lifecycle cases. Not a test.
import React from 'react';
import { renderToString } from 'ink';
import { App } from './shell';
import { initialSession, reduceSession, type SessionEvent } from './editSessionMachine';

const frame = renderToString(React.createElement(App), { columns: 100 });
console.log('--- FRAME (100 cols) ---');
console.log(frame);

const seq: Array<[string, SessionEvent, string]> = [
  ['open', { type: 'open-requested' }, 'opening'],
  ['opened', { type: 'open-succeeded' }, 'watching'],
  ['save 1', { type: 'file-changed' }, 'watching'],
  ['save 2', { type: 'file-changed' }, 'watching'],
  ['delete/rename', { type: 'file-unlinked' }, 'missing'],
  ['reappear', { type: 'file-reappeared' }, 'watching'],
  ['end', { type: 'session-ended' }, 'idle'],
  ['open again', { type: 'open-requested' }, 'opening'],
  ['vscode missing', { type: 'open-failed', reason: 'Visual Studio Code.app not found' }, 'idle'],
];

let s = initialSession;
let ok = true;
console.log('--- REDUCER LIFECYCLE ---');
for (const [label, ev, want] of seq) {
  s = reduceSession(s, ev);
  const pass = s.phase === want;
  ok &&= pass;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: phase=${s.phase} changes=${s.changeCount} last="${s.lastEvent}"`);
}
// unavailable-path fallback surface check
if (!s.lastEvent?.startsWith('VS Code unavailable')) {
  ok = false;
  console.log('FAIL fallback banner trigger');
}
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
