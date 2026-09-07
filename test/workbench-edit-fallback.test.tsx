import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { getProfileTemplatePaths } from '../src/core/profile-template';
import { buildSystemOpenCommand } from '../src/platform/editor';
import { resolveInside } from '../src/platform/path';
import type { WorkbenchProfile, WorkbenchData } from '../src/tui/workbench/profile-data';
import { flatten, makeProfile, noPluginsReader, setupSpawnSuccess, stripAnsi } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

class FakeTtyStdout extends Writable {
  public readonly isTTY = true;
  // Wide enough that long absolute paths render on one row — the main pane is
  // ~70% of the total width and wrapped paths break substring assertions.
  public columns = 300;
  public rows = 40;
  private readonly chunks: Buffer[] = [];

  public override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  public get output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** A TTY-looking stdin that can synthesize keypresses for interactive tests. */
class FakeTtyStdin extends Readable {
  public readonly isTTY = true;
  public override _read(): void {}
  public setRawMode(): this {
    return this;
  }
  public ref(): this {
    return this;
  }
  public unref(): this {
    return this;
  }
  public press(ch: string): void {
    this.push(Buffer.from(ch, 'utf8'));
    this.emit('readable');
  }
}

/** Controlled spawn: emits an ENOENT-style error so the edit session lands in
 *  the open-failed state that surfaces the fallback menu. */
function setupSpawnError(): void {
  vi.mocked(spawn).mockImplementation((() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    setTimeout(() => child.emit('error', new Error('spawn code ENOENT')), 0);
    return child;
  }) as never);
}

