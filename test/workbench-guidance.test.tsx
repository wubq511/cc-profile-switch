import { Readable, Writable } from 'node:stream';

import React from 'react';
import { Box, Text, render } from 'ink';
import { describe, expect, it } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import { MainPane } from '../src/tui/workbench/main-pane';
import { I18nProvider } from '../src/tui/workbench/i18n/react';
import { KeymapOverlay } from '../src/tui/workbench/keymap';
import {
  ErrorPanel,
  HintsProvider,
  NoMatchEmptyState,
  RemoveProfilePanel,
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
  mcpServers: [],
  validation: null,
};

const sampleData: WorkbenchData = {
  profiles: [codingProfile],
  defaultProfile: 'coding',
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
        data: { profiles: [], defaultProfile: undefined },
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
    expect(output).toContain('No profiles match "xyz".');
    expect(flatten(output)).toContain('Search covers profile names and descriptions.');
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
          React.createElement(MainPane, { profile, mcpFailed: [], width: 60, height: 20 }),
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
    });
    await instance.waitUntilRenderFlush();
    await waitForInputListener(stdin);
    return { instance, stdout, stdin };
  }

  it('zero-Profile recipe: pressing [n] opens the create flow', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderInteractive(
      React.createElement(WorkbenchApp, {
        data: { profiles: [], defaultProfile: undefined },
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
    expect(flatten(output)).toContain('search covers profile names and descriptions');
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
    expect(flatten(stripAnsi(stdout.output))).toContain('search covers profile names and descriptions');

    // Blur out of search, then focus again — the tip must stay gone.
    stdout.snapshot();
    stdin.press('\x1b');
    await waitForOutputSettled(stdout, '');
    const secondBaseline = stdout.output;
    stdin.press('/');
    await waitForOutputSettled(stdout, secondBaseline);
    expect(flatten(stripAnsi(stdout.output))).not.toContain('search covers profile names');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
