import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import { KeymapOverlay } from '../src/tui/workbench/keymap';
import { I18nProvider } from '../src/tui/workbench/i18n/react';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { getProfileTemplatePaths } from '../src/core/profile-template';
import type { WorkbenchProfile, WorkbenchData } from '../src/tui/workbench/profile-data';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

class FakeTtyStdout extends Writable {
  public readonly isTTY = true;
  public columns = 100;
  public rows = 30;
  private readonly chunks: Buffer[] = [];

  public override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  public get output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  /** Return and clear the accumulated writes so a later frame can be asserted alone. */
  public snapshot(): string {
    const out = this.output;
    this.chunks.length = 0;
    return out;
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

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

/** Flatten wrapped render output (borders included) for substring assertions. */
function flatten(text: string): string {
  return stripAnsi(text)
    .replace(/[│╭╰╮╯─┌┐└┘┃┏┓┗┛]/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/[ ]+/g, ' ')
    .trim();
}

/** Controlled spawn: emits a successful exit so the edit session reaches 'watching'. */
function setupSpawnSuccess() {
  vi.mocked(spawn).mockImplementation((() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    setTimeout(() => child.emit('close', 0), 5);
    return child;
  }) as never);
}

/** True when any spawn call was handed the given path (works across the
 *  platform-specific editor commands — the path is a separate arg on POSIX and
 *  embedded in the PowerShell script on Windows). */
function spawnTargetsPath(targetPath: string): boolean {
  return vi.mocked(spawn).mock.calls.some((call) => JSON.stringify(call).includes(targetPath));
}

describe('top-level `e` edit in VS Code (§4.3/§8)', () => {
  const tempRoots: string[] = [];
  let previousHome: string | undefined;

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    previousHome = undefined;
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    vi.clearAllMocks();
  });

  /**
   * Point HOME at a fresh temp dir. Every interactive WorkbenchApp render must
   * do this: with the real user home, Ink sometimes never attaches its stdin
   * listener, and the render would also touch the real app home (Safety
   * contract). Returns the temp home path.
   */
  async function overrideHomeToTemp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-toplevel-edit-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    await fs.ensureDir(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    return home;
  }

  /** Point HOME at a temp dir with a real coding profile (CLAUDE.md on disk). */
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

  function profileWith(userMemoryExists: boolean, agentsCount = 0): WorkbenchProfile {
    const agent = {
      kind: 'agents' as const,
      name: 'explore',
      relativePath: 'claude-home/agents/explore.md',
      exists: true,
      frontmatter: { name: 'explore', description: 'read-only exploration' },
      frontmatterParseError: null,
      bodyExcerpt: 'Scan the codebase.',
    };
    return {
      name: 'coding',
      description: 'Daily coding profile',
      isDefault: true,
      isLastUsed: true,
      status: 'valid',
      resourceCounts: {
        userMemory: userMemoryExists ? 1 : 0,
        autoMemory: 0,
        skills: 0,
        agents: agentsCount,
        mcp: 0,
        settings: 1,
        launchConfig: 1,
      },
      resourceDetails: {
        userMemory: {
          kind: 'user-memory',
          name: 'CLAUDE.md',
          relativePath: 'claude-home/CLAUDE.md',
          exists: userMemoryExists,
          lineCount: 3,
          excerpt: 'Prefer explicit answers.',
        },
        agents: agentsCount > 0 ? [agent] : [],
        autoMemory: 0,
        skills: 0,
        mcp: 0,
        settings: 1,
        launchConfig: 1,
      },
      mcpServers: [],
      validation: null,
    };
  }

