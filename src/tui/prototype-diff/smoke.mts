// PROTOTYPE (throwaway) — ad-hoc smoke: renderToString one frame per variant.
// Not a test. Run: npx tsx src/tui/prototype-diff/smoke.mts
import React from 'react';
import { renderToString } from 'ink';
import VariantA from './VariantA';
import VariantB from './VariantB';
import VariantC from './VariantC';

const variants: Array<[string, React.ComponentType]> = [
  ['A — format follows resource', VariantA],
  ['B — one change grammar', VariantB],
  ['C — comparison matrix first', VariantC],
];

let ok = true;
for (const [label, V] of variants) {
  try {
    const frame = renderToString(React.createElement(V), { columns: 100 });
    console.log(`--- ${label} (100 cols) ---`);
    console.log(frame);
  } catch (err) {
    ok = false;
    console.log(`FAIL ${label}: ${(err as Error).message}`);
  }
}
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
