import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import type { WorkbenchProfile, WorkbenchData } from '../src/tui/workbench/profile-data';
import { flatten, stripAnsi } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

/**
 * Regression tests for issue #90 phase 1 (input correctness): Ink broadcasts
 * every keypress to all active `useInput` handlers, so ownership of each
 * contextual key must be decided by UI state (focus region, active prompt,
 * open overlay) — never by handler registration order.
 */

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

describe('Workbench input dispatch ownership (issue #90)', () => {
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

  /** Point HOME at a fresh temp dir (interactive renders must never touch the
   *  real app home; USERPROFILE is the win32 home source). */
  async function overrideHomeToTemp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-input-dispatch-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    await fs.ensureDir(home);
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return home;
  }

  /** Temp app home with a real `coding` profile on disk (CLAUDE.md exists). */
  async function setupRealProfile(): Promise<{ appHome: string }> {
    await overrideHomeToTemp();
    const appHome = getAppHomePaths().appHomePath;
    await createAppConfig(appHome, { clock: () => new Date('2026-08-04T00:00:00Z') });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: () => new Date('2026-08-04T00:00:00Z'),
    });
    return { appHome };
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
        autoMemory: [],
        skills: [],
        settings: ['model'],
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

  /** Poll until the flattened output contains a needle (async core-service
   *  transitions land frames after the settle window). */
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

  async function pressKey(
    stdin: FakeTtyStdin,
    stdout: FakeTtyStdout,
    ch: string,
  ): Promise<void> {
    const baseline = stdout.output;
    stdin.press(ch);
    await waitForOutputSettled(stdout, baseline);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function renderInteractive(element: React.ReactElement): Promise<{
    instance: ReturnType<typeof render>;
    stdout: FakeTtyStdout;
    stdin: FakeTtyStdin;
  }> {
    const stdout = new FakeTtyStdout();
    const stdin = new FakeTtyStdin();
    const instance = render(element, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      // Live frames driven by keypresses: force interactive mode or CI=true
      // flips the harness to non-interactive regardless of the fake TTY.
      interactive: true,
    });
    await instance.waitUntilRenderFlush();
    await waitForInputListener(stdin);
    return { instance, stdout, stdin };
  }

  function renderWorkbench(data: WorkbenchData) {
    resetWelcomeSessionForTests();
    return renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
    );
  }

  it('sidebar focus: [a] opens the install wizard and never drills Agents behind it', async () => {
    await overrideHomeToTemp();
    const { instance, stdout, stdin } = await renderWorkbench(dataFor(profileWith(true, 1)));

    try {
      await pressKey(stdin, stdout, 'a');
      expect(flatten(stripAnsi(stdout.output))).toContain('Skills › add local skill');

      // Close the wizard: the main grid must come back, not a resource drill
      // that fired underneath the overlay (the confirmed double-trigger).
      stdout.snapshot();
      await pressKey(stdin, stdout, '\x1b');
      const afterClose = flatten(stripAnsi(stdout.output));
      expect(afterClose).not.toContain('coding › Agents');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('main-pane focus: [a] drills into Agents without opening the wizard', async () => {
    await overrideHomeToTemp();
    const { instance, stdout, stdin } = await renderWorkbench(dataFor(profileWith(true, 1)));

    try {
      await pressKey(stdin, stdout, '\t');
      expect(flatten(stripAnsi(stdout.output))).toContain('Esc to return to categories');

      await pressKey(stdin, stdout, 'a');
      const output = flatten(stripAnsi(stdout.output));
      expect(output).toContain('coding › Agents');
      expect(output).not.toContain('Skills › add local skill');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('lifecycle prompt: typed q and ? enter the name field instead of quitting / opening help', async () => {
    await overrideHomeToTemp();
    const { instance, stdout, stdin } = await renderWorkbench(dataFor(profileWith(true)));
    let exited = false;
    void instance.waitUntilExit().then(() => {
      exited = true;
    });

    try {
      await pressKey(stdin, stdout, 'c'); // copy prompt: "Copy to: █"
      expect(flatten(stripAnsi(stdout.output))).toContain('Copy to:');

      await pressKey(stdin, stdout, 'q');
      await pressKey(stdin, stdout, '?');

      expect(exited).toBe(false);
      const output = flatten(stripAnsi(stdout.output));
      expect(output).toContain('q?█');
      expect(output).not.toContain('Keyboard Shortcuts');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('remove panel: [u] runs the no-backup removal instead of drilling User Memory', async () => {
    const { appHome } = await setupRealProfile();
    const { instance, stdout, stdin } = await renderWorkbench(dataFor(profileWith(true)));

    try {
      await pressKey(stdin, stdout, 'x');
      expect(flatten(stripAnsi(stdout.output))).toContain('Remove Profile "coding"?');

      await pressKey(stdin, stdout, 'u');
      const output = await waitForOutput(stdout, 'removed', 5000);
      expect(output).toContain('"coding" removed');
      expect(output).not.toContain('coding › User Memory');
      // The no-backup removal actually ran: the profile root left the profiles
      // directory (moved to the Recovery Bin, not deleted).
      expect(fs.existsSync(join(appHome, 'profiles', 'coding'))).toBe(false);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('launch directory screen: typed letters (incl. q) go into the path input', async () => {
    await setupRealProfile();
    const { instance, stdout, stdin } = await renderWorkbench(dataFor(profileWith(true)));
    let exited = false;
    void instance.waitUntilExit().then(() => {
      exited = true;
    });

    try {
      await pressKey(stdin, stdout, 'L');
      await waitForOutput(stdout, 'Type a path:', 5000);

      await pressKey(stdin, stdout, 'q');

      expect(exited).toBe(false);
      expect(flatten(stripAnsi(stdout.output))).toContain('q█');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('launch bar (non-text phase): [?] still opens help and [q] still quits', async () => {
    await setupRealProfile();
    const { instance, stdout, stdin } = await renderWorkbench(dataFor(profileWith(true)));
    let exited = false;
    void instance.waitUntilExit().then(() => {
      exited = true;
    });

    try {
      await pressKey(stdin, stdout, 'l');
      await waitForOutput(stdout, 'Enter to launch', 5000);

      // The footer under the bar advertises ? and q — both stay live here.
      await pressKey(stdin, stdout, '?');
      expect(flatten(stripAnsi(stdout.output))).toContain('Keyboard Shortcuts');
      await pressKey(stdin, stdout, '\x1b'); // close the help sheet

      await pressKey(stdin, stdout, 'q');
      const deadline = Date.now() + 3000;
      while (!exited && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(exited).toBe(true);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('a newer flash message is not cleared by the previous flash timer', async () => {
    await setupRealProfile();
    // No CLAUDE.md in the loaded data: [e] flashes the missing-memory message.
    const { instance, stdout, stdin } = await renderWorkbench(dataFor(profileWith(false)));

    try {
      await pressKey(stdin, stdout, 'e');
      await waitForOutput(stdout, 'CLAUDE.md) is missing');

      // 1.5s later a second, different flash replaces the first. The first
      // flash's 2.5s timer must not clear the newer message early: a clear
      // writes a new frame, so output growth inside the second flash's own
      // 2.5s window is the leak signature.
      await sleep(1500);
      await pressKey(stdin, stdout, 'D');
      await pressKey(stdin, stdout, 'x');
      await pressKey(stdin, stdout, '\r');
      await waitForOutput(stdout, 'Description updated', 5000);

      const lengthAfterSecondFlash = stdout.output.length;
      await sleep(1500);
      expect(stdout.output.length).toBe(lengthAfterSecondFlash);

      // Past the second flash's own deadline the message does clear: a frame
      // lands and the frames written since the flash no longer show it.
      await sleep(1800);
      expect(stdout.output.length).toBeGreaterThan(lengthAfterSecondFlash);
      const framesSinceFlash = flatten(stripAnsi(stdout.output.slice(lengthAfterSecondFlash)));
      expect(framesSinceFlash).not.toContain('Description updated');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  }, 20000);
});
