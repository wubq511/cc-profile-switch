import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingsView } from '../src/tui/workbench/resources/settings-view';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { makeProfile, stripAnsi } from './render-helpers';

// Settings / Launch Config drill view (issue #101 L1): the tree and card grid
// drill into a key-level list with view + edit, backed by the core services
// settings-resource.ts and launch-config-resource.ts.

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

async function waitForOutputContaining(stdout: FakeTtyStdout, text: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stripAnsi(stdout.output).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for output containing: ${text}`);
}

describe('SettingsView (issue #101)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(settingsJson: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-settings-view-'));
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
    await fs.writeJson(join(profilesPath, 'coding', 'claude-home', 'settings.json'), settingsJson, { spaces: 2 });
    return appHome;
  }

  function settingsPath(appHome: string): string {
    return join(getAppHomePaths(appHome).profilesPath, 'coding', 'claude-home', 'settings.json');
  }

  function profileConfigPath(appHome: string): string {
    return join(getAppHomePaths(appHome).profilesPath, 'coding', 'profile.json');
  }

  async function renderView(
    appHome: string,
    category: 'settings' | 'launchConfig',
    onBack?: () => void,
  ): Promise<{ instance: ReturnType<typeof render>; stdout: FakeTtyStdout; stdin: FakeTtyStdin }> {
    const stdout = new FakeTtyStdout();
    const stdin = new FakeTtyStdin();
    const profile = makeProfile({
      name: 'coding',
      description: '',
      isDefault: false,
      resourceCounts: { userMemory: 1, autoMemory: 0, skills: 0, agents: 0, mcp: 0, settings: 1, launchConfig: 1, plugins: 0 },
    });
    const instance = render(
      React.createElement(SettingsView, {
        profile,
        appHomePath: appHome,
        category,
        width: 80,
        height: 24,
        onBack: onBack ?? (() => {}),
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
    return { instance, stdout, stdin };
  }

  const FIXTURE_SETTINGS = {
    model: 'sonnet',
    autoMemoryDirectory: '/managed/dir',
    env: {
      ANTHROPIC_API_KEY: 'sk-live-secret',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    },
  };

  it('lists settings keys with secrets redacted and managed keys marked', async () => {
    const appHome = await makeAppHome(FIXTURE_SETTINGS);
    const { instance, stdout } = await renderView(appHome, 'settings');
    await waitForOutputContaining(stdout, 'env.ANTHROPIC_API_KEY');

    const output = stripAnsi(stdout.output);
    expect(output).toContain('model');
    expect(output).toContain('<redacted>');
    expect(output).not.toContain('sk-live-secret');
    expect(output).toContain('(managed)');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('edits an editable key through the text prompt', async () => {
    const appHome = await makeAppHome(FIXTURE_SETTINGS);
    const { instance, stdout, stdin } = await renderView(appHome, 'settings');
    await waitForOutputContaining(stdout, 'env.ANTHROPIC_API_KEY');

    // Sorted keys: autoMemoryDirectory, env.ANTHROPIC_API_KEY,
    // env.CLAUDE_CODE_ATTRIBUTION_HEADER, model — ↓×3 lands on model.
    for (const ch of ['\x1b[B', '\x1b[B', '\x1b[B', 'e']) {
      stdin.press(ch);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    // Wait for the edit prompt itself before typing into it.
    await waitForOutputContaining(stdout, 'new value for');
    for (const ch of 'opus') {
      stdin.press(ch);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stdin.press('\r');
    // Wait for the save status — the write is async.
    await waitForOutputContaining(stdout, 'saved model');

    const saved = await fs.readJson(settingsPath(appHome));
    expect(saved.model).toBe('opus');
    // Untouched keys survive the atomic rewrite.
    expect(saved.env.ANTHROPIC_API_KEY).toBe('sk-live-secret');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('refuses to edit a ccps-managed key', async () => {
    const appHome = await makeAppHome(FIXTURE_SETTINGS);
    const { instance, stdout, stdin } = await renderView(appHome, 'settings');
    await waitForOutputContaining(stdout, 'autoMemoryDirectory');

    // Cursor starts on the first sorted key: autoMemoryDirectory (managed).
    stdin.press('e');
    await waitForOutputContaining(stdout, 'read-only');

    const saved = await fs.readJson(settingsPath(appHome));
    expect(saved.autoMemoryDirectory).toBe('/managed/dir');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('removes a key to the Recovery Bin after confirmation', async () => {
    const appHome = await makeAppHome(FIXTURE_SETTINGS);
    const { instance, stdout, stdin } = await renderView(appHome, 'settings');
    await waitForOutputContaining(stdout, 'env.ANTHROPIC_API_KEY');

    for (const ch of ['\x1b[B', '\x1b[B', '\x1b[B']) {
      stdin.press(ch);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    stdin.press('x');
    await waitForOutputContaining(stdout, 'Recovery Bin');
    stdin.press('y');
    await waitForOutputContaining(stdout, 'removed model');

    const saved = await fs.readJson(settingsPath(appHome));
    expect('model' in saved).toBe(false);
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('Esc invokes onBack', async () => {
    const appHome = await makeAppHome(FIXTURE_SETTINGS);
    let backed = false;
    const { instance, stdout, stdin } = await renderView(appHome, 'settings', () => {
      backed = true;
    });
    await waitForOutputContaining(stdout, 'model');
    stdin.press('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(backed).toBe(true);
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('toggles a plain launch-config boolean directly', async () => {
    const appHome = await makeAppHome(FIXTURE_SETTINGS);
    const { instance, stdout, stdin } = await renderView(appHome, 'launchConfig');
    // Sorted: claudeArgs, disableAutoMemory, mcpMode, pluginDirs, skipPermissions.
    await waitForOutputContaining(stdout, 'disableAutoMemory');
    stdin.press('\x1b[B');
    await new Promise((resolve) => setTimeout(resolve, 60));
    stdin.press('\r');
    await waitForOutputContaining(stdout, 'saved disableAutoMemory');

    const saved = await fs.readJson(profileConfigPath(appHome));
    expect(saved.launch.disableAutoMemory).toBe(true);
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('gates sensitive launch fields behind a consequence confirm', async () => {
    const appHome = await makeAppHome(FIXTURE_SETTINGS);
    const { instance, stdout, stdin } = await renderView(appHome, 'launchConfig');
    await waitForOutputContaining(stdout, 'skipPermissions');

    // New profiles default skipPermissions to true; the toggle flips it off.
    for (const ch of ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B']) {
      stdin.press(ch);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    stdin.press('\r');
    await waitForOutputContaining(stdout, 'permission');

    // Not yet applied — the confirm gate is still open.
    let saved = await fs.readJson(profileConfigPath(appHome));
    expect(saved.launch.skipPermissions).toBe(true);

    stdin.press('y');
    await waitForOutputContaining(stdout, 'saved skipPermissions');
    saved = await fs.readJson(profileConfigPath(appHome));
    expect(saved.launch.skipPermissions).toBe(false);
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('edits mcpMode through the text prompt and rejects invalid values', async () => {
    const appHome = await makeAppHome(FIXTURE_SETTINGS);
    const { instance, stdout, stdin } = await renderView(appHome, 'launchConfig');
    await waitForOutputContaining(stdout, 'mcpMode');

    for (const ch of ['\x1b[B', '\x1b[B']) {
      stdin.press(ch);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    // Invalid value first: the schema rejects it and the file stays unchanged.
    stdin.press('e');
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const ch of 'bogus') {
      stdin.press(ch);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stdin.press('\r');
    await waitForOutputContaining(stdout, 'invalid value');
    let saved = await fs.readJson(profileConfigPath(appHome));
    expect(saved.launch.mcpMode).not.toBe('bogus');

    // Valid enum value persists.
    stdin.press('e');
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const ch of 'strict') {
      stdin.press(ch);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stdin.press('\r');
    await waitForOutputContaining(stdout, 'saved mcpMode');
    saved = await fs.readJson(profileConfigPath(appHome));
    expect(saved.launch.mcpMode).toBe('strict');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
