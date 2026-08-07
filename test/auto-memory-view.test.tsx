import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { AutoMemoryView } from '../src/tui/workbench/resources/auto-memory-view';
import { EditSessionManager } from '../src/core/edit-session';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { makeProfile, stripAnsi } from './render-helpers';

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

function dummyStdin(): Readable {
  return new Readable({ read() {} });
}

describe('AutoMemoryView render', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHomeWithEntries(entries: { name: string; content: string }[]): Promise<{
    appHome: string;
    profileName: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-automem-view-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    const { profilesPath } = getAppHomePaths(appHome);
    const autoDir = join(profilesPath, 'coding', 'claude-home', 'memory', 'auto');
    // The coding template seeds a MEMORY.md entrypoint; clear it so the test
    // controls exactly which entries exist.
    await fs.remove(autoDir);
    await fs.ensureDir(autoDir);
    for (const entry of entries) {
      await fs.writeFile(join(autoDir, entry.name), entry.content, 'utf8');
    }
    return { appHome, profileName: 'coding' };
  }

  async function renderView(
    appHome: string,
    profileName: string,
    profileNames: string[] = [profileName],
  ): Promise<string> {
    const stdout = new FakeTtyStdout();
    const manager = new EditSessionManager();
    const profile = makeProfile({
      name: profileName,
      description: '',
      isDefault: false,
      resourceCounts: { userMemory: 1, autoMemory: 0, skills: 0, agents: 0, mcp: 0, settings: 1, launchConfig: 1 },
    });
    const instance = render(
      React.createElement(AutoMemoryView, {
        profile,
        appHomePath: appHome,
        profileNames,
        width: 60,
        height: 24,
        editSessionManager: manager,
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
    // Let async list/preview effects resolve and re-render.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    return stripAnsi(stdout.output);
  }

  it('lists entries and renders the selected entry preview', async () => {
    const { appHome, profileName } = await makeAppHomeWithEntries([
      { name: 'topics.md', content: '# Refactoring notes\nKeep functions small.' },
    ]);
    const output = await renderView(appHome, profileName);
    expect(output).toContain('topics.md');
    expect(output).toContain('Refactoring notes');
  });

  it('renders multiple entry names in the list', async () => {
    const { appHome, profileName } = await makeAppHomeWithEntries([
      { name: 'topics.md', content: 'topics content' },
      { name: 'session.md', content: 'session content' },
    ]);
    const output = await renderView(appHome, profileName);
    expect(output).toContain('topics.md');
    expect(output).toContain('session.md');
  });

  it('renders the empty state when there are no entries', async () => {
    const { appHome, profileName } = await makeAppHomeWithEntries([]);
    const output = await renderView(appHome, profileName);
    expect(output).toContain('No Auto Memory entries yet');
  });

  it('surfaces the boundary note that Create and Diff are intentionally unavailable', async () => {
    const { appHome, profileName } = await makeAppHomeWithEntries([
      { name: 'topics.md', content: 'x' },
    ]);
    const output = await renderView(appHome, profileName);
    expect(output).toMatch(/Create is intentionally unavailable/);
    expect(output).toMatch(/Diff is intentionally unavailable/);
  });

  it('renders the action hint with edit/copy/remove/undo/search keys', async () => {
    const { appHome, profileName } = await makeAppHomeWithEntries([
      { name: 'topics.md', content: 'x' },
    ]);
    const output = await renderView(appHome, profileName);
    expect(output).toContain('[e]');
    expect(output).toContain('[c]');
    expect(output).toContain('[x]');
    expect(output).toContain('[u]');
    expect(output).toContain('[/]');
  });

  it('renders the localized title', async () => {
    const { appHome, profileName } = await makeAppHomeWithEntries([
      { name: 'topics.md', content: 'x' },
    ]);
    const output = await renderView(appHome, profileName);
    // Default locale resolves to system locale; the title string is one of the two locales.
    expect(output).toMatch(/Auto Memory|自动记忆/);
  });
});
