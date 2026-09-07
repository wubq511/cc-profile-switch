import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import type { SearchResult } from '../src/core/resource/types';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { flatten, makeProfile, stripAnsi } from './render-helpers';

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

  /** Return and clear the accumulated writes so a later frame can be asserted alone. */
  public snapshot(): string {
    const out = this.output;
    this.chunks.length = 0;
    return out;
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

const sampleData: WorkbenchData = {
  profiles: [
    makeProfile({
      name: 'coding',
      resourceDetails: {
        userMemory: { kind: 'user-memory', name: 'CLAUDE.md', relativePath: 'claude-home/CLAUDE.md', exists: true, lineCount: 12, excerpt: '' },
        agents: [
          { kind: 'agents', name: 'deep-reviewer', relativePath: 'claude-home/agents/deep-reviewer.md', exists: true, frontmatter: null, frontmatterParseError: null, bodyExcerpt: '' },
        ],
        skills: ['pdf-tools'],
        autoMemory: [],
        settings: ['model'],
        plugins: [],
      },
    }),
    makeProfile({
      name: 'study',
      description: 'Research notes',
      isDefault: false,
      resourceCounts: { userMemory: 1, autoMemory: 0, skills: 0, agents: 0, mcp: 0, settings: 0, launchConfig: 1, plugins: 0 },
    }),
  ],
  defaultProfile: 'coding',
  customTemplates: [],
};

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

/** Poll for text the debounced content search adds after typing settles. */
async function waitForOutputContaining(stdout: FakeTtyStdout, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stripAnsi(stdout.output).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    // These tests assert on live frames driven by keypresses, so Ink must
    // stream frames instead of deferring to unmount. Force interactive mode:
    // Ink's auto-detection reads `is-in-ci`, and CI runners export CI=true,
    // which would otherwise flip this harness to non-interactive regardless
    // of the fake TTY.
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

describe('sidebar card-tree search (issue #83, spec §4.2)', () => {
  it('typing in the sidebar search filters the tree and auto-expands matched item paths', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        // Keep tests hermetic: no content search against the real app home.
        searchContent: async () => [],
      }),
    );

    const baseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, baseline);
    await typeText(stdin, stdout, 'deep-re');
    // Discard intermediate frames (earlier prefixes legitimately show the
    // other Profile); the final keystroke's frame carries the filtered tree.
    stdout.snapshot();
    await typeText(stdin, stdout, 'v');

    const output = flatten(stdout.output);
    // The matched agent item row is auto-expanded beneath its Profile…
    expect(output).toContain('deep-reviewer');
    // …while the non-matching Profile is filtered out of the sidebar tree.
    expect(output).not.toContain('study');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('↑ past the top of the list focuses the search box', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        // Keep tests hermetic: no content search against the real app home.
        searchContent: async () => [],
      }),
    );

    const baseline = stdout.output;
    stdin.press('\x1b[A');
    await waitForOutputSettled(stdout, baseline);
    expect(stripAnsi(stdout.output)).toContain('/█');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('Enter on a tree category row drills into the resource list', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        // Keep tests hermetic: no content search against the real app home.
        searchContent: async () => [],
      }),
    );

    // Expand the Profile card, move to the first category row, drill in.
    let baseline = stdout.output;
    stdin.press('\x1b[C');
    await waitForOutputSettled(stdout, baseline);
    baseline = stdout.output;
    stdin.press('\x1b[B');
    await waitForOutputSettled(stdout, baseline);
    baseline = stdout.output;
    stdin.press('\r');
    await waitForOutputSettled(stdout, baseline);

    // The resource list hint line only appears in the drilled resource view.
    expect(flatten(stdout.output)).toContain('[d] diff');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('two-level expansion (issue #101): → on a category reveals items, ← ladders back', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        // Keep tests hermetic: no content search against the real app home.
        searchContent: async () => [],
      }),
    );

    const press = async (ch: string): Promise<void> => {
      const baseline = stdout.output;
      stdin.press(ch);
      await waitForOutputSettled(stdout, baseline);
    };

    // Newest full-screen payload only — accumulated frames would keep showing
    // the item row after it collapsed (same trick as lastFrameLines in the
    // layout tests, including the win32 clearTerminal boundary — ink #969).
    const lastFrame = (): string => {
      // eslint-disable-next-line no-control-regex
      const segments = stdout.output.split(/(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G|\x1b\[2J\x1b\[0f|\x1b\[2J\x1b\[3J\x1b\[H/);
      return flatten(segments[segments.length - 1] ?? '');
    };

    // Expanding the Profile lists category rows only — no item names leak.
    await press('\x1b[C');
    expect(lastFrame()).toContain('Agents');
    expect(lastFrame()).not.toContain('deep-reviewer');

    // ↓ onto the Agents category (userMemory, autoMemory, skills, agents),
    // then → expands it: the item row appears.
    await press('\x1b[B');
    await press('\x1b[B');
    await press('\x1b[B');
    await press('\x1b[B');
    await press('\x1b[C');
    expect(lastFrame()).toContain('deep-reviewer');

    // ← on the expanded category collapses it again…
    await press('\x1b[D');
    expect(lastFrame()).not.toContain('deep-reviewer');
    expect(lastFrame()).toContain('Agents (1)');
    // …← ladders back to the Profile row, and a third ← collapses the profile
    // itself, proving the cursor landed on it. (Assert the tree-row form with
    // the count: the main-pane card grid always prints a bare `Agents 1`.)
    await press('\x1b[D');
    await press('\x1b[D');
    expect(lastFrame()).not.toContain('Agents (1)');
    expect(lastFrame()).toContain('coding');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('Enter on the Settings tree row drills into the key-level settings view (issue #101 L1)', async () => {
    resetWelcomeSessionForTests();
    // The settings view reads from the app home on disk — point HOME at a
    // fixture so the drill lands on a controlled settings.json.
    const root = await mkdtemp(join(tmpdir(), 'ccps-settings-drill-'));
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    const { profilesPath } = getAppHomePaths(appHome);
    await fs.writeJson(
      join(profilesPath, 'coding', 'claude-home', 'settings.json'),
      { model: 'opus-custom' },
      { spaces: 2 },
    );
    const originalHome = process.env.HOME;
    // Windows resolves the user home from USERPROFILE, not HOME
    // (src/platform/path.ts) — set both or the drill reads the real home.
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    try {
      const { instance, stdout, stdin } = await renderInteractive(
        React.createElement(WorkbenchApp, {
          data: sampleData,
          initialLocale: 'en',
          skipWelcome: true,
          searchContent: async () => [],
        }),
      );

      const press = async (ch: string): Promise<void> => {
        const baseline = stdout.output;
        stdin.press(ch);
        await waitForOutputSettled(stdout, baseline);
      };

      // Expand the profile, then ↓ past the six category rows above Settings.
      await press('\x1b[C');
      for (let i = 0; i < 6; i++) await press('\x1b[B');
      await press('\r');

      // The drilled view lists the on-disk settings keys with their values.
      await waitForOutputContaining(stdout, 'opus-custom');
      expect(flatten(stdout.output)).toContain('model');
      instance.unmount();
      await instance.waitUntilExit();
    } finally {
      process.env.HOME = originalHome;
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  it('cross-profile content hits surface as auto-expanded rows from the injected search service', async () => {
    resetWelcomeSessionForTests();
    const hit: SearchResult = {
      profileName: 'study',
      category: 'user-memory',
      itemName: 'CLAUDE.md',
      relativePath: 'CLAUDE.md',
      // Short enough to survive the narrow sidebar's truncate-wrapped hit row.
      matchLine: 'runbook note',
      lineNumber: 4,
    };
    const searchContent = async (): Promise<SearchResult[]> => [hit];
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        searchContent,
      }),
    );

    const baseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, baseline);
    await typeText(stdin, stdout, 'zz');
    // Discard intermediate frames; the debounced hit lands after the last key.
    stdout.snapshot();
    await typeText(stdin, stdout, 'z');
    await waitForOutputContaining(stdout, 'runbook note');

    const output = flatten(stdout.output);
    expect(output).toContain('runbook note');
    expect(output).toContain('study');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
