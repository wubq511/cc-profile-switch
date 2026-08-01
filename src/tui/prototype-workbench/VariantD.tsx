// PROTOTYPE — Variant D: Guided hub + drill-down (menu-style).
// Home screen of Profile cards → Profile screen of numbered resource rows →
// item screen. Every screen prints its own keys at the bottom; nothing is
// hidden behind a cheatsheet. Search: [s] overlay, secondary to browsing.

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
} from './data';
import { editBuffer, useCapture, windowed, type VariantProps } from './shell';

type Screen =
  | { name: 'home' }
  | { name: 'profile'; pi: number }
  | { name: 'category'; pi: number; ci: number };

function clamp(n: number, len: number) {
  return Math.max(0, Math.min(n, Math.max(0, len - 1)));
}

export default function VariantD({ profiles }: VariantProps) {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [homeSel, setHomeSel] = useState(0);
  const [profSel, setProfSel] = useState(0);
  const [itemSel, setItemSel] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [buf, setBuf] = useState('');
  const [searchSel, setSearchSel] = useState(0);
  const [flash, setFlash] = useState('');

  const index = useMemo(() => buildIndex(profiles), [profiles]);
  const results = useMemo(() => searchIndex(index, buf, 8), [index, buf]);

  useEffect(() => {
    setCapture(searchOpen);
    return () => setCapture(false);
  }, [searchOpen, setCapture]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 1600);
  };

  const back = () => {
    setScreen((s) =>
      s.name === 'category' ? { name: 'profile', pi: s.pi } : s.name === 'profile' ? { name: 'home' } : s,
    );
  };

  useInput((input, key) => {
    if (searchOpen) {
      if (key.escape) {
        setSearchOpen(false);
        setBuf('');
        return;
      }
      if (key.upArrow) setSearchSel((s) => clamp(s - 1, results.length));
      else if (key.downArrow) setSearchSel((s) => clamp(s + 1, results.length));
      else if (key.return && results.length) {
        const r = results[clamp(searchSel, results.length)];
        if (r.categoryIdx >= 0) {
          setScreen({ name: 'category', pi: r.profileIdx, ci: r.categoryIdx });
          setItemSel(Math.max(0, r.itemIdx));
        } else {
          setScreen({ name: 'profile', pi: r.profileIdx });
        }
        setSearchOpen(false);
        setBuf('');
        setSearchSel(0);
      } else {
        const next = editBuffer(buf, input, key);
        if (next !== buf) {
          setBuf(next);
          setSearchSel(0);
        }
      }
      return;
    }
    if (input === 's') {
      setSearchOpen(true);
      return;
    }
    if (key.escape || input === 'b') {
      back();
      return;
    }
    if (screen.name === 'home') {
      const cols = gridCols(stdout.columns ?? 80);
      if (key.leftArrow) setHomeSel((s) => clamp(s - 1, profiles.length));
      else if (key.rightArrow) setHomeSel((s) => clamp(s + 1, profiles.length));
      else if (key.upArrow) setHomeSel((s) => clamp(s - cols, profiles.length));
      else if (key.downArrow) setHomeSel((s) => clamp(s + cols, profiles.length));
      else if (key.return) {
        setScreen({ name: 'profile', pi: clamp(homeSel, profiles.length) });
        setProfSel(0);
      }
      return;
    }
    if (screen.name === 'profile') {
      if (key.upArrow) setProfSel((s) => clamp(s - 1, CATEGORIES.length));
      else if (key.downArrow) setProfSel((s) => clamp(s + 1, CATEGORIES.length));
      else if (key.return) {
        setScreen({ name: 'category', pi: screen.pi, ci: clamp(profSel, CATEGORIES.length) });
        setItemSel(0);
      } else if (input >= '1' && input <= String(CATEGORIES.length)) {
        setScreen({ name: 'category', pi: screen.pi, ci: Number(input) - 1 });
        setItemSel(0);
      } else if (input === 'l') {
        flashMsg(`would launch "${profiles[screen.pi].name}" (prototype no-op)`);
      }
      return;
    }
    // category screen
    const p = profiles[screen.pi];
    const items = categoryItems(p, CATEGORIES[screen.ci]);
    if (key.upArrow) setItemSel((s) => clamp(s - 1, items.length));
    else if (key.downArrow) setItemSel((s) => clamp(s + 1, items.length));
    else if (input === 'e') {
      flashMsg(`would open "${items[clamp(itemSel, items.length)]?.label}" in VS Code (prototype no-op)`);
    } else if (input === 'x') {
      flashMsg('would remove with graduated protection (prototype no-op)');
    }
  });

  const rows = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;

  const crumb =
    screen.name === 'home'
      ? 'Home'
      : screen.name === 'profile'
        ? `Home › ${profiles[screen.pi].name}`
        : `Home › ${profiles[screen.pi].name} › ${CATEGORIES[screen.ci]}`;

  const hint =
    screen.name === 'home'
      ? '[←→↑↓] choose a Profile   [enter] open   [s] search   [ctrl+v] next variant'
      : screen.name === 'profile'
        ? '[↑↓] or [1-7] choose a resource   [enter] open   [l] launch   [b/esc] back   [s] search'
        : '[↑↓] choose an item   [e] edit in VS Code   [x] remove   [b/esc] back   [s] search';

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      <Text bold color="cyan">
        {crumb}
      </Text>
      <Text> </Text>
      {screen.name === 'home' ? (
        <HomeGrid profiles={profiles} sel={clamp(homeSel, profiles.length)} cols={cols} rows={rows} />
      ) : screen.name === 'profile' ? (
        <Box flexDirection="column">
          <Text>
            {profiles[screen.pi].description}
            <Text dimColor>
              {'   '}last used: {profiles[screen.pi].lastUsed} · projects: {profiles[screen.pi].projects}
            </Text>
          </Text>
          <Text> </Text>
          {CATEGORIES.map((c, i) => (
            <Text key={c} inverse={i === clamp(profSel, CATEGORIES.length)}>
              {i === clamp(profSel, CATEGORIES.length) ? '›' : ' '} [{i + 1}] {c.padEnd(14)}
              <Text dimColor> {categoryCount(profiles[screen.pi], c)}</Text>
            </Text>
          ))}
          <Text> </Text>
          <Text color="green"> [l] Launch this Profile</Text>
        </Box>
      ) : (
        <CategoryScreen
          pi={screen.pi}
          ci={screen.ci}
          sel={clamp(itemSel, categoryItems(profiles[screen.pi], CATEGORIES[screen.ci]).length)}
          rows={rows}
          profiles={profiles}
        />
      )}
      <Box flexGrow={1} />
      {flash ? <Text color="green"> {flash}</Text> : null}
      <Text dimColor> {hint}</Text>
      {searchOpen ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">
            Search all Profiles: {buf}▏
          </Text>
          {results.map((r, i) => (
            <Text key={i} inverse={i === clamp(searchSel, results.length)}>
              {i === clamp(searchSel, results.length) ? '› ' : '  '}
              {r.profile}
              <Text dimColor> › </Text>
              {r.category ? `${r.category} › ` : ''}
              {r.kind === 'item' ? r.label : r.detail}
            </Text>
          ))}
          {!results.length && <Text dimColor> (type to search)</Text>}
          <Text dimColor> [↑↓] choose [enter] jump there [esc] close</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function gridCols(width: number) {
  return Math.max(1, Math.floor((width - 4) / 32));
}

function HomeGrid({
  profiles,
  sel,
  cols,
  rows,
}: {
  profiles: VariantProps['profiles'];
  sel: number;
  cols: number;
  rows: number;
}) {
  const gc = gridCols(cols);
  const selRow = Math.floor(sel / gc);
  const visibleRows = Math.max(1, Math.floor((rows - 9) / 5));
  const { slice: rowSlice, start } = windowed(
    Array.from({ length: Math.ceil(profiles.length / gc) }, (_, r) => r),
    selRow,
    visibleRows,
  );
  return (
    <Box flexDirection="column">
      {rowSlice.map((r) => (
        <Box key={r}>
          {Array.from({ length: gc }, (_, c) => {
            const i = r * gc + c;
            const p = profiles[i];
            if (!p) return <Box key={c} width={32} />;
            const isSel = i === sel;
            return (
              <Box
                key={c}
                width={32}
                height={5}
                borderStyle={isSel ? 'round' : 'single'}
                borderColor={isSel ? 'cyan' : 'gray'}
                flexDirection="column"
                paddingX={1}
              >
                <Text bold={isSel} wrap="truncate">
                  {p.name}
                  {p.isDefault ? ' ★' : ''}
                </Text>
                <Text dimColor wrap="truncate">
                  skills {p.resources.skills.length} · mcp {p.resources.mcp.length} · agents{' '}
                  {p.resources.agents.length}
                </Text>
                <Text dimColor wrap="truncate">
                  {p.lastUsed}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}
      {profiles.length > gc * visibleRows && (
        <Text dimColor>
          {' '}
          showing rows {start + 1}–{Math.min(start + visibleRows, Math.ceil(profiles.length / gc))} of{' '}
          {Math.ceil(profiles.length / gc)}
        </Text>
      )}
    </Box>
  );
}

function CategoryScreen({
  pi,
  ci,
  sel,
  rows,
  profiles,
}: {
  pi: number;
  ci: number;
  sel: number;
  rows: number;
  profiles: VariantProps['profiles'];
}) {
  const p = profiles[pi];
  const c: Category = CATEGORIES[ci];
  const items = categoryItems(p, c);
  const { slice, start } = windowed(items, sel, Math.max(3, rows - 12));
  const preview = itemPreview(p, c, sel);
  return (
    <Box flexDirection="column">
      {slice.map((it, i) => (
        <Text key={start + i} inverse={start + i === sel}>
          {start + i === sel ? '› ' : '  '}
          {it.label}
          <Text dimColor> — {it.detail}</Text>
        </Text>
      ))}
      <Text> </Text>
      {preview.slice(2).map((l, i) => (
        <Text key={i} dimColor wrap="truncate">
          {'   '}
          {l}
        </Text>
      ))}
      {c === 'Plugins' && <Text color="yellow"> Plugins are Claude-managed — change them in Claude Code.</Text>}
    </Box>
  );
}