describe('editor unavailable fallback (§8, S35)', () => {
  const tempRoots: string[] = [];
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    previousHome = undefined;
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    previousUserProfile = undefined;
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    vi.clearAllMocks();
  });

  /** Point HOME at a fresh temp dir (see workbench-top-level-edit.test.tsx). */
  async function overrideHomeToTemp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-edit-fallback-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return home;
  }

  /** Temp home with a real coding profile (CLAUDE.md on disk). */
  async function setupRealProfile(): Promise<{ appHome: string; claudeMdPath: string }> {
    await overrideHomeToTemp();
    const appHome = getAppHomePaths().appHomePath;
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    return { appHome, claudeMdPath: getProfileTemplatePaths(appHome, 'coding').claudeMdPath };
  }

  const dataFor = (profile: WorkbenchProfile): WorkbenchData => ({
    profiles: [profile],
    defaultProfile: 'coding',
    customTemplates: [],
  });

  async function waitForInputListener(stdin: FakeTtyStdin, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && stdin.listenerCount('readable') === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (stdin.listenerCount('readable') === 0) {
      throw new Error('Ink never attached a stdin readable listener');
    }
  }

  async function waitForOutputSettled(
    stdout: FakeTtyStdout,
    baseline: string,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && stdout.output === baseline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let last = stdout.output;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const current = stdout.output;
      if (current === last) return;
      last = current;
      if (Date.now() > deadline) return;
    }
  }

  async function waitForOutput(
    stdout: FakeTtyStdout,
    needle: string,
    timeoutMs = 3000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = flatten(stripAnsi(stdout.output));
      if (current.includes(needle)) return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return flatten(stripAnsi(stdout.output));
  }

  /**
   * Ink subscribes useInput handlers in a passive effect, so a freshly
   * surfaced menu can be visible before its keys are live; on slow runners
   * (Windows CI) a single press can fall into that gap and vanish. Press
   * until the observable effect lands (bounded), like a user whose keypress
   * did nothing. `effected` must become true near-synchronously once the key
   * is processed, so a full quiet interval means the press was really lost.
   */
  async function pressUntil(
    stdin: FakeTtyStdin,
    key: string,
    effected: () => boolean,
    attempts = 6,
    intervalMs = 1000,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Check first: an earlier press may already have landed, and re-pressing
      // a live key can double-trigger its action.
      if (effected()) return true;
      stdin.press(key);
      const deadline = Date.now() + intervalMs;
      while (Date.now() < deadline) {
        if (effected()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return effected();
  }

  async function renderInteractive(
    element: React.ReactElement,
  ): Promise<{ instance: ReturnType<typeof render>; stdout: FakeTtyStdout; stdin: FakeTtyStdin }> {
    const stdout = new FakeTtyStdout();
    const stdin = new FakeTtyStdin();
    const instance = render(element, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    });
    await instance.waitUntilRenderFlush();
    await waitForInputListener(stdin);
    return { instance, stdout, stdin };
  }

  /** Newest full-screen payload, flattened. Asserting on everything written
   *  after a baseline is not frame-safe on win32: Ink repaints fullscreen
   *  frames via clearTerminal there (ink #969), so a late async state tick
   *  (e.g. the plugin-inventory probe resolving) replays the previous screen
   *  into the post-baseline bytes. Splitting on both repaint boundaries
   *  (eraseLines prefix and win32 clearTerminal) isolates the current frame. */
  function lastFrame(stdout: FakeTtyStdout): string {
    // eslint-disable-next-line no-control-regex
    const segments = stdout.output.split(/(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G|\x1b\[2J\x1b\[0f|\x1b\[2J\x1b\[3J\x1b\[H/);
    return flatten(segments[segments.length - 1] ?? '');
  }

  it('a failed handoff surfaces the inline error with the three fallback actions', async () => {
    setupSpawnError();
    await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile()),
        initialLocale: 'en',
        skipWelcome: true,
        pluginInventoryReader: noPluginsReader,
      }),
    );

    stdin.press('e');
    const output = await waitForOutput(stdout, 'VS Code unavailable');

    expect(output).toContain('VS Code unavailable');
    expect(output).toContain('ENOENT');
    expect(output).toContain('[1] Open in system editor');
    expect(output).toContain('[2] Show path');
    expect(output).toContain('[3] Retry VS Code');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('[2] prints the file path in the panel (no clipboard in a TUI)', async () => {
    setupSpawnError();
    const { claudeMdPath } = await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile()),
        initialLocale: 'en',
        skipWelcome: true,
        pluginInventoryReader: noPluginsReader,
      }),
    );

    stdin.press('e');
    await waitForOutput(stdout, 'VS Code unavailable');

    await pressUntil(stdin, '2', () => flatten(stripAnsi(stdout.output)).includes('CLAUDE.md'));
    const output = await waitForOutput(stdout, 'CLAUDE.md');
    expect(output).toContain(resolveInside(resolve(claudeMdPath)));
    // The menu stays up after revealing the path.
    expect(output).toContain('[3] Retry VS Code');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('[3] retries the handoff; on success the menu clears and watching starts', async () => {
    setupSpawnError();
    await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile()),
        initialLocale: 'en',
        skipWelcome: true,
        pluginInventoryReader: noPluginsReader,
      }),
    );

    stdin.press('e');
    await waitForOutput(stdout, 'VS Code unavailable');
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    setupSpawnSuccess();
    // spawn() runs synchronously once the key is processed, so the call count
    // is the near-synchronous observable for pressUntil.
    const retried = await pressUntil(stdin, '3', () => vi.mocked(spawn).mock.calls.length >= 2);
    expect(retried).toBe(true);
    await waitForOutput(stdout, 'watching');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    // Assert the final visible frame only — historical frames in the raw
    // stream still contain the pre-retry error screen (see lastFrame).
    const settleDeadline = Date.now() + 3000;
    while (Date.now() < settleDeadline && !lastFrame(stdout).includes('watching')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const finalFrame = lastFrame(stdout);
    expect(finalFrame).toContain('watching');
    expect(finalFrame).not.toContain('VS Code unavailable');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('[1] opens the OS default editor with platform arg arrays and dismisses the menu', async () => {
    setupSpawnError();
    const { claudeMdPath } = await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile()),
        initialLocale: 'en',
        skipWelcome: true,
        pluginInventoryReader: noPluginsReader,
      }),
    );

    stdin.press('e');
    await waitForOutput(stdout, 'VS Code unavailable');

    const baseline = stdout.output; // uncleared — settle waits for a NEW frame
    setupSpawnSuccess();
    // The handoff spawn is recorded the moment '1' is processed; press until
    // the observable call count moves (a press landing before the menu's
    // passive-effect input subscription is silently dropped), then settle for
    // the dismiss frame.
    const opened = await pressUntil(stdin, '1', () => vi.mocked(spawn).mock.calls.length >= 2);
    expect(opened).toBe(true);
    await waitForOutputSettled(stdout, baseline);

    // Second spawn is the system-editor handoff: arg-array style, shell:false,
    // no shell string concatenation.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    const expected = buildSystemOpenCommand(resolveInside(resolve(claudeMdPath)));
    expect(vi.mocked(spawn)).toHaveBeenNthCalledWith(
      2,
      expected.command,
      expected.args,
      expected.options,
    );

    // Final visible frame must be a post-dismiss one — historical frames in
    // the raw stream still contain the menu (see lastFrame).
    const menuGoneDeadline = Date.now() + 3000;
    while (Date.now() < menuGoneDeadline && lastFrame(stdout).includes('VS Code unavailable')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(lastFrame(stdout)).not.toContain('VS Code unavailable');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('Esc dismisses the menu without further spawns', async () => {
    setupSpawnError();
    await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile()),
        initialLocale: 'en',
        skipWelcome: true,
        pluginInventoryReader: noPluginsReader,
      }),
    );

    stdin.press('e');
    await waitForOutput(stdout, 'VS Code unavailable');

    const baseline = stdout.output; // uncleared — settle waits for a NEW frame
    stdin.press('\u001b'); // Esc
    // Esc is idempotent (dismiss on an open menu, no-op once closed), so
    // press-until-observed is safe. The dismiss render is observed as the
    // newest frame losing the menu while keeping the sidebar (see lastFrame).
    const dismissed = await pressUntil(stdin, String.fromCodePoint(27), () => {
      const frame = lastFrame(stdout);
      return frame.includes('Type to search…') && !frame.includes('VS Code unavailable');
    });
    expect(dismissed).toBe(true);
    await waitForOutputSettled(stdout, baseline);

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(lastFrame(stdout)).not.toContain('VS Code unavailable');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('zh renders the fallback menu', async () => {
    setupSpawnError();
    await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile()),
        initialLocale: 'zh',
        skipWelcome: true,
        pluginInventoryReader: noPluginsReader,
      }),
    );

    stdin.press('e');
    const output = await waitForOutput(stdout, 'VS Code 不可用');

    expect(output).toContain('VS Code 不可用');
    expect(output).toContain('[1] 使用系统编辑器打开');
    expect(output).toContain('[2] 显示路径');
    expect(output).toContain('[3] 重试 VS Code');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('workbench.editor override reaches the spawn as executable + args', async () => {
    setupSpawnSuccess();
    const { claudeMdPath } = await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile()),
        initialLocale: 'en',
        skipWelcome: true,
        editorOverride: 'fakeeditor -w',
      }),
    );

    stdin.press('e');
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledWith(
        'fakeeditor',
        ['-w', resolveInside(resolve(claudeMdPath))],
        expect.objectContaining({ stdio: 'ignore', shell: false }),
      );
    });

    instance.unmount();
    await instance.waitUntilExit();
  });
});
