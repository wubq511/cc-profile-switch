import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import { flatten, makeProfile, noPluginsReader } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

/** Regression: the Workbench entry enables focus-event reporting
 *  (\x1b[?1004h, workbench/index.mts). Terminals answer with a focus-in
 *  report (\x1b[I) right after mount, and Ink forwards it as input — the
 *  once-per-session welcome card must not treat that as "any key" and
 *  self-dismiss before the user has seen it. */

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

describe('Welcome card vs terminal focus reports', () => {
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
  async function overrideHomeToTemp(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-welcome-focus-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    await fs.ensureDir(home);
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  }

  const data: WorkbenchData = { profiles: [makeProfile()], defaultProfile: 'coding' };

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForInputListener(stdin: FakeTtyStdin, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && stdin.listenerCount('readable') === 0) {
      await sleep(10);
    }
    if (stdin.listenerCount('readable') === 0) {
      throw new Error('Ink never attached a stdin readable listener');
    }
  }

  /** Poll until the flattened output contains the needle. */
  async function waitForOutput(stdout: FakeTtyStdout, needle: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (flatten(stdout.output).includes(needle)) return;
      await sleep(20);
    }
    throw new Error(`output never contained ${JSON.stringify(needle)}`);
  }

  async function renderWelcome(): Promise<{
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
        welcomeBannerEnabled: true,
        mcpProbe: async () => [],
        pluginInventoryReader: noPluginsReader,
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        // Force interactive mode or CI=true flips the harness to
        // non-interactive regardless of the fake TTY.
        interactive: true,
      },
    );
    await instance.waitUntilRenderFlush();
    await waitForInputListener(stdin);
    return { instance, stdout, stdin };
  }

  it('focus-in/out reports do not dismiss the welcome card; a real key does', async () => {
    await overrideHomeToTemp();
    const { instance, stdout, stdin } = await renderWelcome();

    try {
      await waitForOutput(stdout, 'Welcome to Profile Workbench');

      // Terminal answers the focus-reporting probe: focus-in, then focus-out.
      // Neither is a keypress; the card must stay. The accumulated-output
      // buffer always contains the title from earlier frames, so assert on
      // freshly written output only: a wrongful dismissal would render the
      // main UI (profile description) into the post-snapshot frames.
      stdout.snapshot();
      stdin.press('\x1b[I');
      await sleep(150);
      expect(flatten(stdout.output)).not.toContain('Daily coding profile');

      stdout.snapshot();
      stdin.press('\x1b[O');
      await sleep(150);
      expect(flatten(stdout.output)).not.toContain('Daily coding profile');

      // A real key (down arrow) dismisses the card and shows the main UI.
      stdout.snapshot();
      stdin.press('\x1b[B');
      await waitForOutput(stdout, 'Daily coding profile');
      expect(flatten(stdout.output)).not.toContain('Welcome to Profile Workbench');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });
});
