import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import React from 'react';
import { Box, Text, render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import { MainPane } from '../src/tui/workbench/main-pane';
import { initialResourceNavState } from '../src/tui/workbench/resource-nav';
import { I18nProvider } from '../src/tui/workbench/i18n/react';
import { KeymapOverlay } from '../src/tui/workbench/keymap';
import { createAppConfig } from '../src/core/app-config';
import {
  listCustomTemplates,
  saveProfileAsTemplate,
} from '../src/core/custom-template';
import {
  createProfileFromTemplate,
  getProfileTemplatePaths,
} from '../src/core/profile-template';
import {
  ErrorPanel,
  HintsProvider,
  NoMatchEmptyState,
  RemoveProfilePanel,
  SaveTemplatePanel,
  ZeroProfilesEmptyState,
  useHints,
  type HintsApi,
} from '../src/tui/workbench/guidance';
import type { WorkbenchProfile, WorkbenchData } from '../src/tui/workbench/profile-data';
import type { McpServerState } from '../src/core/mcp-list';

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

function dummyStdin(): Readable {
  return new Readable({ read() {} });
}

/** A TTY-looking stdin that can synthesize keypresses for interactive tests. */
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

async function renderTree(element: React.ReactElement, stdout: FakeTtyStdout) {
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: dummyStdin() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
    // These tests assert on intermediate frames (snapshots, first-focus-only
    // hints), so Ink must stream frames live instead of deferring to unmount.
    // Force interactive mode: Ink's auto-detection reads `is-in-ci`, and the
    // CI runner exports CI=true, which would otherwise flip this harness to
    // non-interactive regardless of the fake TTY.
    interactive: true,
  });
  await instance.waitUntilRenderFlush();
  return instance;
}

const codingProfile: WorkbenchProfile = {
  name: 'coding',
  description: 'Daily coding profile',
  isDefault: true,
  isLastUsed: true,
  status: 'valid',
  resourceCounts: { userMemory: 1, autoMemory: 5, skills: 3, agents: 2, mcp: 1, settings: 1, launchConfig: 1 },
  resourceDetails: {
    userMemory: { kind: 'user-memory', name: 'CLAUDE.md', relativePath: 'claude-home/CLAUDE.md', exists: true, lineCount: 12, excerpt: '' },
    agents: [],
    skills: [],
    autoMemory: [],
    settings: [],
  },
  mcpServers: [],
  validation: null,
};

const sampleData: WorkbenchData = {
  profiles: [codingProfile],
  defaultProfile: 'coding',
  customTemplates: [],
};

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

/** Flatten wrapped render output (borders included) for substring assertions. */
function flatten(text: string): string {
  return stripAnsi(text)
    .replace(/[│╭╰╮╯─┌┐└┘┃┏┓┗┛]/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/[ ]+/g, ' ')
    .trim();
}

