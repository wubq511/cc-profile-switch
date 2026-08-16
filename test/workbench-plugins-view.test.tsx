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

// Workbench Plugins category + read-only drill view (issue #101 L4, §7.6).
// Plugins used to render as a separate bottom strip (issue #96); they are now
// a regular grid category whose drill view carries the full inventory. The
// §7.6 boundary is unchanged: names + enable state only, every mutation goes
// through `claude plugin`.

// ---------------------------------------------------------------- harness

// Wide terminal: the delegation guidance is a long single line, and the
// behavior assertions need it rendered contiguously (it wraps mid-phrase in
// the ~50-char main-pane column of an 80-wide terminal).
class FlowTtyStdout extends FakeTtyStdout {
  public columns = 100;
  public rows = 30;
}

// Minimum supported Workbench size; the overflow-budget test runs here.
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
        // MCP probe so the assertions see a quiet pane.
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

  async press(ch: string): Promise<void> {
    if (!this.stdout || !this.stdin) throw new Error('Harness not rendered');
    const baseline = this.stdout.output;
    this.stdin.press(ch);
    await waitForOutputSettled(this.stdout, baseline);
  }

  /** Tab → focus the category grid, ↑ wraps to the last card (Plugins),
   *  Enter drills into the read-only inventory view. */
  async drillIntoPlugins(): Promise<void> {
    await this.press('\t');
    await this.press('\x1b[A');
    await this.press('\r');
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
  const root = await mkdtemp(join(tmpdir(), 'ccps-plugins-view-'));
  tempRoots.push(root);
  const home = join(root, 'home');
  await fs.ensureDir(home);
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

const reader = (inventory: PluginInventory) => async () => inventory;

describe('Workbench Plugins category + drill view (issue #101, §7.6)', () => {
  it('renders plugins as a grid category and keeps names inside the drill view', async () => {
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

    // The grid shows the category card only — no names leak onto the main pane.
    const grid = await h.waitFor('Plugins');
    expect(grid).not.toContain('probe-plugin@probe-marketplace');

    await h.drillIntoPlugins();
    const output = await h.waitFor('probe-plugin@probe-marketplace');
    // Names and enable state are visible in the drill view.
    expect(output).toContain('probe-plugin@probe-marketplace — enabled');
    expect(output).toContain('off@m — disabled');
    // Delegation guidance declares where changes happen.
    expect(output).toContain('change them through `claude plugin`');

    await h.unmount();
  }, 20000);

  it('Esc returns from the drill view to the category grid', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({
        status: 'ok',
        plugins: [{ id: 'probe-plugin@m', enabled: true }],
      }),
    });

    await h.drillIntoPlugins();
    await h.waitFor('probe-plugin@m');
    await h.press('\x1b');
    // The grid is back: the hint line for the focused grid reappears while the
    // drill view's rows are gone from the newest frames.
    const output = await h.waitFor('Plugins');
    expect(output).toContain('Skills');
    await h.unmount();
  }, 20000);

  it('shows an empty state when nothing is installed, keeping the guidance', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({ status: 'ok', plugins: [] }),
    });

    await h.drillIntoPlugins();
    const output = await h.waitFor('no plugins installed');
    expect(output).toContain('no plugins installed');
    expect(output).toContain('change them through `claude plugin`');

    await h.unmount();
  }, 20000);

  it('degrades to an unavailable state when the delegated read reports failure', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    await h.renderApp(dataFor(makeProfile()), {
      // The reader contract is a PluginInventory result — `readPluginInventory`
      // is the single fail-closed boundary and never throws, so an injected
      // reader signals failure by returning 'unavailable'.
      pluginInventoryReader: async () => ({ status: 'unavailable' }),
    });

    await h.drillIntoPlugins();
    const output = await h.waitFor('plugin inventory unavailable');
    expect(output).toContain('plugin inventory unavailable');
    expect(output).toContain('change them through `claude plugin`');

    await h.unmount();
  }, 20000);

  it('offers no mutation affordances — management text names claude plugin only', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({
        status: 'ok',
        plugins: [{ id: 'probe-plugin@probe-marketplace', enabled: true }],
      }),
    });

    await h.drillIntoPlugins();
    await h.waitFor('probe-plugin@probe-marketplace');
    const output = h.text();
    // The view is pure status: no install/remove verbs, no plugin-mutation key.
    expect(output).not.toContain('uninstall');
    expect(output).not.toContain('[p]');
    // The only claude-plugin mention is the delegation guidance.
    expect(output).toContain('change them through `claude plugin`');

    await h.unmount();
  }, 20000);

  it('collapses overflow into a +N line within an 80x24 pane budget', async () => {
    await overrideHomeToTemp();
    const h = new Harness(MinTtyStdout);
    const plugins = Array.from({ length: 30 }, (_, i) => ({
      id: `plugin-${i}@marketplace`,
      enabled: i % 2 === 0,
    }));
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({ status: 'ok', plugins }),
    });

    await h.drillIntoPlugins();
    const output = await h.waitFor('plugin-0@marketplace');
    // The overflow line reports the capped rows rather than dropping silently.
    expect(output).toMatch(/\+\d+ more/);
    // Rows beyond the window are not rendered (the view stays in budget).
    expect(output).not.toContain('plugin-29@marketplace');
    // The delegation line renders inside the 80x24 pane; assert the unwrapped
    // prefix — at this width the full phrase wraps mid-text.
    expect(output).toContain('Claude-managed — change them through');

    await h.unmount();
  }, 20000);

  it('shows the full inventory on a tall pane instead of capping at an arbitrary count', async () => {
    await overrideHomeToTemp();
    const h = new Harness(); // 100×30 FlowTtyStdout
    const plugins = Array.from({ length: 10 }, (_, i) => ({
      id: `plugin-${i}@marketplace`,
      enabled: i % 2 === 0,
    }));
    await h.renderApp(dataFor(makeProfile()), {
      pluginInventoryReader: reader({ status: 'ok', plugins }),
    });

    await h.drillIntoPlugins();
    const output = await h.waitFor('plugin-9@marketplace');
    expect(output).toContain('plugin-0@marketplace');
    expect(output).toContain('plugin-9@marketplace');
    expect(output).not.toMatch(/\+\d+ more/);
    expect(output).toContain('Claude-managed — change them through `claude plugin`');

    await h.unmount();
  }, 20000);

  it('re-probes a profile whose read failed instead of pinning unavailable for the session', async () => {
    await overrideHomeToTemp();
    const h = new Harness();
    // First probe of 'coding' fails; every later probe succeeds. The reader
    // call count is the direct evidence that the failed state is retried
    // rather than pinned.
    let codingReads = 0;
    const flakyReader = async (
      _appHomePath: string,
      profileName: string,
    ): Promise<PluginInventory> => {
      if (profileName === 'coding') {
        codingReads += 1;
        if (codingReads === 1) return { status: 'unavailable' };
      }
      return { status: 'ok', plugins: [{ id: 'probe-plugin@m', enabled: true }] };
    };
    await h.renderApp(
      { profiles: [makeProfile(), makeProfile({ name: 'second' })], defaultProfile: 'coding' },
      { pluginInventoryReader: flakyReader },
    );

    // Initial probe of the selected profile fails closed: the drill view shows
    // the unavailable state.
    await h.drillIntoPlugins();
    await h.waitFor('plugin inventory unavailable');
    expect(codingReads).toBe(1);
    // Back out: Esc leaves the drill view (grid focus), Esc returns to the tree.
    await h.press('\x1b');
    await h.press('\x1b');

    // Switch to the second profile in the tree — its read succeeds, and the
    // drilled view shows the inventory.
    await h.press('\x1b[B');
    await h.drillIntoPlugins();
    await h.waitFor('probe-plugin@m — enabled');

    // Switch back to coding: the transient failure was not cached, so the
    // re-visit re-probes instead of pinning 'unavailable'.
    await h.press('\x1b');
    await h.press('\x1b');
    await h.press('\x1b[A');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && codingReads < 2) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(codingReads).toBe(2);
    await h.drillIntoPlugins();
    await h.waitFor('probe-plugin@m — enabled');

    await h.unmount();
  }, 30000);
});
