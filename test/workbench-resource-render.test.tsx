import { Readable, Writable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';

import { ResourceList } from '../src/tui/workbench/resource-list';
import { ResourceDiffView } from '../src/tui/workbench/resource-diff-view';
import { ResourcePreview } from '../src/tui/workbench/resource-preview';
import { I18nProvider } from '../src/tui/workbench/i18n/react';
import type { WorkbenchProfile } from '../src/tui/workbench/profile-data';
import type { UserMemoryDiff, AgentsDiff } from '../src/core/resource';

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

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function profile(name: string): WorkbenchProfile {
  return {
    name,
    description: `Profile ${name}`,
    isDefault: false,
    isLastUsed: false,
    status: 'valid',
    resourceCounts: {
      userMemory: 1,
      autoMemory: 0,
      skills: 0,
      agents: 1,
      mcp: 0,
      settings: 1,
      launchConfig: 1,
    },
    resourceDetails: {
      userMemory: {
        kind: 'user-memory',
        name: 'CLAUDE.md',
        relativePath: 'claude-home/CLAUDE.md',
        exists: true,
        lineCount: 3,
        excerpt: 'Prefer explicit answers.',
      },
      agents: [
        {
          kind: 'agents',
          name: 'explore',
          relativePath: 'claude-home/agents/explore.md',
          exists: true,
          frontmatter: { name: 'explore', description: 'read-only exploration' },
          frontmatterParseError: null,
          bodyExcerpt: 'Scan the codebase.',
        },
      ],
      autoMemory: 0,
      skills: 0,
      mcp: 0,
      settings: 1,
      launchConfig: 1,
    },
    validation: null,
  };
}

function renderWithLocale(element: React.ReactElement) {
  const stdout = new FakeTtyStdout();
  const instance = render(
    React.createElement(I18nProvider, { initialLocale: 'en' }, element),
    { stdout, stdin: dummyStdin(), debug: true },
  );
  return { instance, stdout };
}

describe('ResourceList', () => {
  it('renders agent rows with names and descriptions', async () => {
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourceList, {
        profile: profile('coding'),
        category: 'agents',
        selectedIndex: 0,
        sessionFor: () => undefined,
        width: 60,
        height: 20,
        hintLine: '[e] edit  [x] remove',
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('coding › Agents');
    expect(output).toContain('explore');
    expect(output).toContain('read-only exploration');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('renders the missing user-memory recreate hint', async () => {
    const p = profile('coding');
    p.resourceDetails.userMemory.exists = false;
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourceList, {
        profile: p,
        category: 'user-memory',
        selectedIndex: 0,
        sessionFor: () => undefined,
        width: 60,
        height: 20,
        hintLine: '',
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('CLAUDE.md not found');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('ResourcePreview', () => {
  it('renders file content with line numbers', async () => {
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourcePreview, {
        profile: profile('coding'),
        category: 'user-memory',
        resourceName: 'CLAUDE.md',
        content: '# Title\nPrefer explicit answers.\n',
        scrollOffset: 0,
        session: undefined,
        width: 60,
        height: 20,
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('Prefer explicit answers.');
    expect(output).toContain('1');
    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe('ResourceDiffView', () => {
  const memoryDiff: UserMemoryDiff = {
    profileA: 'coding',
    profileB: 'study',
    lines: [
      { type: 'same', text: '# Title' },
      { type: 'del', text: 'old line' },
      { type: 'add', text: 'new line' },
    ],
    aLineCount: 2,
    bLineCount: 2,
  };

  it('renders a unified line diff for User Memory', async () => {
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourceDiffView, {
        profile: profile('coding'),
        category: 'user-memory',
        diff: memoryDiff,
        drilledAgent: null,
        profiles: [profile('coding'), profile('study')],
        width: 60,
        height: 20,
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('old line');
    expect(output).toContain('new line');
    instance.unmount();
    await instance.waitUntilExit();
  });

  const agentsDiff: AgentsDiff = {
    profileA: 'coding',
    profileB: 'study',
    files: [
      { name: 'explore', verdict: 'changed', lines: [
        { type: 'del', text: 'old body' },
        { type: 'add', text: 'new body' },
      ] },
      { name: 'editor', verdict: 'added' },
    ],
    addedCount: 1,
    removedCount: 0,
    changedCount: 1,
    sameCount: 0,
  };

  it('renders a per-file layer for Agents', async () => {
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourceDiffView, {
        profile: profile('coding'),
        category: 'agents',
        diff: agentsDiff,
        drilledAgent: 'explore',
        profiles: [profile('coding'), profile('study')],
        width: 60,
        height: 20,
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('explore');
    expect(output).toContain('editor');
    expect(output).toContain('old body');
    expect(output).toContain('new body');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
