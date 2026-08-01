// PROTOTYPE — Variant H: guidance density "always-on coach" (issue #29).
// Same question as Variant F — this is the maximal pole:
// guidance is ambient and persistent — a coach strip on top explains the
// current context, a rotating tips bar sits at the bottom, every pane carries
// a "what is this" line, errors arrive as boxed panels with numbered recovery
// steps, destructive actions explain themselves fully, and first run is a
// three-step tour. Nothing retires and nothing hides behind [?].
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

type Mode = 'tour' | 'nav' | 'search' | 'help';

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

const CATEGORY_COACH: Record<Category, string> = {
  'User Memory': 'instructions you wrote for Claude Code yourself',
  'Auto Memory': 'notes Claude Code keeps for this Profile across sessions',
  Skills: 'reusable instruction packs — copied is owned here, linked shares a source',
  Agents: 'subagent definitions this Profile can delegate to',
  MCP: 'connections to external tool servers',
  Settings: 'model choice, env keys, and the managed boundary rule',
  Plugins: 'Claude-managed extensions — change them through Claude Code',
};

const TIPS = [
  'press / to search across every Profile and resource item',
  '↑ at the very top of the list jumps into the search box',
  'l launches the selected Profile right in this directory',
  'e opens long text in VS Code — the preview refreshes when you come back',
  'x removes with a backup kept by default — u skips the backup (Recovery Bin)',
  'a linked Skill shares its source — removing it never deletes the source',
  '? opens the full keyboard sheet at any time',
];

const TOUR = [
  {
    title: 'The sidebar — your Profiles',
    body: 'Each card is a Profile: an isolated Claude Code environment with its own memory, skills, and settings. ↑↓ moves between cards, → expands one to reveal its resources.',
  },
  {
    title: 'The main pane — details',
    body: 'Whatever you select lands here. A Profile shows its seven resource groups as cards; a group shows its items; an item shows a preview.',
  },
  {
    title: 'Search & actions',
    body: '/ searches every Profile and resource at once. Letter keys act on the current selection: l launch, e edit in VS Code, b backup, x remove (a backup is kept by default). ? always shows the full sheet.',
  },
];

