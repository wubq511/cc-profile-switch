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
import type {
  ResourceDiffResult,
  CopiedSkillsDiff,
  McpInventoryDiff,
} from '../src/core/resource/diff-all';
import type { LaunchConfigDiffEntry, SettingsDiffEntry } from '../src/core/diff';

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
      autoMemory: [],
      skills: [],
      settings: ['model'],
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
  function renderDiff(diff: ResourceDiffResult | null, extra: { drilledAgent?: string | null } = {}) {
    return renderWithLocale(
      React.createElement(ResourceDiffView, {
        profile: profile('coding'),
        diff,
        counterpart: 'study',
        drilledAgent: extra.drilledAgent ?? null,
        profiles: [profile('coding'), profile('study')],
        width: 60,
        height: 20,
        scrollOffset: 0,
      }),
    );
  }

  it('renders a unified line diff for User Memory', async () => {
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
    const { instance, stdout } = renderDiff({ category: 'user-memory', diff: memoryDiff });
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('old line');
    expect(output).toContain('new line');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('renders a per-file layer for Agents with drill-in', async () => {
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
    const { instance, stdout } = renderDiff({ category: 'agents', diff: agentsDiff }, { drilledAgent: 'explore' });
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('explore');
    expect(output).toContain('editor');
    expect(output).toContain('old body');
    expect(output).toContain('new body');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('renders a Settings redacted key table (values never appear)', async () => {
    const settings: SettingsDiffEntry[] = [
      { key: 'model', verdict: 'changed' },
      { key: 'env.ANTHROPIC_API_KEY', verdict: 'changed' },
      { key: 'permissions.allow', verdict: 'only-b' },
    ];
    const { instance, stdout } = renderDiff({ category: 'settings', diff: settings });
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('model');
    expect(output).toContain('env.ANTHROPIC_API_KEY');
    expect(output).toContain('permissions.allow');
    expect(output).toContain('value differs');
    // The redaction contract: a token-shaped value never reaches the surface.
    expect(output).not.toContain('sk-ant-secret-value');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('renders an MCP inventory with per-Profile cells', async () => {
    const mcp: McpInventoryDiff = {
      profileA: 'coding',
      profileB: 'study',
      rows: [
        { name: 'context7', inA: true, inB: true, transportA: 'http', transportB: 'http', connectionA: 'connected', connectionB: 'connected' },
        { name: 'playwright', inA: true, inB: false, transportA: 'stdio', transportB: null, connectionA: 'failed', connectionB: null },
        { name: 'obsidian', inA: false, inB: true, transportA: null, transportB: 'sse', connectionA: null, connectionB: 'connected' },
      ],
    };
    const { instance, stdout } = renderDiff({ category: 'mcp', diff: mcp });
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('context7');
    expect(output).toContain('playwright');
    expect(output).toContain('obsidian');
    expect(output).toContain('http·connected');
    expect(output).toContain('stdio·failed');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('renders a Copied Skills hash-tree diff vs own source', async () => {
    const skills: CopiedSkillsDiff = {
      profileA: 'coding',
      profileB: 'study',
      skills: [
        {
          name: 'grilling',
          inA: true,
          inB: true,
          aVsSource: {
            name: 'grilling',
            mode: 'copy',
            sourceKind: 'local',
            sourceDescription: '~/src/grilling',
            entries: [
              { relPath: 'questions.md', verdict: 'changed' },
              { relPath: 'examples.md', verdict: 'new-at-source' },
              { relPath: 'old.md', verdict: 'gone-at-source' },
            ],
            changedCount: 1,
            newAtSourceCount: 1,
            goneAtSourceCount: 1,
            sourceMissing: false,
          },
          aDisabledReason: null,
          bVsSource: null,
          bDisabledReason: null,
        },
      ],
    };
    const { instance, stdout } = renderDiff({ category: 'skills', diff: skills });
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('grilling');
    expect(output).toContain('questions.md');
    expect(output).toContain('examples.md');
    expect(output).toContain('old.md');
    expect(output).toContain('~/src/grilling');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('renders a launch-config key table with values and sensitive warnings', async () => {
    const launch: LaunchConfigDiffEntry[] = [
      { key: 'mcpMode', verdict: 'same', valueA: 'none', valueB: 'none', sensitive: false },
      { key: 'skipPermissions', verdict: 'changed', valueA: false, valueB: true, sensitive: true },
    ];
    const { instance, stdout } = renderDiff({ category: 'launch-config', diff: launch });
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('mcpMode: none');
    expect(output).toContain('skipPermissions: false → true');
    expect(output).toContain('security-sensitive');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
