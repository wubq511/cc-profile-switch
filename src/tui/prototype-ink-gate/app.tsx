// PROTOTYPE (throwaway) — issue #36
// Ink packaging-gate app: exercises the surfaces the gate must prove —
// live size, key echo, CJK width alignment, focus reporting, and a
// VS Code-style handoff (suspend → child process → resume).
//
// `headless` renders the same screen without useInput/raw mode so CI can
// render deterministically with piped stdio (focus line stays a placeholder).

import React, { useEffect, useState } from 'react';
import {
  Box,
  Text,
  useApp,
  useInput,
  useIsScreenReaderEnabled,
  useStdin,
  useStdout,
} from 'ink';

// The CJK string has display width 20 (10 chars × 2 columns). Both ruler and
// CJK lines share a 7-column prefix, so the end marker must land at display
// column 27 — directly under ruler digit index 20. If Ink or the terminal
// mis-measures width, the marker visibly drifts off the ruler.
export const CJK_TEXT = '配置切换プロファイル';
export const CJK_END = '│';
export const RULER = '0123456789'.repeat(3); // 30 display columns

export type InkGateAppProps = {
  handoffs?: number;
  headless?: boolean;
  onHandoff?: () => void;
};

type GateScreenProps = {
  columns: number;
  rows: number;
  lastKey: string;
  focus: 'unknown' | 'in' | 'out';
  handoffs: number;
  screenReader: boolean;
};

function keyName(input: string, key: Record<string, boolean | undefined>): string {
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.return) return 'enter';
  if (key.escape) return 'esc';
  return JSON.stringify(input);
}

function GateScreen({ columns, rows, lastKey, focus, handoffs, screenReader }: GateScreenProps) {
  if (screenReader) {
    return (
      <Box flexDirection="column">
        <Text>INK-GATE screen-reader summary</Text>
        <Text>
          size: {columns}x{rows}
        </Text>
        <Text>cjk: {CJK_TEXT}</Text>
        <Text>
          key: {lastKey}; focus: {focus}; handoffs: {handoffs}
        </Text>
        <Text>v handoff · q quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        INK-GATE prototype · issue #36 · size: {columns}x{rows}
      </Text>
      <Text>
        key: {lastKey} · focus: {focus} · handoffs: {handoffs}
      </Text>
      <Text>ruler |{RULER}|</Text>
      <Text>
        cjk   |{CJK_TEXT}
        {CJK_END}
      </Text>
      {handoffs > 0 && <Text>refreshed after handoff #{handoffs}</Text>}
      <Text>arrows/enter/esc echo · v VS Code handoff · q quit</Text>
    </Box>
  );
}

function HeadlessGate({ handoffs }: { handoffs: number }) {
  const { stdout } = useStdout();
  const screenReader = useIsScreenReaderEnabled();
  return (
    <GateScreen
      columns={stdout.columns ?? 80}
      rows={stdout.rows ?? 24}
      lastKey="none"
      focus="unknown"
      handoffs={handoffs}
      screenReader={screenReader}
    />
  );
}

function InteractiveGate({ handoffs, onHandoff }: { handoffs: number; onHandoff?: () => void }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  const screenReader = useIsScreenReaderEnabled();

  const [columns, setColumns] = useState(stdout.columns ?? 80);
  const [rows, setRows] = useState(stdout.rows ?? 24);
  const [lastKey, setLastKey] = useState('none');
  const [focus, setFocus] = useState<'unknown' | 'in' | 'out'>('unknown');

  useEffect(() => {
    const onResize = () => {
      setColumns(stdout.columns ?? 80);
      setRows(stdout.rows ?? 24);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Focus-in/focus-out events arrive as raw escape sequences on stdin once
  // the entry has enabled reporting with \x1b[?1004h.
  useEffect(() => {
    const onData = (data: Buffer) => {
      const text = data.toString('utf8');
      if (text.includes('\x1b[I')) setFocus('in');
      if (text.includes('\x1b[O')) setFocus('out');
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'v') {
      onHandoff?.();
      return;
    }
    setLastKey(keyName(input, key));
  });

  return (
    <GateScreen
      columns={columns}
      rows={rows}
      lastKey={lastKey}
      focus={focus}
      handoffs={handoffs}
      screenReader={screenReader}
    />
  );
}

export function InkGateApp({ handoffs = 0, headless = false, onHandoff }: InkGateAppProps) {
  if (headless) {
    return <HeadlessGate handoffs={handoffs} />;
  }
  return <InteractiveGate handoffs={handoffs} onHandoff={onHandoff} />;
}