  const dataFor = (profile: WorkbenchProfile): WorkbenchData => ({
    profiles: [profile],
    defaultProfile: 'coding',
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

  async function waitForOutputSettled(stdout: FakeTtyStdout, baseline: string, timeoutMs = 3000): Promise<void> {
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

  /** Poll until the flattened output contains a needle (the edit session's
   *  'opening'→'watching' transition lands a frame or two after the spawn
   *  exits, which `waitForOutputSettled` can miss under frame throttling). */
  async function waitForOutput(stdout: FakeTtyStdout, needle: string, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = flatten(stripAnsi(stdout.output));
      if (current.includes(needle)) return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return flatten(stripAnsi(stdout.output));
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
    });
    await instance.waitUntilRenderFlush();
    await waitForInputListener(stdin);
    return { instance, stdout, stdin };
  }

  it('? help sheet lists [e] Edit in VS Code in the Actions group', async () => {
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(I18nProvider, { initialLocale: 'en' }, React.createElement(KeymapOverlay, { visible: true })),
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: dummyStdin() as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false },
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('[e] Edit in VS Code');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('pressing [e] on the profile grid opens the Profile CLAUDE.md and shows the watching banner', async () => {
    setupSpawnSuccess();
    const { claudeMdPath } = await setupRealProfile();
    const data = dataFor(profileWith(true));
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
    );

    const baseline = stdout.output;
    stdin.press('e');
    await waitForOutputSettled(stdout, baseline);

    const output = stripAnsi(stdout.output);
    // The edit was handed to VS Code for the selected Profile's CLAUDE.md.
    expect(spawnTargetsPath(claudeMdPath)).toBe(true);
    // §8 watching banner renders in the grid, with the change counter empty.
    expect(flatten(output)).toContain('watching');
    expect(flatten(output)).toContain('✎');
    // The grid hint line advertises the now-implemented [e] affordance.
    expect(flatten(output)).toContain('[e]Edit in VS Code');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('pressing [e] while the category grid is focused still opens CLAUDE.md (no dead-key state)', async () => {
    setupSpawnSuccess();
    const { claudeMdPath } = await setupRealProfile();
    const data = dataFor(profileWith(true));
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
    );

    // Tab focuses the category grid; the sidebar action keys are captured, but
    // the app-level `e` stays live (matching `u`/`a` in the same state).
    const tabBaseline = stdout.output;
    stdin.press('\t');
    await waitForOutputSettled(stdout, tabBaseline);
    expect(flatten(stripAnsi(stdout.output))).toContain('Esc to return to categories');

    stdin.press('e');
    const focusedOutput = await waitForOutput(stdout, 'watching');

    expect(spawnTargetsPath(claudeMdPath)).toBe(true);
    expect(focusedOutput).toContain('watching');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('external save refreshes the banner with the per-session change counter', async () => {
    setupSpawnSuccess();
    const { claudeMdPath } = await setupRealProfile();
    const data = dataFor(profileWith(true));
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
    );

    const baseline = stdout.output;
    stdin.press('e');
    await waitForOutputSettled(stdout, baseline);
    // The session must be watching (watcher attached) before an external write.
    expect(flatten(stripAnsi(stdout.output))).toContain('watching');

    await fs.writeFile(claudeMdPath, '# coding memory\nupdated line\n', 'utf8');
    const saveBaseline = stdout.output;
    await waitForOutputSettled(stdout, saveBaseline);

    const refreshed = stripAnsi(stdout.output);
    expect(flatten(refreshed)).toContain('(#1)');
    expect(flatten(refreshed)).toMatch(/updated \d{2}:\d{2}:\d{2}/);

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('when CLAUDE.md is missing, [e] explains the recreate path instead of opening VS Code', async () => {
    setupSpawnSuccess();
    await overrideHomeToTemp(); // interactive renders must stay off the real home
    const data = dataFor(profileWith(false));
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
    );

    const baseline = stdout.output;
    stdin.press('e');
    await waitForOutputSettled(stdout, baseline);

    const output = stripAnsi(stdout.output);
    expect(flatten(output)).toContain('User Memory (CLAUDE.md) is missing');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('does not fire the top-level edit while a resource view owns the keys (agents drill-down)', async () => {
    setupSpawnSuccess();
    const { appHome, claudeMdPath } = await setupRealProfile();
    const agentPath = join(appHome, 'profiles', 'coding', 'claude-home', 'agents', 'explore.md');
    await fs.ensureDir(join(appHome, 'profiles', 'coding', 'claude-home', 'agents'));
    await fs.writeFile(agentPath, '# explore\nscan the codebase.\n', 'utf8');
    const data = dataFor(profileWith(true, 1));
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
    );

    try {
      // Focus the category grid (sidebar keys — including the skill wizard's
      // [a] — are captured), then [a] drills into Agents without the wizard.
      let baseline = stdout.output;
      stdin.press('\t');
      await waitForOutputSettled(stdout, baseline);
      expect(flatten(stripAnsi(stdout.output))).toContain('Esc to return to categories');

      baseline = stdout.output;
      stdin.press('a');
      await waitForOutputSettled(stdout, baseline);
      expect(flatten(stripAnsi(stdout.output))).toContain('coding › Agents');

      // Resource view owns the keys: [e] opens the selected agent file, not
      // the Profile's CLAUDE.md.
      baseline = stdout.output;
      stdin.press('e');
      await waitForOutputSettled(stdout, baseline);

      expect(spawnTargetsPath(agentPath)).toBe(true);
      expect(spawnTargetsPath(claudeMdPath)).toBe(false);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('zh renders the missing-CLAUDE.md guidance for the top-level edit', async () => {
    setupSpawnSuccess();
    await overrideHomeToTemp(); // interactive renders must stay off the real home
    const data = dataFor(profileWith(false));
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'zh', skipWelcome: true }),
    );

    const baseline = stdout.output;
    stdin.press('e');
    await waitForOutputSettled(stdout, baseline);
    expect(flatten(stripAnsi(stdout.output))).toContain('用户记忆（CLAUDE.md）缺失');

    instance.unmount();
    await instance.waitUntilExit();
  });
});

function dummyStdin(): Readable {
  return new Readable({ read() {} });
}
