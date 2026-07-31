// PROTOTYPE (throwaway) — run: npm run prototype:diff
// .mts so Ink (ESM-only) imports cleanly from this CommonJS package.
// Issue #44: render the three diff-presentation variants in the alternate
// screen; q / ctrl+c exits.
import React from 'react';
import { render } from 'ink';
import { App } from './shell';

process.stdout.write('\x1b[?1049h');
const app = render(React.createElement(App));
await app.waitUntilExit();
process.stdout.write('\x1b[?1049l');
