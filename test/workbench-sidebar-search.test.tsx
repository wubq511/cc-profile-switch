import { Readable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import { FakeTtyStdout, flatten, makeProfile, noPluginsReader, stripAnsi } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

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

async function typeText(stdin: FakeTtyStdin, stdout: FakeTtyStdout, text: string): Promise<void> {
  for (const ch of text) {
    const baseline = stdout.output;
    stdin.press(ch);
    await waitForOutputSettled(stdout, baseline);
  }
}

const sampleData: WorkbenchData = {
  profiles: [
    makeProfile({ name: 'coding' }),
    makeProfile({ name: 'study', description: 'Research notes', isDefault: false }),
  ],
  defaultProfile: 'coding',
};

// Ink's useInput broadcasts every keypress to ALL active handlers with no
// propagation stop. While the sidebar search box owns focus, the app-level
// letter/action keys must stay suppressed (issue #83/#84).
describe('sidebar search input suppression (issue #83/#84, spec §4.2)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('typing q/e/u/a into the focused search feeds the query, never app-level actions', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        // Keep tests hermetic: no content search against the real app home.
        searchContent: async () => [],
        // …and no plugin-inventory spawn on mount (issue #96): the assertion
        // below pins that `spawn` is never called by search input.
        pluginInventoryReader: noPluginsReader,
      }),
    );
    let exited = false;
    void instance.waitUntilExit().then(() => {
      exited = true;
    });

    const slashBaseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, slashBaseline);
    expect(stripAnsi(stdout.output)).toContain('/█');

    await typeText(stdin, stdout, 'queua');

    const frame = stripAnsi(stdout.output);
    // The query box received every character…
    expect(frame).toContain('/queua');
    // …while `q` never quit the Workbench (#83)…
    expect(exited).toBe(false);
    // …`e` never opened an editor (#84)…
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    // …and `u`/`a` never drilled into a resource category (the resource-list
    // hint line only renders in a drilled view).
    expect(flatten(stdout.output)).not.toContain('[d] diff');

    // Esc clears the box per §4.2; top-level keys work again afterwards.
    const escBaseline = stdout.output;
    stdin.press('\x1b');
    await waitForOutputSettled(stdout, escBaseline);
    expect(stripAnsi(stdout.output)).toContain('Type to search…');

    stdin.press('q');
    const deadline = Date.now() + 3000;
    while (!exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(exited).toBe(true);
    await instance.waitUntilExit();
  });

  it('? typed into the focused search feeds the query instead of opening the help sheet', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        searchContent: async () => [],
        pluginInventoryReader: noPluginsReader,
      }),
    );

    const slashBaseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, slashBaseline);
    await typeText(stdin, stdout, '?');

    const frame = stripAnsi(stdout.output);
    expect(frame).toContain('/?');
    expect(frame).not.toContain('Keyboard Shortcuts');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
