// PROTOTYPE (throwaway) — shell for the diff-presentation prototype.
// Issue #44: three radically different answers to "what does Diff look like,
// and how does cross-Profile comparison compose?" —
//   A: format follows resource (pairwise diff, per-resource presentation)
//   B: one change grammar (whole-Profile unified changeset)
//   C: comparison matrix first (N-Profile fingerprints, pairwise drill-down)
import React, { useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import VariantA from './VariantA';
import VariantB from './VariantB';
import VariantC from './VariantC';

const VARIANTS = [
  { key: 'A', name: 'format follows resource', Component: VariantA },
  { key: 'B', name: 'one change grammar', Component: VariantB },
  { key: 'C', name: 'comparison matrix first', Component: VariantC },
];

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [vi, setVi] = useState(() => {
    const want = (process.env.CCPS_PROTO_VARIANT ?? '').toUpperCase();
    const i = VARIANTS.findIndex((v) => v.key === want);
    return i >= 0 ? i : 0;
  });

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    // [ ] cycle variants — no CaptureContext here: variants use only arrows/Enter/Esc.
    if (input === ']') setVi((i) => (i + 1) % VARIANTS.length);
    if (input === '[') setVi((i) => (i - 1 + VARIANTS.length) % VARIANTS.length);
    if (input === 'q') exit();
  });

  const v = VARIANTS[vi];
  const w = stdout.columns ?? 80;
  const h = stdout.rows ?? 24;

  return (
    <Box flexDirection="column" width={w} height={h}>
      <Box flexDirection="column" flexGrow={1}>
        <v.Component />
      </Box>
      <Box width={w} justifyContent="center">
        <Text backgroundColor="white" color="black" bold wrap="truncate">
          {`variant ${v.key} — ${v.name} (${vi + 1}/${VARIANTS.length}) · press [ or ] to switch · fixture: coding / study / writing · ${w}×${h} · q quit `}
        </Text>
      </Box>
    </Box>
  );
}
