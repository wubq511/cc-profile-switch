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
import { loadWorkbenchData } from '../src/tui/workbench/profile-data';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import { flatten, noPluginsReader } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

/**
 * Issue #110 (spec §7, Testing Decisions "入口级补充"): a broken resource in
 * one Profile must not block a healthy Profile in the real Workbench. Real
 * core data loads from a synthetic app home (CLAUDE.md replaced by a
 * directory → EISDIR), driven through the actual Ink render: the healthy
 * profile stays listed/selectable with working actions, the broken category
 * shows the explicit error with a fix direction, and a repair + refresh
 * clears the error without a restart.
 */

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');

class FakeTtyStdout extends Writable {
  public readonly isTTY = true;
  public columns = 120;
  public rows = 40;
  private readonly chunks: Buffer[] = [];

  public override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  public get output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  public snapshot(): string {
    const out = this.output;
    this.chunks.length = 0;
    return out;
  }
}

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

describe('Workbench error isolation (issue #110)', () => {
  const tempRoots: string[] = [];
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    previousHome = undefined;
    previousUserProfile = undefined;
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    vi.clearAllMocks();
  });

  async function makeAppHome(): Promise<string> {
    // Point HOME at a fresh temp dir first: createProfileFromTemplate reads
    // the real user home for claudeMdExcludes, and the Workbench reads the
    // app home from HOME/USERPROFILE too (win32 uses USERPROFILE).
    const root = await mkdtemp(join(tmpdir(), 'ccps-isolation-ui-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    await fs.ensureDir(home);
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const appHome = join(home, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    for (const name of ['healthy', 'broken']) {
      await createProfileFromTemplate({
        appHomePath: appHome,
        name,
        template: 'coding',
        clock: FIXED_CLOCK,
      });
    }
    return appHome;
  }

  function claudeHomeOf(appHome: string, name: string): string {
    return join(getAppHomePaths(appHome).profilesPath, name, 'claude-home');
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForOutput(
    stdout: FakeTtyStdout,
    needle: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (flatten(stdout.output).includes(needle)) return;
      await sleep(20);
    }
    throw new Error(`output never contained ${JSON.stringify(needle)}`);
  }

  async function renderWorkbench(data: WorkbenchData): Promise<{
    instance: ReturnType<typeof render>;
    stdout: FakeTtyStdout;
    stdin: FakeTtyStdin;
  }> {
    resetWelcomeSessionForTests();
    const stdout = new FakeTtyStdout();
    const stdin = new FakeTtyStdin();
    const instance = render(
      React.createElement(WorkbenchApp, {
        data,
        initialLocale: 'en',
        skipWelcome: true,
        mcpProbe: async () => [],
        pluginInventoryReader: noPluginsReader,
        searchContent: async () => [],
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      },
    );
    await instance.waitUntilRenderFlush();
    return { instance, stdout, stdin };
  }

  it('healthy profile stays selectable with its resources while the broken profile shows the read error', async () => {
    const appHome = await makeAppHome();
    // broken: CLAUDE.md is a directory → EISDIR on read.
    const brokenClaudeMd = join(claudeHomeOf(appHome, 'broken'), 'CLAUDE.md');
    await fs.remove(brokenClaudeMd);
    await fs.ensureDir(brokenClaudeMd);

    const data = await loadWorkbenchData(appHome);
    const broken = data.profiles.find((p) => p.name === 'broken');
    const healthy = data.profiles.find((p) => p.name === 'healthy');
    if (!broken || !healthy) throw new Error('both profiles must load');
    expect(broken.resourceStates?.userMemory.status).toBe('unreadable');
    expect(healthy.resourceStates?.userMemory.status).toBe('ok');

    const { instance, stdout, stdin } = await renderWorkbench(data);
    try {
      // Profiles are sorted (broken first); the broken one is selected.
      await waitForOutput(stdout, 'broken');
      const home = flatten(stdout.output);
      expect(home).toContain('healthy');

      // The broken profile's User Memory card carries the explicit error.
      stdout.snapshot();
      stdin.press('u');
      await waitForOutput(stdout, 'Resource cannot be read (EISDIR)');
      // The error pane (header + fix direction) is the live surface; the
      // hint-line footer carries the standard list hint for the recreated
      // action, so assert on the error block itself.
      const brokenView = flatten(stdout.snapshot());
      expect(brokenView).toContain('Fix the path');
      expect(brokenView).toContain('Resource cannot be read (EISDIR)');

      // Back out (Esc), select the healthy profile (↓), and check its User
      // Memory opens normally — the broken profile did not block it.
      stdout.snapshot();
      stdin.press('\x1b');
      await waitForOutput(stdout, 'Auto Memory');
      stdout.snapshot();
      stdin.press('\x1b[B');
      await waitForOutput(stdout, 'Focused software development profile');
      stdout.snapshot();
      stdin.press('u');
      await waitForOutput(stdout, 'CLAUDE.md');
      const healthyView = flatten(stdout.snapshot());
      // The healthy profile's memory is readable and previewable.
      expect(healthyView).not.toContain('Resource cannot be read');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('repairing the resource on disk and refreshing clears the error without a restart', async () => {
    const appHome = await makeAppHome();
    const brokenClaudeMd = join(claudeHomeOf(appHome, 'broken'), 'CLAUDE.md');
    await fs.remove(brokenClaudeMd);
    await fs.ensureDir(brokenClaudeMd);

    const brokenData = await loadWorkbenchData(appHome);
    const brokenBefore = brokenData.profiles.find((p) => p.name === 'broken');
    if (!brokenBefore) throw new Error('broken profile must load');
    expect(brokenBefore.resourceStates?.userMemory.status).toBe('unreadable');

    const { instance, stdout, stdin } = await renderWorkbench(brokenData);
    try {
      // The broken profile is selected (sorted first); drill into its User Memory.
      stdout.snapshot();
      stdin.press('u');
      await waitForOutput(stdout, 'Resource cannot be read (EISDIR)');

      // User repairs the file on disk.
      await fs.remove(brokenClaudeMd);
      await fs.writeFile(brokenClaudeMd, '# repaired', 'utf8');

      // Esc out of the resource view, then re-enter: the re-entry refresh
      // reloads the real core data, and the newest frame shows the repaired
      // memory — no restart. Ink's trailing render throttle can deliver a
      // stale frame after the repaired one on slow runners, so wait until the
      // LAST written frame is the repaired list (error-free), like the
      // locale test's waitForSlice ordering check.
      stdout.snapshot();
      stdin.press('\x1b');
      await sleep(300);
      stdout.snapshot();
      stdin.press('u');
      const from = stdout.output.length;
      const deadline = Date.now() + 8000;
      let ok = false;
      for (;;) {
        const flat = flatten(stdout.output.slice(from));
        const lastRepaired = flat.lastIndexOf('1 lines');
        const lastError = flat.lastIndexOf('Resource cannot be read');
        if (lastRepaired >= 0 && lastRepaired > lastError) {
          ok = true;
          break;
        }
        if (Date.now() > deadline) break;
        await sleep(50);
      }
      expect(ok).toBe(true);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });
});