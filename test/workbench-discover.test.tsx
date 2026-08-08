import { Readable, Writable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import { DiscoverView } from '../src/tui/workbench/skills/discover';
import { SkillsDiscoverySession } from '../src/core/skills-discovery';
import {
  apiRepo,
  apiTree,
  makeHttp,
  rawSkill,
  repoSearchJson,
  skillshubSearch,
  shubItem,
  FakeResponse,
} from './fixtures/discovery-http';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';

// Discover surface (spec §7.4, issue #68).
//
// The three tiers render in the Workbench: curated backbone browse + merged
// search, an honest experimental badge gated by the config switch, six-state
// audit views, and "catalog unavailable" wording for a failed layer — never
// disguised as "no results". Installing a result routes through the §7.3
// adapter (asserted at the DiscoverView boundary).

class FakeTtyStdout extends Writable {
  public readonly isTTY = true;
  public columns = 110;
  public rows = 32;
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

/** Poll until the (de-ANSI'd) output contains `text` — for async renders that
 * settle later than a frame-level stability check (debounced search). */
async function waitForText(stdout: FakeTtyStdout, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stripAnsi(stdout.output).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for "${text}" in output`);
}

async function renderInteractive(element: React.ReactElement): Promise<{
  instance: ReturnType<typeof render>;
  stdout: FakeTtyStdout;
  stdin: FakeTtyStdin;
}> {
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

const sampleData: WorkbenchData = {
  profiles: [
    {
      name: 'coding',
      description: 'Daily coding profile',
      isDefault: true,
      isLastUsed: true,
      status: 'valid',
      resourceCounts: {
        userMemory: 1,
        autoMemory: 5,
        skills: 3,
        agents: 2,
        mcp: 1,
        settings: 1,
        launchConfig: 1,
      },
      resourceDetails: {
        userMemory: {
          kind: 'user-memory',
          name: 'CLAUDE.md',
          relativePath: 'claude-home/CLAUDE.md',
          exists: true,
          lineCount: 12,
          excerpt: 'Prefer explicit answers.',
        },
        agents: [],
        autoMemory: 5,
        skills: 3,
        mcp: 1,
        settings: 1,
        launchConfig: 1,
      },
      mcpServers: [],
      validation: null,
    },
  ],
  defaultProfile: 'coding',
};

/** A Discover session served entirely by a fake HTTP layer. */
function fakeSession(
  options: { experimentalEnabled?: boolean; http?: ReturnType<typeof makeHttp>['http'] } = {},
): SkillsDiscoverySession {
  const browse =
    options.http ??
    makeHttp([
      ['/repos/vercel-labs/skills', apiRepo('vercel-labs', 'skills')],
      ['/git/trees/main', apiTree(['skills/find-skills/SKILL.md'])],
      [
        'raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md',
        rawSkill('find-skills', 'Finds skills.'),
      ],
    ]).http;
  return new SkillsDiscoverySession({
    http: browse,
    experimentalEnabled: options.experimentalEnabled ?? true,
    now: () => new Date('2026-08-01T12:00:00.000Z'),
    tokenProvider: async () => null,
    repoSkillLimit: 20,
  });
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

/** Press keys one at a time, settling the render between each, so the category
 * focus → Skills card → Enter (BulkOpsView, §11.1) → `d` (Discover) sequence
 * commits. Discover moved behind `d` when the Skills card became the bulk-ops
 * entry (issue #72). */
async function openDiscoverFromSkillsCard(
  stdin: FakeTtyStdin,
  stdout: FakeTtyStdout,
): Promise<void> {
  stdin.press('\t');
  await waitForOutputSettled(stdout, stdout.output);
  stdin.press('\x1b[B');
  await waitForOutputSettled(stdout, stdout.output);
  stdin.press('\x1b[B');
  await waitForOutputSettled(stdout, stdout.output);
  stdin.press('\r');
  await waitForOutputSettled(stdout, stdout.output);
  stdin.press('d');
  await waitForOutputSettled(stdout, stdout.output);
}

describe('Workbench Discover entry (Skills category card)', () => {
  it('Enter on the Skills card opens Discover and shows the curated browse', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        configLoader: async () => ({
          version: 2,
          recovery: { retentionDays: 30 },
          workbench: { skillsDiscoveryExperimental: true },
        }),
        discoverySessionFactory: () => fakeSession(),
      }),
    );
    await openDiscoverFromSkillsCard(stdin, stdout);
    await waitForText(stdout, 'find-skills');

    const output = stripAnsi(stdout.output);
    expect(output).toContain('Discover');
    // Curated backbone browse surfaced the frontmatter-parsed Skill.
    expect(output).toContain('find-skills');
    expect(output).toContain('Finds skills.');
    // Persistent experimental badge (default-on, spec §7.4).
    expect(output).toContain('[experimental]');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('hides the experimental badge and layer when the config switch is off', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        configLoader: async () => ({
          version: 2,
          recovery: { retentionDays: 30 },
          workbench: { skillsDiscoveryExperimental: false },
        }),
        discoverySessionFactory: (_appHome, experimental) =>
          fakeSession({ experimentalEnabled: experimental }),
      }),
    );
    await openDiscoverFromSkillsCard(stdin, stdout);

    const output = stripAnsi(stdout.output);
    expect(output).not.toContain('[experimental]');
    expect(output).toContain('experimental layer off');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('offline browse reads "catalog unavailable", never "no results"', async () => {
    resetWelcomeSessionForTests();
    const offlineSession = new SkillsDiscoverySession({
      http: async () => {
        throw new TypeError('fetch failed');
      },
      experimentalEnabled: true,
      now: () => new Date('2026-08-01T12:00:00.000Z'),
      tokenProvider: async () => null,
    });
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: sampleData,
        initialLocale: 'en',
        skipWelcome: true,
        configLoader: async () => ({
          version: 2,
          recovery: { retentionDays: 30 },
          workbench: { skillsDiscoveryExperimental: true },
        }),
        discoverySessionFactory: () => offlineSession,
      }),
    );
    await openDiscoverFromSkillsCard(stdin, stdout);
    await waitForText(stdout, 'catalog unavailable');

    const output = stripAnsi(stdout.output);
    expect(output).toContain('catalog unavailable');
    expect(output).not.toContain('No results');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('DiscoverView interactions', () => {
  it('searching merges a skills.sh result with install counts and an audit state', async () => {
    const { http } = makeHttp([
      ['/search/repositories', new FakeResponse(200, { total_count: 0, items: [] })],
      [
        'https://skills.sh/api/search',
        skillshubSearch([
          {
            ...shubItem({ id: 'mattpocock/skills/git-guardrails', installs: 185164 }),
            audit: 'pass',
          },
        ]),
      ],
    ]);
    const session = new SkillsDiscoverySession({
      http,
      experimentalEnabled: true,
      now: () => new Date('2026-08-01T12:00:00.000Z'),
      tokenProvider: async () => null,
    });
    const onInstall = vi.fn();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(DiscoverView, {
        profileName: 'coding',
        session,
        width: 110,
        height: 32,
        headless: false,
        onBack: () => {},
        onInstallSource: onInstall,
        onOpenBrowser: () => {},
      }),
    );
    // Focus search, type a query, wait for the debounced merged search to land.
    const baseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, baseline);
    stdin.press('g');
    stdin.press('i');
    stdin.press('t');
    await waitForText(stdout, 'git-guardrails');

    const output = stripAnsi(stdout.output);
    expect(output).toContain('185,164'); // install count
    expect(output).toContain('✓ audited'); // audit 'pass' rendered (never hidden)
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('Enter on a result routes its install source to the acquisition adapter', async () => {
    const session = fakeSession();
    const onInstall = vi.fn();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(DiscoverView, {
        profileName: 'coding',
        session,
        width: 110,
        height: 32,
        headless: false,
        onBack: () => {},
        onInstallSource: onInstall,
        onOpenBrowser: () => {},
      }),
    );
    // Wait for the curated browse to land, then install the selected result.
    const baseline = stdout.output;
    stdin.press('\r');
    await waitForOutputSettled(stdout, baseline);

    expect(onInstall).toHaveBeenCalledTimes(1);
    // The backbone result installs via a precise tree URL (spec §7.4).
    expect(onInstall).toHaveBeenCalledWith(
      'https://github.com/vercel-labs/skills/tree/main/skills/find-skills',
      undefined,
    );
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('keeps the healthy layer’s results when the other layer is down (partial failure)', async () => {
    const { http } = makeHttp([
      ['/search/repositories', repoSearchJson(['o/skill-repo'])],
      ['/repos/o/skill-repo', apiRepo('o', 'skill-repo')],
      ['/git/trees/main', apiTree(['git/SKILL.md'])],
      ['raw.githubusercontent.com/o/skill-repo/main/git/SKILL.md', rawSkill('git', 'Git skill.')],
      ['https://skills.sh/api/search', new FakeResponse(500, {})],
    ]);
    const session = new SkillsDiscoverySession({
      http,
      experimentalEnabled: true,
      now: () => new Date('2026-08-01T12:00:00.000Z'),
      tokenProvider: async () => null,
    });
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(DiscoverView, {
        profileName: 'coding',
        session,
        width: 110,
        height: 32,
        headless: false,
        onBack: () => {},
        onInstallSource: () => {},
        onOpenBrowser: () => {},
      }),
    );
    // Search: backbone finds a Skill; skills.sh is down.
    const baseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, baseline);
    stdin.press('g');
    stdin.press('i');
    stdin.press('t');
    await waitForText(stdout, 'Git skill.');

    const output = stripAnsi(stdout.output);
    // The backbone result survives — never hidden behind the failure wording.
    expect(output).toContain('Git skill.');
    expect(output).toContain('catalog unavailable');
    expect(output).not.toContain('No results');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('surfaces a partial backbone failure ("catalog partially unavailable")', async () => {
    // Only vercel-labs/skills is served; the other curated repos 404 → degraded.
    const session = new SkillsDiscoverySession({
      http: makeHttp([
        ['/repos/vercel-labs/skills', apiRepo('vercel-labs', 'skills')],
        ['/git/trees/main', apiTree(['skills/find-skills/SKILL.md'])],
        [
          'raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md',
          rawSkill('find-skills', 'Finds skills.'),
        ],
      ]).http,
      experimentalEnabled: false,
      now: () => new Date('2026-08-01T12:00:00.000Z'),
      tokenProvider: async () => null,
    });
    const { instance, stdout } = await renderInteractive(
      React.createElement(DiscoverView, {
        profileName: 'coding',
        session,
        width: 110,
        height: 32,
        headless: false,
        onBack: () => {},
        onInstallSource: () => {},
        onOpenBrowser: () => {},
      }),
    );
    await waitForText(stdout, 'find-skills');

    const output = stripAnsi(stdout.output);
    // The healthy repo's results are shown AND the degradation is surfaced.
    expect(output).toContain('find-skills');
    expect(output).toContain('catalog partially unavailable');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('browser handoff calls the open-browser callback', async () => {
    const session = fakeSession();
    const onOpenBrowser = vi.fn();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(DiscoverView, {
        profileName: 'coding',
        session,
        width: 110,
        height: 32,
        headless: false,
        onBack: () => {},
        onInstallSource: () => {},
        onOpenBrowser,
      }),
    );
    const baseline = stdout.output;
    stdin.press('b');
    await waitForOutputSettled(stdout, baseline);
    expect(onOpenBrowser).toHaveBeenCalledWith('https://skills.sh');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
