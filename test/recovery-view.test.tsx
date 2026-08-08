import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { RecoveryView } from '../src/tui/workbench/resources/recovery-view';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { createFileTreeItem, listRecoveryBinItems } from '../src/core/recovery-bin';
import { backupProfile } from '../src/core/profile';
import { flatten, stripAnsi } from './render-helpers';

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

function dummyStdin(): Readable {
  return new Readable({ read() {} });
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

/** Poll until the flattened output contains `needle`; returns the flattened output. */
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

describe('RecoveryView render (issue #94)', () => {
  const tempRoots: string[] = [];
  const clock = () => new Date('2026-08-02T00:00:00Z');

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-recovery-view-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock,
    });
    return appHome;
  }

  async function renderView(
    appHome: string,
    /** Poll until the async reload settles on this substring. */
    until?: string,
  ): Promise<string> {
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(RecoveryView, {
        appHomePath: appHome,
        profileNames: ['coding'],
        width: 80,
        height: 24,
        onBack: () => {},
        headless: true,
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: dummyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    // The list/backup load is async, so a fixed sleep races a slow platform
    // (Windows CI). Poll for the expected content instead; the assertion below
    // remains the source of truth.
    if (until) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !stripAnsi(stdout.output).includes(until)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await instance.waitUntilRenderFlush();
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await instance.waitUntilRenderFlush();
    }
    instance.unmount();
    await instance.waitUntilExit();
    return stripAnsi(stdout.output);
  }

  it('renders Bin items and Backups as distinct sections with sizes and totals (S115)', async () => {
    const appHome = await makeAppHome();
    const { profilesPath } = getAppHomePaths(appHome);
    const claudeMd = join(profilesPath, 'coding', 'claude-home', 'CLAUDE.md');
    await fs.ensureDir(join(profilesPath, 'coding', 'claude-home'));
    await fs.writeFile(claudeMd, '# Coding profile', 'utf8');

    await createFileTreeItem({
      appHomePath: appHome,
      origin: 'remove',
      kind: 'user-memory',
      profile: 'coding',
      coordinates: { targetRelativePath: 'claude-home/CLAUDE.md' },
      sourcePath: claudeMd,
      clock,
    });
    await backupProfile({ appHomePath: appHome, name: 'coding', clock });

    const output = await renderView(appHome, 'Recovery Items (temporary)');

    // Distinct section headers carry the durable/temporary boundary.
    expect(output).toContain('Recovery Items (temporary)');
    expect(output).toContain('Profile Backups (durable)');
    // Bin row: identity, origin Profile, per-item expiry, size.
    expect(output).toContain('CLAUDE.md · user memory · from coding · expires 2026-09-01 ·');
    // Backup row: the durable marker, its id, and a size.
    expect(output).toContain('◆ coding-20260802-000000 · backup ·');
    // Per-section totals render.
    expect(output).toContain('total');
  }, 20000);

  it('renders the empty state when the Bin and Backups are both empty', async () => {
    const appHome = await makeAppHome();
    const output = await renderView(appHome, 'The Recovery Bin is empty.');
    expect(output).toContain('The Recovery Bin is empty.');
    expect(output).toContain('No backups yet.');
  }, 20000);

  it('shows the header, subtitle, and action hint', async () => {
    const appHome = await makeAppHome();
    const output = await renderView(appHome, 'Recovery Bin');
    expect(output).toContain('Recovery Bin');
    expect(output).toMatch(/temp items auto-expire/);
    expect(output).toContain('[Enter] restore');
    expect(output).toContain('[x] delete');
    expect(output).toContain('[E] empty bin');
    expect(output).toContain('[esc] back');
  }, 20000);

  it('refuses a colliding restore via the numbered panel and never overwrites (issue #94, §9.3)', async () => {
    const appHome = await makeAppHome();
    const { profilesPath } = getAppHomePaths(appHome);
    const claudeMd = join(profilesPath, 'coding', 'claude-home', 'CLAUDE.md');
    await fs.ensureDir(join(profilesPath, 'coding', 'claude-home'));
    await fs.writeFile(claudeMd, '# Coding profile', 'utf8');

    // Bin the CLAUDE.md but KEEP the original in place → restore collides.
    const item = await createFileTreeItem({
      appHomePath: appHome,
      origin: 'remove',
      kind: 'user-memory',
      profile: 'coding',
      coordinates: { targetRelativePath: 'claude-home/CLAUDE.md' },
      sourcePath: claudeMd,
      clock,
    });

    const stdout = new FakeTtyStdout();
    const stdin = new FakeTtyStdin();
    const instance = render(
      React.createElement(RecoveryView, {
        appHomePath: appHome,
        profileNames: ['coding'],
        width: 80,
        height: 24,
        onBack: () => {},
        headless: false,
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
    await waitForInputListener(stdin);

    // Enter on the focused Bin item → collision dialog (refuse-by-default).
    await waitForOutput(stdout, 'CLAUDE.md');
    stdin.press('\r');
    await waitForOutput(stdout, 'Restore blocked');

    // The numbered-explanation panel is visible — no silent overwrite.
    const panel = flatten(stripAnsi(stdout.output));
    expect(panel).toMatch(/Restore blocked|恢复被阻止/);
    expect(panel).toMatch(/1\. /);
    expect(panel).toMatch(/2\. /);
    expect(panel).toMatch(/3\. /);

    // Refuse: nothing is written and the item is NOT consumed.
    stdin.press('\x1b');
    await waitForOutput(stdout, 'Recovery Bin');
    expect(await fs.readFile(claudeMd, 'utf8')).toBe('# Coding profile');
    expect(await listRecoveryBinItems(appHome)).toHaveLength(1);
    expect(await fs.pathExists(item.itemDirPath)).toBe(true);

    instance.unmount();
    await instance.waitUntilExit();
  }, 20000);
});