export default function VariantH({ profiles }: VariantProps) {
  const { stdout } = useStdout();
  const setCapture = useCapture();
  const [expandedP, setExpandedP] = useState<Set<number>>(new Set([0]));
  const [expandedC, setExpandedC] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>('tour');
  const [tourStep, setTourStep] = useState(0);
  const [query, setQuery] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [flash, setFlash] = useState<{ text: string; color: string } | null>(null);
  const [error, setError] = useState<string[] | null>(null);
  const [tip, setTip] = useState(0);
  const flashGen = useRef(0);
  const errorGen = useRef(0);

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
  const showError = (lines: string[]) => {
    const g = ++errorGen.current;
    setError(lines);
    setTimeout(() => {
      if (errorGen.current === g) setError(null);
    }, 6000);
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
    if (mode === 'tour') {
      if (key.escape) setMode('nav');
      else if (key.return) {
        if (tourStep + 1 >= TOUR.length) setMode('nav');
        else setTourStep((s) => s + 1);
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
    if (input === 't') {
      setTip((i) => (i + 1) % TIPS.length);
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
      if (launchFails(p))
        showError([
          `✕ launch failed: "claude" not found on PATH`,
          `  1. install Claude Code, or`,
          `  2. [e] edit this Profile's Settings → env to fix PATH`,
          `  3. [?] opens the full help sheet`,
        ]);
      else flashMsg(`would launch "${p.name}" (prototype no-op)`);
    } else if (input === 'e' && row) {
      flashMsg(`would open "${row.label.replace(/^[▾▸·] /, '')}" in VS Code (prototype no-op)`);
    } else if (input === 'b' && row?.type === 'profile') {
      flashMsg(`would back up "${profiles[row.pi].name}" (prototype no-op)`);
    } else if (input === 'a' && row) {
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
  // coach strip (4 lines) + tips bar (1) eat into the list budget
  const listH = Math.max(3, rows_ - 13);

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

  const coachLine = (() => {
    if (!selRow)
      return profiles.length === 0
        ? `Coach · no Profiles yet — press [n] and we'll create your first together.`
        : `Coach · nothing selected — [esc] clears the search so you can browse.`;
    const p = profiles[selRow.pi];
    if (selRow.type === 'profile')
      return `Coach · Profile "${p.name}" — an isolated Claude Code environment: ${p.resources.skills.length} skills · ${p.resources.mcp.length} MCP servers · last used ${p.lastUsed}.`;
    const c: Category = CATEGORIES[selRow.ci];
    if (selRow.type === 'category') return `Coach · ${p.name} › ${c} — ${CATEGORY_COACH[c]}.`;
    return `Coach · ${p.name} › ${c} › ${categoryItems(p, c)[selRow.ii]?.label ?? ''} — [e] opens it in VS Code.`;
  })();

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
        <Box flexDirection="column">
          <Text bold>Let's create your first Profile.</Text>
          <Text> </Text>
          <Text wrap="wrap">
            A Profile is an isolated Claude Code environment — its own memory, skills, agents, MCP
            connections, and settings. Switching Profiles never touches your project files.
          </Text>
          <Text> </Text>
          <Text color="cyan">[n] create a Profile — you'll give it a name and a purpose</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>Nothing matches "{q}".</Text>
          <Text> </Text>
          <Text dimColor wrap="wrap">
            Search looks through Profile names, descriptions, and every resource item — try the name
            of a Skill, an Agent, or an MCP server.
          </Text>
          <Text color="cyan">[esc] clear the search and go back to browsing</Text>
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
            an isolated Claude Code environment · default: {p.isDefault ? 'yes' : 'no'} · projects:{' '}
            {p.projects}
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
            [l] launch · [e] edit settings · [b] backup · [x] remove — details in the coach strip ↑
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
          <Text dimColor wrap="truncate">
            {CATEGORY_COACH[c]}
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
              nothing here yet — [a] adds your first{c === 'Skills' ? ' (Copy owns it here, Link shares a source)' : ''}
            </Text>
          )}
          <Box flexGrow={1} />
          <Text color="cyan" wrap="truncate">
            [e] edit · [a] add · expand in the tree to act on one item
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
        <Text dimColor wrap="truncate">
          {c === 'Plugins' ? CATEGORY_COACH.Plugins : '[e] opens in VS Code · [x] removes it from this Profile only'}
        </Text>
        <Text> </Text>
        {itemPreview(p, c, selRow.ii).map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        <Box flexGrow={1} />
        <Text color="cyan" wrap="truncate">
          {c === 'Plugins'
            ? '(Claude-managed — change via Claude Code)'
            : `[e] edit in VS Code  [x] remove${skill?.kind === 'linked' ? ' (linked: source is kept)' : ''}`}
        </Text>
      </Box>
    );
  };

  if (mode === 'tour') {
    const step = TOUR[tourStep];
    return (
      <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={2}
          width={Math.min(70, cols - 8)}
        >
          <Text bold>
            Quick tour — step {tourStep + 1}/{TOUR.length}: {step.title}
          </Text>
          <Text> </Text>
          <Text wrap="wrap">{step.body}</Text>
          <Text> </Text>
          <Text dimColor>[enter] {tourStep + 1 >= TOUR.length ? 'start using it' : 'next'} · [esc] skip the tour</Text>
        </Box>
      </Box>
    );
  }

  if (mode === 'help') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Variant H — always-on coach · help</Text>
        <Text> </Text>
        <Text> [↑/↓]      move · [←/→] collapse/expand · [enter] toggle</Text>
        <Text> [/] or [↑] search (list top) · type to filter · [esc] clear</Text>
        <Text> [l/e/b/x]  launch / edit in VS Code / backup / remove</Text>
        <Text> [a]        add to the selected category · [n] new Profile</Text>
        <Text> [t]        next tip · [?] close this sheet</Text>
        <Text> </Text>
        <Text dimColor> the coach strip (top) explains whatever is selected; the tips bar (bottom) rotates.</Text>
        <Text dimColor> demo: [l] on "experiments" fails (error panel) · [ctrl+d] data: small/large/empty</Text>
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
      <Box flexDirection="column" flexShrink={0} borderStyle="single" borderColor="blue" paddingX={1} marginX={1}>
        <Text wrap="truncate">{coachLine}</Text>
        <Text dimColor wrap="truncate">
          ↑↓ move · / search · l launch · e edit · b backup · x remove · n new · ? help
        </Text>
      </Box>
      <Box flexGrow={1} paddingX={1} gap={1}>
        <Box flexDirection="column" width={sideW} borderStyle="single" borderColor="gray" paddingX={1}>
          {searchBox}
          <Text bold color="cyan">
            Profiles ({rows.filter((r) => r.type === 'profile').length}/{profiles.length})
          </Text>
          <Text dimColor>isolated Claude Code environments</Text>
          {slice.map((r, i) => {
            const isSel = start + i === clamp(sel, rows.length);
            return r.type === 'profile' ? profileCard(profiles[r.pi], r.pi, isSel) : treeRow(r, isSel);
          })}
          {!rows.length && (
            <>
              <Text dimColor>{profiles.length === 0 ? 'No Profiles yet.' : '(no matches)'}</Text>
              <Text dimColor wrap="truncate">
                {profiles.length === 0 ? '[n] creates your first' : 'try a Skill or Agent name'}
              </Text>
            </>
          )}
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            coach ↑ explains the selection
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          {mainPane()}
        </Box>
      </Box>
      {confirm && confirmProfile ? (
        <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor="red" paddingX={1} marginX={1}>
          {confirm.kind === 'profile' ? (
            <>
              <Text bold>Remove Profile "{confirmProfile.name}"?</Text>
              <Text wrap="wrap">
                Everything inside goes with it — memory, skills, agents, MCP entries, settings. Your
                projects on disk are never touched.
              </Text>
              <Text> [y] back up first (default) — a durable Profile Backup, restore anytime</Text>
              <Text> [u] skip the backup — lands in the Recovery Bin, auto-expires (30 days)</Text>
              <Text dimColor> [esc] keep it</Text>
            </>
          ) : (
            <>
              <Text bold>
                Remove "{confirm.label}" from "{confirmProfile.name}"?
              </Text>
              <Text dimColor wrap="wrap">
                It lands in the Recovery Bin — temporary holding that auto-expires after 30 days, so
                you can undo.
                {confirmLinked ? ' Linked: its source is never deleted.' : ''}
              </Text>
              <Text> [y] remove → Recovery Bin</Text>
              <Text dimColor> [esc] keep it</Text>
            </>
          )}
        </Box>
      ) : error ? (
        <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor="red" paddingX={1} marginX={1}>
          {error.map((l, i) => (
            <Text key={i} color={i === 0 ? 'red' : undefined} wrap="truncate">
              {l}
            </Text>
          ))}
        </Box>
      ) : flash ? (
        <Text color={flash.color}> {flash.text}</Text>
      ) : (
        <Text dimColor wrap="truncate">
          {' '}
          tip {tip + 1}/{TIPS.length} · {TIPS[tip]} — [t] next
        </Text>
      )}
    </Box>
  );
}
