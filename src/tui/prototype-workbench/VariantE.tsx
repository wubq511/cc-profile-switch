// PROTOTYPE — Variant E: hybrid per the human's first verdict (issue #25).
// B's two-pane layout + tree sidebar · D's Profile cards · C's search box.
// Two sub-decisions are left open on purpose and are runtime-switchable:
//   [i] card↔tree integration: 'tree-nav' | 'sidebar-cards' | 'split'
//   [p] search box placement:  'top' (sidebar) | 'bottom' (sidebar) | 'center' (palette)
//
// Integration modes:
//   tree-nav      — sidebar is a plain tree (B); cards live in the main pane
//   sidebar-cards — Profile nodes of the tree ARE cards; categories/items are
//                   tree rows beneath their card
//   split         — sidebar top = Profile cards list; sidebar bottom = the
//                   selected Profile's resource tree; [tab] switches zone

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
  type Profile,
} from './data';
import { editBuffer, useCapture, type VariantProps } from './shell';

type Integration = 'tree-nav' | 'sidebar-cards' | 'split';
type SearchPlace = 'top' | 'bottom' | 'center';
type Mode = 'nav' | 'search' | 'help';

const INTEGRATIONS: Integration[] = ['tree-nav', 'sidebar-cards', 'split'];
const PLACES: SearchPlace[] = ['top', 'bottom', 'center'];

const INTEGRATION_LABEL: Record<Integration, string> = {
  'tree-nav': '树导航·主区卡片',
  'sidebar-cards': '侧栏卡片树',
  split: '上卡片·下资源树',
};
const PLACE_LABEL: Record<SearchPlace, string> = {
  top: '侧栏顶部',
  bottom: '侧栏底部',
  center: '全局中央',
};

interface Row {
  type: 'profile' | 'category' | 'item';
  pi: number;
  ci: number;
  ii: number;
  label: string;
  tag: string;
}

function clamp(n: number, len: number) {
  return Math.max(0, Math.min(n, Math.max(0, len - 1)));
}

function match(hay: string, q: string) {
  return hay.toLowerCase().includes(q.toLowerCase());
}

// Category/item rows for one profile, honoring expansion (or query auto-expand).
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

// Profile-card display data, filtered by query.
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

