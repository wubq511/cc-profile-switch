// PROTOTYPE — Variant K (issue #32): launch flow pole 2 — "launch sheet · exit".
// `l` opens a launch sheet: project-directory choice (current / recents / typed),
// validation status inline (blockers shown in the sheet, launch disabled), and
// an expandable dry-run plan — all in one screen before committing.
// After Claude Code exits, the Workbench has EXITED for good: you land back in
// your shell with a hint to reopen (`ccps`). Contrast with J's resume.

import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { bridge } from './launchBridge.mts';
import {
  dryRunLines,
  RECENT_DIRS,
  START_CWD,
  statusMark,
  validationFor,
  WorkbenchFrame,
} from './launchShared';
import { editBuffer, useCapture, type VariantProps } from './shell';

type Phase = 'nav' | 'sheet';

const DIR_CHOICES = [START_CWD, ...RECENT_DIRS];

export default function VariantK({ profiles }: VariantProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [pi, setPi] = useState(0);
  const [phase, setPhase] = useState<Phase>('nav');
  const [dirBuf, setDirBuf] = useState(START_CWD);
  const [editing, setEditing] = useState(false);
  const [showDry, setShowDry] = useState(false);

  const p = profiles[pi];
  const v = p ? validationFor(p) : { status: 'valid' as const, findings: [] };
  const blocked = v.status === 'error';
  const { mark, color } = statusMark(v.status);
  const rows = stdout.rows ?? 24;

  const busy = phase === 'sheet';
  useEffect(() => {
    setCapture(busy);
    return () => setCapture(false);
  }, [busy, setCapture]);

  const openSheet = () => {
    setDirBuf(START_CWD);
    setEditing(false);
    setShowDry(false);
    setPhase('sheet');
  };

  const launch = () => {
    bridge.pending = { profileName: p.name, cwd: dirBuf, resume: false };
    exit();
  };

  useInput((input, key) => {
    if (!p) return;
    if (phase === 'nav') {
      if (input === 'l') openSheet();
      return;
    }
    // sheet
    if (editing) {
      if (key.escape) setEditing(false);
      else if (key.return) setEditing(false);
      else setDirBuf((b) => editBuffer(b, input, key));
      return;
    }
    if (key.escape) {
      setPhase('nav');
      return;
    }
    if (key.tab) {
      const i = DIR_CHOICES.indexOf(dirBuf);
      setDirBuf(DIR_CHOICES[(i + 1) % DIR_CHOICES.length]);
      return;
    }
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= DIR_CHOICES.length) {
      setDirBuf(DIR_CHOICES[digit - 1]);
      return;
    }
    if (input === 'e') setEditing(true);
    else if (input === 'd') setShowDry((s) => !s);
    else if (key.return && !blocked) launch();
  });

  const navMain = p ? (
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
      <Box flexGrow={1} />
      <Text color="cyan">[l] launch — pick the project directory, then go</Text>
    </>
  ) : (
    <Text dimColor>No Profiles yet.</Text>
  );

  const sheetMain = p ? (
    <>
      <Text bold>
        Launch: {p.name} <Text dimColor>— {p.description}</Text>
      </Text>
      <Text>
        status: <Text color={color}>{mark} {v.status}</Text>
        {v.status === 'warning' ? (
          <Text color="yellow"> — {v.findings[0].code}: {v.findings[0].message}</Text>
        ) : null}
      </Text>
      {blocked ? (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginY={1}>
          <Text color="red" bold>
            not launch-ready — {v.findings.length} error findings:
          </Text>
          {v.findings.map((f, i) => (
            <Text key={i} wrap="truncate">
              {'  '}
              {f.code}: {f.message}
            </Text>
          ))}
          <Text dimColor wrap="truncate">
            resolve the error findings to enable launch — `ccps validate {p.name}` has the full list
          </Text>
        </Box>
      ) : null}
      <Text> </Text>
      <Text>
        project directory: <Text bold color={editing ? 'yellow' : undefined}>{dirBuf}{editing ? '▏' : ''}</Text>
      </Text>
      <Text dimColor> [tab] cycle · [1]-[{DIR_CHOICES.length}] pick · [e] type a path</Text>
      {DIR_CHOICES.map((d, i) => (
        <Text key={i} color={d === dirBuf ? 'cyan' : 'gray'} wrap="truncate">
          {'  '}
          {i + 1}  {d}
          {i === 0 ? ' (where ccps started)' : ''}
          {d === dirBuf ? ' ✓' : ''}
        </Text>
      ))}
      <Text> </Text>
      {showDry ? (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {dryRunLines(p.name, dirBuf, v).slice(0, Math.max(6, rows - 16)).map((l, i) => (
            <Text key={i} wrap="truncate">
              {l}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexGrow={1} />
      {blocked ? (
        <Text color="red">[enter] launch — disabled until error findings are resolved</Text>
      ) : (
        <Text color="cyan">[d] dry-run plan {showDry ? '▾' : '▸'} · [enter] launch · [esc] cancel</Text>
      )}
      {blocked ? <Text dimColor>[esc] back</Text> : null}
    </>
  ) : null;

  return (
    <WorkbenchFrame
      profiles={profiles}
      pi={pi}
      setPi={setPi}
      navActive={phase === 'nav'}
      footer="K: launch sheet · exit — [l] launch sheet · [↑/↓] select"
    >
      {phase === 'sheet' ? sheetMain : navMain}
    </WorkbenchFrame>
  );
}
