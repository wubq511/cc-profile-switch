import { Readable, Writable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import type { SearchResult } from '../src/core/resource/types';
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
      },
    }),
    makeProfile({
      name: 'study',
      description: 'Research notes',
      isDefault: false,
      resourceCounts: { userMemory: 1, autoMemory: 0, skills: 0, agents: 0, mcp: 0, settings: 0, launchConfig: 1 },
    }),
  ],
  defaultProfile: 'coding',
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
