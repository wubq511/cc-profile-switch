// PROTOTYPE — Variant F: guidance density "on-demand / pull" (issue #29).
// Question: what amount & placement of first-run / empty-state / error /
// destructive-action / shortcut / discovery guidance lets an individual user
// operate Profile Workbench without filesystem knowledge, while keeping the
// steady-state interface compact?
// Stance — the minimal pole: steady state shows almost nothing. All guidance
// lives behind [?] and in one-line empty states. No first-run UI, no tips.
// Navigation model locked per issue #25: two-pane, sidebar-cards, top search.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
  CATEGORIES,
  categoryCount,
  categoryItems,
  itemPreview,
  type Category,
  type Profile,
} from './data';
import { editBuffer, useCapture, type VariantProps } from './shell';

type Mode = 'nav' | 'search' | 'help';

interface Row {
  type: 'profile' | 'category' | 'item';
  pi: number;
  ci: number;
  ii: number;
  label: string;
  tag: string;
}

interface Confirm {
  kind: 'profile' | 'item';
  pi: number;
  ci: number;
  ii: number;
  label: string;
}

function clamp(n: number, len: number) {
  return Math.max(0, Math.min(n, Math.max(0, len - 1)));
}

function match(hay: string, q: string) {
  return hay.toLowerCase().includes(q.toLowerCase());
}

function resourceRows(p: Profile, pi: number, expandedC: Set<string>, q: string): Row[] {
  const out: Row[] = [];
  const pMatch = q && (match(p.name, q) || match(p.description, q));
  CATEGORIES.forEach((c, ci) => {
    const items = categoryItems(p, c);
    const cMatch = q && match(c, q);
    const hitItems = q ? items.filter((it) => match(it.label, q) || match(it.detail, q)) : [];
    if (q && !pMatch && !cMatch && hitItems.length === 0) return;
    const open = q ? true : expandedC.has(`${pi}:${ci}`);
    out.push({
      type: 'category',
      pi,
      ci,
      ii: -1,
      label: `${items.length > 1 ? (open ? '▾' : '▸') : '·'} ${c}`,
      tag: categoryCount(p, c),
    });
    const shown = q ? (cMatch || pMatch ? items : hitItems) : open ? items : [];
    shown.forEach((it) => {
      out.push({ type: 'item', pi, ci, ii: items.indexOf(it), label: it.label, tag: '' });
    });
  });
  return out;
}

function visibleProfiles(profiles: Profile[], q: string): { p: Profile; pi: number }[] {
  return profiles
    .map((p, pi) => ({ p, pi }))
    .filter(
      ({ p }) =>
        !q ||
        match(p.name, q) ||
        match(p.description, q) ||
        resourceRows(p, 0, new Set(), q).length > 0,
    );
}

// Demo trigger so error guidance is visible: launching these Profiles "fails".
const launchFails = (p: Profile) => p.name === 'experiments' || p.name === 'scratch';

