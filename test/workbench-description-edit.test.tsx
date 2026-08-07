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
import { getProfileTemplatePaths } from '../src/core/profile-template';
import type { WorkbenchProfile, WorkbenchData } from '../src/tui/workbench/profile-data';
import { flatten, makeProfile, stripAnsi } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

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

describe('Profile description inline edit (S5)', () => {
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

  /** Point HOME at a fresh temp dir (see workbench-top-level-edit.test.tsx):
   *  interactive renders must stay off the real home, and Windows resolves the
   *  user home from USERPROFILE, not HOME. */
  async function overrideHomeToTemp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-desc-edit-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    await fs.ensureDir(home);
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return home;
  }

  /** Temp home with a real coding profile on disk; the Workbench's refresh
   *  after save reads this app home, so the card must reflect it. */
  async function setupRealProfile(): Promise<{ appHome: string; profileConfigPath: string }> {
    await overrideHomeToTemp();
    const appHome = getAppHomePaths().appHomePath;
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    return { appHome, profileConfigPath: getProfileTemplatePaths(appHome, 'coding').profileConfigPath };
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

  /** Poll until the flattened output contains a needle (async save + refresh
   *  land a frame or two after the keypress). Returns the final output. */
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
      // Force interactive mode — CI=true would otherwise defer frames to
      // unmount regardless of the fake TTY (see workbench-top-level-edit).
      interactive: true,
    });
    await instance.waitUntilRenderFlush();
    await waitForInputListener(stdin);
    return { instance, stdout, stdin };
  }

  /** Type text one keypress at a time, letting the event loop drain between
   *  pushes: rapid back-to-back pushes coalesce into one multi-char data
   *  event, which the app's single-char input filter (deliberately) ignores. */
  async function typeText(stdin: FakeTtyStdin, text: string, delayMs = 25): Promise<void> {
    for (const ch of text) {
      stdin.press(ch);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  it('advertises [D] Edit description on the profile hints', async () => {
    await overrideHomeToTemp();
    resetWelcomeSessionForTests();

    const { instance, stdout } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile()),
        initialLocale: 'en',
        skipWelcome: true,
      }),
    );

    expect(flatten(stripAnsi(stdout.output))).toContain('[D]Edit description');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('D opens the inline edit prefilled with the current description; Esc cancels without writing', async () => {
    const { profileConfigPath } = await setupRealProfile();
    const before = await fs.readFile(profileConfigPath, 'utf8');
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile({ description: 'Daily coding profile' })),
        initialLocale: 'en',
        skipWelcome: true,
      }),
    );

    stdin.press('D');
    const draftOutput = await waitForOutput(stdout, 'Daily coding profile█');
    expect(draftOutput).toContain('Daily coding profile█');

    const baseline = stdout.snapshot();
    stdin.press('\u001b'); // Esc
    await waitForOutputSettled(stdout, baseline);
    const output = flatten(stripAnsi(stdout.output));
    // Cancelled: the card shows the description again, the draft row is gone.
    expect(output).toContain('Daily coding profile');
    expect(output).not.toContain('█');
    // The manifest on disk is untouched.
    expect(await fs.readFile(profileConfigPath, 'utf8')).toBe(before);

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('typing a description and pressing Enter saves it and reflects it on the card', async () => {
    const { profileConfigPath } = await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile({ description: '' })),
        initialLocale: 'en',
        skipWelcome: true,
      }),
    );

    stdin.press('D');
    await waitForOutput(stdout, '█');

    // Lifecycle letters typed into the draft must not fire sidebar actions:
    // 'n' (create) and 'x' (remove) become draft text here. If capture leaked,
    // the draft row would never render 'nx'.
    await typeText(stdin, 'nx');
    const draftOutput = await waitForOutput(stdout, 'nx█');
    expect(draftOutput).toContain('nx█');

    await typeText(stdin, ' focus work');
    stdin.press('\r');

    const flashOutput = await waitForOutput(stdout, 'Description updated');
    expect(flashOutput).toContain('Description updated');

    // Persisted to profile.json (leading space trimmed) and reflected on the
    // card after the refresh reloads the real app home.
    await expect(fs.readJson(profileConfigPath)).resolves.toMatchObject({
      name: 'coding',
      description: 'nx focus work',
    });
    const output = await waitForOutput(stdout, 'nx focus work');
    expect(output).toContain('nx focus work');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('erasing the draft and pressing Enter clears the saved description', async () => {
    const { profileConfigPath } = await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile({ description: 'ab' })),
        initialLocale: 'en',
        skipWelcome: true,
      }),
    );

    stdin.press('D');
    await waitForOutput(stdout, 'ab█');
    await typeText(stdin, '\u007f\u007f'); // Backspace ×2 empties the prefilled draft
    stdin.press('\r');

    const output = await waitForOutput(stdout, 'Description updated');
    expect(output).toContain('Description updated');
    await expect(fs.readJson(profileConfigPath)).resolves.toMatchObject({
      name: 'coding',
      description: '',
    });

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('zh renders the edit affordance and the saved flash', async () => {
    const { profileConfigPath } = await setupRealProfile();
    resetWelcomeSessionForTests();

    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataFor(makeProfile({ description: '' })),
        initialLocale: 'zh',
        skipWelcome: true,
      }),
    );

    expect(flatten(stripAnsi(stdout.output))).toContain('[D]编辑描述');

    stdin.press('D');
    await waitForOutput(stdout, '█');
    await typeText(stdin, 'abc');
    stdin.press('\r');

    const output = await waitForOutput(stdout, '描述已更新');
    expect(output).toContain('描述已更新');
    await expect(fs.readJson(profileConfigPath)).resolves.toMatchObject({ description: 'abc' });

    instance.unmount();
    await instance.waitUntilExit();
  });
});
