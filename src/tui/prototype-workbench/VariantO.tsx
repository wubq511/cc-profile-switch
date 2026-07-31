// PROTOTYPE — Variant L (issue #30): install flow as a 3-step wizard.
// Step 1 pick the Local Skill Source → step 2 mode cards (Copy / Link at equal
// visual weight, Copy selected by default, ownership & update semantics on the
// cards) → step 3 confirm with target-change preview, health checks, collision
// resolution, and the fail-safe path when the platform cannot create a link.
// Sim: [f] toggles "platform denies links" on every step.

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
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

type Step = 'source' | 'mode' | 'confirm';

export default function VariantO() {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [step, setStep] = useState<Step>('source');
  const [si, setSi] = useState(0);
  const [mode, setMode] = useState<InstallMode>('copy');
  const [denied, setDenied] = useState(false);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const src = LOCAL_SOURCES[si];
  const installName = name || src.name;
  const collision = collides(installName);
  const checks = checksFor(src, mode, denied);
  const blocked = !canInstall(src, mode, denied, installName);

  useEffect(() => {
    setCapture(editing);
    return () => setCapture(false);
  }, [editing, setCapture]);

  const cols = stdout.columns ?? 80;
  const cardW = Math.min(34, Math.floor((cols - 10) / 2));

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        return;
      }
      if (key.return) {
        setEditing(false);
        return;
      }
      setName((b) => editBuffer(b, input, key));
      return;
    }
    if (input === 'f') {
      setDenied((d) => !d);
      return;
    }
    if (key.escape) {
      if (step === 'mode') setStep('source');
      else if (step === 'confirm') setStep('mode');
      return;
    }
    if (step === 'source') {
      if (key.upArrow) setSi((i) => Math.max(0, i - 1));
      else if (key.downArrow) setSi((i) => Math.min(LOCAL_SOURCES.length - 1, i + 1));
      else if (key.return) {
        setName('');
        setStep('mode');
      }
      return;
    }
    if (step === 'mode') {
      if (key.leftArrow || key.rightArrow) setMode((m) => (m === 'copy' ? 'link' : 'copy'));
      else if (key.return) setStep('confirm');
      return;
    }
    // confirm
    if (mode === 'link' && denied && input === 'c') {
      setMode('copy'); // safe fallback: same source, Profile-owned snapshot
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
        setFlash(
          `replaced "${installName}" — old copy → Recovery Bin, 30d · installed ${mode === 'copy' ? 'snapshot' : 'link'} (prototype no-op)`,
        );
        setStep('source');
        return;
      }
    }
    if (key.return) {
      if (blocked) {
        setFlash('✕ cannot install — resolve the failed checks first');
        return;
      }
      setFlash(
        mode === 'copy'
          ? `installed "${installName}" — snapshot owned by Profile "coding" (prototype no-op)`
          : `linked "${installName}" → ${src.path} — source edits appear live (prototype no-op)`,
      );
      setStep('source');
      setName('');
    }
  });

  const modeCard = (m: InstallMode, title: string, lines: string[]) => {
    const sel = mode === m;
    return (
      <Box
        flexDirection="column"
        width={cardW}
        borderStyle={sel ? 'round' : 'single'}
        borderColor={sel ? 'cyan' : 'gray'}
        paddingX={1}
      >
        <Text bold={sel} color={sel ? 'cyan' : undefined}>
          {sel ? '●' : '○'} {title}
          {m === 'copy' ? <Text dimColor>  (default)</Text> : null}
        </Text>
        {lines.map((l, i) => (
          <Text key={i} wrap="wrap">
            {l}
          </Text>
        ))}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Breadcrumb extra={`step ${step === 'source' ? '1/3 source' : step === 'mode' ? '2/3 copy or link' : '3/3 confirm'}`} />
      <Text> </Text>
      {step === 'source' && (
        <Box flexDirection="column">
          <Text bold>Which Local Skill Source?</Text>
          <Text dimColor>a directory on this machine containing a Skill</Text>
          <Text> </Text>
          {LOCAL_SOURCES.map((s, i) => (
            <Text key={s.path} inverse={i === si} wrap="truncate">
              {'  '}
              {s.path} {s.valid ? '' : '  ⚠ no SKILL.md'}
            </Text>
          ))}
          <Text> </Text>
          <Text color="cyan">[↑/↓] choose · [enter] continue</Text>
        </Box>
      )}
      {step === 'mode' && (
        <Box flexDirection="column">
          <Text bold>
            Install "{src.name}" — as a Copy or a Link?
          </Text>
          <Text dimColor>{src.path}</Text>
          <Text> </Text>
          <Box gap={2}>
            {modeCard('copy', 'Copy', [
              'Profile owns an independent snapshot.',
              'Source edits never flow in.',
              'Update = re-copy later (undo via Recovery Bin).',
            ])}
            {modeCard('link', 'Link', [
              'Profile uses the source live.',
              'Source edits appear immediately.',
              'Removing the link never deletes the source.',
            ])}
          </Box>
          <Text> </Text>
          <Text color="cyan">[←/→] choose · [enter] continue · [esc] back</Text>
        </Box>
      )}
      {step === 'confirm' && (
        <Box flexDirection="column">
          <Text bold>
            Confirm — install "{installName}" ({mode === 'copy' ? 'Copy' : 'Link'})
          </Text>
          <Text> </Text>
          <Text dimColor>what changes in Profile "coding":</Text>
          {previewLines(src, mode, installName).map((l, i) => (
            <Text key={i} wrap="truncate">
              {'  '}
              {l}
            </Text>
          ))}
          <Text> </Text>
          <Text dimColor>checks:</Text>
          {checks.map((c, i) => (
            <Text key={i} color={c.ok ? 'green' : 'red'} wrap="truncate">
              {'  '}
              {c.ok ? '✓' : '✕'} {c.text}
            </Text>
          ))}
          <Text> </Text>
          {collision ? (
            <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text color="yellow">
                ⚠ "{installName}" already exists ({collision.kind})
              </Text>
              <Text> [r] rename to "{suggestName(installName)}"   [e] type a name</Text>
              <Text> [v] replace it — old copy → Recovery Bin (30 days)</Text>
              <Text dimColor> [esc] back</Text>
            </Box>
          ) : blocked ? (
            <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
              <Text color="red">✕ cannot install — nothing was written</Text>
              {mode === 'link' && denied ? (
                <Text> [c] fall back to Copy — same source, Profile-owned snapshot</Text>
              ) : (
                <Text> pick a valid Skill source ([esc] back)</Text>
              )}
            </Box>
          ) : (
            <Text color="cyan">[enter] install · [esc] back</Text>
          )}
        </Box>
      )}
      <Box flexGrow={1} />
      {flash ? <Text color="green"> {flash}</Text> : null}
      <Text dimColor>
        sim: [f] platform denies links: {denied ? 'ON' : 'off'} · wizard variant — one decision per screen
      </Text>
    </Box>
  );
}