export default function VariantF({ profiles }: VariantProps) {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [expandedP, setExpandedP] = useState<Set<number>>(new Set([0]));
  const [expandedC, setExpandedC] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>('nav');
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [flash, setFlash] = useState<{ text: string; color: string } | null>(null);
  const flashGen = useRef(0);

  const q = query.trim();

  const rows = useMemo(() => {
    const out: Row[] = [];
    visibleProfiles(profiles, q).forEach(({ p, pi }) => {
      const cats = resourceRows(p, pi, expandedC, q);
      const open = q ? true : expandedP.has(pi);
      out.push({
        type: 'profile',
        pi,
        ci: -1,
        ii: -1,
        label: `${open ? '▾' : '▸'} ${p.name}`,
        tag: p.isDefault ? '★' : '',
      });
      if (open) out.push(...cats);
    });
    return out;
  }, [profiles, q, expandedP, expandedC]);

  const selRow = rows[clamp(sel, rows.length)];
  const searching = mode === 'search';
  const busy = searching || confirm !== null;
  useEffect(() => {
    setCapture(busy);
    return () => setCapture(false);
  }, [busy, setCapture]);

  const flashMsg = (text: string, color = 'green') => {
    const g = ++flashGen.current;
    setFlash({ text, color });
    setTimeout(() => {
      if (flashGen.current === g) setFlash(null);
    }, 3000);
  };

  const toggleExpandC = (r: Row) =>
    setExpandedC((s) => {
      const n = new Set(s);
      const k = `${r.pi}:${r.ci}`;
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  useInput((input, key) => {
    if (confirm) {
      const p = profiles[confirm.pi];
      if (key.escape) setConfirm(null);
      else if (input === 'y') {
        setConfirm(null);
        flashMsg(
          confirm.kind === 'profile'
            ? `removed "${p.name}" — backup kept (prototype no-op)`
            : `removed "${confirm.label}" → Recovery Bin (prototype no-op)`,
        );
      } else if (confirm.kind === 'profile' && input === 'u') {
        setConfirm(null);
        flashMsg(`removed "${p.name}" without backup → Recovery Bin, 30d (prototype no-op)`);
      }
      return;
    }
    if (mode === 'help') {
      if (input === '?' || key.escape) setMode('nav');
      return;
    }
    if (searching) {
      if (key.escape) {
        setMode('nav');
        setQuery('');
        return;
      }
      if (key.return || key.downArrow) {
        setMode('nav');
        return;
      }
      const next = editBuffer(query, input, key);
      if (next !== query) {
        setQuery(next);
        setSel(0);
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
    if (input === 'n') {
      flashMsg('would open the create Profile flow (prototype no-op)');
      return;
    }
    if (!selRow) return;
    const cur = clamp(sel, rows.length);
    const row = rows[cur];
    if (key.upArrow && cur === 0) {
      // ↑ past the top of the list focuses the search box
      setMode('search');
      return;
    }
    if (key.upArrow) setSel((s) => clamp(s - 1, rows.length));
    else if (key.downArrow) setSel((s) => clamp(s + 1, rows.length));
    else if (key.rightArrow) {
      if (row?.type === 'profile' && !expandedP.has(row.pi))
        setExpandedP((s) => new Set(s).add(row.pi));
      else if (row?.type === 'category') toggleExpandC(row);
      else if (rows.length) setSel((s) => clamp(s + 1, rows.length));
    } else if (key.leftArrow) {
      if (row?.type === 'profile' && expandedP.has(row.pi))
        setExpandedP((s) => {
          const n = new Set(s);
          n.delete(row.pi);
          return n;
        });
      else if (row?.type === 'category' && expandedC.has(`${row.pi}:${row.ci}`)) toggleExpandC(row);
      else if (row && row.type !== 'profile') {
        for (let i = cur - 1; i >= 0; i--) {
          const r = rows[i];
          if (
            (row.type === 'item' && r.type === 'category' && r.pi === row.pi && r.ci === row.ci) ||
            (row.type === 'category' && r.type === 'profile' && r.pi === row.pi)
          ) {
            setSel(i);
            break;
          }
        }
      }
    } else if (key.return) {
      if (row?.type === 'profile')
        setExpandedP((s) => {
          const n = new Set(s);
          if (n.has(row.pi)) n.delete(row.pi);
          else n.add(row.pi);
          return n;
        });
      else if (row?.type === 'category') toggleExpandC(row);
    } else if (input === 'l' && row?.type === 'profile') {
      const p = profiles[row.pi];
      if (launchFails(p)) flashMsg(`launch failed: "claude" not found on PATH — [?] for fixes`, 'red');
      else flashMsg(`would launch "${p.name}" (prototype no-op)`);
    } else if (input === 'e' && row) {
      flashMsg(`would open "${row.label.replace(/^[▾▸·] /, '')}" in VS Code (prototype no-op)`);
    } else if (input === 'b' && row?.type === 'profile') {
      flashMsg(`would back up "${profiles[row.pi].name}" (prototype no-op)`);
    } else if (input === 'x' && row && row.type !== 'category') {
      setConfirm({
        kind: row.type === 'profile' ? 'profile' : 'item',
        pi: row.pi,
        ci: row.ci,
        ii: row.ii,
        label: row.label.replace(/^[▾▸·] /, ''),
      });
    }
  });

  // ---- layout metrics ----
  const rows_ = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;
  const sideW = Math.max(30, Math.min(42, Math.floor(cols * 0.34)));
  const listH = Math.max(3, rows_ - 8);

  const heightOf = (r: Row) => (r.type === 'profile' ? 5 : 1);
  const { slice, start } = useMemo(() => {
    if (!rows.length) return { slice: [] as Row[], start: 0 };
    const s = clamp(sel, rows.length);
    let used = heightOf(rows[s]);
    let lo = s;
    while (lo > 0 && used + heightOf(rows[lo - 1]) <= Math.floor(listH / 2)) {
      lo--;
      used += heightOf(rows[lo]);
    }
    let hi = s + 1;
    while (hi < rows.length && used + heightOf(rows[hi]) <= listH) {
      used += heightOf(rows[hi]);
      hi++;
    }
    while (lo > 0 && used + heightOf(rows[lo - 1]) <= listH) {
      lo--;
      used += heightOf(rows[lo]);
    }
    return { slice: rows.slice(lo, hi), start: lo };
  }, [rows, sel, listH]);

  const searchBox = (
    <Box flexDirection="column">
      <Text color={searching ? 'yellow' : 'gray'}>
        {searching ? `▸ search: ${query}▏` : query ? `▸ search: ${query}  (esc clears)` : '▸ [/] or [↑] search'}
      </Text>
      <Text dimColor>{'─'.repeat(Math.max(4, sideW - 6))}</Text>
    </Box>
  );

  const profileCard = (p: Profile, pi: number, isSel: boolean) => (
    <Box
      key={`${pi}-card`}
      flexDirection="column"
      borderStyle={isSel ? 'round' : 'single'}
      borderColor={isSel ? 'cyan' : 'gray'}
      paddingX={1}
      width={sideW - 4}
    >
      <Text bold={isSel} wrap="truncate">
        {expandedP.has(pi) || q ? '▾' : '▸'} {p.name}
        {p.isDefault ? ' ★' : ''}
      </Text>
      <Text dimColor wrap="truncate">
        skills {p.resources.skills.length} · mcp {p.resources.mcp.length} · {p.lastUsed}
      </Text>
    </Box>
  );

  const treeRow = (r: Row, isSel: boolean) => {
    const depth = r.type === 'profile' ? 0 : r.type === 'category' ? 1 : 2;
    return (
      <Text key={`${r.pi}:${r.ci}:${r.ii}`} inverse={isSel} wrap="truncate">
        {'  '.repeat(depth)}
        {r.label}
        {r.tag ? <Text dimColor> {r.tag}</Text> : null}
      </Text>
    );
  };

  const mainPane = () => {
    if (!selRow)
      return profiles.length === 0 ? (
        <Text dimColor>No Profiles yet — [n] create one.</Text>
      ) : (
        <Text dimColor>(no selection — esc clears search)</Text>
      );
    const p = profiles[selRow.pi];
    if (selRow.type === 'profile') {
      const gc = Math.max(1, Math.floor((cols - sideW - 6) / 26));
      const cardRows: Category[][] = [];
      CATEGORIES.forEach((c, i) => {
        const ri = Math.floor(i / gc);
        if (!cardRows[ri]) cardRows[ri] = [];
        cardRows[ri].push(c);
      });
      return (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>
            {p.name} <Text dimColor>— {p.description}</Text>
          </Text>
          <Text dimColor>
            default: {p.isDefault ? 'yes' : 'no'} · last used: {p.lastUsed} · projects: {p.projects}
          </Text>
          <Text> </Text>
          {cardRows.map((rowCats, ri) => (
            <Box key={ri}>
              {rowCats.map((c) => {
                const items = categoryItems(p, c);
                return (
                  <Box
                    key={c}
                    width={26}
                    height={5}
                    borderStyle="single"
                    borderColor="gray"
                    flexDirection="column"
                    paddingX={1}
                  >
                    <Text bold wrap="truncate">
                      {c}
                    </Text>
                    <Text dimColor wrap="truncate">
                      {categoryCount(p, c)}
                    </Text>
                    <Text dimColor wrap="truncate">
                      {items[0]?.label ?? ''}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          ))}
          <Box flexGrow={1} />
          <Text color="cyan">[l] launch  [e] edit settings  [b] backup  [x] remove</Text>
        </Box>
      );
    }
    const c: Category = CATEGORIES[selRow.ci];
    if (selRow.type === 'category') {
      const items = categoryItems(p, c);
      return (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>
            {p.name} › {c}
          </Text>
          <Text> </Text>
          {items.slice(0, listH).map((it, i) => (
            <Text key={i} wrap="truncate">
              {'  '}
              {it.label} <Text dimColor>— {it.detail}</Text>
            </Text>
          ))}
          <Box flexGrow={1} />
          <Text color="cyan">[e] edit · expand in tree to act on one item</Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold>
          {p.name} › {c} › {categoryItems(p, c)[selRow.ii]?.label ?? ''}
        </Text>
        <Text> </Text>
        {itemPreview(p, c, selRow.ii).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        <Box flexGrow={1} />
        <Text color="cyan">
          {c === 'Plugins'
            ? '(Claude-managed — change via Claude Code)'
            : '[e] edit in VS Code  [x] remove from Profile'}
        </Text>
      </Box>
    );
  };

  if (mode === 'help') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Variant F — on-demand guidance · help</Text>
        <Text> </Text>
        <Text> [↑/↓]      move · [←/→] collapse/expand · [enter] toggle</Text>
        <Text> [/] or [↑] search (list top) · type to filter · [esc] clear</Text>
        <Text> [l/e/b/x]  launch / edit in VS Code / backup / remove</Text>
        <Text> [n]        new Profile · [?] close this sheet</Text>
        <Text> </Text>
        <Text bold> concepts</Text>
        <Text> Profile       isolated Claude Code environment — own memory, skills, settings</Text>
        <Text> Copied Skill  snapshot owned by the Profile</Text>
        <Text> Linked Skill  shares a local source; removing never deletes the source</Text>
        <Text> Backup        durable copy, kept until you delete it</Text>
        <Text> Recovery Bin  temporary holding (30 days) for removals without backup</Text>
        <Text> Plugins       Claude-managed — change them through Claude Code</Text>
        <Text> </Text>
        <Text dimColor> demo: [l] on "experiments" fails (error guidance) · [ctrl+d] data: small/large/empty</Text>
        <Text dimColor> [ctrl+r] reset variant state · [ctrl+v] next variant · [ctrl+c] quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexGrow={1} paddingX={1} gap={1}>
        <Box flexDirection="column" width={sideW} borderStyle="single" borderColor="gray" paddingX={1}>
          {searchBox}
          <Text bold color="cyan">
            Profiles ({rows.filter((r) => r.type === 'profile').length}/{profiles.length})
          </Text>
          {slice.map((r, i) => {
            const isSel = start + i === clamp(sel, rows.length);
            return r.type === 'profile' ? profileCard(profiles[r.pi], r.pi, isSel) : treeRow(r, isSel);
          })}
          {!rows.length && (
            <Text dimColor>
              {profiles.length === 0 ? '(none yet — [n] create one)' : '(no matches — esc clears)'}
            </Text>
          )}
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            [?] keys & concepts
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          {mainPane()}
        </Box>
      </Box>
      {confirm ? (
        <Text color="yellow" wrap="truncate">
          {confirm.kind === 'profile'
            ? ` Remove "${profiles[confirm.pi].name}"? backup kept — [y] remove · [u] no backup → Bin (30d) · [esc] cancel`
            : ` Remove "${confirm.label}" from "${profiles[confirm.pi].name}"? → Recovery Bin (30d) — [y] remove · [esc] cancel`}
        </Text>
      ) : flash ? (
        <Text color={flash.color}> {flash.text}</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
