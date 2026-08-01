import { EventEmitter } from 'node:events';
import { dirname, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditSessionManager } from '../src/core/edit-session/session-manager';
import type { EditSession } from '../src/core/edit-session/types';
import { resolveInside } from '../src/platform/path';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    watch: vi.fn(),
    pathExists: vi.fn(),
    readFile: vi.fn(),
    realpathSync: { native: vi.fn((p: string) => p) },
  },
}));

import { spawn } from 'node:child_process';
import fs from 'fs-extra';

/** The manager keys sessions by the fully resolved path; on Windows a POSIX
 *  input like '/tmp/a.md' resolves onto the current drive ('D:\tmp\a.md').
 *  Mirror the manager's own resolution so assertions hold on every platform. */
function resolvedPath(filePath: string): string {
  return resolveInside(resolve(filePath));
}

function setupSpawnSuccess() {
  vi.mocked(spawn).mockImplementation((() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  }) as never);
}

function setupSpawnFailure(code = 1) {
  vi.mocked(spawn).mockImplementation((() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    setTimeout(() => child.emit('close', code), 0);
    return child;
  }) as never);
}

function setupSpawnError() {
  vi.mocked(spawn).mockImplementation((() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 0);
    return child;
  }) as never);
}

describe('EditSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('open', () => {
    it('transitions to watching on successful editor spawn', async () => {
      setupSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const changes: Array<{ filePath: string; session: EditSession }> = [];
      const manager = new EditSessionManager({
        onChange: (filePath, session) => changes.push({ filePath, session }),
      });

      await manager.open('/tmp/test.md');

      const session = manager.getSession(resolvedPath('/tmp/test.md'));
      expect(session?.phase).toBe('watching');
      expect(session?.filePath).toBe(resolvedPath('/tmp/test.md'));
    });

    it('transitions to idle on editor spawn failure', async () => {
      setupSpawnFailure();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      const session = manager.getSession(resolvedPath('/tmp/test.md'));
      expect(session?.phase).toBe('idle');
      expect(session?.openFailedReason).toBeTruthy();
    });

    it('transitions to idle on spawn error', async () => {
      setupSpawnError();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      const session = manager.getSession(resolvedPath('/tmp/test.md'));
      expect(session?.phase).toBe('idle');
      expect(session?.openFailedReason).toBeTruthy();
    });

    it('starts a file watcher on success', async () => {
      setupSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      expect(fs.watch).toHaveBeenCalledWith(dirname(resolvedPath('/tmp/test.md')), expect.any(Function));
    });

    it('watches the realpath-canonicalized directory (Windows 8.3 short-path guard)', async () => {
      setupSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);
      // Windows: fs.watch must get the long-form path — a short-form input
      // (e.g. under a RUNNER~1 TEMP root) trips libuv's fs-event assertion
      // and aborts the process. The manager canonicalizes via realpath.
      const canonical = resolve('canonical-dir');
      vi.mocked(fs.realpathSync.native).mockImplementationOnce(() => canonical);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      expect(fs.watch).toHaveBeenCalledWith(canonical, expect.any(Function));
    });

    it('fires onChange callback for each state transition', async () => {
      setupSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const changes: string[] = [];
      const manager = new EditSessionManager({
        onChange: (_filePath, session) => changes.push(session.phase),
      });

      await manager.open('/tmp/test.md');

      expect(changes).toContain('opening');
      expect(changes).toContain('watching');
    });
  });

  describe('endSession', () => {
    it('ends an active session and cleans up', async () => {
      setupSpawnSuccess();
      const watcherClose = vi.fn();
      vi.mocked(fs.watch).mockReturnValue({ close: watcherClose } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');
      expect(manager.isFileUnderSession(resolvedPath('/tmp/test.md'))).toBe(true);

      manager.endSession(resolvedPath('/tmp/test.md'));
      expect(manager.isFileUnderSession(resolvedPath('/tmp/test.md'))).toBe(false);
      expect(watcherClose).toHaveBeenCalled();
      expect(manager.getSession(resolvedPath('/tmp/test.md'))).toBeUndefined();
    });
  });

  describe('isFileUnderSession', () => {
    it('returns true when file has an active session', async () => {
      setupSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/a.md');
      await manager.open('/tmp/b.md');

      expect(manager.isFileUnderSession(resolvedPath('/tmp/a.md'))).toBe(true);
      expect(manager.isFileUnderSession(resolvedPath('/tmp/b.md'))).toBe(true);
      expect(manager.isFileUnderSession(resolvedPath('/tmp/c.md'))).toBe(false);
    });
  });

  describe('getActiveSessionPaths', () => {
    it('returns paths of all active sessions', async () => {
      setupSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/a.md');
      await manager.open('/tmp/b.md');

      const active = manager.getActiveSessionPaths();
      expect(active).toContain(resolvedPath('/tmp/a.md'));
      expect(active).toContain(resolvedPath('/tmp/b.md'));
      expect(active).toHaveLength(2);
    });
  });

  describe('dispose', () => {
    it('ends all active sessions', async () => {
      setupSpawnSuccess();
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
      setupSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager();
      await manager.open('/tmp/test.md');

      expect(manager.isFileUnderSession(resolvedPath('/tmp/test.md'))).toBe(true);
      expect(manager.isFileUnderSession(resolvedPath('/tmp/other.md'))).toBe(false);
    });
  });

  describe('editor override', () => {
    it('uses editor override when provided', async () => {
      setupSpawnSuccess();
      vi.mocked(fs.watch).mockReturnValue({ close: vi.fn() } as never);

      const manager = new EditSessionManager({ editorOverride: 'vim' });
      await manager.open('/tmp/test.md');

      expect(spawn).toHaveBeenCalledWith('vim', [resolvedPath('/tmp/test.md')], expect.objectContaining({ stdio: 'ignore' }));
    });
  });
});
