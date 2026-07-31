// PROTOTYPE (throwaway) — issue #31: VS Code edit handoff + live refresh.
// Question: how should Profile Workbench open long-form resources in VS Code,
// communicate that editing moved outside the terminal, observe changes without
// data loss, refresh previews, handle deleted/renamed files, and behave when
// VS Code is unavailable? Real scratch files + real fs.watch + real VS Code
// spawn against node_modules/.cache/ccps-proto-edit-session/ (wipe me).

import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildEditorSpawnCommand } from '../../platform/editor';
import {
  initialSession,
  reduceSession,
  type EditSession,
  type SessionEvent,
} from './editSessionMachine';

const SCRATCH = path.join(process.cwd(), 'node_modules/.cache/ccps-proto-edit-session');

interface Resource {
  id: string;
  label: string;
  rel: string;
  seed: string;
}

const RESOURCES: Resource[] = [
  {
    id: 'user-memory',
    label: 'User Memory',
    rel: 'CLAUDE.md',
    seed: '# User Memory\n\n- Prefer pnpm over npm.\n- Answer in Chinese.\n',
  },
  {
    id: 'agent',
    label: 'Agent: reviewer',
    rel: 'agents/reviewer.md',
    seed: '---\nname: reviewer\nmodel: inherit\n---\n\nYou review diffs for regressions.\n',
  },
  {
    id: 'auto-memory',
    label: 'Auto Memory',
    rel: 'memory/auto/session-notes.md',
    seed: '# Auto Memory\n\n- User often works in worktrees.\n',
  },
];

type WritePolicy = 'block' | 'write-through';

interface ResourceState {
  session: EditSession;
  exists: boolean;
  knownContent: string; // last content read from disk (diff baseline)
  previewContent: string; // what the preview pane shows
  stale: boolean; // knownContent newer than previewContent
  notice: string | null; // transient shell-level message (policy blocks etc.)
  updatedAt: string | null;
}

type Action =
  | { type: 'event'; id: string; event: SessionEvent }
  | { type: 'disk'; id: string; exists: boolean; content: string | null; auto: boolean }
  | { type: 'refresh'; id: string }
  | { type: 'notice'; id: string; notice: string | null };

function now(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function initResource(r: Resource): ResourceState {
  const abs = path.join(SCRATCH, r.rel);
  const exists = fs.existsSync(abs);
  const content = exists ? fs.readFileSync(abs, 'utf8') : '';
  return {
    session: initialSession,
    exists,
    knownContent: content,
    previewContent: content,
    stale: false,
    notice: null,
    updatedAt: exists ? now() : null,
  };
}

function reducer(state: Record<string, ResourceState>, a: Action): Record<string, ResourceState> {
  const cur = state[a.id];
  switch (a.type) {
    case 'event':
      return { ...state, [a.id]: { ...cur, session: reduceSession(cur.session, a.event) } };
    case 'disk': {
      // known content moved; preview follows only under auto-refresh
      const next: ResourceState = {
        ...cur,
        exists: a.exists,
        knownContent: a.content ?? cur.knownContent,
        stale: a.exists && a.content !== null && a.content !== cur.previewContent,
        updatedAt: now(),
      };
      if (a.auto && a.exists && a.content !== null) {
        next.previewContent = a.content;
        next.stale = false;
      }
      return { ...state, [a.id]: next };
    }
    case 'refresh':
      return {
        ...state,
        [a.id]: { ...cur, previewContent: cur.knownContent, stale: false, updatedAt: now() },
      };
    case 'notice':
      return { ...state, [a.id]: { ...cur, notice: a.notice } };
  }
}

function seedScratch() {
  for (const r of RESOURCES) {
    const abs = path.join(SCRATCH, r.rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, r.seed);
    }
  }
}

function openInDefaultEditor(abs: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  spawn(cmd, [abs], { stdio: 'ignore' }).unref();
}

