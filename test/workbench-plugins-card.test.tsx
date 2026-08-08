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
import type { PluginInventory } from '../src/core/plugins';
import { FakeTtyStdout, flatten, makeProfile, stripAnsi } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------- harness

// Wide terminal: the delegation guidance is a long single line, and the
// behavior assertions need it rendered contiguously (it wraps mid-phrase in
// the ~50-char main-pane column of an 80-wide terminal).
class FlowTtyStdout extends FakeTtyStdout {
  public columns = 100;
  public rows = 30;
}

// Minimum supported Workbench size; the 80x24 layout test runs here.
class MinTtyStdout extends FakeTtyStdout {
  public columns = 80;
  public rows = 24;
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

async function waitForInputListener(stdin: FakeTtyStdin, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stdin.listenerCount('readable') === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (stdin.listenerCount('readable') === 0) {
    throw new Error('Ink never attached a stdin readable listener');
  }
}

/** Poll until the flattened output contains `needle`. */
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

class Harness {
  public instance: ReturnType<typeof render> | null = null;
  public stdout: FakeTtyStdout | null = null;
  public stdin: FakeTtyStdin | null = null;

  constructor(private readonly tty: typeof FakeTtyStdout = FlowTtyStdout) {}

  async renderApp(
    data: WorkbenchData,
    extraProps: Partial<React.ComponentProps<typeof WorkbenchApp>> = {},
  ): Promise<void> {
    resetWelcomeSessionForTests();
    const stdout = new this.tty();
    const stdin = new FakeTtyStdin();
    const instance = render(
      React.createElement(WorkbenchApp, {
        data,
        initialLocale: 'en',
        skipWelcome: true,
        // Hermetic: the default readers probe the real app home; inject no-op
        // MCP probe so the card assertions see a quiet pane.
        mcpProbe: async () => [],
        ...extraProps,
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
    this.instance = instance;
    this.stdout = stdout;
    this.stdin = stdin;
  }

  async waitFor(needle: string, timeoutMs = 5000): Promise<string> {
    if (!this.stdout) throw new Error('Harness not rendered');
    return waitForOutput(this.stdout, needle, timeoutMs);
  }

  text(): string {
    if (!this.stdout) throw new Error('Harness not rendered');
    return flatten(stripAnsi(this.stdout.output));
  }

  async unmount(): Promise<void> {
    if (this.instance) {
      this.instance.unmount();
      await this.instance.waitUntilExit();
      this.instance = null;
    }
  }
}

// ---------------------------------------------------------------- fixtures

const dataFor = (profile: WorkbenchProfile): WorkbenchData => ({
  profiles: [profile],
  defaultProfile: 'coding',
});

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

/** Point HOME at a fresh temp dir so interactive renders stay off the real
 *  home (same pattern as the other workbench view tests). */
async function overrideHomeToTemp(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ccps-plugins-card-'));
  tempRoots.push(root);
  const home = join(root, 'home');
  await fs.ensureDir(home);
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

const reader = (inventory: PluginInventory) => async () => inventory;

describe('Workbench read-only Plugins card (issue #96, §7.6)', () => {
  it('renders the inventory as names + status with the delegation guidance', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({
        status: 'ok',
        plugins: [
          { id: 'probe-plugin@probe-marketplace', enabled: true },
          { id: 'off@m', enabled: false },
        ],
      }),
    });

    const output = await h.waitFor('probe-plugin@probe-marketplace');
    // Names and enable state are visible.
    expect(output).toContain('probe-plugin@probe-marketplace — enabled');
    expect(output).toContain('off@m — disabled');
    // Delegation guidance declares where changes happen.
    expect(output).toContain('change them through `claude plugin`');

    await h.unmount();
  });

  it('shows an empty state when nothing is installed, keeping the guidance', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({ status: 'ok', plugins: [] }),
    });

    const output = await h.waitFor('no plugins installed');
    expect(output).toContain('no plugins installed');
    expect(output).toContain('change them through `claude plugin`');

    await h.unmount();
  });

  it('degrades to an unavailable state when the delegated read fails', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: async () => {
        throw new Error('claude plugin list failed');
      },
    });

    const output = await h.waitFor('plugin inventory unavailable');
    expect(output).toContain('plugin inventory unavailable');
    expect(output).toContain('change them through `claude plugin`');

    await h.unmount();
  });

  it('offers no mutation affordances — management text names claude plugin only', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({
        status: 'ok',
        plugins: [{ id: 'probe-plugin@probe-marketplace', enabled: true }],
      }),
    });

    await h.waitFor('probe-plugin@probe-marketplace');
    const output = h.text();
    // The card is pure status: no install/remove verbs, no plugin-mutation key.
    expect(output).not.toContain('install');
    expect(output).not.toContain('uninstall');
    expect(output).not.toContain('[p]');
    // The only claude-plugin mention is the delegation guidance.
    expect(output).toContain('change them through `claude plugin`');

    await h.unmount();
  });

  it('caps the list at the pane budget at 80x24 and still shows the guidance', async () => {
    await overrideHomeToTemp();
    const h = new Harness(MinTtyStdout);
    const plugins = Array.from({ length: 8 }, (_, i) => ({
      id: `plugin-${i}@marketplace`,
      enabled: i % 2 === 0,
    }));
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({ status: 'ok', plugins }),
    });

    const output = await h.waitFor('plugin-0@marketplace');
    // The overflow line reports the capped rows rather than dropping silently.
    expect(output).toContain('+4 more');
    // Rows beyond the cap are not rendered (the card stays in budget).
    expect(output).not.toContain('plugin-7@marketplace');
    // The card's last line (delegation guidance) is visible inside the 80x24
    // pane; assert the unwrapped prefix — at this width the full phrase wraps
    // mid-text and the flattened output interleaves the sidebar.
    expect(output).toContain('Claude-managed — change them through');

    await h.unmount();
  });
});
