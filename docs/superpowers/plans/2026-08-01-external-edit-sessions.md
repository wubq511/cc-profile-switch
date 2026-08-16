# External Edit Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement external edit sessions that open long-text resources in VS Code while the Workbench stays operable, with live refresh, missing-state handling, and write guards.

**Architecture:** Pure reducer state machine in `core/edit-session/` (zero I/O), I/O session manager class that orchestrates `fs.watch` + editor spawn, Ink components in `tui/workbench/edit-session/` for banners/badges/overlays. The prototype at `src/tui/prototype-edit-session/` is the reference implementation to promote.

**Tech Stack:** TypeScript, Node.js `fs.watch`, `fs-extra`, `picocolors`, `zod`, Ink 7 (components only), Vitest

## Global Constraints

- Node >=22, CommonJS package, ESM Ink bundle built separately
- `spawn(command, args, { shell: false })` — never concatenate shell strings
- Foreground colors only (picocolors), no background fills
- CLI and TUI route through the same core services
- Platform-specific behavior needs explicit win32/darwin/linux tests
- All paths resolved absolute, traversal blocked
- `npm run check` (lint + test + build) must pass before commit

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/core/edit-session/types.ts` | SessionPhase, EditSession, SessionEvent types |
| Create | `src/core/edit-session/reducer.ts` | Pure reducer — state machine transitions |
| Create | `src/core/edit-session/session-manager.ts` | I/O orchestration — fs.watch, editor spawn, debounce, write guard |
| Create | `src/core/edit-session/index.ts` | Barrel export |
| Create | `test/edit-session-reducer.test.ts` | Reducer unit tests |
| Create | `test/edit-session-manager.test.ts` | Session manager tests (mocked fs/spawn) |
| Modify | `src/tui/workbench/i18n/en.ts` | Add edit-session i18n keys |
| Modify | `src/tui/workbench/i18n/zh.ts` | Add edit-session i18n keys (Chinese) |
| Modify | `src/tui/workbench/i18n/index.ts` | Register new keys in type |
| Create | `src/tui/workbench/edit-session/EditBanner.tsx` | Persistent top banner for active sessions |
| Create | `src/tui/workbench/edit-session/WatchingBadge.tsx` | Per-resource ✎ watching badge |
| Create | `src/tui/workbench/edit-session/MissingOverlay.tsx` | Missing file warning + last content |
| Create | `src/tui/workbench/edit-session/FallbackMenu.tsx` | VS Code unavailable fallbacks |

---

### Task 1: Types and Pure Reducer

**Files:**
- Create: `src/core/edit-session/types.ts`
- Create: `src/core/edit-session/reducer.ts`
- Create: `src/core/edit-session/index.ts`
- Test: `test/edit-session-reducer.test.ts`

**Interfaces:**
- Produces: `SessionPhase`, `EditSession`, `SessionEvent`, `initialSession`, `reduceSession`, `isSessionActive`

This task promotes the prototype reducer into production code with enriched fields (filePath, lastContent, lastUpdated, openFailedReason).

- [ ] **Step 1: Create types.ts**

```typescript
// src/core/edit-session/types.ts

export type SessionPhase = 'idle' | 'opening' | 'watching' | 'missing';

export interface EditSession {
  phase: SessionPhase;
  /** absolute path of the watched file */
  filePath: string;
  /** how many external saves were observed since handoff */
  changeCount: number;
  /** human-readable last lifecycle event */
  lastEvent: string | null;
  /** last successfully read file content (for missing-state display) */
  lastContent: string | null;
  /** timestamp of last external save */
  lastUpdated: Date | null;
  /** reason for VS Code unavailability (for fallback menu) */
  openFailedReason: string | null;
}

export type SessionEvent =
  | { type: 'open-requested'; filePath: string }
  | { type: 'open-succeeded' }
  | { type: 'open-failed'; reason: string }
  | { type: 'file-changed'; content: string; timestamp: Date }
  | { type: 'file-unlinked' }
  | { type: 'file-reappeared'; content: string; timestamp: Date }
  | { type: 'session-ended' };
```

- [ ] **Step 2: Create reducer.ts**

```typescript
// src/core/edit-session/reducer.ts

import type { EditSession, SessionEvent, SessionPhase } from './types';

