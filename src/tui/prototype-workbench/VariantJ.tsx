// PROTOTYPE — Variant J (issue #32): launch flow pole 1 — "launch here · resume".
// `l` goes straight to a one-line pre-launch bar: the launch directory is ALWAYS
// the directory ccps was started in (status-quo cwd semantics, zero steps, the
// shortest possible safe flow). Blocked Profiles get a persistent blocker panel.
// After Claude Code exits, the Workbench RESUMES in place — the driver in
// index.mts re-enters the alternate screen and re-renders right here.

import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { bridge } from './launchBridge.mts';
import {
  dryRunLines,
  START_CWD,
  statusMark,
  validationFor,
  WorkbenchFrame,
} from './launchShared';
import type { VariantProps } from './shell';

type Phase = 'nav' | 'pre' | 'dry' | 'blocked';

export default function VariantJ({ profiles }: VariantProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [pi, setPi] = useState(() => {
    const last = bridge.lastExit;
    const i = last ? profiles.findIndex((p) => p.name === last.profileName) : -1;
    return i >= 0 ? i : 0;
  });
  const [phase, setPhase] = useState<Phase>('nav');
  const [flash] = useState<string | null>(() =>
    bridge.lastExit
      ? `Claude Code exited (${bridge.lastExit.code ?? 0}) — Workbench resumed on "${bridge.lastExit.profileName}"`
      : null,
  );
  useEffect(() => {
    bridge.lastExit = null; // consume the resume flash so ctrl+r doesn't replay it
  }, []);

  const p = profiles[pi];
  const v = p ? validationFor(p) : { status: 'valid' as const, findings: [] };
  const blocked = v.status === 'error';
  const { mark, color } = statusMark(v.status);
  const rows = stdout.rows ?? 24;

  const launch = () => {
    bridge.pending = { profileName: p.name, cwd: START_CWD, resume: true };
    exit();
  };

  useInput((input, key) => {
    if (!p) return;
    if (phase === 'pre') {
      if (key.escape) setPhase('nav');
      else if (input === 'd') setPhase('dry');
      else if (key.return) launch();
      return;
    }
    if (phase === 'dry') {
      if (key.escape) setPhase('nav');
      else if (key.return && !blocked) launch();
      return;
    }
    if (phase === 'blocked') {
      if (key.escape || input === 'l') setPhase('nav');
      return;
    }
    // nav
    if (input === 'l') setPhase(blocked ? 'blocked' : 'pre');
    else if (input === 'd') setPhase('dry');
  });

  if (phase === 'dry' && p) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        {dryRunLines(p.name, START_CWD, v).slice(0, rows - 3).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        <Box flexGrow={1} />
        {blocked ? (
          <Text color="red"> launch disabled — resolve error findings first · [esc] back</Text>
        ) : (
          <Text color="cyan"> [enter] launch · [esc] back</Text>
        )}
      </Box>
    );
  }

  const bottomBar = () => {
    if (phase === 'pre')
      return (
        <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor="cyan" paddingX={1} marginX={1}>
          <Text bold>
            Launch {p.name} → {START_CWD}
          </Text>
          {v.status === 'warning' ? (
            <Text color="yellow">
              ⚠ {v.findings[0].code}: {v.findings[0].message} — launchable
            </Text>
          ) : null}
          <Text dimColor> [enter] launch · [d] dry-run plan · [esc] cancel</Text>
        </Box>
      );
    if (phase === 'blocked')
      return (
        <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor="red" paddingX={1} marginX={1}>
          <Text color="red" bold>
            ✕ "{p.name}" is not launch-ready — {v.findings.length} error findings:
          </Text>
          {v.findings.map((f, i) => (
            <Text key={i} wrap="truncate">
              {'  '}
              {f.code}: {f.message}
            </Text>
          ))}
          <Text dimColor wrap="truncate">
            Next: fix the Profile, then relaunch — `ccps validate {p.name}` has the full list
          </Text>
          <Text dimColor> [esc] back</Text>
        </Box>
      );
    if (flash) return <Text color="green"> {flash}</Text>;
    return <Text> </Text>;
  };

  return (
    <WorkbenchFrame
      profiles={profiles}
      pi={pi}
      setPi={setPi}
      navActive={phase === 'nav'}
      footer="J: launch here · resume — [l] launch · [d] dry-run · [↑/↓] select"
    >
      {p ? (
        <>
          <Text bold>
            {p.name} <Text dimColor>— {p.description}</Text>
          </Text>
          <Text>
            status: <Text color={color}>{mark} {v.status}</Text>
            <Text dimColor>
              {'  '}· projects: {p.projects} · last used: {p.lastUsed}
            </Text>
          </Text>
          <Text> </Text>
          <Text>
            launch directory: <Text bold>{START_CWD}</Text>
          </Text>
          <Text dimColor wrap="wrap">
            the directory ccps started in — Claude picks up this project's own config, always
          </Text>
          <Box flexGrow={1} />
          <Text color="cyan">[l] launch · [d] dry-run plan</Text>
        </>
      ) : (
        <Text dimColor>No Profiles yet.</Text>
      )}
      {bottomBar()}
    </WorkbenchFrame>
  );
}
