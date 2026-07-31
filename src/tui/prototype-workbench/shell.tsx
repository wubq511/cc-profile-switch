// PROTOTYPE (throwaway) — shell for the Workbench navigation prototype (issue #25).
// Four radically different navigation variants of the same Profile Workbench,
// switchable at runtime. The question: which full-screen layout, Profile-first
// hierarchy, cross-Profile search model, contextual action model, and keyboard
// help best serve small AND large Profile inventories at realistic terminal sizes?

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { largeInventory, smallInventory, type Profile } from './data';
import VariantA from './VariantA';
import VariantB from './VariantB';
import VariantC from './VariantC';
import VariantD from './VariantD';
import VariantE from './VariantE';

// Variants set this while a text field is focused so the shell stops
// interpreting single-letter keys (q / [ / ]). Ctrl combos stay global.
export const CaptureContext = createContext<(on: boolean) => void>(() => {});
export const useCapture = () => useContext(CaptureContext);

// Shared prototype primitives (layout stays per-variant on purpose).
export function windowed<T>(items: T[], sel: number, height: number): { slice: T[]; start: number } {
  const start = Math.max(0, Math.min(sel - Math.floor(height / 2), Math.max(0, items.length - height)));
  return { slice: items.slice(start, start + height), start };
}

export function editBuffer(
  buf: string,
  input: string,
  key: { backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean; escape?: boolean; return?: boolean; tab?: boolean; upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean },
): string {
  if (key.backspace || key.delete) return buf.slice(0, -1);
  if (
    key.ctrl || key.meta || key.escape || key.return || key.tab ||
    key.upArrow || key.downArrow || key.leftArrow || key.rightArrow
  ) {
    return buf;
  }
  return buf + input;
}

const VARIANTS = [
  { key: 'A', name: 'Miller columns', Component: VariantA },
  { key: 'B', name: 'Tree + detail pane', Component: VariantB },
  { key: 'C', name: 'Search-first palette', Component: VariantC },
  { key: 'D', name: 'Guided hub drill-down', Component: VariantD },
  { key: 'E', name: 'Hybrid tree + cards', Component: VariantE },
];

export interface VariantProps {
  profiles: Profile[];
}

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [vi, setVi] = useState(0);
  const [big, setBig] = useState(false);
  const [capture, setCapture] = useState(false);
  const [, force] = useState(0);

  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.ctrl && input === 'v') {
      setVi((i) => (i + 1) % VARIANTS.length);
      return;
    }
    if (key.ctrl && input === 'd') {
      setBig((b) => !b);
      return;
    }
    if (capture) return;
    if (input === ']') setVi((i) => (i + 1) % VARIANTS.length);
    if (input === '[') setVi((i) => (i - 1 + VARIANTS.length) % VARIANTS.length);
    if (input === 'q') exit();
  });

  const profiles = big ? largeInventory : smallInventory;
  const v = VARIANTS[vi];
  const w = stdout.columns ?? 80;
  const h = stdout.rows ?? 24;

  return (
    <CaptureContext.Provider value={setCapture}>
      <Box flexDirection="column" width={w} height={h}>
        <Box flexDirection="column" flexGrow={1}>
          <v.Component profiles={profiles} />
        </Box>
        <Box width={w} justifyContent="center">
          <Text backgroundColor="white" color="black" bold>
            {` [ctrl+v]/${'[ ]'} variant ${v.key} — ${v.name} (${vi + 1}/${VARIANTS.length})   [ctrl+d] data: ${
              big ? 'large (42 profiles)' : 'small (3 profiles)'
            }   ${w}×${h}   [ctrl+c] quit `}
          </Text>
        </Box>
      </Box>
    </CaptureContext.Provider>
  );
}
