import { Readable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import {
  createAppConfig,
  loadAppConfigSync,
  saveWorkbenchLanguageSync,
} from '../src/core/app-config';
import { resolveLocale } from '../src/tui/workbench/i18n/index';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import { FakeTtyStdout, makeProfile, stripAnsi } from './render-helpers';

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
    // Keypress flows need live frames; force interactive mode because CI
    // runners export CI=true, which would otherwise defer renders to unmount.
    interactive: true,
  });
  await instance.waitUntilRenderFlush();
  await waitForInputListener(stdin);
  return { instance, stdout, stdin };
}

const sampleData: WorkbenchData = {
  profiles: [makeProfile({ name: 'coding' })],
  defaultProfile: 'coding',
};

// Locale resolution chain (spec §14.10): explicit `workbench.language` in
// config.json → system locale; the in-Workbench switch re-renders immediately
// and writes back.
describe('workbench language config chain (issue #54, spec §14.10)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-wb-locale-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome);
    return appHome;
  }

  it('config.json language=zh resolves to Chinese at startup', async () => {
    const appHome = await makeAppHome();
    saveWorkbenchLanguageSync(appHome, 'zh');

    const config = loadAppConfigSync(appHome);
    expect(config.workbench.language).toBe('zh');
    expect(resolveLocale(config.workbench.language)).toBe('zh');
  });

  it('write-back is atomic and preserves every other config field', async () => {
    const appHome = await makeAppHome();
    const before = loadAppConfigSync(appHome);

    saveWorkbenchLanguageSync(appHome, 'en');

    const after = loadAppConfigSync(appHome);
    expect(after.workbench.language).toBe('en');
    expect(after.workbench.skillsDiscoveryExperimental).toBe(
      before.workbench.skillsDiscoveryExperimental,
    );
    expect(after.recovery).toEqual(before.recovery);
    expect(after.lastUsedProfile).toBe(before.lastUsedProfile);
    expect(after.createdAt).toBe(before.createdAt);
    const files = await fs.readdir(appHome);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('missing language field falls back to the system locale', async () => {
    const appHome = await makeAppHome();
    const config = loadAppConfigSync(appHome);

    expect(config.workbench.language).toBeUndefined();
    const resolved = resolveLocale(config.workbench.language);
    expect(resolved === 'zh' || resolved === 'en').toBe(true);
  });
});

describe('in-Workbench language switch (issue #54, spec §14.10)', () => {
  it('[l] in the help sheet toggles zh↔en with immediate re-render and a change callback', async () => {
    resetWelcomeSessionForTests();
    const onLocaleChange = vi.fn();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        searchContent: async () => [],
        onLocaleChange,
      }),
    );

    // The help sheet documents the switch.
    let baseline = stdout.output;
    stdin.press('?');
    await waitForOutputSettled(stdout, baseline);
    let frame = stripAnsi(stdout.output);
    expect(frame).toContain('Keyboard Shortcuts');
    expect(frame).toContain('Switch language');

    // [l] → zh: the sheet itself re-renders in Chinese immediately.
    baseline = stdout.output;
    stdin.press('l');
    await waitForOutputSettled(stdout, baseline);
    expect(onLocaleChange).toHaveBeenCalledWith('zh');
    frame = stripAnsi(stdout.output);
    expect(frame).toContain('键盘快捷键');
    expect(frame).toContain('切换语言');

    // [l] → en again.
    baseline = stdout.output;
    stdin.press('l');
    await waitForOutputSettled(stdout, baseline);
    expect(onLocaleChange).toHaveBeenCalledWith('en');
    expect(stripAnsi(stdout.output)).toContain('Keyboard Shortcuts');

    // Esc still closes the sheet after the toggles. stdout accumulates every
    // frame ever written, so assert only on the frames after the Esc press.
    const historyLength = stdout.output.length;
    baseline = stdout.output;
    stdin.press('\x1b');
    await waitForOutputSettled(stdout, baseline);
    expect(stripAnsi(stdout.output.slice(historyLength))).not.toContain('Keyboard Shortcuts');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
