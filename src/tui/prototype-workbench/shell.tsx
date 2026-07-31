// PROTOTYPE (throwaway) — shell for the Workbench prototypes.
// Issue #25: navigation variants A–E (E was chosen: two-pane, sidebar-cards,
// top search). Issue #29: guidance-density variants F/G/H, built on the locked
// navigation model — the question: what amount & placement of first-run,
// empty-state, error, destructive-action, shortcut, and discovery guidance
// keeps the Workbench operable without filesystem knowledge while keeping the
// steady-state interface compact? Issue #32: launch-flow variants J/K/L — J is
// "launch here · resume", K is "launch sheet · exit", L is the combined flow
// from round one (bar + directory screen + full-screen dry-run, runtime
// exit-behavior toggle); all actually spawn a Claude Code stand-in via the
// render loop in index.mts.

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { emptyInventory, largeInventory, smallInventory, type Profile } from './data';
import { bridge } from './launchBridge.mts';
import VariantA from './VariantA';
import VariantB from './VariantB';
import VariantC from './VariantC';
import VariantD from './VariantD';
import VariantE from './VariantE';
import VariantF from './VariantF';
import VariantG from './VariantG';
import VariantH from './VariantH';
import VariantI from './VariantI';
import VariantJ from './VariantJ';
import VariantK from './VariantK';
import VariantL from './VariantL';

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
  { key: 'F', name: 'guidance: on-demand', Component: VariantF },
  { key: 'G', name: 'guidance: progressive', Component: VariantG },
  { key: 'H', name: 'guidance: coached', Component: VariantH },
  { key: 'I', name: 'guidance: chosen mix', Component: VariantI },
  { key: 'J', name: 'launch: here · resume', Component: VariantJ },
  { key: 'K', name: 'launch: sheet · exit', Component: VariantK },
  { key: 'L', name: 'launch: combined', Component: VariantL },
];

const DATASETS = [
  { label: 'small(3)', profiles: smallInventory },
  { label: 'large(42)', profiles: largeInventory },
  { label: 'empty(0)', profiles: emptyInventory },
];

export interface VariantProps {
  profiles: Profile[];
}

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [vi, setViRaw] = useState(() => {
    const want = (process.env.CCPS_PROTO_VARIANT ?? '').toUpperCase();
    const i = VARIANTS.findIndex((v) => v.key === want);
    // restored after a Workbench-resume remount (issue #32 launch variants)
    return i >= 0 ? i : Math.min(bridge.ui.vi, VARIANTS.length - 1);
  });
  const [di, setDiRaw] = useState(() => Math.min(bridge.ui.di, DATASETS.length - 1));
  const setVi = (up: (i: number) => number) =>
    setViRaw((old) => {
      const next = up(old);
      bridge.ui.vi = next;
      return next;
    });
  const setDi = (up: (i: number) => number) =>
    setDiRaw((old) => {
      const next = up(old);
      bridge.ui.di = next;
      return next;
    });
  const [resetKey, setResetKey] = useState(0);
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
      setDi((i) => (i + 1) % DATASETS.length);
      return;
    }
    if (key.ctrl && input === 'r') {
      // remount the variant: resets first-run overlays, hint retirement, tours
      setResetKey((n) => n + 1);
      return;
    }
    if (capture) return;
    if (input === ']') setVi((i) => (i + 1) % VARIANTS.length);
    if (input === '[') setVi((i) => (i - 1 + VARIANTS.length) % VARIANTS.length);
    if (input === 'q') exit();
  });

  const { label, profiles } = DATASETS[di];
  const v = VARIANTS[vi];
  const w = stdout.columns ?? 80;
  const h = stdout.rows ?? 24;

  return (
    <CaptureContext.Provider value={setCapture}>
      <Box flexDirection="column" width={w} height={h}>
        <Box flexDirection="column" flexGrow={1}>
          <v.Component key={`${v.key}-${resetKey}`} profiles={profiles} />
        </Box>
        <Box width={w} justifyContent="center">
          <Text backgroundColor="white" color="black" bold wrap="truncate">
            {` [ctrl+v] variant ${v.key} — ${v.name} (${vi + 1}/${VARIANTS.length}) · [ctrl+d] data: ${label} · [ctrl+r] reset · ${w}×${h} · [ctrl+c] quit `}
          </Text>
        </Box>
      </Box>
    </CaptureContext.Provider>
  );
}
