// PROTOTYPE (throwaway) — run: npm run prototype
// .mts so Ink (ESM-only) imports cleanly from this CommonJS package.
import React from 'react';
import { render } from 'ink';
import { App } from './shell';

process.stdout.write('\x1b[?1049h'); // alternate screen
const app = render(React.createElement(App), { exitOnCtrlC: false });
await app.waitUntilExit();
process.stdout.write('\x1b[?1049l'); // restore screen
