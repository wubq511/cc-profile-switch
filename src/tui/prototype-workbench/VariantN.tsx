// PROTOTYPE — Variant N (issue #30): "compare futures" — pick the outcome, not
// the option. Two equal columns render Profile "coding"'s Skills AFTER install
// under Copy vs under Link (resulting list entry, what source edits do later,
// what removal does, checks per side). The cursor starts on the Copy future;
// [enter] chooses the future under the cursor. Semantics are taught by showing
// consequences, not prose. Sim: [f] toggles "platform denies links".

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
  Breadcrumb,
  checksFor,
  collides,
  EXISTING_SKILLS,
  LOCAL_SOURCES,
  suggestName,
  TARGET_DIR,
  type InstallMode,
} from './installShared';
import { editBuffer, useCapture } from './shell';

export default function VariantN() {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [picked, setPicked] = useState(false);
  const [si, setSi] = useState(0);
  const [col, setCol] = useState<InstallMode>('copy');
  const [denied, setDenied] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const src = LOCAL_SOURCES[si];
  const installName = name || src.name;
  const collision = collides(installName);

  useEffect(() => {
    setCapture(editing);
    return () => setCapture(false);
  }, [editing, setCapture]);

  const cols = stdout.columns ?? 80;
  const colW = Math.floor((cols - 8) / 2);

  useInput((input, key) => {
    if (editing) {
      if (key.escape || key.return) setEditing(false);
      else setName((b) => editBuffer(b, input, key));
      return;
    }
    if (input === 'f') {
      setDenied((d) => !d);
      return;
    }
    if (!picked) {
      if (key.upArrow) setSi((i) => Math.max(0, i - 1));
      else if (key.downArrow) setSi((i) => Math.min(LOCAL_SOURCES.length - 1, i + 1));
      else if (key.return) {
        setName('');
        setPicked(true);
      }
      return;
    }
    if (key.escape) {
      setPicked(false);
      return;
    }
    if (collision) {
      if (input === 'r') {
        setName(suggestName(installName));
        return;
      }
      if (input === 'e') {
        setName(installName);
        setEditing(true);
        return;
      }
      if (input === 'v') {
        setFlash(`replaced "${installName}" — old copy → Recovery Bin, 30d · installed (prototype no-op)`);
        setPicked(false);
        setName('');
        return;
      }
    }
    if (key.leftArrow || key.rightArrow) {
      setCol((c) => (c === 'copy' ? 'link' : 'copy'));
      return;
    }
    if (key.return) {
      const checks = checksFor(src, col, denied);
      if (!src.valid || collision) {
        setFlash('✕ cannot install — resolve the blocker below first');
        return;
      }
      if (col === 'link' && checks.some((c) => !c.ok)) {
        setFlash('✕ Link is unavailable here — nothing written; the Copy future still works');
        return;
      }
      setFlash(
        col === 'copy'
          ? `installed "${installName}" — snapshot owned by Profile "coding" (prototype no-op)`
          : `linked "${installName}" → ${src.path} — source edits appear live (prototype no-op)`,
      );
      setPicked(false);
      setName('');
    }
  });

  if (!picked) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Breadcrumb extra="pick a source, then compare" />
        <Text> </Text>
        <Text bold>Which Local Skill Source?</Text>
        <Text> </Text>
        {LOCAL_SOURCES.map((s, i) => (
          <Text key={s.path} inverse={i === si} wrap="truncate">
            {'  '}
            {s.path} {s.valid ? '' : '  ⚠ no SKILL.md'}
          </Text>
        ))}
        <Box flexGrow={1} />
        {flash ? <Text color="green"> {flash}</Text> : null}
        <Text color="cyan">[↑/↓] choose · [enter] compare futures</Text>
      </Box>
    );
  }

  const future = (m: InstallMode) => {
    const sel = col === m;
    const checks = checksFor(src, m, denied);
    const unavailable = m === 'link' && checks.some((c) => !c.ok);
    const entry =
      m === 'copy'
        ? [`${installName} ← new`, `copied (profile-owned)`]
        : [`${installName} ← new`, `⇢ ${src.path}`];
    const later =
      m === 'copy'
        ? ['source edits → no effect here', 'update → re-copy (undo 3 days)', 'remove → Recovery Bin, source untouched']
        : ['source edits → appear live', 'update → nothing to do, it is live', 'remove → link only, source kept'];
    return (
      <Box
        flexDirection="column"
        width={colW}
        borderStyle={sel ? 'round' : 'single'}
        borderColor={sel ? (unavailable ? 'red' : 'cyan') : 'gray'}
        paddingX={1}
      >
        <Text bold={sel} color={sel ? (unavailable ? 'red' : 'cyan') : undefined}>
          {sel ? '▶' : ' '} {m === 'copy' ? 'If you Copy (default)' : 'If you Link'}
        </Text>
        <Text> </Text>
        <Text dimColor>coding › Skills becomes:</Text>
        {EXISTING_SKILLS.slice(0, 3).map((s) => (
          <Text key={s.name} dimColor wrap="truncate">
            {'  '}
            {s.name}
          </Text>
        ))}
        <Text wrap="truncate">
          {'  '}
          <Text bold color={unavailable ? 'red' : 'green'}>
            {entry[0]}
          </Text>
        </Text>
        <Text dimColor wrap="truncate">
          {'    '}
          {entry[1]}
        </Text>
        <Text dimColor>{'  '}…</Text>
        <Text> </Text>
        <Text dimColor>later:</Text>
        {later.map((l, i) => (
          <Text key={i} wrap="truncate">
            {'  '}
            {l}
          </Text>
        ))}
        <Text> </Text>
        {checks.map((c, i) => (
          <Text key={i} color={c.ok ? 'green' : 'red'} wrap="truncate">
            {'  '}
            {c.ok ? '✓' : '✕'} {c.text}
          </Text>
        ))}
        {unavailable ? (
          <Text color="red" wrap="wrap">
            {'  '}this future is unavailable on this platform — Copy still works
          </Text>
        ) : null}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Breadcrumb extra={`${src.path} → choose the future`} />
      <Text> </Text>
      <Box gap={2}>
        {future('copy')}
        {future('link')}
      </Box>
      <Text> </Text>
      <Text dimColor>
        target: {TARGET_DIR}/{installName}
        {collision ? `  ⚠ "${installName}" exists (${collision.kind})` : ''}
      </Text>
      {collision ? (
        <Text color="yellow" wrap="truncate">
          [r] rename → "{suggestName(installName)}" · [e] type a name · [v] replace (old copy → Recovery Bin, 30d)
        </Text>
      ) : null}
      <Box flexGrow={1} />
      {flash ? <Text color="green"> {flash}</Text> : null}
      <Text dimColor>
        [←/→] compare · [enter] take this future · [esc] change source · sim [f] denies links: {denied ? 'ON' : 'off'}
      </Text>
    </Box>
  );
}
