import fs from 'fs-extra';
import { basename, dirname, resolve } from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';

import { buildEditorSpawnCommand } from '../../platform/editor';
import { resolveInside } from '../../platform/path';
import type { Clock } from '../types';
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
    const resolvedPath = resolveInside(resolve(filePath));
    const existing = this.sessions.get(resolvedPath);
    if (existing && isSessionActive(existing)) {
      this.dispatch(resolvedPath, { type: 'open-requested', filePath: resolvedPath });
      return;
    }

    this.sessions.set(resolvedPath, { ...initialSession });
    this.dispatch(resolvedPath, { type: 'open-requested', filePath: resolvedPath });

    try {
      const command = this.editorOverride
        ? this.buildOverrideCommand(resolvedPath)
        : buildEditorSpawnCommand(resolvedPath);

      await this.spawnEditor(command);
      this.dispatch(resolvedPath, { type: 'open-succeeded' });
      this.startWatcher(resolvedPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.dispatch(resolvedPath, { type: 'open-failed', reason });
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
    for (const filePath of Array.from(this.sessions.keys())) {
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
      // Canonicalize the watched directory: on Windows, handing libuv a path
      // with an 8.3 short-form component (e.g. a short-form TEMP root like
      // C:\Users\RUNNER~1\...) trips the fs-event assertion
      // (!_wcsnicmp(filename, dir, dirlen), src\win\fs-event.c) which aborts
      // the process and cannot be caught. realpath yields the long form.
      let watchDir = dir;
      try {
        watchDir = fs.realpathSync.native(dir);
      } catch {
        // realpath failed (e.g. dir does not exist); the watch below either
        // works with the unresolved path or throws into the outer catch.
      }
      const watcher = fs.watch(watchDir, (_event, watchedFilename) => {
        if (watchedFilename !== filename) return;
        this.scheduleDebounce(filePath);
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

  private scheduleDebounce(filePath: string): void {
    this.clearDebounce(filePath);
    const timer = setTimeout(() => this.handleFileEvent(filePath), this.debounceMs);
    this.debounceTimers.set(filePath, timer);
  }

  private clearDebounce(filePath: string): void {
    const timer = this.debounceTimers.get(filePath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(filePath);
    }
  }

  private async handleFileEvent(filePath: string): Promise<void> {
    const session = this.sessions.get(filePath);
    if (!session || !isSessionActive(session)) return;

    const exists = await fs.pathExists(filePath);

    if (!exists) {
      if (session.phase === 'watching' || session.phase === 'opening') {
        this.dispatch(filePath, { type: 'file-unlinked' });
      }
      return;
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }

    const timestamp = this.clock();

    if (session.phase === 'missing') {
      this.dispatch(filePath, { type: 'file-reappeared', content, timestamp });
    } else {
      this.dispatch(filePath, { type: 'file-changed', content, timestamp });
    }
  }

  private buildOverrideCommand(filePath: string) {
    return {
      command: this.editorOverride!,
      args: [filePath],
      options: { stdio: 'ignore' as const, shell: false },
      failureGuidance: `Check that "${this.editorOverride}" is installed and available in PATH.`,
    };
  }

  private spawnEditor(
    command: ReturnType<typeof buildEditorSpawnCommand>,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, command.args, { ...command.options, shell: false } as SpawnOptions);

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