export default function VariantE({ profiles }: VariantProps) {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [integration, setIntegration] = useState<Integration>('sidebar-cards');
  const [place, setPlace] = useState<SearchPlace>('top');
  const [expandedP, setExpandedP] = useState<Set<number>>(new Set([0]));
  const [expandedC, setExpandedC] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0); // unified-list selection (tree-nav / sidebar-cards)
  const [cardSel, setCardSel] = useState(0); // split: profile card index (into visibleProfiles)
  const [treeSel, setTreeSel] = useState(0); // split: row index inside selected profile's tree
  const [zone, setZone] = useState<'cards' | 'tree'>('cards'); // split focus
  const [mode, setMode] = useState<Mode>('nav');
  const [query, setQuery] = useState('');
  const [paletteSel, setPaletteSel] = useState(0);
  const [pending, setPending] = useState<{ pi: number; ci: number; ii: number } | null>(null);
  const [flash, setFlash] = useState('');

  const q = query.trim();
  const isSplit = integration === 'split';

  // unified rows for tree-nav / sidebar-cards
  const rows = useMemo(() => {
    if (isSplit) return [];
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
  }, [profiles, q, expandedP, expandedC, isSplit]);

  // split-mode data
  const cards = useMemo(() => visibleProfiles(profiles, q), [profiles, q]);
  const splitProfile = cards[clamp(cardSel, cards.length)];
  const splitRows = useMemo(
    () => (isSplit && splitProfile ? resourceRows(splitProfile.p, splitProfile.pi, expandedC, q) : []),
    [isSplit, splitProfile, expandedC, q],
  );

  const index = useMemo(() => buildIndex(profiles), [profiles]);
  const paletteResults = useMemo(() => searchIndex(index, query, 10), [index, query]);

  // current context (for the main pane)
  const selRow = isSplit
    ? zone === 'tree'
      ? splitRows[clamp(treeSel, splitRows.length)]
      : { type: 'profile' as const, pi: splitProfile?.pi ?? 0, ci: -1, ii: -1, label: '', tag: '' }
    : rows[clamp(sel, rows.length)];

  const searching = mode === 'search';
  useEffect(() => {
    setCapture(searching);
    return () => setCapture(false);
  }, [searching, setCapture]);

  const flashMsg = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 1600);
  };

  // palette jump target → expand + select after rows rebuild
  useEffect(() => {
    if (!pending) return;
    if (isSplit) {
      const ci = cards.findIndex((c) => c.pi === pending.pi);
      if (ci >= 0) {
        setCardSel(ci);
        setZone(pending.ci >= 0 ? 'tree' : 'cards');
        setTreeSel(0);
      }
    } else {
      const idx = rows.findIndex(
        (r) =>
          r.pi === pending.pi &&
          (pending.ci < 0
            ? r.type === 'profile'
            : r.ci === pending.ci && (pending.ii < 0 ? r.type === 'category' : r.ii === pending.ii)),
      );
      if (idx >= 0) setSel(idx);
    }
    setPending(null);
  }, [pending, rows, cards, isSplit]);

  const toggleExpandC = (r: Row) =>
    setExpandedC((s) => {
      const n = new Set(s);
      const k = `${r.pi}:${r.ci}`;
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  useInput((input, key) => {
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
      if (key.return) {
        setMode('nav');
        if (place === 'center' && paletteResults.length) {
          const r = paletteResults[clamp(paletteSel, paletteResults.length)];
          setExpandedP((s) => new Set(s).add(r.profileIdx));
          if (r.categoryIdx >= 0)
            setExpandedC((s) => new Set(s).add(`${r.profileIdx}:${r.categoryIdx}`));
          setPending({ pi: r.profileIdx, ci: r.categoryIdx, ii: r.itemIdx });
          setQuery('');
        }
        return;
      }
      if (place === 'center') {
        if (key.upArrow) setPaletteSel((s) => clamp(s - 1, paletteResults.length));
        else if (key.downArrow) setPaletteSel((s) => clamp(s + 1, paletteResults.length));
      } else if (key.downArrow) {
        // leave the search box into the (filtered) list
        setMode('nav');
        return;
      }
      const next = editBuffer(query, input, key);
      if (next !== query) {
        setQuery(next);
        setSel(0);
        setCardSel(0);
        setTreeSel(0);
        setPaletteSel(0);
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
    if (input === 'i') {
      setIntegration((v) => INTEGRATIONS[(INTEGRATIONS.indexOf(v) + 1) % INTEGRATIONS.length]);
      setSel(0);
      setCardSel(0);
      setTreeSel(0);
      setZone('cards');
      return;
    }
    if (input === 'p') {
      setPlace((v) => PLACES[(PLACES.indexOf(v) + 1) % PLACES.length]);
      return;
    }
    if (isSplit && key.tab) {
      setZone((z) => (z === 'cards' ? 'tree' : 'cards'));
      return;
    }
    if (!selRow) return;

    // split cards zone
    if (isSplit && zone === 'cards') {
      if (key.upArrow && place === 'top' && clamp(cardSel, cards.length) === 0) {
        setMode('search');
        return;
      }
      if (key.upArrow) setCardSel((s) => clamp(s - 1, cards.length));
      else if (key.downArrow) setCardSel((s) => clamp(s + 1, cards.length));
      else if (key.return || key.rightArrow) setZone('tree');
      else if (input === 'l' && splitProfile)
        flashMsg(`would launch "${splitProfile.p.name}" (prototype no-op)`);
      else if (input === 'b' && splitProfile)
        flashMsg(`would back up "${splitProfile.p.name}" (prototype no-op)`);
      return;
    }

    // tree rows (unified list or split tree zone)
    const treeLen = isSplit ? splitRows.length : rows.length;
    const cur = isSplit ? clamp(treeSel, treeLen) : clamp(sel, treeLen);
    const setCur = isSplit ? setTreeSel : setSel;
    const row = (isSplit ? splitRows : rows)[cur];
    if (key.upArrow && place === 'top' && cur === 0) {
      // ↑ past the top of the list focuses the search box
      setMode('search');
      return;
    }
    if (key.upArrow) setCur((s: number) => clamp(s - 1, treeLen));
    else if (key.downArrow) setCur((s: number) => clamp(s + 1, treeLen));
    else if (key.leftArrow && isSplit && zone === 'tree' && (!row || row.type === 'category')) {
      const r = row;
      if (r && expandedC.has(`${r.pi}:${r.ci}`)) toggleExpandC(r);
      else setZone('cards');
    } else if (key.rightArrow) {
      if (row?.type === 'profile' && !isSplit && !expandedP.has(row.pi))
        setExpandedP((s) => new Set(s).add(row.pi));
      else if (row?.type === 'category') toggleExpandC(row);
      else if (treeLen) setCur((s: number) => clamp(s + 1, treeLen));
    } else if (key.leftArrow) {
      if (row?.type === 'profile' && !isSplit && expandedP.has(row.pi))
        setExpandedP((s) => {
          const n = new Set(s);
          n.delete(row.pi);
          return n;
        });
      else if (row?.type === 'category' && expandedC.has(`${row.pi}:${row.ci}`)) toggleExpandC(row);
      else if (row && row.type !== 'profile' && !isSplit) {
        for (let i = cur - 1; i >= 0; i--) {
          const r = rows[i];
          if (
            (row.type === 'item' && r.type === 'category' && r.pi === row.pi && r.ci === row.ci) ||
            (row.type === 'category' && r.type === 'profile' && r.pi === row.pi)
          ) {
            setCur(i);
            break;
          }
        }
      }
    } else if (key.return) {
      if (row?.type === 'profile' && !isSplit)
        setExpandedP((s) => {
          const n = new Set(s);
          if (n.has(row.pi)) n.delete(row.pi);
          else n.add(row.pi);
          return n;
        });
      else if (row?.type === 'category') toggleExpandC(row);
    } else if (input === 'l' && row?.type === 'profile') {
      flashMsg(`would launch "${profiles[row.pi].name}" (prototype no-op)`);
    } else if (input === 'e' && row) {
      flashMsg(`would open "${row.label.replace(/^[▾▸·] /, '')}" in VS Code (prototype no-op)`);
    } else if (input === 'b' && row?.type === 'profile') {
      flashMsg(`would back up "${profiles[row.pi].name}" (prototype no-op)`);
    } else if (input === 'x') {
      flashMsg('would remove with graduated protection (prototype no-op)');
    }
  });

  // ---- layout metrics ----
  const rows_ = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;
  const sideW = Math.max(30, Math.min(42, Math.floor(cols * 0.34)));
  const searchRows = place === 'center' ? 0 : 2;
  const listH = Math.max(3, rows_ - 6 - searchRows);

  // variable-height window for the unified list (profile cards are 5 lines tall)
  const cardMode = integration === 'sidebar-cards';
  const heightOf = (r: Row) => (cardMode && r.type === 'profile' ? 5 : 1);
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
  }, [rows, sel, listH, cardMode]);

  // split zones windows
  const cardH = Math.max(6, Math.floor(listH / 2));
  const cardWin = useMemo(() => {
    const perRow = 5;
    const maxCards = Math.max(1, Math.floor(cardH / perRow));
    const s = clamp(cardSel, cards.length);
    const startI = Math.max(0, Math.min(s - Math.floor(maxCards / 2), Math.max(0, cards.length - maxCards)));
    return { slice: cards.slice(startI, startI + maxCards), start: startI };
  }, [cards, cardSel, cardH]);
  const splitWin = useMemo(() => {
    const s = clamp(treeSel, splitRows.length);
    const h = Math.max(2, listH - cardH);
    const startI = Math.max(0, Math.min(s - Math.floor(h / 2), Math.max(0, splitRows.length - h)));
    return { slice: splitRows.slice(startI, startI + h), start: startI };
  }, [splitRows, treeSel, listH, cardH]);

  // ---- render pieces ----
  const searchBox = (
    <Box flexDirection="column">
      <Text color={searching ? 'yellow' : 'gray'}>
        {searching ? `▸ search: ${query}▏` : query ? `▸ search: ${query}  (esc clears)` : '▸ [/] or [↑] search'}
      </Text>
      <Text dimColor>{'─'.repeat(Math.max(4, sideW - 6))}</Text>
    </Box>
  );

  const profileCard = (p: Profile, pi: number, isSel: boolean, expandable: boolean) => (
    <Box
      key={`${pi}-card`}
      flexDirection="column"
      borderStyle={isSel ? 'round' : 'single'}
      borderColor={isSel ? 'cyan' : 'gray'}
      paddingX={1}
      width={sideW - 4}
    >
      <Text bold={isSel} wrap="truncate">
        {expandable ? (expandedP.has(pi) || q ? '▾' : '▸') : '◆'} {p.name}
        {p.isDefault ? ' ★' : ''}
      </Text>
      <Text dimColor wrap="truncate">
        skills {p.resources.skills.length} · mcp {p.resources.mcp.length} · {p.lastUsed}
      </Text>
    </Box>
  );

  const treeRow = (r: Row, isSel: boolean, keyPrefix = '') => {
    const depth = r.type === 'profile' ? 0 : r.type === 'category' ? 1 : 2;
    return (
      <Text key={`${keyPrefix}${r.pi}:${r.ci}:${r.ii}`} inverse={isSel} wrap="truncate">
        {'  '.repeat(depth)}
        {r.label}
        {r.tag ? <Text dimColor> {r.tag}</Text> : null}
      </Text>
    );
  };

  const mainPane = () => {
    if (!selRow) return <Text dimColor>(no selection)</Text>;
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
        <Text bold>Variant E — hybrid · keyboard help</Text>
        <Text> </Text>
        <Text> [↑/↓]      move through the sidebar</Text>
        <Text> [←/→]      collapse / expand, or parent / child</Text>
        <Text> [enter]    toggle expand</Text>
        <Text> [tab]      (split mode) switch between cards and resource tree</Text>
        <Text>
          {' '}
          [i]        integration: {INTEGRATIONS.map((v) => (v === integration ? `[${INTEGRATION_LABEL[v]}]` : INTEGRATION_LABEL[v])).join(' → ')}
        </Text>
        <Text>
          {' '}
          [p]        search placement: {PLACES.map((v) => (v === place ? `[${PLACE_LABEL[v]}]` : PLACE_LABEL[v])).join(' → ')}
        </Text>
        <Text> [/] or [↑] search ({place === 'center' ? 'floating palette' : `sidebar ${place}; ↑ at list top focuses it, ↓ leaves it`})</Text>
        <Text> [l/e/b/x]  launch / edit / backup / remove (contextual)</Text>
        <Text> [?]        close this help</Text>
        <Text dimColor> [ctrl+v] next variant · [ctrl+d] toggle data size · [ctrl+c] quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexGrow={1} paddingX={1} gap={1}>
        <Box flexDirection="column" width={sideW} borderStyle="single" borderColor="gray" paddingX={1}>
          {place === 'top' ? searchBox : null}
          {isSplit ? (
            <>
              <Text bold color={zone === 'cards' ? 'cyan' : 'gray'}>
                Profiles ({cards.length}/{profiles.length}){zone === 'cards' ? ' ●' : ''}
              </Text>
              {cardWin.slice.map(({ p, pi }, i) =>
                profileCard(p, pi, zone === 'cards' && cardWin.start + i === clamp(cardSel, cards.length), false),
              )}
              {!cards.length && <Text dimColor>(no matches)</Text>}
              <Text dimColor>{'─'.repeat(Math.max(4, sideW - 6))}</Text>
              <Text bold color={zone === 'tree' ? 'cyan' : 'gray'}>
                {splitProfile ? `${splitProfile.p.name} resources` : 'resources'}
                {zone === 'tree' ? ' ●' : ''}
              </Text>
              {splitWin.slice.map((r, i) =>
                treeRow(r, zone === 'tree' && splitWin.start + i === clamp(treeSel, splitRows.length), 's'),
              )}
              {splitProfile && !splitRows.length && <Text dimColor>(no matches)</Text>}
            </>
          ) : (
            <>
              <Text bold color="cyan">
                Profiles ({rows.filter((r) => r.type === 'profile').length}/{profiles.length})
              </Text>
              {slice.map((r, i) => {
                const isSel = start + i === clamp(sel, rows.length);
                return cardMode && r.type === 'profile'
                  ? profileCard(profiles[r.pi], r.pi, isSel, true)
                  : treeRow(r, isSel);
              })}
              {!rows.length && <Text dimColor>(no matches)</Text>}
            </>
          )}
          <Box flexGrow={1} />
          {place === 'bottom' ? searchBox : null}
          <Text dimColor wrap="truncate">
            [i] {INTEGRATION_LABEL[integration]} [p] {PLACE_LABEL[place]}
            {isSplit ? ' [tab] 换区' : ''}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          {mainPane()}
        </Box>
      </Box>
      {flash ? <Text color="green"> {flash}</Text> : <Text> </Text>}
      {searching && place === 'center' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginX={4}>
          <Text bold color="yellow">
            Search: {query}▏
          </Text>
          {paletteResults.map((r, i) => (
            <Text key={i} inverse={i === clamp(paletteSel, paletteResults.length)} wrap="truncate">
              {i === clamp(paletteSel, paletteResults.length) ? '› ' : '  '}
              {r.profile}
              <Text dimColor> › </Text>
              {r.category ? `${r.category} › ` : ''}
              {r.kind === 'item' ? r.label : r.detail}
            </Text>
          ))}
          {!paletteResults.length && <Text dimColor> (type to search all Profiles and resources)</Text>}
          <Text dimColor> [↑↓] choose [enter] jump there [esc] close</Text>
        </Box>
      ) : null}
    </Box>
  );
}
