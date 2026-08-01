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
import { loadWorkbenchData, type WorkbenchData } from '../src/tui/workbench/profile-data';

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

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function flatten(text: string): string {
  return stripAnsi(text)
    .replace(/[│╭╰╮╯─┌┐└┘┃┏┓┗┛]/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/[ ]+/g, ' ')
    .trim();
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

/** Poll until the flattened output contains a needle (async diff landing). */
async function waitForOutput(stdout: FakeTtyStdout, needle: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = flatten(stripAnsi(stdout.output));
    if (current.includes(needle)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return flatten(stripAnsi(stdout.output));
}

/** Wait until a re-render after the baseline (settling each keypress). */
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
  });
  await instance.waitUntilRenderFlush();
  await waitForInputListener(stdin);
  return { instance, stdout, stdin };
}

describe('grid-level cross-Profile diff entry (issue #71, spec §12)', () => {
  const tempRoots: string[] = [];
  let previousHome: string | undefined;

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    previousHome = undefined;
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    vi.clearAllMocks();
  });

  /** Point HOME at a fresh temp dir (interactive renders stay off the real home). */
  async function overrideHomeToTemp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-diff-wb-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    await fs.ensureDir(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
    return home;
  }

  async function setupProfiles(): Promise<{ appHome: string; data: WorkbenchData }> {
    await overrideHomeToTemp();
    const appHome = getAppHomePaths().appHomePath;
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    for (const name of ['coding', 'study', 'work']) {
      await createProfileFromTemplate({
        appHomePath: appHome,
        name,
        template: 'coding',
        clock: () => new Date('2026-07-31T16:00:00Z'),
      });
    }
    // Distinct settings per Profile so the diff has rows; inject a real
    // credential shape so the redaction contract is proven through the surface.
    await fs.writeJson(join(appHome, 'profiles', 'coding', 'claude-home', 'settings.json'), {
      model: 'sonnet',
      env: { ANTHROPIC_API_KEY: `sk-ant-api03-${'A'.repeat(36)}` },
      permissions: { allow: 'Bash(npm run *)' },
    });
    await fs.writeJson(join(appHome, 'profiles', 'study', 'claude-home', 'settings.json'), {
      model: 'opus',
      env: { ANTHROPIC_API_KEY: `sk-ant-api03-${'B'.repeat(36)}` },
      permissions: { allow: 'Bash(npm run *)' },
    });
    await fs.writeJson(join(appHome, 'profiles', 'work', 'claude-home', 'settings.json'), {
      model: 'opus',
      env: { ANTHROPIC_API_KEY: `sk-ant-api03-${'C'.repeat(36)}` },
      permissions: { deny: 'Bash(rm -rf *)' },
    });
    const data = await loadWorkbenchData(appHome);
    return { appHome, data };
  }

  it('`d` on a focused Settings card opens the pairwise settings diff', async () => {
    const { data } = await setupProfiles();
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
    );

    // Tab focuses the category grid, then move to Settings (card #6: userMemory,
    // autoMemory, skills, agents, mcp, settings, launchConfig) and press `d`.
    // Each press settles before the next so the async focus state lands.
    let baseline = stdout.output;
    stdin.press('\t');
    await waitForOutputSettled(stdout, baseline);
    for (let i = 0; i < 5; i++) {
      baseline = stdout.output;
      stdin.press('\x1b[B');
      await waitForOutputSettled(stdout, baseline);
    }
    baseline = stdout.output;
    stdin.press('d');

    const output = await waitForOutput(stdout, 'value differs');
    // The diff header shows the pairwise comparison.
    expect(output).toContain('coding → study');
    // Settings redaction contract: key names + verdicts, values never rendered.
    expect(output).toContain('model');
    expect(output).toContain('env.ANTHROPIC_API_KEY');
    // AC#3 through the surface: the injected credential shape never appears.
    expect(output).not.toContain('sk-ant-api03');
    expect(output).not.toContain('sonnet');
    expect(output).not.toContain('opus');

    instance.unmount();
    await instance.waitUntilExit();
  });

  it('↑/↓ switch the counterpart in place (no N-way matrix)', async () => {
    const { data } = await setupProfiles();
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
    );

    let baseline = stdout.output;
    stdin.press('\t');
    await waitForOutputSettled(stdout, baseline);
    for (let i = 0; i < 5; i++) {
      baseline = stdout.output;
      stdin.press('\x1b[B');
      await waitForOutputSettled(stdout, baseline);
    }
    baseline = stdout.output;
    stdin.press('d');
    await waitForOutput(stdout, 'coding → study');

    // ↓ switches the counterpart from study to work (in place, no new surface).
    baseline = stdout.output;
    stdin.press('\x1b[B');
    const switched = await waitForOutput(stdout, 'permissions.deny');
    expect(switched).toContain('coding → work');
    // The work-only row landed; the counterpart row set changed in place.
    expect(switched).toContain('permissions.deny');

    // Esc returns to the category grid (idle), not to a resource list.
    baseline = stdout.output;
    stdin.press('\x1b');
    await waitForOutputSettled(stdout, baseline);
    const back = flatten(stripAnsi(stdout.output));
    expect(back).toContain('diff vs another Profile');

    instance.unmount();
    await instance.waitUntilExit();
  });
});