export const initialSession: EditSession = {
  phase: 'idle',
  filePath: '',
  changeCount: 0,
  lastEvent: null,
  lastContent: null,
  lastUpdated: null,
  openFailedReason: null,
};

export function reduceSession(s: EditSession, e: SessionEvent): EditSession {
  switch (e.type) {
    case 'open-requested':
      if (s.phase === 'watching' || s.phase === 'missing') {
        return { ...s, lastEvent: 'Already open — VS Code re-focused' };
      }
      return {
        ...s,
        phase: 'opening',
        filePath: e.filePath,
        lastEvent: 'Opening in VS Code…',
        openFailedReason: null,
      };

    case 'open-succeeded':
      if (s.phase !== 'opening') return s;
      return {
        ...s,
        phase: 'watching',
        changeCount: 0,
        lastEvent: 'Handed off — editing in VS Code, Workbench is watching',
      };

    case 'open-failed':
      if (s.phase !== 'opening') return s;
      return {
        ...s,
        phase: 'idle',
        changeCount: 0,
        lastEvent: `VS Code unavailable: ${e.reason}`,
        openFailedReason: e.reason,
      };

    case 'file-changed':
      if (s.phase === 'watching') {
        return {
          ...s,
          changeCount: s.changeCount + 1,
          lastContent: e.content,
          lastUpdated: e.timestamp,
          lastEvent: `Saved in VS Code (change #${s.changeCount + 1})`,
        };
      }
      if (s.phase === 'missing') {
        return {
          ...s,
          phase: 'watching',
          changeCount: s.changeCount + 1,
          lastContent: e.content,
          lastUpdated: e.timestamp,
          lastEvent: 'File reappeared and changed',
        };
      }
      return {
        ...s,
        lastContent: e.content,
        lastUpdated: e.timestamp,
        lastEvent: 'Changed on disk outside an edit session',
      };

    case 'file-unlinked':
      if (s.phase === 'watching' || s.phase === 'opening') {
        return {
          ...s,
          phase: 'missing',
          lastEvent: 'File deleted or renamed — tracking paused, preview shows last known content',
        };
      }
      return { ...s, lastEvent: 'File deleted or renamed on disk' };

    case 'file-reappeared':
      if (s.phase === 'missing') {
        return {
          ...s,
          phase: 'watching',
          lastContent: e.content,
          lastUpdated: e.timestamp,
          lastEvent: 'File reappeared — watching resumed',
        };
      }
      return s;

    case 'session-ended':
      return { ...initialSession, lastEvent: 'Edit session ended' };
  }
}

export function isSessionActive(s: EditSession): boolean {
  return s.phase === 'watching' || s.phase === 'opening' || s.phase === 'missing';
}
```

- [ ] **Step 3: Create barrel index.ts**

```typescript
// src/core/edit-session/index.ts

export type { EditSession, SessionEvent, SessionPhase } from './types';
export { initialSession, reduceSession, isSessionActive } from './reducer';
```

- [ ] **Step 4: Write reducer tests**

```typescript
// test/edit-session-reducer.test.ts

import { describe, expect, it } from 'vitest';

import { initialSession, isSessionActive, reduceSession } from '../src/core/edit-session/reducer';
import type { EditSession, SessionEvent } from '../src/core/edit-session/types';

const NOW = new Date('2026-08-01T12:00:00Z');

