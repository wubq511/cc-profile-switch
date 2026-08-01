// PROTOTYPE — Variant M (issue #30): install flow as ONE live sheet.
// Source, Copy/Link radio (equal weight, Copy on by default), target-change
// preview and health checks all on a single screen; every section re-renders
// live as you move. [tab] cycles focus: source → mode → confirm.
// Sim: [f] toggles "platform denies links".

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  Breadcrumb,
  canInstall,
  checksFor,
  collides,
  LOCAL_SOURCES,
  previewLines,
  suggestName,
  type InstallMode,
} from './installShared';
import { editBuffer, useCapture } from './shell';

type Focus = 'source' | 'mode' | 'go';

export default function VariantP() {
  const setCapture = useCapture();
  const [focus, setFocus] = useState<Focus>('source');
  const [si, setSi] = useState(0);
  const [mode, setMode] = useState<InstallMode>('copy');
  const [denied, setDenied] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState<{ text: string; color: string } | null>(null);

  const src = LOCAL_SOURCES[si];
  const installName = name || src.name;
  const collision = collides(installName);
  const checks = checksFor(src, mode, denied);
  const blocked = !canInstall(src, mode, denied, installName);

  useEffect(() => {
    setCapture(editing);
    return () => setCapture(false);
  }, [editing, setCapture]);

  const say = (text: string, color = 'green') => setFlash({ text, color });

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
    if (key.tab) {
      setFocus((fo) => (fo === 'source' ? 'mode' : fo === 'mode' ? 'go' : 'source'));
      return;
    }
    if (key.escape) {
      say('cancelled — nothing written', 'gray');
      return;
    }
    if (focus === 'source') {
      if (key.upArrow) {
        setSi((i) => Math.max(0, i - 1));
        setName('');
      } else if (key.downArrow) {
        setSi((i) => Math.min(LOCAL_SOURCES.length - 1, i + 1));
        setName('');
      }
      return;
    }
    if (focus === 'mode') {
      if (key.leftArrow || key.rightArrow || input === ' ') setMode((m) => (m === 'copy' ? 'link' : 'copy'));
      return;
    }
    // focus === 'go'
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
        say(`replaced "${installName}" — old copy → Recovery Bin, 30d · installed (prototype no-op)`);
        setName('');
        return;
      }
    }
    if (mode === 'link' && denied && input === 'c') {
      setMode('copy');
      return;
    }
    if (key.return) {
      if (blocked) {
        say('✕ cannot install — resolve the failed checks first', 'red');
        return;
      }
      say(
        mode === 'copy'
          ? `installed "${installName}" — snapshot owned by Profile "coding" (prototype no-op)`
          : `linked "${installName}" → ${src.path} — source edits appear live (prototype no-op)`,
      );
      setName('');
    }
  });

  const section = (title: string, active: boolean, children: React.ReactNode) => (
    <Box
      flexDirection="column"
      borderStyle={active ? 'round' : 'single'}
      borderColor={active ? 'cyan' : 'gray'}
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color={active ? 'cyan' : undefined}>
        {title}
      </Text>
      {children}
    </Box>
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Breadcrumb extra="one screen — everything live" />
      <Text> </Text>
      {section(
        '1 · Local Skill Source',
        focus === 'source',
        <>
          {LOCAL_SOURCES.map((s, i) => (
            <Text key={s.path} inverse={focus === 'source' && i === si} wrap="truncate">
              {'  '}
              {i === si ? '●' : '○'} {s.path} {s.valid ? '' : ' ⚠ no SKILL.md'}
            </Text>
          ))}
        </>,
      )}
      {section(
        '2 · Install as  (Copy is the default)',
        focus === 'mode',
        <Box gap={4}>
          <Box flexDirection="column" width={34}>
            <Text bold={mode === 'copy'} color={mode === 'copy' ? 'cyan' : undefined}>
              {mode === 'copy' ? '●' : '○'} Copy
            </Text>
            <Text wrap="wrap">Profile-owned snapshot. Source edits never flow in; update = re-copy.</Text>
          </Box>
          <Box flexDirection="column" width={34}>
            <Text bold={mode === 'link'} color={mode === 'link' ? 'cyan' : undefined}>
              {mode === 'link' ? '●' : '○'} Link
            </Text>
            <Text wrap="wrap">Uses the source live. Edits appear immediately; removal never deletes it.</Text>
          </Box>
        </Box>,
      )}
      {section(
        '3 · Preview & checks',
        focus === 'go',
        <>
          {previewLines(src, mode, installName).map((l, i) => (
            <Text key={i} dimColor wrap="truncate">
              {'  '}
              {l}
            </Text>
          ))}
          {checks.map((c, i) => (
            <Text key={i} color={c.ok ? 'green' : 'red'} wrap="truncate">
              {'  '}
              {c.ok ? '✓' : '✕'} {c.text}
            </Text>
          ))}
          {collision ? (
            <Text color="yellow" wrap="truncate">
              {'  '}⚠ "{installName}" exists ({collision.kind}) — [r] rename → "{suggestName(installName)}" · [e] type · [v] replace (→ Recovery Bin)
            </Text>
          ) : null}
          {mode === 'link' && denied ? (
            <Text color="yellow" wrap="truncate">
              {'  '}[c] fall back to Copy — same source, Profile-owned snapshot
            </Text>
          ) : null}
          <Text color={blocked ? 'gray' : 'cyan'}>
            {'  '}[enter] {blocked ? 'install (blocked — see ✕ above)' : `install "${installName}"`}
          </Text>
        </>,
      )}
      <Box flexGrow={1} />
      {flash ? <Text color={flash.color}> {flash.text}</Text> : null}
      <Text dimColor>
        [tab] section · sim [f] denies links: {denied ? 'ON' : 'off'} · sheet variant — all decisions on one screen
      </Text>
    </Box>
  );
}
