// PROTOTYPE — Variant C: Search-first palette (Raycast/fzf-style).
// No persistent tree: the app IS a search box over all Profiles and resources.
// Enter opens a detail page; esc walks back. [tab] opens actions on a result.
// Help: inline hint line + [?] cheatsheet.

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
  buildIndex,
  CATEGORIES,
  categoryCount,
  categoryItems,
  itemPreview,
  searchIndex,
  type Category,
  type SearchEntry,
} from './data';
import { editBuffer, useCapture, windowed, type VariantProps } from './shell';

type Mode =
  | { name: 'search' }
  | { name: 'detail'; entry: SearchEntry }
  | { name: 'actions'; entry: SearchEntry }
  | { name: 'help' };

function clamp(n: number, len: number) {
  return Math.max(0, Math.min(n, Math.max(0, len - 1)));
}

export default function VariantC({ profiles }: VariantProps) {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [mode, setMode] = useState<Mode>({ name: 'search' });
  const [buf, setBuf] = useState('');
  const [sel, setSel] = useState(0);
  const [actionSel, setActionSel] = useState(0);
  const [flash, setFlash] = useState('');

  const index = useMemo(() => buildIndex(profiles), [profiles]);
  const results = useMemo(
    () => (buf.trim() ? searchIndex(index, buf, 14) : index.filter((e) => e.kind === 'profile').slice(0, 14)),
    [index, buf],
  );

  useEffect(() => {
    setCapture(mode.name === 'search');
    return () => setCapture(false);
  }, [mode, setCapture]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 1600);
  };

  const actionsFor = (e: SearchEntry): string[] => {
    if (e.kind === 'profile') return ['Launch', 'Edit settings in VS Code', 'Backup', 'Rename', 'Remove'];
    if (e.category === 'Plugins') return ['(Claude-managed — change via Claude Code)'];
    if (e.category === 'Skills') return ['Edit in VS Code', 'Remove from Profile', 'Reveal source'];
    return ['Edit in VS Code', 'Remove from Profile'];
  };

  useInput((input, key) => {
    if (mode.name === 'help') {
      if (input === '?' || key.escape) setMode({ name: 'search' });
      return;
    }
    if (mode.name === 'search') {
      if (key.upArrow) setSel((s) => clamp(s - 1, results.length));
      else if (key.downArrow) setSel((s) => clamp(s + 1, results.length));
      else if (key.tab && results.length) {
        setActionSel(0);
        setMode({ name: 'actions', entry: results[clamp(sel, results.length)] });
      } else if (key.return && results.length) {
        setMode({ name: 'detail', entry: results[clamp(sel, results.length)] });
      } else if (input === '?' && !buf) {
        setMode({ name: 'help' });
      } else if (key.escape) {
        if (buf) setBuf('');
      } else {
        const next = editBuffer(buf, input, key);
        if (next !== buf) {
          setBuf(next);
          setSel(0);
        }
      }
      return;
    }
    if (mode.name === 'actions') {
      const acts = actionsFor(mode.entry);
      if (key.escape || key.tab) {
        setMode({ name: 'search' });
        return;
      }
      if (key.upArrow) setActionSel((s) => clamp(s - 1, acts.length));
      else if (key.downArrow) setActionSel((s) => clamp(s + 1, acts.length));
      else if (key.return && acts.length) {
        flashMsg(`would run "${acts[clamp(actionSel, acts.length)]}" on ${mode.entry.label} (prototype no-op)`);
        setMode({ name: 'search' });
      }
      return;
    }
    // detail
    if (key.escape) setMode({ name: 'search' });
    else if (input === '?') setMode({ name: 'help' });
  });

  const rows = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;
  const boxW = Math.min(cols - 4, 84);
  const listH = Math.max(4, rows - 10);
  const { slice, start } = windowed(results, clamp(sel, results.length), listH);

  if (mode.name === 'help') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Variant C — Search-first palette · keyboard help</Text>
        <Text> </Text>
        <Text> [type]      search all Profiles and resources (empty = list Profiles)</Text>
        <Text> [↑/↓]       move through results</Text>
        <Text> [enter]     open the selected result</Text>
        <Text> [tab]       actions for the selected result</Text>
        <Text> [esc]       clear the query, then walk back</Text>
        <Text> [?]         this help (on an empty query)</Text>
        <Text dimColor> [ctrl+v] next variant · [ctrl+d] toggle data size · [ctrl+c] quit</Text>
      </Box>
    );
  }

  if (mode.name === 'detail') {
    const e = mode.entry;
    const p = profiles[e.profileIdx];
    const lines: string[] = [];
    if (e.kind === 'profile') {
      lines.push(
        p.description,
        `default: ${p.isDefault ? 'yes' : 'no'}   last used: ${p.lastUsed}   projects: ${p.projects}`,
        '',
        ...CATEGORIES.map((c) => `  ${c.padEnd(14)} ${categoryCount(p, c)}`),
      );
    } else if (e.itemIdx >= 0 && e.category) {
      lines.push(...itemPreview(p, e.category as Category, e.itemIdx));
    } else if (e.category) {
      lines.push(...categoryItems(p, e.category as Category).map((it) => `  ${it.label} — ${it.detail}`));
    }
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold color="cyan">
          {e.profile}
          {e.category ? ` › ${e.category}` : ''}
          {e.kind === 'item' ? ` › ${e.label}` : ''}
        </Text>
        <Text> </Text>
        {lines.map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        <Box flexGrow={1} />
        {flash ? <Text color="green"> {flash}</Text> : null}
        <Text dimColor> [esc] back to search · [tab] actions (on a result) · [ctrl+c] quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" paddingTop={1}>
      <Box flexDirection="column" width={boxW}>
        <Box borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">
            🔎 {buf}
            <Text backgroundColor="cyan" color="black">
              {' '}
            </Text>
          </Text>
        </Box>
        {slice.map((r, i) => {
          const isSel = start + i === clamp(sel, results.length);
          return (
            <Text key={start + i} inverse={isSel} wrap="truncate">
              {isSel ? '› ' : '  '}
              <Text color={r.kind === 'profile' ? 'green' : undefined}>
                {r.kind === 'profile' ? '◆ ' : '  '}
              </Text>
              {r.profile}
              <Text dimColor> › </Text>
              {r.category ? `${r.category} › ` : ''}
              {r.kind === 'item' ? r.label : r.detail}
            </Text>
          );
        })}
        {!results.length && <Text dimColor> no matches</Text>}
        <Text dimColor>
          {' '}
          [↑↓] choose [enter] open [tab] actions [esc] clear{!buf ? ' [?] help' : ''}
        </Text>
        {flash ? <Text color="green"> {flash}</Text> : null}
      </Box>
      {mode.name === 'actions' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={Math.min(50, boxW)}>
          <Text bold color="yellow">
            Actions — {mode.entry.label}
          </Text>
          {actionsFor(mode.entry).map((a, i) => (
            <Text key={i} inverse={i === clamp(actionSel, actionsFor(mode.entry).length)}>
              {i === clamp(actionSel, actionsFor(mode.entry).length) ? '› ' : '  '}
              {a}
            </Text>
          ))}
          <Text dimColor> [↑↓] choose [enter] run [esc] back</Text>
        </Box>
      ) : null}
    </Box>
  );
}