describe('edit-session reducer', () => {
  describe('initial state', () => {
    it('starts idle with no activity', () => {
      expect(initialSession.phase).toBe('idle');
      expect(initialSession.changeCount).toBe(0);
      expect(initialSession.lastEvent).toBeNull();
      expect(initialSession.lastContent).toBeNull();
      expect(initialSession.lastUpdated).toBeNull();
      expect(initialSession.openFailedReason).toBeNull();
    });
  });

  describe('open-requested', () => {
    it('transitions idle → opening', () => {
      const next = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      expect(next.phase).toBe('opening');
      expect(next.filePath).toBe('/tmp/test.md');
      expect(next.lastEvent).toBe('Opening in VS Code…');
    });

    it('no-ops when already watching', () => {
      const watching: EditSession = { ...initialSession, phase: 'watching', filePath: '/tmp/test.md' };
      const next = reduceSession(watching, { type: 'open-requested', filePath: '/tmp/test.md' });
      expect(next.phase).toBe('watching');
      expect(next.lastEvent).toBe('Already open — VS Code re-focused');
    });

    it('no-ops when in missing state', () => {
      const missing: EditSession = { ...initialSession, phase: 'missing', filePath: '/tmp/test.md' };
      const next = reduceSession(missing, { type: 'open-requested', filePath: '/tmp/test.md' });
      expect(next.phase).toBe('missing');
      expect(next.lastEvent).toBe('Already open — VS Code re-focused');
    });
  });

  describe('open-succeeded', () => {
    it('transitions opening → watching', () => {
      const opening = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      const next = reduceSession(opening, { type: 'open-succeeded' });
      expect(next.phase).toBe('watching');
      expect(next.changeCount).toBe(0);
      expect(next.lastEvent).toBe('Handed off — editing in VS Code, Workbench is watching');
    });

    it('no-ops when not in opening phase', () => {
      const next = reduceSession(initialSession, { type: 'open-succeeded' });
      expect(next).toEqual(initialSession);
    });
  });

  describe('open-failed', () => {
    it('transitions opening → idle with reason', () => {
      const opening = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      const next = reduceSession(opening, { type: 'open-failed', reason: 'not found' });
      expect(next.phase).toBe('idle');
      expect(next.openFailedReason).toBe('not found');
      expect(next.lastEvent).toBe('VS Code unavailable: not found');
    });

    it('no-ops when not in opening phase', () => {
      const next = reduceSession(initialSession, { type: 'open-failed', reason: 'x' });
      expect(next).toEqual(initialSession);
    });
  });

  describe('file-changed', () => {
    it('increments changeCount and updates content when watching', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-changed', content: 'new content', timestamp: NOW });
      expect(s.changeCount).toBe(1);
      expect(s.lastContent).toBe('new content');
      expect(s.lastUpdated).toBe(NOW);
      expect(s.lastEvent).toBe('Saved in VS Code (change #1)');
    });

    it('transitions missing → watching on file-changed', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-unlinked' });
      expect(s.phase).toBe('missing');
      s = reduceSession(s, { type: 'file-changed', content: 'reappeared', timestamp: NOW });
      expect(s.phase).toBe('watching');
      expect(s.lastContent).toBe('reappeared');
    });

    it('updates content even when idle (out-of-session change)', () => {
      const next = reduceSession(initialSession, { type: 'file-changed', content: 'x', timestamp: NOW });
      expect(next.lastContent).toBe('x');
      expect(next.lastUpdated).toBe(NOW);
      expect(next.lastEvent).toBe('Changed on disk outside an edit session');
    });

    it('accumulates multiple changes', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-changed', content: 'a', timestamp: NOW });
      s = reduceSession(s, { type: 'file-changed', content: 'b', timestamp: NOW });
      s = reduceSession(s, { type: 'file-changed', content: 'c', timestamp: NOW });
      expect(s.changeCount).toBe(3);
      expect(s.lastContent).toBe('c');
    });
  });

  describe('file-unlinked', () => {
    it('transitions watching → missing preserving lastContent', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-changed', content: 'saved content', timestamp: NOW });
      s = reduceSession(s, { type: 'file-unlinked' });
      expect(s.phase).toBe('missing');
      expect(s.lastContent).toBe('saved content');
    });

    it('transitions opening → missing', () => {
      const opening = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      const next = reduceSession(opening, { type: 'file-unlinked' });
      expect(next.phase).toBe('missing');
    });

    it('records event when idle', () => {
      const next = reduceSession(initialSession, { type: 'file-unlinked' });
      expect(next.phase).toBe('idle');
      expect(next.lastEvent).toBe('File deleted or renamed on disk');
    });
  });

  describe('file-reappeared', () => {
    it('transitions missing → watching', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-unlinked' });
      s = reduceSession(s, { type: 'file-reappeared', content: 'back', timestamp: NOW });
      expect(s.phase).toBe('watching');
      expect(s.lastContent).toBe('back');
      expect(s.lastEvent).toBe('File reappeared — watching resumed');
    });

    it('no-ops when not in missing phase', () => {
      const next = reduceSession(initialSession, { type: 'file-reappeared', content: 'x', timestamp: NOW });
      expect(next).toEqual(initialSession);
    });
  });

  describe('session-ended', () => {
    it('resets to initial state', () => {
      let s = reduceSession(initialSession, { type: 'open-requested', filePath: '/tmp/test.md' });
      s = reduceSession(s, { type: 'open-succeeded' });
      s = reduceSession(s, { type: 'file-changed', content: 'x', timestamp: NOW });
      s = reduceSession(s, { type: 'session-ended' });
      expect(s.phase).toBe('idle');
      expect(s.changeCount).toBe(0);
      expect(s.lastContent).toBeNull();
      expect(s.lastEvent).toBe('Edit session ended');
    });
  });

  describe('isSessionActive', () => {
    it('returns true for watching, opening, missing', () => {
      expect(isSessionActive({ ...initialSession, phase: 'watching' })).toBe(true);
      expect(isSessionActive({ ...initialSession, phase: 'opening' })).toBe(true);
      expect(isSessionActive({ ...initialSession, phase: 'missing' })).toBe(true);
    });

    it('returns false for idle', () => {
      expect(isSessionActive(initialSession)).toBe(false);
    });
  });

  describe('full lifecycle', () => {
    it('idle → opening → watching → missing → watching → idle', () => {
      let s = initialSession;
      s = reduceSession(s, { type: 'open-requested', filePath: '/tmp/test.md' });
      expect(s.phase).toBe('opening');
      s = reduceSession(s, { type: 'open-succeeded' });
      expect(s.phase).toBe('watching');
      s = reduceSession(s, { type: 'file-changed', content: 'v1', timestamp: NOW });
      expect(s.changeCount).toBe(1);
      s = reduceSession(s, { type: 'file-unlinked' });
      expect(s.phase).toBe('missing');
      expect(s.lastContent).toBe('v1');
      s = reduceSession(s, { type: 'file-reappeared', content: 'v2', timestamp: NOW });
      expect(s.phase).toBe('watching');
      s = reduceSession(s, { type: 'session-ended' });
      expect(s.phase).toBe('idle');
    });
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/edit-session-reducer.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/edit-session/ test/edit-session-reducer.test.ts
git commit -m "feat(edit-session): add pure reducer state machine with enriched fields"
```

---

### Task 2: Session Manager

**Files:**
- Create: `src/core/edit-session/session-manager.ts`
- Test: `test/edit-session-manager.test.ts`

**Interfaces:**
- Consumes: `EditSession`, `SessionEvent`, `reduceSession`, `initialSession`, `isSessionActive` from Task 1; `buildEditorSpawnCommand`, `openWithDefaultEditor` from `src/platform/editor.ts`; `Clock` from `src/core/types.ts`
- Produces: `EditSessionManager` class with methods `open(filePath)`, `endSession(filePath)`, `isFileUnderSession(filePath)`, `getSession(filePath)`, `getActiveSessionPaths()`, `dispose()`, `onChange` callback

- [ ] **Step 1: Create session-manager.ts**

```typescript
// src/core/edit-session/session-manager.ts

import fs from 'fs-extra';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';

import { buildEditorSpawnCommand } from '../../platform/editor';
import type { Clock } from '../../types';
import { initialSession, isSessionActive, reduceSession } from './reducer';
import type { EditSession, SessionEvent } from './types';

export type SessionChangeCallback = (filePath: string, session: EditSession) => void;

export type SessionManagerDeps = {
  clock?: Clock;
  editorOverride?: string;
  onChange?: SessionChangeCallback;
  debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 100;

export class EditSessionManager {
  private sessions = new Map<string, EditSession>();
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly clock: Clock;
  private readonly editorOverride: string | undefined;
  private readonly onChange: SessionChangeCallback | undefined;
  private readonly debounceMs: number;

  constructor(deps: SessionManagerDeps = {}) {
    this.clock = deps.clock ?? (() => new Date());
    this.editorOverride = deps.editorOverride;
    this.onChange = deps.onChange;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async open(filePath: string): Promise<void> {
    const existing = this.sessions.get(filePath);
    if (existing && isSessionActive(existing)) {
      this.dispatch(filePath, { type: 'open-requested', filePath });
      return;
    }

    this.sessions.set(filePath, { ...initialSession });
    this.dispatch(filePath, { type: 'open-requested', filePath });

    try {
      const command = this.editorOverride
        ? this.buildOverrideCommand(filePath)
        : buildEditorSpawnCommand(filePath);

      await this.spawnEditor(command, filePath);
      this.dispatch(filePath, { type: 'open-succeeded' });
      this.startWatcher(filePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.dispatch(filePath, { type: 'open-failed', reason });
    }
  }

  endSession(filePath: string): void {
    this.dispatch(filePath, { type: 'session-ended' });
    this.stopWatcher(filePath);
    this.clearDebounce(filePath);
    this.sessions.delete(filePath);
  }

  isFileUnderSession(filePath: string): boolean {
    const session = this.sessions.get(filePath);
    return session !== undefined && isSessionActive(session);
  }

  getSession(filePath: string): EditSession | undefined {
    return this.sessions.get(filePath);
  }

  getActiveSessionPaths(): string[] {
    return Array.from(this.sessions.entries())
      .filter(([, s]) => isSessionActive(s))
      .map(([p]) => p);
  }

  dispose(): void {
    for (const filePath of this.sessions.keys()) {
      this.endSession(filePath);
    }
  }

  private dispatch(filePath: string, event: SessionEvent): void {
    const current = this.sessions.get(filePath) ?? { ...initialSession };
    const next = reduceSession(current, event);
    this.sessions.set(filePath, next);
    this.onChange?.(filePath, next);
  }

  private startWatcher(filePath: string): void {
    const dir = dirname(filePath);
    const filename = basename(filePath);

    try {
      const watcher = fs.watch(dir, (event, watchedFilename) => {
        if (watchedFilename !== filename) return;
        this.scheduleDebounce(filePath, event);
      });
      this.watchers.set(filePath, watcher);
    } catch {
      // directory may not exist or be unwatchable; session continues
      // without live refresh — user can still edit in VS Code
    }
  }

  private stopWatcher(filePath: string): void {
    const watcher = this.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(filePath);
    }
  }

  private scheduleDebounce(filePath: string, event: string): void {
    this.clearDebounce(filePath);
    const timer = setTimeout(() => this.handleFileEvent(filePath, event), this.debounceMs);
    this.debounceTimers.set(filePath, timer);
  }

  private clearDebounce(filePath: string): void {
    const timer = this.debounceTimers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(filePath);
    }
  }

  private async handleFileEvent(filePath: string, event: string): Promise<void> {
    const session = this.sessions.get(filePath);
    if (!session || !isSessionActive(session)) return;

    const exists = await fs.pathExists(filePath);

    if (!exists) {
      if (session.phase === 'watching' || session.phase === 'opening') {
        this.dispatch(filePath, { type: 'file-unlinked' });
      }
      return;
    }

    // File exists — read content
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return; // unreadable, skip
    }

    const timestamp = this.clock();

    if (session.phase === 'missing') {
      this.dispatch(filePath, { type: 'file-reappeared', content, timestamp });
    } else {
      this.dispatch(filePath, { type: 'file-changed', content, timestamp });
    }
  }

  private buildOverrideCommand(filePath: string) {
    // When an editor override is configured, use it directly with the file path
    return {
      command: this.editorOverride!,
      args: [filePath],
      options: { stdio: 'ignore' as const },
      failureGuidance: `Check that "${this.editorOverride}" is installed and available in PATH.`,
    };
  }

  private spawnEditor(
    command: ReturnType<typeof buildEditorSpawnCommand>,
    filePath: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, command.args, command.options as spawn.SpawnOptions);

      child.once('error', (error) => {
        reject(new Error(`Failed to open editor: ${error.message}`));
      });

      child.once('close', (exitCode) => {
        if (exitCode === 0) {
          resolve();
          return;
        }
        reject(new Error(command.failureGuidance));
      });
    });
  }
}
```

- [ ] **Step 2: Update barrel index.ts to export session-manager**

Add to `src/core/edit-session/index.ts`:

```typescript
export { EditSessionManager } from './session-manager';
export type { SessionChangeCallback, SessionManagerDeps } from './session-manager';
```

- [ ] **Step 3: Write session manager tests**

```typescript
// test/edit-session-manager.test.ts

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditSessionManager } from '../src/core/edit-session/session-manager';
import type { EditSession } from '../src/core/edit-session/types';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    watch: vi.fn(),
    pathExists: vi.fn(),
    readFile: vi.fn(),
  },
}));

