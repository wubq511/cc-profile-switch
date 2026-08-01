import { Readable, Writable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';

import { WorkbenchApp } from '../src/tui/workbench/app';
import { isBelowMinimum } from '../src/tui/workbench/resize-guard';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';

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

const emptyData: WorkbenchData = {
  profiles: [],
  defaultProfile: undefined,
  customTemplates: [],
};

const sampleData: WorkbenchData = {
  profiles: [
    {
      name: 'coding',
      description: 'Daily coding profile',
      isDefault: true,
      isLastUsed: true,
      status: 'valid',
      resourceCounts: { userMemory: 1, autoMemory: 5, skills: 3, agents: 2, mcp: 1, settings: 1, launchConfig: 1 },
      resourceDetails: {
        userMemory: { kind: 'user-memory', name: 'CLAUDE.md', relativePath: 'claude-home/CLAUDE.md', exists: true, lineCount: 12, excerpt: 'Prefer explicit answers.' },
        agents: [
          { kind: 'agents', name: 'explore', relativePath: 'claude-home/agents/explore.md', exists: true, frontmatter: { name: 'explore', description: 'read-only exploration' }, frontmatterParseError: null, bodyExcerpt: 'Scan the codebase.' },
          { kind: 'agents', name: 'coder', relativePath: 'claude-home/agents/coder.md', exists: true, frontmatter: { name: 'coder', description: 'general engineering' }, frontmatterParseError: null, bodyExcerpt: 'Write code.' },
        ],
        autoMemory: ['2026-07-01.md', '2026-07-02.md', '2026-07-03.md', '2026-07-04.md', '2026-07-05.md'],
        skills: ['pdf', 'review', 'commit'],
        settings: ['model'],
      },
      mcpServers: ['filesystem'],
      validation: null,
    },
    {
      name: 'study',
      description: 'Research and study',
      isDefault: false,
      isLastUsed: false,
      status: 'valid',
      resourceCounts: { userMemory: 1, autoMemory: 2, skills: 1, agents: 0, mcp: 0, settings: 1, launchConfig: 1 },
      resourceDetails: {
        userMemory: { kind: 'user-memory', name: 'CLAUDE.md', relativePath: 'claude-home/CLAUDE.md', exists: true, lineCount: 8, excerpt: 'Structured learning.' },
        agents: [],
        autoMemory: ['2026-07-01.md', '2026-07-02.md'],
        skills: ['pdf'],
        settings: ['model'],
      },
      mcpServers: [],
      validation: null,
    },
  ],
  defaultProfile: 'coding',
  customTemplates: [],
};

describe('Workbench render', () => {
  it('renders without crashing with empty profiles', async () => {
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(WorkbenchApp, { data: emptyData, initialLocale: 'en', headless: true }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: dummyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    expect(stdout.output.length).toBeGreaterThan(0);
  });

  it('renders without crashing with sample profiles', async () => {
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', headless: true }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: dummyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    expect(stdout.output.length).toBeGreaterThan(0);
  });

  it('renders in Chinese locale', async () => {
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'zh', headless: true }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: dummyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('配置');
  });

  it('renders lifecycle action hints in sidebar', async () => {
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', headless: true, skipWelcome: true }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: dummyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    // Read after unmount so the final frame is flushed to the fake stdout
    // (matches the other render tests in this file).
    const output = stripAnsi(stdout.output);
    expect(output).toContain('[n]');
    expect(output).toContain('[c]');
    expect(output).toContain('[r]');
    expect(output).toContain('[d]');
    expect(output).toContain('[v]');
    expect(output).toContain('[b]');
    expect(output).toContain('[s]');
    expect(output).toContain('[x]');
    // Skill install entry point (issue #64, spec §7.2)
    expect(output).toContain('[a]');
  });
});

describe('resize guard', () => {
  it('detects below-minimum terminal sizes', () => {
    expect(isBelowMinimum(79, 24)).toBe(true);
    expect(isBelowMinimum(80, 23)).toBe(true);
    expect(isBelowMinimum(79, 23)).toBe(true);
  });

  it('accepts minimum terminal size', () => {
    expect(isBelowMinimum(80, 24)).toBe(false);
  });

  it('accepts above-minimum terminal sizes', () => {
    expect(isBelowMinimum(120, 30)).toBe(false);
    expect(isBelowMinimum(200, 50)).toBe(false);
  });
});

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}
