// PROTOTYPE — Variant G: guidance density "progressive inline" (issue #29).
// Same question as Variant F — this is the adaptive middle stance:
// guidance is attached to the focused element and to empty states, it appears
// just-in-time, and it RETIRES: every hint disappears after you use the key
// three times. First run gets one dismissible welcome card; steady state ends
// up as compact as Variant F, but the user was taught on the way there.
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

type Mode = 'welcome' | 'nav' | 'search' | 'help';

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

const launchFails = (p: Profile) => p.name === 'experiments' || p.name === 'scratch';

const HINT_TEXT: Record<string, string> = {
  l: 'l launch',
  e: 'e edit',
  b: 'b backup',
  x: 'x remove',
  a: 'a add',
  n: 'n new',
  '/': '/ search',
  '?': '? all keys',
};
const RETIRE_AFTER = 3;

export default function VariantG({ profiles }: VariantProps) {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [expandedP, setExpandedP] = useState<Set<number>>(new Set([0]));
  const [expandedC, setExpandedC] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>('welcome');
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [flash, setFlash] = useState<{ text: string; color: string } | null>(null);
  const [used, setUsed] = useState<Record<string, number>>({});
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

  const flashMsg = (text: string, color = 'green', ms = 4200) => {
    const g = ++flashGen.current;
    setFlash({ text, color });
    setTimeout(() => {
      if (flashGen.current === g) setFlash(null);
    }, ms);
  };

  const mark = (k: string) => setUsed((u) => ({ ...u, [k]: (u[k] ?? 0) + 1 }));

  // retiring hint line: hints for keys used RETIRE_AFTER times drop out
  const hintLine = (keys: string[]) => {
    const live = keys.filter((k) => (used[k] ?? 0) < RETIRE_AFTER).map((k) => HINT_TEXT[k]);
    return live.length ? live.join('  ·  ') : 'you know the ropes — [?] all keys';
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
        mark('x');
        setConfirm(null);
        flashMsg(
          confirm.kind === 'profile'
            ? `removed "${p.name}" — backup kept (prototype no-op)`
            : `removed "${confirm.label}" → Recovery Bin (prototype no-op)`,
        );
      } else if (confirm.kind === 'profile' && input === 'u') {
        mark('x');
        setConfirm(null);
        flashMsg(`removed "${p.name}" without backup → Recovery Bin, 30d (prototype no-op)`);
      }
      return;
    }
    if (mode === 'welcome') {
      if (key.return || key.escape) setMode('nav');
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
      mark('?');
      setMode('help');
      return;
    }
    if (input === '/') {
      mark('/');
      setMode('search');
      return;
    }
    if (input === 'n') {
      mark('n');
      flashMsg('would open the create Profile flow (prototype no-op)');
      return;
    }
    if (!selRow) return;
    const cur = clamp(sel, rows.length);
    const row = rows[cur];
    if (key.upArrow && cur === 0) {
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
      mark('l');
      const p = profiles[row.pi];
      if (launchFails(p))
        flashMsg(
          `launch failed: "claude" not found on PATH\nfix: install Claude Code — or [e] edit Settings → env for this Profile`,
          'red',
          5000,
        );
      else flashMsg(`would launch "${p.name}" (prototype no-op)`);
    } else if (input === 'e' && row) {
      mark('e');
      flashMsg(`would open "${row.label.replace(/^[▾▸·] /, '')}" in VS Code (prototype no-op)`);
    } else if (input === 'b' && row?.type === 'profile') {
      mark('b');
      flashMsg(`would back up "${profiles[row.pi].name}" (prototype no-op)`);
    } else if (input === 'a' && row) {
      mark('a');
      flashMsg('would add here — Skills offer Copy and Link (prototype no-op)');
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
    let usedH = heightOf(rows[s]);
    let lo = s;
    while (lo > 0 && usedH + heightOf(rows[lo - 1]) <= Math.floor(listH / 2)) {
      lo--;
      usedH += heightOf(rows[lo]);
    }
    let hi = s + 1;
    while (hi < rows.length && usedH + heightOf(rows[hi]) <= listH) {
      usedH += heightOf(rows[hi]);
      hi++;
    }
    while (lo > 0 && usedH + heightOf(rows[lo - 1]) <= listH) {
      lo--;
      usedH += heightOf(rows[lo]);
    }
    return { slice: rows.slice(lo, hi), start: lo };
  }, [rows, sel, listH]);

  const searchTipLive = (used['/'] ?? 0) < 2;
  const searchBox = (
    <Box flexDirection="column">
      <Text color={searching ? 'yellow' : 'gray'}>
        {searching ? `▸ search: ${query}▏` : query ? `▸ search: ${query}  (esc clears)` : '▸ [/] or [↑] search'}
      </Text>
      {searching && searchTipLive && !q ? (
        <Text dimColor wrap="truncate">
          tip: covers names, descriptions, every resource item
        </Text>
      ) : null}
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
        <Box flexDirection="column">
          <Text bold>No Profiles yet.</Text>
          <Text> </Text>
          <Text wrap="wrap">A Profile is an isolated Claude Code environment — its own memory, skills, and settings.</Text>
          <Text> </Text>
          <Text color="cyan">[n] create your first Profile</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>Nothing matches "{q}".</Text>
          <Text dimColor>Search covers names, descriptions, and every resource item — try a Skill name.</Text>
          <Text color="cyan">[esc] clear search</Text>
        </Box>
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
      const failedMcp = p.resources.mcp.filter((m) => m.status === 'failed');
      return (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>
            {p.name} <Text dimColor>— {p.description}</Text>
          </Text>
          <Text dimColor>
            default: {p.isDefault ? 'yes' : 'no'} · last used: {p.lastUsed} · projects: {p.projects}
          </Text>
          {failedMcp.length ? (
            <Text color="yellow" wrap="truncate">
              ⚠ mcp {failedMcp.map((m) => `"${m.name}"`).join(', ')} failed — open MCP › {failedMcp[0].name}, [e] to inspect
            </Text>
          ) : null}
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
                      {items[0]?.label ?? (items.length === 0 ? 'empty — [a] add' : '')}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          ))}
          <Box flexGrow={1} />
          <Text color="cyan" wrap="truncate">
            {hintLine(['l', 'e', 'b', 'x', '/', '?'])}
          </Text>
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
          {!items.length && (
            <Text dimColor>
              empty — [a] add your first{c === 'Skills' ? ' (copy or link)' : ''}
            </Text>
          )}
          <Box flexGrow={1} />
          <Text color="cyan" wrap="truncate">
            {hintLine(items.length ? ['e', 'a', '?'] : ['a', 'n', '?'])}
          </Text>
        </Box>
      );
    }
    const skill = c === 'Skills' ? p.resources.skills[selRow.ii] : undefined;
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
        {c === 'Plugins' ? (
          <Text color="cyan">(Claude-managed — change via Claude Code)</Text>
        ) : (
          <Text color="cyan" wrap="truncate">
            {hintLine(['e', 'x', '?'])}
            {skill?.kind === 'linked' ? '  ·  linked: remove never deletes the source' : ''}
          </Text>
        )}
      </Box>
    );
  };

  if (mode === 'welcome') {
    return (
      <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={2}
          width={Math.min(66, cols - 8)}
        >
          <Text bold>Welcome to Profile Workbench</Text>
          <Text> </Text>
          <Text wrap="wrap">
            One place for your Profiles — isolated Claude Code environments, each with its own
            memory, skills, and settings.
          </Text>
          <Text> </Text>
          <Text>  [↑/↓] move      [/] search everything      [?] every key</Text>
          <Text> </Text>
          <Text dimColor>[enter] start — shows once per session ([ctrl+r] brings it back)</Text>
        </Box>
      </Box>
    );
  }

  if (mode === 'help') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Variant G — progressive inline guidance · help</Text>
        <Text> </Text>
        <Text> [↑/↓]      move · [←/→] collapse/expand · [enter] toggle</Text>
        <Text> [/] or [↑] search (list top) · type to filter · [esc] clear</Text>
        <Text> [l/e/b/x]  launch / edit in VS Code / backup / remove</Text>
        <Text> [a]        add to the selected category · [n] new Profile</Text>
        <Text> [?]        close this sheet</Text>
        <Text> </Text>
        <Text dimColor> hints fade away after you use a key {RETIRE_AFTER} times — this sheet is always here.</Text>
        <Text dimColor> demo: [l] on "experiments" fails (error guidance) · [ctrl+d] data: small/large/empty</Text>
        <Text dimColor> [ctrl+r] reset variant state · [ctrl+v] next variant · [ctrl+c] quit</Text>
      </Box>
    );
  }

  const confirmProfile = confirm ? profiles[confirm.pi] : null;
  const confirmLinked =
    confirm?.kind === 'item' &&
    CATEGORIES[confirm.ci] === 'Skills' &&
    profiles[confirm.pi].resources.skills[confirm.ii]?.kind === 'linked';

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
            <>
              <Text dimColor>{profiles.length === 0 ? 'No Profiles yet.' : '(no matches)'}</Text>
              {profiles.length === 0 ? (
                <Text dimColor wrap="truncate">
                  [n] create your first
                </Text>
              ) : (
                <Text dimColor wrap="truncate">
                  try a Skill name — search covers everything
                </Text>
              )}
            </>
          )}
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            hints fade as you use them · [?] all keys
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          {mainPane()}
        </Box>
      </Box>
      {confirm && confirmProfile ? (
        <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor="yellow" paddingX={1} marginX={1}>
          {confirm.kind === 'profile' ? (
            <>
              <Text bold>
                Remove Profile "{confirmProfile.name}"?
              </Text>
              <Text dimColor wrap="truncate">
                goes with it: {confirmProfile.resources.skills.length} skills ·{' '}
                {confirmProfile.resources.agents.length} agents · memory · settings
              </Text>
              <Text> [y] back up first, then remove (default — restore anytime)</Text>
              <Text> [u] no backup → Recovery Bin (auto-expires, 30 days)</Text>
              <Text dimColor> [esc] keep it</Text>
            </>
          ) : (
            <>
              <Text bold>
                Remove "{confirm.label}" from "{confirmProfile.name}"?
              </Text>
              {confirmLinked ? <Text dimColor>linked — its source is never deleted.</Text> : null}
              <Text> [y] remove → Recovery Bin (auto-expires, 30 days)</Text>
              <Text dimColor> [esc] keep it</Text>
            </>
          )}
        </Box>
      ) : flash ? (
        <Text color={flash.color}> {flash.text}</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
