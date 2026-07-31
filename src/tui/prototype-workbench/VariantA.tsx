// PROTOTYPE — Variant A: Miller columns (ranger-style).
// Hierarchy: Profiles → Resource categories → Items → Preview, one column each.
// Search: [/] filters the focused column; [ctrl+f] cross-Profile overlay.
// Actions: [enter] opens a contextual modal. Help: footer hints + [?] cheatsheet.

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
  buildIndex,
  CATEGORIES,
  categoryCount,
  categoryItems,
  fuzzyScore,
  itemPreview,
  searchIndex,
} from './data';
import { editBuffer, useCapture, windowed, type VariantProps } from './shell';

type Mode = 'nav' | 'filter' | 'search' | 'actions' | 'help';

const COL_TITLES = ['Profiles', 'Resources', 'Items'];

function clamp(n: number, len: number) {
  return Math.max(0, Math.min(n, Math.max(0, len - 1)));
}

export default function VariantA({ profiles }: VariantProps) {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [col, setCol] = useState(0);
  const [selP, setSelP] = useState(0);
  const [selC, setSelC] = useState(0);
  const [selI, setSelI] = useState(0);
  const [filters, setFilters] = useState<string[]>(['', '', '']);
  const [mode, setMode] = useState<Mode>('nav');
  const [filterBuf, setFilterBuf] = useState('');
  const [searchBuf, setSearchBuf] = useState('');
  const [searchSel, setSearchSel] = useState(0);
  const [actionSel, setActionSel] = useState(0);
  const [flash, setFlash] = useState('');

  const fprof = useMemo(
    () => profiles.filter((p) => fuzzyScore(filters[0] || ' ', ' ' + p.name) >= 0 && p.name.toLowerCase().includes(filters[0].toLowerCase())),
    [profiles, filters],
  );
  const profile = fprof[clamp(selP, fprof.length)];
  const fcats = CATEGORIES.filter((c) =>
    c.toLowerCase().includes(filters[1].toLowerCase()),
  );
  const category = fcats[clamp(selC, fcats.length)];
  const fitems = profile
    ? categoryItems(profile, category).filter((it) =>
        it.label.toLowerCase().includes(filters[2].toLowerCase()),
      )
    : [];
  const itemIdx = clamp(selI, fitems.length);

  const index = useMemo(() => buildIndex(profiles), [profiles]);
  const results = useMemo(() => searchIndex(index, searchBuf, 12), [index, searchBuf]);

  useEffect(() => {
    setCapture(mode === 'filter' || mode === 'search');
    return () => setCapture(false);
  }, [mode, setCapture]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 1600);
  };

  const actions = (): string[] => {
    if (!profile) return [];
    if (col === 0) return ['Launch', 'Edit settings in VS Code', 'Backup', 'Rename', 'Remove'];
    if (col === 1) return ['Open', 'Edit in VS Code'];
    const item = fitems[itemIdx];
    if (!item) return [];
    if (category === 'Skills')
      return ['Edit in VS Code', 'Remove from Profile', 'Reveal source'];
    if (category === 'Plugins') return ['(Claude-managed — toggle in Claude Code)'];
    return ['Edit in VS Code', 'Remove from Profile'];
  };

  useInput((input, key) => {
    if (mode === 'help') {
      if (input === '?' || key.escape) setMode('nav');
      return;
    }
    if (mode === 'filter') {
      if (key.escape) {
        setMode('nav');
        return;
      }
      if (key.return) {
        setMode('nav');
        return;
      }
      const next = editBuffer(filterBuf, input, key);
      if (next !== filterBuf) {
        setFilterBuf(next);
        setFilters((f) => f.map((v, i) => (i === col ? next : v)));
        if (col === 0) setSelP(0);
        if (col === 1) setSelC(0);
        if (col === 2) setSelI(0);
      }
      return;
    }
    if (mode === 'search') {
      if (key.escape) {
        setMode('nav');
        return;
      }
      if (key.upArrow) setSearchSel((s) => clamp(s - 1, results.length));
      else if (key.downArrow) setSearchSel((s) => clamp(s + 1, results.length));
      else if (key.return && results.length) {
        const r = results[clamp(searchSel, results.length)];
        setFilters(['', '', '']);
        setSelP(profiles.findIndex((p) => p.name === r.profile));
        if (r.categoryIdx >= 0) {
          setSelC(r.categoryIdx);
          setSelI(Math.max(0, r.itemIdx));
          setCol(2);
        } else {
          setCol(0);
        }
        setMode('nav');
        setSearchBuf('');
        setSearchSel(0);
      } else {
        const next = editBuffer(searchBuf, input, key);
        if (next !== searchBuf) {
          setSearchBuf(next);
          setSearchSel(0);
        }
      }
      return;
    }
    if (mode === 'actions') {
      const acts = actions();
      if (key.escape) setMode('nav');
      else if (key.upArrow) setActionSel((s) => clamp(s - 1, acts.length));
      else if (key.downArrow) setActionSel((s) => clamp(s + 1, acts.length));
      else if (key.return && acts.length) {
        const target =
          col === 0 ? profile?.name : col === 1 ? category : fitems[itemIdx]?.label;
        flashMsg(`would run "${acts[clamp(actionSel, acts.length)]}" on ${target} (prototype no-op)`);
        setMode('nav');
      }
      return;
    }
    // nav mode
    if (input === '?') {
      setMode('help');
      return;
    }
    if (key.leftArrow || input === 'h') setCol((c) => Math.max(0, c - 1));
    else if (key.rightArrow || input === 'l') setCol((c) => Math.min(2, c + 1));
    else if (key.upArrow || input === 'k') {
      if (col === 0) setSelP((s) => clamp(s - 1, fprof.length));
      if (col === 1) setSelC((s) => clamp(s - 1, fcats.length));
      if (col === 2) setSelI((s) => clamp(s - 1, fitems.length));
    } else if (key.downArrow || input === 'j') {
      if (col === 0) setSelP((s) => clamp(s + 1, fprof.length));
      if (col === 1) setSelC((s) => clamp(s + 1, fcats.length));
      if (col === 2) setSelI((s) => clamp(s + 1, fitems.length));
    } else if (key.return) {
      setActionSel(0);
      setMode('actions');
    } else if (input === '/') {
      setFilterBuf(filters[col]);
      setMode('filter');
    } else if (key.ctrl && input === 'f') {
      setMode('search');
    } else if (key.escape && filters[col]) {
      setFilters((f) => f.map((v, i) => (i === col ? '' : v)));
    }
  });

  const rows = stdout.rows ?? 24;
  const listH = Math.max(3, rows - 6);
  const cols = stdout.columns ?? 80;
  const w1 = Math.max(16, Math.min(26, Math.floor(cols * 0.22)));
  const w2 = Math.max(16, Math.min(22, Math.floor(cols * 0.18)));
  const w3 = Math.max(20, Math.min(30, Math.floor(cols * 0.24)));

  const renderList = (
    title: string,
    width: number,
    items: { label: string; tag?: string }[],
    sel: number,
    focused: boolean,
    filter: string,
  ) => {
    const { slice, start } = windowed(items, sel, listH);
    return (
      <Box
        flexDirection="column"
        width={width}
        borderStyle={focused ? 'round' : 'single'}
        borderColor={focused ? 'cyan' : 'gray'}
      >
        <Text bold color={focused ? 'cyan' : undefined}>
          {title}
          {filter ? <Text color="yellow"> /{filter}</Text> : null}
        </Text>
        {slice.map((it, i) => {
          const isSel = start + i === sel;
          return (
            <Text key={start + i} inverse={isSel && focused} dimColor={!isSel && !focused}>
              {isSel ? '› ' : '  '}
              {it.label}
              {it.tag ? <Text dimColor> {it.tag}</Text> : null}
            </Text>
          );
        })}
        {items.length === 0 ? <Text dimColor>(empty)</Text> : null}
      </Box>
    );
  };

  const previewLines = profile && category ? itemPreview(profile, category, itemIdx) : [];

  if (mode === 'help') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Variant A — Miller columns · keyboard help</Text>
        <Text> </Text>
        <Text> [←/→ or h/l]  move between columns</Text>
        <Text> [↑/↓ or j/k]  move selection within a column</Text>
        <Text> [enter]       contextual action menu for the selection</Text>
        <Text> [/]           filter the focused column (type, enter to keep, esc to stop)</Text>
        <Text> [ctrl+f]      cross-Profile search (jumps the columns to a hit)</Text>
        <Text> [esc]         clear the focused column's filter</Text>
        <Text> [?]           close this help</Text>
        <Text dimColor> [ctrl+v] next variant · [ctrl+d] toggle data size · [ctrl+c] quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexGrow={1} gap={1} paddingX={1}>
        {renderList(
          `Profiles (${fprof.length})`,
          w1,
          fprof.map((p) => ({
            label: p.name,
            tag: p.isDefault ? '★' : '',
          })),
          clamp(selP, fprof.length),
          col === 0,
          filters[0],
        )}
        {renderList(
          profile ? `Resources — ${profile.name}` : 'Resources',
          w2,
          fcats.map((c) => ({ label: c, tag: profile ? categoryCount(profile, c) : '' })),
          clamp(selC, fcats.length),
          col === 1,
          filters[1],
        )}
        {renderList(
          category ?? 'Items',
          w3,
          fitems.map((it) => ({ label: it.label })),
          itemIdx,
          col === 2,
          filters[2],
        )}
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold dimColor>
            Preview
          </Text>
          {previewLines.slice(0, listH).map((l, i) => (
            <Text key={i} wrap="truncate">
              {l}
            </Text>
          ))}
        </Box>
      </Box>
      {mode === 'filter' ? (
        <Text color="yellow"> filter [{COL_TITLES[col]}]: {filterBuf}▏</Text>
      ) : (
        <Text dimColor>
          {' '}
          [←→] column [↑↓] select [enter] actions [/] filter [ctrl+f] search [?] help
        </Text>
      )}
      {flash ? <Text color="green"> {flash}</Text> : null}
      {mode === 'search' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginX={2}
        >
          <Text bold color="yellow">
            Cross-Profile search: {searchBuf}▏
          </Text>
          {results.map((r, i) => (
            <Text key={i} inverse={i === clamp(searchSel, results.length)}>
              {i === clamp(searchSel, results.length) ? '› ' : '  '}
              {r.profile}
              <Text dimColor> › </Text>
              {r.category ? `${r.category} › ` : ''}
              {r.label} <Text dimColor>{r.detail}</Text>
            </Text>
          ))}
          {!results.length && <Text dimColor> (type to search all Profiles and resources)</Text>}
          <Text dimColor> [↑↓] choose [enter] jump there [esc] close</Text>
        </Box>
      ) : null}
      {mode === 'actions' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          marginX={2}
        >
          <Text bold color="cyan">
            Actions
          </Text>
          {actions().map((a, i) => (
            <Text key={i} inverse={i === clamp(actionSel, actions().length)}>
              {i === clamp(actionSel, actions().length) ? '› ' : '  '}
              {a}
            </Text>
          ))}
          <Text dimColor> [↑↓] choose [enter] run [esc] close</Text>
        </Box>
      ) : null}
    </Box>
  );
}
