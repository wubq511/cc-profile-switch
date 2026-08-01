// PROTOTYPE — Variant L (issue #32): the combined launch flow from the human's
// round-one verdicts on poles J/K:
//   directory step  — compromise: [l] launch-here bar (ccps start dir, zero
//                     steps) + [L] a directory screen (current / recents /
//                     typed) only when you want elsewhere
//   blockers        — K style: inline red box, launch key disabled
//   dry-run         — J style: full-screen plan page
//   after-exit      — UNRESOLVED in round one (the stand-in looked like the
//                     user's normal shell, so resume-vs-exit couldn't be
//                     judged); [t] toggles resume ↔ exit at runtime to feel both.

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

type Phase = 'nav' | 'bar' | 'dirs' | 'dry';
type AfterExit = 'resume' | 'exit';

const DIR_CHOICES = [START_CWD, ...RECENT_DIRS];

export default function VariantL({ profiles }: VariantProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [pi, setPi] = useState(() => {
    const last = bridge.lastExit;
    const i = last ? profiles.findIndex((p) => p.name === last.profileName) : -1;
    return i >= 0 ? i : 0;
  });
  const [phase, setPhase] = useState<Phase>('nav');
  const [dirBuf, setDirBuf] = useState(START_CWD);
  const [editing, setEditing] = useState(false);
  const [afterExit, setAfterExit] = useState<AfterExit>('resume');
  const [flash] = useState<string | null>(() =>
    bridge.lastExit
      ? `Claude Code exited (${bridge.lastExit.code ?? 0}) — Workbench resumed on "${bridge.lastExit.profileName}"`
      : null,
  );
  useEffect(() => {
    bridge.lastExit = null; // consume the resume flash
  }, []);

  const p = profiles[pi];
  const v = p ? validationFor(p) : { status: 'valid' as const, findings: [] };
  const blocked = v.status === 'error';
  const { mark, color } = statusMark(v.status);
  const rows = stdout.rows ?? 24;

  const busy = phase !== 'nav';
  useEffect(() => {
    setCapture(busy);
    return () => setCapture(false);
  }, [busy, setCapture]);

  const launch = () => {
    bridge.pending = { profileName: p.name, cwd: dirBuf, resume: afterExit === 'resume' };
    exit();
  };

  const toggleExit = () => setAfterExit((a) => (a === 'resume' ? 'exit' : 'resume'));

  useInput((input, key) => {
    if (!p) return;
    if (phase === 'nav') {
      if (input === 'l') setPhase('bar');
      else if (input === 'L') setPhase('dirs');
      else if (input === 'd') setPhase('dry');
      return;
    }
    if (phase === 'bar') {
      if (key.escape) setPhase('nav');
      else if (input === 'L') setPhase('dirs');
      else if (input === 'd') setPhase('dry');
      else if (input === 't') toggleExit();
      else if (key.return && !blocked) launch();
      return;
    }
    if (phase === 'dry') {
      if (key.escape) setPhase('bar');
      else if (input === 't') toggleExit();
      else if (key.return && !blocked) launch();
      return;
    }
    // dirs
    if (editing) {
      if (key.escape || key.return) setEditing(false);
      else setDirBuf((b) => editBuffer(b, input, key));
      return;
    }
    if (key.escape) {
      setPhase('bar');
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
    else if (input === 'd') setPhase('dry');
    else if (input === 't') toggleExit();
    else if (key.return && !blocked) launch();
  });

  const blockerBox = (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginY={1}>
      <Text color="red" bold>
        ✕ not launch-ready — {v.findings.length} error findings:
      </Text>
      {v.findings.map((f, i) => (
        <Text key={i} wrap="truncate">
          {'  '}
          {f.code}: {f.message}
        </Text>
      ))}
      <Text dimColor wrap="truncate">
        resolve the error findings to enable launch — `ccps validate {p?.name}` has the full list
      </Text>
    </Box>
  );

  if (phase === 'dry' && p) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        {dryRunLines(p.name, dirBuf, v).slice(0, rows - 4).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        <Box flexGrow={1} />
        {blocked ? (
          <Text color="red"> launch disabled — resolve error findings first · [esc] back</Text>
        ) : (
          <Text color="cyan">
            {' '}
            [enter] launch · after-exit: {afterExit} [t] · [esc] back
          </Text>
        )}
      </Box>
    );
  }

  const dirsMain = p ? (
    <>
      <Text bold>
        Launch: {p.name} <Text dimColor>— choose the project directory</Text>
      </Text>
      <Text>
        status: <Text color={color}>{mark} {v.status}</Text>
      </Text>
      {blocked ? blockerBox : null}
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
      <Box flexGrow={1} />
      {blocked ? (
        <Text color="red">[enter] launch — disabled until error findings are resolved</Text>
      ) : (
        <Text color="cyan">
          [enter] launch · after-exit: {afterExit} [t] · [d] dry-run · [esc] back
        </Text>
      )}
    </>
  ) : null;

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
      <Text> </Text>
      <Text>
        launch directory: <Text bold>{dirBuf}</Text>
      </Text>
      <Text dimColor wrap="wrap">
        Claude starts in the chosen directory — that project's own config always applies
      </Text>
      <Box flexGrow={1} />
      <Text color="cyan">[l] launch here · [L] launch elsewhere · [d] dry-run</Text>
    </>
  ) : (
    <Text dimColor>No Profiles yet.</Text>
  );

  const barPanel = p ? (
    <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={blocked ? 'red' : 'cyan'} paddingX={1} marginX={1}>
      <Text bold>
        Launch {p.name} → {dirBuf}
        <Text dimColor>
          {'   '}after-exit: {afterExit} [t]
        </Text>
      </Text>
      {v.status === 'warning' ? (
        <Text color="yellow">
          ⚠ {v.findings[0].code}: {v.findings[0].message} — launchable
        </Text>
      ) : null}
      {blocked ? (
        <>
          {v.findings.map((f, i) => (
            <Text key={i} color="red" wrap="truncate">
              {'  '}
              {f.code}: {f.message}
            </Text>
          ))}
          <Text dimColor wrap="truncate">
            resolve the error findings to enable launch — `ccps validate {p.name}`
          </Text>
        </>
      ) : null}
      <Text dimColor>
        {' '}
        {blocked ? '[enter] launch (disabled)' : '[enter] launch'} · [L] choose directory · [d] dry-run · [esc] cancel
      </Text>
    </Box>
  ) : null;

  return (
    <WorkbenchFrame
      profiles={profiles}
      pi={pi}
      setPi={setPi}
      navActive={phase === 'nav'}
      footer="L: combined launch — [l] here · [L] elsewhere · [d] dry-run · [↑/↓] select"
    >
      {phase === 'dirs' ? dirsMain : navMain}
      {phase === 'bar' ? barPanel : null}
      {phase === 'nav' && flash ? <Text color="green"> {flash}</Text> : null}
    </WorkbenchFrame>
  );
}
