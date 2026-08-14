import { Readable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import type { WorkbenchProfile, WorkbenchData } from '../src/tui/workbench/profile-data';
import {
  FakeTtyStdout,
  flatten,
  makeProfile,
  noPluginsReader,
  stripAnsi,
} from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

/**
 * Compact-width category grid (issue #98, V1/V2): at 80 columns the card
 * title row must keep the full category name (the card's primary label) with
 * the focus `▸` intact, while descriptor rows (drill/diff hints) drop first.
 * At ≥100 columns the descriptors render as before.
 */

class MinTtyStdout extends FakeTtyStdout {
  public columns = 80;
  public rows = 24;
}

class WideTtyStdout extends FakeTtyStdout {
  public columns = 140;
  public rows = 40;
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

/** Point HOME at a fresh temp dir so interactive renders stay off the real home. */
async function overrideHomeToTemp(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ccps-grid-compact-'));
  tempRoots.push(root);
  const home = join(root, 'home');
  await fs.ensureDir(home);
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
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

async function waitForOutput(
  stdout: FakeTtyStdout,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = flatten(stripAnsi(stdout.output));
    if (current.includes(needle)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return flatten(stripAnsi(stdout.output));
}

const dataFor = (profile: WorkbenchProfile): WorkbenchData => ({
  profiles: [profile],
  defaultProfile: 'coding',
});

async function renderApp(tty: typeof FakeTtyStdout) {
  resetWelcomeSessionForTests();
  const stdout = new tty();
  const stdin = new FakeTtyStdin();
  const instance = render(
    React.createElement(WorkbenchApp, {
      data: dataFor(makeProfile()),
      initialLocale: 'en',
      skipWelcome: true,
      mcpProbe: async () => [],
      pluginInventoryReader: noPluginsReader,
    } as React.ComponentProps<typeof WorkbenchApp>),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    },
  );
  await instance.waitUntilRenderFlush();
  await waitForInputListener(stdin);
  return { instance, stdout, stdin };
}

describe('Workbench category grid at compact width (issue #98 V1/V2)', () => {
  it('keeps every category name intact at 80x24 and drops descriptor rows first', async () => {
    await overrideHomeToTemp();
    const { instance, stdout } = await renderApp(MinTtyStdout);

    try {
      const output = await waitForOutput(stdout, 'coding');
      for (const name of [
        'User Memory',
        'Auto Memory',
        'Skills',
        'Agents',
        'MCP',
        'Settings',
        'Launch Config',
      ]) {
        expect(output).toContain(name);
      }
      // Descriptor rows dropped before the name is touched.
      expect(output).not.toContain('d diff vs another');
      expect(output).not.toContain('[enter] bulk ops');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('keeps the focus ▸ on the title row at 80x24', async () => {
    await overrideHomeToTemp();
    const { instance, stdout, stdin } = await renderApp(MinTtyStdout);

    try {
      await waitForOutput(stdout, 'coding');
      stdin.press('\t');
      const output = await waitForOutput(stdout, '▸ User Memory');
      expect(output).toContain('▸ User Memory');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('still renders bordered cards with descriptor rows at 140x40', async () => {
    await overrideHomeToTemp();
    const { instance, stdout } = await renderApp(WideTtyStdout);

    try {
      const output = await waitForOutput(stdout, 'd diff vs another');
      expect(output).toContain('[enter] bulk ops');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });
});
