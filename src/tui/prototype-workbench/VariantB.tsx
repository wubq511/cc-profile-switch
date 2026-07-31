// PROTOTYPE — Variant B: Tree sidebar + detail pane (IDE-style).
// Hierarchy: expandable tree (Profiles → Resources → Items) on the left,
// detail + direct-letter actions on the right. Search: [/] palette overlay.
// Help: persistent sidebar hint + [?] cheatsheet.

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

interface Row {
  type: 'profile' | 'category' | 'item';
  pi: number;
  ci: number;
  ii: number;
  depth: number;
  label: string;
  tag: string;
}

type Mode = 'nav' | 'search' | 'help';

function clamp(n: number, len: number) {
  return Math.max(0, Math.min(n, Math.max(0, len - 1)));
}

export default function VariantB({ profiles }: VariantProps) {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [expandedP, setExpandedP] = useState<Set<number>>(new Set([0]));
  const [expandedC, setExpandedC] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>('nav');
  const [searchBuf, setSearchBuf] = useState('');
  const [searchSel, setSearchSel] = useState(0);
  const [flash, setFlash] = useState('');

  const rows = useMemo(() => {
    const out: Row[] = [];
    profiles.forEach((p, pi) => {
      const open = expandedP.has(pi);
      out.push({
        type: 'profile',
        pi,
        ci: -1,
        ii: -1,
        depth: 0,
        label: `${open ? '▾' : '▸'} ${p.name}`,
        tag: p.isDefault ? '★' : '',
      });
      if (!open) return;
      CATEGORIES.forEach((c, ci) => {
        const key = `${pi}:${ci}`;
        const copen = expandedC.has(key);
        const items = categoryItems(p, c);
        out.push({
          type: 'category',
          pi,
          ci,
          ii: -1,
          depth: 1,
          label: `${items.length > 1 ? (copen ? '▾' : '▸') : '·'} ${c}`,
          tag: categoryCount(p, c),
        });
        if (!copen) return;
        items.forEach((it, ii) => {
          out.push({ type: 'item', pi, ci, ii, depth: 2, label: it.label, tag: '' });
        });
      });
    });
    return out;
  }, [profiles, expandedP, expandedC]);

  const selRow = rows[clamp(sel, rows.length)];
  const index = useMemo(() => buildIndex(profiles), [profiles]);
  const results = useMemo(() => searchIndex(index, searchBuf, 10), [index, searchBuf]);

  useEffect(() => {
    setCapture(mode === 'search');
    return () => setCapture(false);
  }, [mode, setCapture]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 1600);
  };

  const jumpTo = (pi: number, ci: number, ii: number) => {
    setExpandedP((s) => new Set(s).add(pi));
    if (ci >= 0) setExpandedC((s) => new Set(s).add(`${pi}:${ci}`));
    // rows rebuild async-ish; find target after expansion via a tick
    setTimeout(() => {
      // recompute on next render; approximate by scanning rows memo is stale, so
      // store a pending selection instead
      setPending({ pi, ci, ii });
    }, 0);
  };
  const [pending, setPending] = useState<{ pi: number; ci: number; ii: number } | null>(null);
  useEffect(() => {
    if (!pending) return;
    const idx = rows.findIndex(
      (r) => r.pi === pending.pi && (pending.ci < 0 || r.ci === pending.ci) && (pending.ii < 0 ? r.ii === -1 : r.ii === pending.ii) && (pending.ii >= 0 ? r.type === 'item' : pending.ci >= 0 ? r.type === 'category' : r.type === 'profile'),
    );
    if (idx >= 0) setSel(idx);
    setPending(null);
  }, [pending, rows]);

  useInput((input, key) => {
    if (mode === 'help') {
      if (input === '?' || key.escape) setMode('nav');
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
        jumpTo(r.profileIdx, r.categoryIdx, r.itemIdx);
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
    // nav
    if (input === '?') {
      setMode('help');
      return;
    }
    if (input === '/') {
      setMode('search');
      return;
    }
    if (!selRow) return;
    if (key.upArrow) setSel((s) => clamp(s - 1, rows.length));
    else if (key.downArrow) setSel((s) => clamp(s + 1, rows.length));
    else if (key.rightArrow) {
      if (selRow.type === 'profile' && !expandedP.has(selRow.pi))
        setExpandedP((s) => new Set(s).add(selRow.pi));
      else if (selRow.type === 'category') setExpandedC((s) => new Set(s).add(`${selRow.pi}:${selRow.ci}`));
      else setSel((s) => clamp(s + 1, rows.length));
    } else if (key.leftArrow) {
      if (selRow.type === 'profile' && expandedP.has(selRow.pi))
        setExpandedP((s) => {
          const n = new Set(s);
          n.delete(selRow.pi);
          return n;
        });
      else if (selRow.type === 'category' && expandedC.has(`${selRow.pi}:${selRow.ci}`))
        setExpandedC((s) => {
          const n = new Set(s);
          n.delete(`${selRow.pi}:${selRow.ci}`);
          return n;
        });
      else if (selRow.depth > 0) {
        // walk backwards for the nearest parent row
        let p = -1;
        for (let i = sel - 1; i >= 0; i--) {
          const r = rows[i];
          if (selRow.type === 'item' && r.type === 'category' && r.pi === selRow.pi && r.ci === selRow.ci) {
            p = i;
            break;
          }
          if (selRow.type === 'category' && r.type === 'profile' && r.pi === selRow.pi) {
            p = i;
            break;
          }
        }
        if (p >= 0) setSel(p);
      }
    } else if (key.return) {
      if (selRow.type === 'profile')
        setExpandedP((s) => {
          const n = new Set(s);
          if (n.has(selRow.pi)) n.delete(selRow.pi);
          else n.add(selRow.pi);
          return n;
        });
      else if (selRow.type === 'category')
        setExpandedC((s) => {
          const n = new Set(s);
          const k2 = `${selRow.pi}:${selRow.ci}`;
          if (n.has(k2)) n.delete(k2);
          else n.add(k2);
          return n;
        });
    } else if (input === 'l' && selRow.type === 'profile') {
      flashMsg(`would launch "${profiles[selRow.pi].name}" (prototype no-op)`);
    } else if (input === 'e') {
      flashMsg(`would open "${selRow.label.replace(/^[▾▸·] /, '')}" in VS Code (prototype no-op)`);
    } else if (input === 'b' && selRow.type === 'profile') {
      flashMsg(`would back up "${profiles[selRow.pi].name}" (prototype no-op)`);
    } else if (input === 'x') {
      flashMsg(`would remove "${selRow.label.replace(/^[▾▸·] /, '')}" — graduated protection here (prototype no-op)`);
    }
  });

  const rows_ = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;
  const sideW = Math.max(24, Math.min(38, Math.floor(cols * 0.3)));
  const listH = Math.max(3, rows_ - 5);
  const { slice, start } = windowed(rows, clamp(sel, rows.length), listH);

  const detail = (): { title: string; lines: string[]; actions: string } => {
    if (!selRow) return { title: '', lines: [], actions: '' };
    const p = profiles[selRow.pi];
    if (selRow.type === 'profile') {
      return {
        title: `Profile — ${p.name}`,
        lines: [
          p.description,
          `default: ${p.isDefault ? 'yes' : 'no'}   last used: ${p.lastUsed}   projects: ${p.projects}`,
          '',
          ...CATEGORIES.map((c) => `  ${c.padEnd(14)} ${categoryCount(p, c)}`),
        ],
        actions: '[l] launch  [e] edit settings  [b] backup  [x] remove',
      };
    }
    const c: Category = CATEGORIES[selRow.ci];
    if (selRow.type === 'category') {
      const items = categoryItems(p, c);
      return {
        title: `${p.name} › ${c}`,
        lines: items.slice(0, listH - 4).map((it) => `  ${it.label} — ${it.detail}`),
        actions: '[e] edit  [x] remove selected item (expand to pick one)',
      };
    }
    return {
      title: `${p.name} › ${c} › ${categoryItems(p, c)[selRow.ii]?.label ?? ''}`,
      lines: itemPreview(p, c, selRow.ii),
      actions:
        c === 'Plugins'
          ? '(Claude-managed — change via Claude Code)'
          : '[e] edit in VS Code  [x] remove from Profile',
    };
  };
  const d = detail();

  if (mode === 'help') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Variant B — Tree + detail pane · keyboard help</Text>
        <Text> </Text>
        <Text> [↑/↓]      move through the tree</Text>
        <Text> [←/→]      collapse / expand, or jump to parent / first child</Text>
        <Text> [enter]    toggle expand</Text>
        <Text> [l]        launch the selected Profile</Text>
        <Text> [e]        edit the selection in VS Code</Text>
        <Text> [b]        back up the selected Profile</Text>
        <Text> [x]        remove (graduated protection)</Text>
        <Text> [/]        cross-Profile search palette</Text>
        <Text> [?]        close this help</Text>
        <Text dimColor> [ctrl+v] next variant · [ctrl+d] toggle data size · [ctrl+c] quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexGrow={1} paddingX={1} gap={1}>
        <Box flexDirection="column" width={sideW} borderStyle="single" borderColor="gray">
          <Text bold color="cyan">
            Profiles ({profiles.length})
          </Text>
          {slice.map((r, i) => {
            const isSel = start + i === clamp(sel, rows.length);
            return (
              <Text key={start + i} inverse={isSel} wrap="truncate">
                {'  '.repeat(r.depth)}
                {r.label}
                {r.tag ? <Text dimColor> {r.tag}</Text> : null}
              </Text>
            );
          })}
          <Box flexGrow={1} />
          <Text dimColor> [/] search [?] help</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>{d.title}</Text>
          <Text> </Text>
          {d.lines.map((l, i) => (
            <Text key={i} wrap="truncate">
              {l}
            </Text>
          ))}
          <Box flexGrow={1} />
          <Text color="cyan">{d.actions}</Text>
        </Box>
      </Box>
      {flash ? <Text color="green"> {flash}</Text> : <Text> </Text>}
      {mode === 'search' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginX={2}>
          <Text bold color="yellow">
            Search: {searchBuf}▏
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
    </Box>
  );
}