function copyPath(abs: string) {
  try {
    if (process.platform === 'darwin') {
      const p = spawn('pbcopy', [], { stdio: 'pipe' });
      p.stdin.end(abs);
    }
  } catch {
    /* best effort */
  }
}

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [sel, setSel] = useState(0);
  const [auto, setAuto] = useState(true);
  const [vscodeUp, setVscodeUp] = useState(true);
  const [policy, setPolicy] = useState<WritePolicy>('block');
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    seedScratch();
    return Object.fromEntries(RESOURCES.map((r) => [r.id, initResource(r)]));
  });
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const stateRef = useRef(state);
  stateRef.current = state;
  const timers = useRef<Record<string, NodeJS.Timeout>>({});

  // one recursive watcher over the scratch root; per-resource debounce
  useEffect(() => {
    const watcher = fs.watch(SCRATCH, { recursive: true }, (_ev, filename) => {
      if (!filename) return;
      const rel = filename.split(path.sep).join('/');
      const res = RESOURCES.find((r) => r.rel === rel);
      if (!res) return;
      clearTimeout(timers.current[res.id]);
      timers.current[res.id] = setTimeout(() => {
        const abs = path.join(SCRATCH, res.rel);
        const exists = fs.existsSync(abs);
        const cur = stateRef.current[res.id];
        if (!exists && cur.exists) {
          dispatch({ type: 'event', id: res.id, event: { type: 'file-unlinked' } });
          dispatch({ type: 'disk', id: res.id, exists: false, content: null, auto: autoRef.current });
        } else if (exists) {
          const content = fs.readFileSync(abs, 'utf8');
          if (!cur.exists) {
            dispatch({ type: 'event', id: res.id, event: { type: 'file-reappeared' } });
            dispatch({ type: 'disk', id: res.id, exists: true, content, auto: autoRef.current });
          } else if (content !== cur.knownContent) {
            dispatch({ type: 'event', id: res.id, event: { type: 'file-changed' } });
            dispatch({ type: 'disk', id: res.id, exists: true, content, auto: autoRef.current });
          }
        }
      }, 100);
    });
    return () => watcher.close();
  }, []);

  const openInVsCode = (res: Resource) => {
    const id = res.id;
    dispatch({ type: 'event', id, event: { type: 'open-requested' } });
    if (!vscodeUp) {
      setTimeout(() => {
        dispatch({
          type: 'event',
          id,
          event: { type: 'open-failed', reason: 'Visual Studio Code.app not found' },
        });
      }, 300);
      return;
    }
    const abs = path.join(SCRATCH, res.rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, res.seed);
    }
    try {
      const c = buildEditorSpawnCommand(abs);
      const child = spawn(c.command, c.args, c.options);
      child.once('error', () =>
        dispatch({ type: 'event', id, event: { type: 'open-failed', reason: 'spawn failed' } }),
      );
      child.once('close', (code) => {
        dispatch({
          type: 'event',
          id,
          event:
            code === 0
              ? { type: 'open-succeeded' }
              : { type: 'open-failed', reason: `installer exited ${code}` },
        });
      });
    } catch {
      dispatch({ type: 'event', id, event: { type: 'open-failed', reason: 'spawn threw' } });
    }
  };

  const workbenchWrite = (res: Resource) => {
    const id = res.id;
    const cur = stateRef.current[id];
    const active = cur.session.phase === 'watching' || cur.session.phase === 'opening';
    if (active && policy === 'block') {
      dispatch({
        type: 'notice',
        id,
        notice:
          'BLOCKED — frontmatter edit refused: this file is open in VS Code and may hold unsaved changes. Finish there first. (policy: block)',
      });
      return;
    }
    const abs = path.join(SCRATCH, res.rel);
    fs.appendFileSync(abs, `\n<!-- workbench-write ${now()} -->\n`);
    dispatch({
      type: 'notice',
      id,
      notice: active
        ? 'Frontmatter WRITTEN to disk while VS Code may hold an unsaved buffer — VS Code will warn about a save conflict and this write can be lost. (policy: write-through)'
        : 'Frontmatter field written — no VS Code session active, always safe.',
    });
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    const res = RESOURCES[sel];
    if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSel((s) => Math.min(RESOURCES.length - 1, s + 1));
    else if (input === 'q') exit();
    else if (input === 'e') openInVsCode(res);
    else if (input === 'o') openInDefaultEditor(path.join(SCRATCH, res.rel));
    else if (input === 'c') {
      copyPath(path.join(SCRATCH, res.rel));
      dispatch({ type: 'notice', id: res.id, notice: 'Path copied to clipboard' });
    } else if (input === 'a') setAuto((v) => !v);
    else if (input === 'r') dispatch({ type: 'refresh', id: res.id });
    else if (input === 'f') workbenchWrite(res);
    else if (input === 'w') setPolicy((p) => (p === 'block' ? 'write-through' : 'block'));
    else if (input === 'u') setVscodeUp((v) => !v);
    else if (input === 'x') dispatch({ type: 'event', id: res.id, event: { type: 'session-ended' } });
  });

  const w = stdout.columns ?? 100;
  const h = stdout.rows ?? 30;
  const listW = 34;
  const cur = RESOURCES[sel];
  const cs = state[cur.id];

  const badge = (s: ResourceState): string => {
    switch (s.session.phase) {
      case 'opening':
        return '…opening';
      case 'watching':
        return s.stale ? '✎ watching (stale)' : '✎ watching';
      case 'missing':
        return '⚠ missing';
      default:
        return s.stale ? 'changed on disk' : '';
    }
  };

  return (
    <Box flexDirection="column" width={w} height={h}>
      <Box flexGrow={1}>
        <Box flexDirection="column" width={listW} borderStyle="round" borderColor="gray">
          <Text bold> Resources (Profile: coding)</Text>
          {RESOURCES.map((r, i) => {
            const s = state[r.id];
            return (
              <Box key={r.id} flexDirection="column">
                <Text inverse={i === sel} color={s.exists ? undefined : 'red'}>
                  {i === sel ? '›' : ' '} {r.label}
                </Text>
                <Text dimColor={s.session.phase === 'idle'} color={s.session.phase === 'missing' ? 'yellow' : 'cyan'}>
                  {'   '}
                  {badge(s)}
                  {s.session.changeCount > 0 ? ` (+${s.session.changeCount})` : ''}
                </Text>
              </Box>
            );
          })}
          <Box flexGrow={1} />
          <Text dimColor> scratch: PROTOTYPE — wipe me</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>
            Preview — {cur.label} <Text dimColor>{path.join(SCRATCH, cur.rel)}</Text>
          </Text>
          {cs.session.phase === 'watching' && (
            <Text color="cyan" bold>
              ● Editing in VS Code — Workbench is watching; saves refresh this preview
              {auto ? '' : ' (manual r)'}
            </Text>
          )}
          {cs.session.phase === 'missing' && (
            <Text color="yellow" bold>
              ● File deleted or renamed outside the terminal — showing last known content. Reappears → watching
              resumes.
            </Text>
          )}
          {cs.session.phase === 'opening' && <Text color="cyan">Opening in VS Code…</Text>}
          {cs.stale && <Text color="magenta">preview stale — press [r] to refresh</Text>}
          {cs.notice && <Text color="yellow">{cs.notice}</Text>}
          <Text dimColor>
            updated {cs.updatedAt ?? '—'} · changes observed {cs.session.changeCount}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {(cs.exists ? cs.previewContent : cs.previewContent)
              .split('\n')
              .slice(0, Math.max(3, h - 14))
              .map((line, i) => (
                <Text key={i} wrap="truncate">
                  {line || ' '}
                </Text>
              ))}
          </Box>
          <Box flexGrow={1} />
          <Text dimColor>
            machine: phase={cs.session.phase} changes={cs.session.changeCount} last=&quot;
            {cs.session.lastEvent ?? '—'}&quot;
          </Text>
        </Box>
      </Box>
      {cs.session.lastEvent?.startsWith('VS Code unavailable') && (
        <Box width={w}>
          <Text color="red" bold>
            ● VS Code unavailable — [o] open with system default editor · [c] copy path · or fix install and [e]
            again
          </Text>
        </Box>
      )}
      <Box width={w} justifyContent="center">
        <Text backgroundColor="white" color="black" bold>
          {` [e]dit VS Code  [a]uto-refresh:${auto ? 'on' : 'OFF'}  [r]efresh  [f] fm-edit  [w]rite-policy:${policy}  [u] vscode:${vscodeUp ? 'present' : 'MISSING'}  [x] end session  [q]uit `}
        </Text>
      </Box>
    </Box>
  );
}