describe('welcome card', () => {
  it('shows once per session and explains Profiles plus the three keys', async () => {
    resetWelcomeSessionForTests();
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', headless: true }),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('Welcome to Profile Workbench');
    expect(output).toContain('[↑/↓] move between Profiles');
    expect(output).toContain('[/] search everything');
    expect(output).toContain('[?] every key and concept');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('does not reappear on a second render in the same session', async () => {
    resetWelcomeSessionForTests();
    // First render in this session shows the card.
    const stdout1 = new FakeTtyStdout();
    const first = await renderTree(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', headless: true }),
      stdout1,
    );
    expect(stripAnsi(stdout1.output)).toContain('Welcome to Profile Workbench');
    first.unmount();
    await first.waitUntilExit();

    // Second render in the same session must not show it again.
    const stdout2 = new FakeTtyStdout();
    const second = await renderTree(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', headless: true }),
      stdout2,
    );
    const output = stripAnsi(stdout2.output);
    expect(output).not.toContain('Welcome to Profile Workbench');
    expect(output).toContain('Profiles');
    second.unmount();
    await second.waitUntilExit();
  });
});

describe('? help sheet', () => {
  it('includes the concepts section (concepts, no filesystem paths)', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(KeymapOverlay, { visible: true }),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('Keyboard Shortcuts');
    expect(output).toContain('Concepts');
    expect(output).toContain('Copied Skill');
    expect(output).toContain('Linked Skill');
    expect(output).toContain('Recovery Bin');
    expect(output).toContain('Plugins');
    // Concepts never expose filesystem paths.
    expect(output).not.toContain('claude-home');
    expect(output).not.toContain('.claude');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('error panel', () => {
  it('renders a boxed panel with numbered recovery steps', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(ErrorPanel, {
          message: 'Profile removal confirmation did not match.',
          code: 'PROFILE_DELETE_CONFIRMATION_MISMATCH',
          guidance: 'Type the exact profile name to remove it: coding',
        }),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('PROFILE_DELETE_CONFIRMATION_MISMATCH');
    expect(output).toContain('1.');
    expect(output).toContain('Type the exact profile name');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('numbers each recovery step when guidance has several sentences', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(ErrorPanel, {
          message: 'Launch blocked.',
          code: 'LAUNCH_BLOCKED',
          guidance: 'Run ccps validate coding. Fix every error finding. Then retry the launch.',
        }),
      ),
      stdout,
    );
    const flat = flatten(stripAnsi(stdout.output));
    expect(flat).toContain('1.');
    expect(flat).toContain('2.');
    expect(flat).toContain('3.');
    expect(flat).toContain('Fix every error finding');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('destructive panel', () => {
  it('renders the graduated options [y]/[u]/[esc] with a consequence line', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(RemoveProfilePanel, { profile: codingProfile }),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('Remove Profile "coding"?');
    expect(output).toContain('[y] back up first, then remove');
    expect(output).toContain('[u] no backup');
    expect(output).toContain('[esc] keep it');
    expect(output).toContain('3 skills · 2 agents');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('save-template panel', () => {
  it('renders the stripping summary with a single light [y]/[esc] confirm (S102)', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(SaveTemplatePanel, {
          templateName: 'team-base',
          strippedCount: 3,
        }),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('Save template "team-base"?');
    expect(output).toContain('3 secret fields stripped, Auto Memory not included');
    expect(output).toContain('[y] save template');
    expect(output).toContain('[esc] cancel');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('renders the stripping summary in Chinese', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'zh' },
        React.createElement(SaveTemplatePanel, {
          templateName: 'team-base',
          strippedCount: 2,
        }),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('已剔除 2 个机密字段，不包含 Auto Memory');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('hint retirement', () => {
  let hintApi: HintsApi | null = null;

  function HintProbe(): React.ReactElement {
    const hints = useHints();
    hintApi = hints;
    return React.createElement(
      Box,
      null,
      React.createElement(Text, null, `live:${hints.liveKeys(['l', 'b']).join('')}`),
    );
  }

  it('drops a hint after its key has been used three times', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(HintsProvider, null, React.createElement(HintProbe)),
      stdout,
    );
    expect(stripAnsi(stdout.output)).toContain('live:lb');

    for (let i = 0; i < 3; i++) {
      hintApi!.markUsed('l');
      await instance.waitUntilRenderFlush();
    }

    expect(hintApi!.isRetired('l')).toBe(true);
    expect(hintApi!.liveKeys(['l', 'b'])).toEqual(['b']);
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('empty states', () => {
  it('zero-Profile state is a recipe offering [n]', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(ZeroProfilesEmptyState, null),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('No Profiles yet.');
    expect(output).toContain('Press [n] to create your first Profile');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('zero-Profile recipe shows in the full app (no profiles)', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(WorkbenchApp, {
        data: { profiles: [], defaultProfile: undefined, customTemplates: [] },
        initialLocale: 'en',
        headless: true,
        skipWelcome: true,
      }),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('No Profiles yet.');
    expect(flatten(output)).toContain('Press [n] to create your first Profile');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('no-match search state explains what search covers and how to clear', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(NoMatchEmptyState, { query: 'xyz' }),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    expect(output).toContain('Nothing matches "xyz".');
    expect(flatten(output)).toContain('Search covers profiles, resource items, and memory/agent content.');
    expect(output).toContain('Press [esc] to clear search');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('guidance copy wraps at ~26 columns without truncation', async () => {
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(
          Box,
          { width: 26, flexDirection: 'column' },
          React.createElement(ZeroProfilesEmptyState, null),
        ),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    // The full recipe survives a 26-column width (wrapped, never truncated).
    const flat = flatten(output);
    expect(flat).toContain('own memory, skills, and settings.');
    expect(flat).toContain('Press [n] to create your first Profile');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('empty category cards offer [a] add (Skills name copy or link)', async () => {
    const profile: WorkbenchProfile = {
      ...codingProfile,
      resourceCounts: { userMemory: 1, autoMemory: 1, skills: 0, agents: 2, mcp: 1, settings: 1, launchConfig: 1 },
    };
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' },
        React.createElement(
          HintsProvider,
          null,
          React.createElement(MainPane, {
            profile,
            profiles: [profile],
            nav: initialResourceNavState(),
            mcpFailed: [],
            width: 60,
            height: 20,
            sessionFor: () => undefined,
            content: null,
            diff: null,
            drilledAgent: null,
            agentFrontmatter: null,
            searchResults: [],
            onSaveFrontmatter: () => {},
            onBack: () => {},
            hintLine: '',
          }),
        ),
      ),
      stdout,
    );
    const output = stripAnsi(stdout.output);
    const flat = flatten(output);
    // The offer and the Skills-specific "copy or link" hint both render (the
    // wrapped second line interleaves with the neighboring card, so assert the
    // single-line piece plus the wrapped tail).
    expect(flat).toContain('[a] add (copy or');
    expect(flat).toContain('link)');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('failed-MCP amber nudge', () => {
  it('nudges when the selected Profile has MCP servers that failed to connect', async () => {
    const data: WorkbenchData = {
      profiles: [
        { ...codingProfile, mcpServers: ['filesystem', 'browser'] },
      ],
      defaultProfile: 'coding',
      customTemplates: [],
    };
    const probe: (appHomePath: string, profileName: string) => Promise<McpServerState[]> = async () => [
      { name: 'filesystem', failed: false },
      { name: 'browser', failed: true },
    ];
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(WorkbenchApp, {
        data,
        initialLocale: 'en',
        headless: true,
        skipWelcome: true,
        mcpProbe: probe,
      }),
      stdout,
    );
    // Allow the async probe to land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const output = stripAnsi(stdout.output);
    expect(flatten(output)).toContain('MCP "browser" failed to connect');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('shows no nudge when every server is healthy', async () => {
    const data: WorkbenchData = {
      profiles: [{ ...codingProfile, mcpServers: ['filesystem'] }],
      defaultProfile: 'coding',
      customTemplates: [],
    };
    const probe: (appHomePath: string, profileName: string) => Promise<McpServerState[]> = async () => [
      { name: 'filesystem', failed: false },
    ];
    const stdout = new FakeTtyStdout();
    const instance = await renderTree(
      React.createElement(WorkbenchApp, {
        data,
        initialLocale: 'en',
        headless: true,
        skipWelcome: true,
        mcpProbe: probe,
      }),
      stdout,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const output = stripAnsi(stdout.output);
    expect(output).not.toContain('failed to connect');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('keypress guidance flows', () => {
  /** Poll until Ink attaches its stdin 'readable' listener (keypresses are
   *  dropped before that; a fixed sleep flakes under parallel CI load). */
  async function waitForInputListener(stdin: FakeTtyStdin, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && stdin.listenerCount('readable') === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (stdin.listenerCount('readable') === 0) {
      throw new Error('Ink never attached a stdin readable listener');
    }
  }

  /** Wait until the press-triggered frame arrives and stdout stops changing.
   *  `baseline` is the output captured before the keypress; we first wait for a
   *  change (so we don't return before the render lands), then for stability. */
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
      // Keypress flows need live, interactive frames (see renderTree above);
      // without this, CI=true forces non-interactive mode and the press-driven
      // renders are deferred until unmount.
      interactive: true,
    });
    await instance.waitUntilRenderFlush();
    await waitForInputListener(stdin);
    return { instance, stdout, stdin };
  }

  it('zero-Profile recipe: pressing [n] opens the create flow', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: { profiles: [], defaultProfile: undefined, customTemplates: [] },
        initialLocale: 'en',
        skipWelcome: true,
      }),
    );
    expect(stripAnsi(stdout.output)).toContain('No Profiles yet.');
    const nBaseline = stdout.output;
    stdin.press('n');
    await waitForOutputSettled(stdout, nBaseline);
    const output = stripAnsi(stdout.output);
    expect(output).toContain('Select template:');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('create picker lists custom templates after the built-ins with a source distinction (S102)', async () => {
    resetWelcomeSessionForTests();
    const dataWithTemplate: WorkbenchData = {
      ...sampleData,
      customTemplates: [{ name: 'team-base', sourceProfile: 'coding' }],
    };
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: dataWithTemplate,
        initialLocale: 'en',
        skipWelcome: true,
      }),
    );
    const nBaseline = stdout.output;
    stdin.press('n');
    await waitForOutputSettled(stdout, nBaseline);
    const output = flatten(stripAnsi(stdout.output));
    expect(output).toContain('Select template:');
    expect(output).toContain('Built-in');
    expect(output).toContain('Custom');
    expect(output).toContain('team-base (custom)');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('pressing [x] opens the destructive panel and [esc] keeps the Profile', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', skipWelcome: true }),
    );
    const xBaseline = stdout.output;
    stdin.press('x');
    await waitForOutputSettled(stdout, xBaseline);
    const opened = stripAnsi(stdout.output);
    expect(flatten(opened)).toContain('Remove Profile "coding"?');
    expect(flatten(opened)).toContain('[y] back up first, then remove');

    // The output getter concatenates every frame ever written; discard the
    // pre-ESC history so `closed` proves the panel was removed, not just re-rendered.
    stdout.snapshot();
    const escBaseline = stdout.output;
    stdin.press('\x1b');
    // Node readline holds a lone ESC ~100ms before emitting the escape keypress
    // (it may be the start of a longer sequence); the settle-wait covers it.
    await waitForOutputSettled(stdout, escBaseline);
    const closed = stripAnsi(stdout.snapshot());
    expect(closed).not.toContain('Remove Profile "coding"?');
    expect(closed).toContain('Profiles');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('first-search-focus shows the one-line discovery tip', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', skipWelcome: true }),
    );
    const slashBaseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, slashBaseline);
    const output = stripAnsi(stdout.output);
    expect(flatten(output)).toContain('covers profiles, resource items, and memory/agent content');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('search discovery tip does not reappear on a later focus (first-focus only)', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', skipWelcome: true }),
    );
    const firstBaseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, firstBaseline);
    expect(flatten(stripAnsi(stdout.output))).toContain('covers profiles, resource items, and memory/agent content');

    // Blur out of search, then focus again — the tip must stay gone.
    stdout.snapshot();
    stdin.press('\x1b');
    await waitForOutputSettled(stdout, '');
    const secondBaseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, secondBaseline);
    expect(flatten(stripAnsi(stdout.output))).not.toContain('covers profiles, resource items');
    instance.unmount();
    await instance.waitUntilExit();
  });

  // S102–S104 end-to-end journeys: the Workbench drives the real core
  // services against a tmp app home (HOME override), so the picker, the
  // zero-confirm removal, and the create/save flashes are pinned for real.
  // The fixture profile carries one settings secret and NO MCP servers, so
  // create never shells out to the `claude` binary.
  describe('custom template journeys (S102-S104)', () => {
    const TEMPLATE_FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');
    const tempRoots: string[] = [];

    afterEach(async () => {
      await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
      tempRoots.length = 0;
    });

    async function makeRealAppHome(): Promise<{ userHome: string; appHome: string }> {
      const root = await mkdtemp(join(tmpdir(), 'ccps-wb-template-'));
      tempRoots.push(root);
      const userHome = path.join(root, 'userhome');
      const appHome = path.join(userHome, '.cc-profile-switch');
      await createAppConfig(appHome, { clock: TEMPLATE_FIXED_CLOCK });
      await createProfileFromTemplate({
        appHomePath: appHome,
        name: 'coding',
        template: 'coding',
        clock: TEMPLATE_FIXED_CLOCK,
      });
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeJson(paths.settingsPath, {
        autoMemoryDirectory: paths.autoMemoryPath,
        claudeMdExcludes: [],
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-secret-token-123',
          CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        },
      });
      return { userHome, appHome };
    }

    /** Run `fn` with the user home pointed at the tmp dir, then restore. On
     * win32 the app resolves home from USERPROFILE (src/platform/path.ts), so
     * both vars must be pinned or the flows leak into the real runner home. */
    async function withHome<T>(userHome: string, fn: () => Promise<T>): Promise<T> {
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = userHome;
      process.env.USERPROFILE = userHome;
      try {
        return await fn();
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalUserProfile === undefined) {
          delete process.env.USERPROFILE;
        } else {
          process.env.USERPROFILE = originalUserProfile;
        }
      }
    }

    async function pressEach(stdin: FakeTtyStdin, stdout: FakeTtyStdout, chars: string): Promise<void> {
      for (const ch of chars) {
        const baseline = stdout.output;
        stdin.press(ch);
        await waitForOutputSettled(stdout, baseline);
      }
    }

    /** Poll until a marker renders. Async core-service transitions (preview /
     * save / create / remove) land frames after the 20ms settle window of
     * waitForOutputSettled, so those steps must wait on content, not quiet. */
    async function waitForOutputContaining(
      stdout: FakeTtyStdout,
      marker: string,
      timeoutMs = 5000,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stripAnsi(stdout.output).includes(marker)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for output containing: ${marker}`);
    }

    async function openPickerAtCustomRow(
      stdin: FakeTtyStdin,
      stdout: FakeTtyStdout,
    ): Promise<void> {
      let baseline = stdout.output;
      stdin.press('n');
      await waitForOutputSettled(stdout, baseline);
      // 5 built-ins (coding/study/work/research/general) precede the custom row.
      for (let i = 0; i < 5; i++) {
        baseline = stdout.output;
        stdin.press('\x1b[B');
        await waitForOutputSettled(stdout, baseline);
      }
    }

    it('S104: x on a custom picker row removes it with no confirm; built-in rows ignore x', async () => {
      const { userHome, appHome } = await makeRealAppHome();
      await saveProfileAsTemplate({
        appHomePath: appHome,
        profileName: 'coding',
        templateName: 'team-base',
        clock: TEMPLATE_FIXED_CLOCK,
      });

      await withHome(userHome, async () => {
        resetWelcomeSessionForTests();
        const data: WorkbenchData = {
          ...sampleData,
          customTemplates: [{ name: 'team-base', sourceProfile: 'coding' }],
        };
        const { instance, stdout, stdin } = await renderInteractive(
          React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
        );

        // Open the picker; x on the highlighted built-in row (index 0) is a no-op.
        let baseline = stdout.output;
        stdin.press('n');
        await waitForOutputSettled(stdout, baseline);
        expect(flatten(stripAnsi(stdout.output))).toContain('team-base (custom)');
        stdin.press('x');
        // Nothing re-renders for a no-op: fixed settle window, then assert.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await listCustomTemplates(appHome)).toHaveLength(1);
        expect(flatten(stripAnsi(stdout.output))).toContain('Select template:');
        expect(stripAnsi(stdout.output)).not.toContain('removed');

        // Highlight the custom row (5 built-ins down): removal hint appears.
        for (let i = 0; i < 5; i++) {
          baseline = stdout.output;
          stdin.press('\x1b[B');
          await waitForOutputSettled(stdout, baseline);
        }
        expect(flatten(stripAnsi(stdout.output))).toContain('[x] remove this template');

        // x removes it with NO confirm panel (zero-confirm, S104).
        stdout.snapshot();
        stdin.press('x');
        await waitForOutputContaining(stdout, 'Template "team-base" removed');
        const frame = flatten(stripAnsi(stdout.output));
        expect(frame).not.toContain('[y]');
        expect(frame).toContain('Template "team-base" removed');
        expect(await listCustomTemplates(appHome)).toHaveLength(0);
        instance.unmount();
        await instance.waitUntilExit();
      });
    });

    it('S103: create from a custom template flashes the guided re-entry keys', async () => {
      const { userHome, appHome } = await makeRealAppHome();
      await saveProfileAsTemplate({
        appHomePath: appHome,
        profileName: 'coding',
        templateName: 'team-base',
        clock: TEMPLATE_FIXED_CLOCK,
      });

      await withHome(userHome, async () => {
        resetWelcomeSessionForTests();
        const data: WorkbenchData = {
          ...sampleData,
          customTemplates: [{ name: 'team-base', sourceProfile: 'coding' }],
        };
        const { instance, stdout, stdin } = await renderInteractive(
          React.createElement(WorkbenchApp, { data, initialLocale: 'en', skipWelcome: true }),
        );

        await openPickerAtCustomRow(stdin, stdout);
        // Select the custom row → step 2 name prompt.
        const selectBaseline = stdout.output;
        stdin.press('\r');
        await waitForOutputSettled(stdout, selectBaseline);
        expect(stripAnsi(stdout.output)).toContain('Profile name:');

        await pressEach(stdin, stdout, 'fresh');
        stdin.press('\r');
        await waitForOutputContaining(stdout, 'created from template "team-base"');
        const frame = flatten(stripAnsi(stdout.output));
        expect(frame).toContain('"fresh" created from template "team-base"');
        expect(frame).toContain('Re-enter 1 secret keys: ANTHROPIC_API_KEY');
        // The profile really landed in the tmp app home.
        expect(
          await fs.pathExists(getProfileTemplatePaths(appHome, 'fresh').profileRootPath),
        ).toBe(true);
        instance.unmount();
        await instance.waitUntilExit();
      });
    });

    it('S102: s saves the profile as a template after the stripping-summary confirm', async () => {
      const { userHome, appHome } = await makeRealAppHome();

      await withHome(userHome, async () => {
        resetWelcomeSessionForTests();
        const { instance, stdout, stdin } = await renderInteractive(
          React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', skipWelcome: true }),
        );

        // [s] opens the template-name prompt for the selected profile.
        const saveBaseline = stdout.output;
        stdin.press('s');
        await waitForOutputSettled(stdout, saveBaseline);
        expect(stripAnsi(stdout.output)).toContain('Template name:');

        await pressEach(stdin, stdout, 'my-tpl');
        stdin.press('\r');
        await waitForOutputContaining(stdout, 'Save template "my-tpl"?');
        // Light-confirm panel with the stripping summary — nothing saved yet.
        let frame = flatten(stripAnsi(stdout.output));
        expect(frame).toContain('Save template "my-tpl"?');
        expect(frame).toContain('1 secret fields stripped, Auto Memory not included');
        expect(frame).toContain('[y] save template');
        expect(await listCustomTemplates(appHome)).toHaveLength(0);

        // [y] saves the stripped template.
        stdin.press('y');
        await waitForOutputContaining(stdout, 'Template "my-tpl" saved');
        frame = flatten(stripAnsi(stdout.output));
        expect(frame).toContain('Template "my-tpl" saved');
        expect((await listCustomTemplates(appHome)).map((t) => t.name)).toEqual(['my-tpl']);
        const savedSettings = await fs.readJson(
          path.join(appHome, 'templates', 'my-tpl', 'profile', 'claude-home', 'settings.json'),
        );
        expect(savedSettings.env.ANTHROPIC_API_KEY).toBe('<redacted>');
        instance.unmount();
        await instance.waitUntilExit();
      });
    });
  });
});