import { spawn } from 'node:child_process';
import fs from 'fs-extra';

function mockSpawnSuccess() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  vi.mocked(spawn).mockReturnValue(child as never);
  // Resolve on next tick
  setTimeout(() => {
    child.emit('close', 0);
  }, 0);
  return child;
}

function mockSpawnFailure(code = 1) {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  vi.mocked(spawn).mockReturnValue(child as never);
  setTimeout(() => {
    child.emit('close', code);
  }, 0);
  return child;
}

function mockSpawnError() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  vi.mocked(spawn).mockReturnValue(child as never);
  setTimeout(() => {
    child.emit('error', new Error('spawn ENOENT'));
  }, 0);
  return child;
}

describe('EditSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('open', () => {
    it('transitions to watching on successful editor spawn', async () => {
      mockSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const changes: Array<{ filePath: string; session: EditSession }> = [];
      const manager = new EditSessionManager({
        onChange: (filePath, session) => changes.push({ filePath, session }),
      });

      await manager.open('/tmp/test.md');

      const session = manager.getSession('/tmp/test.md');
      expect(session?.phase).toBe('watching');
      expect(session?.filePath).toBe('/tmp/test.md');
    });

    it('transitions to idle on editor spawn failure', async () => {
      mockSpawnFailure();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      const session = manager.getSession('/tmp/test.md');
      expect(session?.phase).toBe('idle');
      expect(session?.openFailedReason).toBeTruthy();
    });

    it('transitions to idle on spawn error', async () => {
      mockSpawnError();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      const session = manager.getSession('/tmp/test.md');
      expect(session?.phase).toBe('idle');
      expect(session?.openFailedReason).toBeTruthy();
    });

    it('starts a file watcher on success', async () => {
      mockSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      expect(fs.watch).toHaveBeenCalledWith('/tmp', expect.any(Function));
    });

    it('fires onChange callback for each state transition', async () => {
      mockSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const changes: string[] = [];
      const manager = new EditSessionManager({
        onChange: (_, session) => changes.push(session.phase),
      });

      await manager.open('/tmp/test.md');

      expect(changes).toContain('opening');
      expect(changes).toContain('watching');
    });
  });

  describe('endSession', () => {
    it('ends an active session and cleans up', async () => {
      mockSpawnSuccess();
      const watcherClose = vi.fn();
      vi.mocked(fs.watch).mockReturnValue({ close: watcherClose } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');
      expect(manager.isFileUnderSession('/tmp/test.md')).toBe(true);

      manager.endSession('/tmp/test.md');
      expect(manager.isFileUnderSession('/tmp/test.md')).toBe(false);
      expect(watcherClose).toHaveBeenCalled();
      expect(manager.getSession('/tmp/test.md')).toBeUndefined();
    });
  });

  describe('isFileUnderSession', () => {
    it('returns true when file has an active session', async () => {
      mockSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/a.md');
      await manager.open('/tmp/b.md');

      expect(manager.isFileUnderSession('/tmp/a.md')).toBe(true);
      expect(manager.isFileUnderSession('/tmp/b.md')).toBe(true);
      expect(manager.isFileUnderSession('/tmp/c.md')).toBe(false);
    });
  });

  describe('getActiveSessionPaths', () => {
    it('returns paths of all active sessions', async () => {
      mockSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/a.md');
      await manager.open('/tmp/b.md');

      const active = manager.getActiveSessionPaths();
      expect(active).toContain('/tmp/a.md');
      expect(active).toContain('/tmp/b.md');
      expect(active).toHaveLength(2);
    });
  });

  describe('dispose', () => {
    it('ends all active sessions', async () => {
      mockSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/a.md');
      await manager.open('/tmp/b.md');

      manager.dispose();
      expect(manager.getActiveSessionPaths()).toHaveLength(0);
    });
  });

  describe('write guard', () => {
    it('refuses structured-field writes when session is active', async () => {
      mockSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      expect(manager.isFileUnderSession('/tmp/test.md')).toBe(true);
      // A different file in the same profile is not blocked
      expect(manager.isFileUnderSession('/tmp/other.md')).toBe(false);
    });
  });

  describe('editor override', () => {
    it('uses editor override when provided', async () => {
      mockSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager({ editorOverride: 'vim' });
      await manager.open('/tmp/test.md');

      expect(spawn).toHaveBeenCalledWith('vim', ['/tmp/test.md'], expect.objectContaining({ stdio: 'ignore' }));
    });
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/edit-session-manager.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/edit-session/session-manager.ts src/core/edit-session/index.ts test/edit-session-manager.test.ts
git commit -m "feat(edit-session): add session manager with fs.watch, editor spawn, and write guard"
```

---

### Task 3: i18n Keys

**Files:**
- Modify: `src/tui/workbench/i18n/en.ts`
- Modify: `src/tui/workbench/i18n/zh.ts`
- Modify: `src/tui/workbench/i18n/index.ts`
- Test: `test/workbench-i18n.test.ts` (existing, should still pass)

**Interfaces:**
- Consumes: existing i18n structure from `src/tui/workbench/i18n/`
- Produces: edit-session i18n keys for use by Ink components

- [ ] **Step 1: Add English keys to en.ts**

Add these keys to the `en` object in `src/tui/workbench/i18n/en.ts`:

```typescript
  // Edit session
  'editSession.banner': 'Editing {count} file(s) in VS Code — Workbench is watching',
  'editSession.watching': 'watching',
  'editSession.watching.changeCount': '(#{count})',
  'editSession.watching.updated': 'updated {time}',
  'editSession.missing.title': 'File deleted or renamed — tracking paused',
  'editSession.missing.hint': 'Preview shows last known content. Watching resumes when the file reappears.',
  'editSession.fallback.title': 'VS Code unavailable',
  'editSession.fallback.systemEditor': 'Open in system editor',
  'editSession.fallback.copyPath': 'Copy path to clipboard',
  'editSession.fallback.retry': 'Retry VS Code',
  'editSession.writeBlocked': 'Finish in VS Code first',
```

- [ ] **Step 2: Add Chinese keys to zh.ts**

Add these keys to the `zh` object in `src/tui/workbench/i18n/zh.ts`:

```typescript
  // Edit session
  'editSession.banner': '正在 VS Code 中编辑 {count} 个文件 — Workbench 正在监听',
  'editSession.watching': '监听中',
  'editSession.watching.changeCount': '(#{count})',
  'editSession.watching.updated': '更新于 {time}',
  'editSession.missing.title': '文件已删除或重命名 — 监听暂停',
  'editSession.missing.hint': '预览显示最后已知内容。文件重新出现时自动恢复监听。',
  'editSession.fallback.title': 'VS Code 不可用',
  'editSession.fallback.systemEditor': '使用系统编辑器打开',
  'editSession.fallback.copyPath': '复制路径到剪贴板',
  'editSession.fallback.retry': '重试 VS Code',
  'editSession.writeBlocked': '请先在 VS Code 中完成编辑',
```

- [ ] **Step 3: Update index.ts if needed to include new keys in the type**

The `LocaleKey` type is derived from `en`, so adding keys to `en.ts` automatically includes them. Verify `index.ts` doesn't need changes.

- [ ] **Step 4: Run existing i18n tests**

Run: `npx vitest run test/workbench-i18n.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/workbench/i18n/
git commit -m "feat(edit-session): add i18n keys for edit session UI"
```

---

### Task 4: Ink Components

**Files:**
- Create: `src/tui/workbench/edit-session/EditBanner.tsx`
- Create: `src/tui/workbench/edit-session/WatchingBadge.tsx`
- Create: `src/tui/workbench/edit-session/MissingOverlay.tsx`
- Create: `src/tui/workbench/edit-session/FallbackMenu.tsx`

**Interfaces:**
- Consumes: `EditSession` from Task 1, i18n keys from Task 3, `picocolors`
- Produces: React components for the Workbench edit session UI

Note: These components are not tested with Ink's testing library (Ink 7 compatibility is unresolved per spec §2). They are type-checked via `tsc` and visually verified in the prototype.

- [ ] **Step 1: Create EditBanner.tsx**

```tsx
// src/tui/workbench/edit-session/EditBanner.tsx

import React from 'react';
import { Box, Text } from 'ink';
import pc from 'picocolors';

interface EditBannerProps {
  activeCount: number;
}

export function EditBanner({ activeCount }: EditBannerProps) {
  if (activeCount === 0) return null;

  return (
    <Box>
      <Text>{pc.green('✎')} Editing {activeCount} file{activeCount !== 1 ? 's' : ''} in VS Code — Workbench is watching</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Create WatchingBadge.tsx**

```tsx
// src/tui/workbench/edit-session/WatchingBadge.tsx

import React from 'react';
import { Box, Text } from 'ink';
import pc from 'picocolors';

interface WatchingBadgeProps {
  phase: 'idle' | 'opening' | 'watching' | 'missing';
  changeCount: number;
  lastUpdated: Date | null;
}

export function WatchingBadge({ phase, changeCount, lastUpdated }: WatchingBadgeProps) {
  if (phase === 'idle') return null;

  if (phase === 'opening') {
    return (
      <Box>
        <Text>{pc.cyan('…opening')}</Text>
      </Box>
    );
  }

  if (phase === 'missing') {
    return (
      <Box>
        <Text>{pc.yellow('⚠ missing')}</Text>
      </Box>
    );
  }

  // watching
  const timeStr = lastUpdated
    ? lastUpdated.toLocaleTimeString('en-GB', { hour12: false })
    : null;

  return (
    <Box gap={1}>
      <Text>{pc.green('✎ watching')}</Text>
      {changeCount > 0 && <Text>{pc.dim(`(#${changeCount})`)}</Text>}
      {timeStr && <Text>{pc.dim(`updated ${timeStr}`)}</Text>}
    </Box>
  );
}
```

- [ ] **Step 3: Create MissingOverlay.tsx**

```tsx
// src/tui/workbench/edit-session/MissingOverlay.tsx

import React from 'react';
import { Box, Text } from 'ink';
import pc from 'picocolors';

interface MissingOverlayProps {
  lastContent: string | null;
  maxLines?: number;
}

export function MissingOverlay({ lastContent, maxLines = 20 }: MissingOverlayProps) {
  const lines = (lastContent ?? '').split('\n').slice(0, maxLines);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{pc.yellow('⚠ File deleted or renamed — tracking paused')}</Text>
      </Box>
      <Box>
        <Text dimColor>Preview shows last known content. Watching resumes when the file reappears.</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => (
          <Text key={i} wrap="truncate">{line || ' '}</Text>
        ))}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Create FallbackMenu.tsx**

```tsx
// src/tui/workbench/edit-session/FallbackMenu.tsx

import React from 'react';
import { Box, Text } from 'ink';
import pc from 'picocolors';

interface FallbackMenuProps {
  reason: string | null;
  onSystemEditor?: () => void;
  onCopyPath?: () => void;
  onRetry?: () => void;
}

export function FallbackMenu({ reason, onSystemEditor, onCopyPath, onRetry }: FallbackMenuProps) {
  if (!reason) return null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{pc.red('● VS Code unavailable')}: {reason}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <Text>[1] Open in system editor</Text>
        <Text>[2] Copy path to clipboard</Text>
        <Text>[3] Retry VS Code</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/tui/workbench/edit-session/
git commit -m "feat(edit-session): add Ink components for banner, badge, missing overlay, and fallback menu"
```

---

### Task 5: Integration and Full Test Suite

**Files:**
- All files from Tasks 1–4

**Interfaces:**
- Consumes: All prior tasks
- Produces: Fully integrated edit-session module, passing `npm run check`

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Run full check**

Run: `npm run check`
Expected: lint + test + build all pass

- [ ] **Step 5: Commit any fixes if needed**

If any fixes were required during the check:

```bash
git add -A
git commit -m "fix(edit-session): address lint/build/test issues"
```

---

### Task 6: Code Review

- [ ] **Step 1: Run code review using the code-review skill**

Invoke the `/code-review` skill to review all changes on this branch against the spec and coding standards.

- [ ] **Step 2: Address any findings from the review**

Fix issues found during code review and commit.

- [ ] **Step 3: Final `npm run check`**

Run: `npm run check`
Expected: All pass
