// Workbench profile export/import flows (issue #95, scenarios S98–S101).
//
// Drives the full WorkbenchApp through the Ink headless seam: export from a
// Profile card produces a bundle via the core service; import walks the
// keyboard-complete flow (prompt → preview → confirm → land on the imported
// Profile), including collision import-as-new-name, abort, and MCP
// re-registration through an injected CaptureProcess. The bundle's secret
// stripping is already covered by test/profile-export.test.ts at the core
// seam; this file asserts the Workbench wires the same service end-to-end.

import { Readable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { exportProfile } from '../src/core/profile-export';
import { getClaudeJsonPath } from '../src/core/mcp-servers';
import { loadWorkbenchData } from '../src/tui/workbench/profile-data';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import type { CaptureProcess } from '../src/platform/process';
import { FakeTtyStdout, flatten, stripAnsi } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------- harness

class FlowTtyStdout extends FakeTtyStdout {
  public columns = 120;
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

  async renderApp(
    data: WorkbenchData,
    extraProps: Partial<React.ComponentProps<typeof WorkbenchApp>> = {},
  ): Promise<void> {
    resetWelcomeSessionForTests();
    const stdout = new FlowTtyStdout();
    const stdin = new FakeTtyStdin();
    const instance = render(
      React.createElement(WorkbenchApp, {
        data,
        initialLocale: 'en',
        skipWelcome: true,
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

  async typeText(text: string): Promise<void> {
    for (const ch of text) {
      await this.press(ch);
    }
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

const FIXED_CLOCK = () => new Date('2026-08-02T00:00:00Z');

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

/** Point HOME at a fresh temp dir and return the temp root. */
async function overrideHomeToTemp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ccps-io-'));
  tempRoots.push(root);
  const home = join(root, 'home');
  await fs.ensureDir(home);
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return root;
}

/** Temp app home with a real 'coding' Profile on disk. */
async function makeAppHome(profileNames: string[]): Promise<string> {
  await overrideHomeToTemp();
  const appHome = getAppHomePaths().appHomePath;
  await createAppConfig(appHome, { clock: FIXED_CLOCK });
  for (const name of profileNames) {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: FIXED_CLOCK,
    });
  }
  return appHome;
}

/** Export 'coding' from an app home into `<root>/out/coding.bundle.tar.gz`. */
async function makeBundle(srcAppHome: string): Promise<string> {
  const outDir = join(dirname(srcAppHome), 'out');
  await fs.ensureDir(outDir);
  const bundlePath = join(outDir, 'coding.bundle.tar.gz');
  const result = await exportProfile({
    appHomePath: srcAppHome,
    name: 'coding',
    outputPath: bundlePath,
    clock: FIXED_CLOCK,
  });
  expect(await fs.pathExists(result.bundlePath)).toBe(true);
  return bundlePath;
}

/** Add a native MCP server to a Profile's `.claude.json`. */
async function writeMcpServer(
  appHome: string,
  profileName: string,
  serverName: string,
): Promise<void> {
  const { profilesPath } = getAppHomePaths(appHome);
  const profileRoot = join(profilesPath, profileName);
  const filePath = getClaudeJsonPath(profileRoot);
  const existing = (await fs.pathExists(filePath)) ? await fs.readJson(filePath) : {};
  const mcpServers = existing.mcpServers ?? {};
  mcpServers[serverName] = { type: 'stdio', command: '/usr/bin/example', args: ['--serve'] };
  await fs.writeJson(filePath, { ...existing, mcpServers }, { spaces: 2 });
}

// --- mock `claude mcp add` delegation -------------------------------------------
// Mirrors Claude Code's filesystem effect: `mcp add --scope user` writes the
// entry to $CLAUDE_CONFIG_DIR/.claude.json (the imported profile's claude-home).

type RecordedCall = { args: string[]; claudeConfigDir: string };

function mockClaudeAdd(): { capture: CaptureProcess; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const capture: CaptureProcess = async (_command, args, options) => {
    const claudeConfigDir = options.env?.CLAUDE_CONFIG_DIR as string;
    calls.push({ args, claudeConfigDir });
    if (args[0] === 'mcp' && args[1] === 'add') {
      const name = parseAddName(args);
      if (name) applyMcpAdd(claudeConfigDir, args);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }
    return { exitCode: 1, stdout: '', stderr: 'no mock match', timedOut: false };
  };
  return { capture, calls };
}

function parseAddName(args: string[]): string | undefined {
  let i = 2;
  while (i < args.length) {
    const a = args[i];
    if (a === '--scope' || a === '--transport') {
      i += 2;
      continue;
    }
    if (a === '-e' || a === '--env') {
      i += 2;
      continue;
    }
    return a;
  }
  return undefined;
}

function applyMcpAdd(claudeConfigDir: string, args: string[]): void {
  let i = 2;
  let transport: 'stdio' | 'sse' | 'http' = 'stdio';
  const env: Record<string, string> = {};
  while (i < args.length) {
    const a = args[i];
    if (a === '--scope') {
      i += 2;
      continue;
    }
    if (a === '--transport') {
      transport = args[i + 1] as 'stdio' | 'sse' | 'http';
      i += 2;
      continue;
    }
    if (a === '-e' || a === '--env') {
      const pair = args[i + 1];
      const eq = pair.indexOf('=');
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 2;
      continue;
    }
    break;
  }
  const name = args[i];
  i += 1;
  const entry: Record<string, unknown> = {};
  if (transport !== 'stdio') entry.type = transport;
  if (transport === 'sse' || transport === 'http') {
    entry.url = args[i];
  } else {
    if (args[i] === '--') i += 1;
    entry.command = args[i];
    i += 1;
    if (i < args.length) entry.args = args.slice(i);
  }
  if (Object.keys(env).length > 0) entry.env = env;
  writeClaudeConfigMcpServer(claudeConfigDir, name, entry);
}

function writeClaudeConfigMcpServer(
  claudeConfigDir: string,
  name: string,
  entry: Record<string, unknown>,
): void {
  const file = join(claudeConfigDir, '.claude.json');
  let json: Record<string, unknown> = {};
  try {
    json = fs.readJsonSync(file);
  } catch {
    json = {};
  }
  const mcpServers = (json.mcpServers as Record<string, unknown> | undefined) ?? {};
  mcpServers[name] = entry;
  fs.outputJsonSync(file, { ...json, mcpServers }, { spaces: 2 });
}

// ---------------------------------------------------------------- tests

describe('Workbench profile export/import flows (issue #95)', () => {
  it('exports the selected profile to a bundle path (S98–S99)', async () => {
    const appHome = await makeAppHome(['coding']);
    const data = await loadWorkbenchData(appHome);
    const outDir = join(dirname(appHome), 'out');
    await fs.ensureDir(outDir);
    const bundlePath = join(outDir, 'coding.bundle.tar.gz');

    const h = new Harness();
    try {
      await h.renderApp(data, { mcpProbe: async () => [] });
      await h.press('E');
      await h.waitFor('Export to:');
      await h.typeText(bundlePath);
      await h.press('\r');
      await h.waitFor('Exported "coding"');
      expect(await fs.pathExists(bundlePath)).toBe(true);
    } finally {
      await h.unmount();
    }
  }, 20000);

  it('imports a bundle end-to-end and lands on the imported profile (S100–S101)', async () => {
    const srcAppHome = await makeAppHome(['coding']);
    const bundlePath = await makeBundle(srcAppHome);

    // Fresh, empty app home — the import recreates the Profile from the bundle.
    await overrideHomeToTemp();
    const appHome = getAppHomePaths().appHomePath;
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    const data = await loadWorkbenchData(appHome);
    expect(data.profiles).toHaveLength(0);

    const h = new Harness();
    try {
      await h.renderApp(data, { mcpProbe: async () => [] });
      await h.press('i');
      await h.waitFor('Bundle path:');
      await h.typeText(bundlePath);
      await h.press('\r');
      await h.waitFor('Import profile');
      expect(h.text()).toContain('Import as: coding');
      await h.press('y');
      await h.waitFor('Imported "coding"');

      const refreshed = await loadWorkbenchData(appHome);
      expect(refreshed.profiles.map((p) => p.name)).toEqual(['coding']);
    } finally {
      await h.unmount();
    }
  }, 20000);

  it('collision preview imports under a new name', async () => {
    const appHome = await makeAppHome(['coding']);
    const bundlePath = await makeBundle(appHome);
    const data = await loadWorkbenchData(appHome);

    const h = new Harness();
    try {
      await h.renderApp(data, { mcpProbe: async () => [] });
      await h.press('i');
      await h.waitFor('Bundle path:');
      await h.typeText(bundlePath);
      await h.press('\r');
      await h.waitFor('Import profile');
      expect(h.text()).toContain('already exists');
      await h.typeText('dev');
      await h.press('\r');
      await h.waitFor('Imported "dev"');

      const refreshed = await loadWorkbenchData(appHome);
      expect(refreshed.profiles.map((p) => p.name).sort()).toEqual(['coding', 'dev']);
    } finally {
      await h.unmount();
    }
  }, 20000);

  it('Esc on the preview aborts without creating a profile', async () => {
    const appHome = await makeAppHome(['coding']);
    const bundlePath = await makeBundle(appHome);
    const data = await loadWorkbenchData(appHome);

    const h = new Harness();
    try {
      await h.renderApp(data, { mcpProbe: async () => [] });
      await h.press('i');
      await h.waitFor('Bundle path:');
      await h.typeText(bundlePath);
      await h.press('\r');
      await h.waitFor('Import profile');
      await h.press('\x1b');

      const refreshed = await loadWorkbenchData(appHome);
      expect(refreshed.profiles.map((p) => p.name)).toEqual(['coding']);
    } finally {
      await h.unmount();
    }
  }, 20000);

  it('re-registers MCP servers through the injected CaptureProcess', async () => {
    const srcAppHome = await makeAppHome(['coding']);
    await writeMcpServer(srcAppHome, 'coding', 'github');
    const bundlePath = await makeBundle(srcAppHome);

    // Fresh, empty app home.
    await overrideHomeToTemp();
    const appHome = getAppHomePaths().appHomePath;
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    const data = await loadWorkbenchData(appHome);

    const { capture, calls } = mockClaudeAdd();
    const h = new Harness();
    try {
      await h.renderApp(data, { mcpProbe: async () => [], captureProcess: capture });
      await h.press('i');
      await h.waitFor('Bundle path:');
      await h.typeText(bundlePath);
      await h.press('\r');
      await h.waitFor('Import profile');
      expect(h.text()).toContain('MCP servers: github');
      await h.press('y');
      await h.waitFor('Imported "coding"');

      const addCalls = calls.filter((c) => c.args[0] === 'mcp' && c.args[1] === 'add');
      expect(addCalls.some((c) => c.args.includes('github'))).toBe(true);
      for (const call of addCalls) {
        expect(call.args).toContain('--scope');
        expect(call.args).toContain('user');
      }
      const { profilesPath } = getAppHomePaths(appHome);
      const claudeJson = await fs.readJson(
        getClaudeJsonPath(join(profilesPath, 'coding')),
      );
      expect(claudeJson.mcpServers?.github).toBeDefined();
    } finally {
      await h.unmount();
    }
  }, 20000);

  it('surfaces an import that fails auto-validate (S100 final step)', async () => {
    const srcAppHome = await makeAppHome(['coding']);
    // Remove the auto-memory MEMORY.md entrypoint: export still succeeds (the
    // bundle just lacks the file), but the imported profile fails validateProfile
    // with REQUIRED_FILE_MISSING — repair never recreates it. The TUI must report
    // the outcome instead of a clean success.
    const { profilesPath } = getAppHomePaths(srcAppHome);
    await fs.remove(
      join(profilesPath, 'coding', 'claude-home', 'memory', 'auto', 'MEMORY.md'),
    );
    const bundlePath = await makeBundle(srcAppHome);

    await overrideHomeToTemp();
    const appHome = getAppHomePaths().appHomePath;
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    const data = await loadWorkbenchData(appHome);

    const h = new Harness();
    try {
      await h.renderApp(data, { mcpProbe: async () => [] });
      await h.press('i');
      await h.waitFor('Bundle path:');
      await h.typeText(bundlePath);
      await h.press('\r');
      await h.waitFor('Import profile');
      await h.press('y');
      await h.waitFor('Imported "coding"');
      expect(h.text()).toContain('Validation: error');
    } finally {
      await h.unmount();
    }
  }, 20000);
});
