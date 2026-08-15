import { Readable, Writable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import { makeProfile, stripAnsi } from './render-helpers';

class FakeTtyStdout extends Writable {
  public readonly isTTY = true;
  public columns = 140;
  public rows = 40;
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

/** 50 skills + a 3-entry Auto Memory category: the exact sidebar load whose
 *  wide-terminal frames fused rows in the issue #97 audit (issue #98, V17). */
const wideTreeData: WorkbenchData = {
  profiles: [
    makeProfile({
      name: 'profile-001',
      description: 'Coding profile fixture 1.',
      resourceCounts: { userMemory: 1, autoMemory: 3, skills: 50, agents: 2, mcp: 1, settings: 1, launchConfig: 1, plugins: 0 },
      resourceDetails: {
        userMemory: { kind: 'user-memory', name: 'CLAUDE.md', relativePath: 'claude-home/CLAUDE.md', exists: true, lineCount: 12, excerpt: '' },
        agents: [],
        skills: Array.from({ length: 50 }, (_, i) => `skill-${String(i + 1).padStart(3, '0')}`),
        autoMemory: ['MEMORY.md', 'topic-01.md', 'topic-02.md'],
        settings: [],
        plugins: [],
      },
    }),
  ],
  defaultProfile: 'profile-001',
};

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

/** Visible lines of the most recently painted frame. The interactive standard
 *  renderer prefixes each repaint with eraseLines(N); splitting there and
 *  taking the last segment isolates the newest full-screen payload. On win32
 *  Ink instead clears fullscreen frames with clearTerminal (ink #969), so the
 *  boundary alternation includes that sequence — without it the whole
 *  accumulated output reads as one frame on Windows. */
function lastFrameLines(output: string): string[] {
  // eslint-disable-next-line no-control-regex
  const segments = output.split(/(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G|\x1b\[2J\x1b\[0f|\x1b\[2J\x1b\[3J\x1b\[H/);
  const last = segments[segments.length - 1];
  return last.split('\n').map((line) => stripAnsi(line));
}

async function renderWideApp(locale: 'en' | 'zh') {
  const stdout = new FakeTtyStdout();
  const stdin = new FakeTtyStdin();
  const instance = render(
    React.createElement(WorkbenchApp, {
      data: wideTreeData,
      initialLocale: locale,
      skipWelcome: true,
      searchContent: async () => [],
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

describe('wide sidebar layout (issue #98, V17)', () => {
  it('expanded tree rows stay bound: category keeps its count, items stay clean', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderWideApp('en');

    // Expand the Profile card — the first expanded frame used to drop the
    // Auto Memory category row and fuse its count onto the MEMORY.md item row.
    const baseline = stdout.output;
    stdin.press('\x1b[C');
    await waitForOutputSettled(stdout, baseline);

    // Issue #101: items live behind a second expansion level — move onto the
    // Auto Memory category (↓ past User Memory) and expand it with →.
    let step = stdout.output;
    stdin.press('\x1b[B');
    await waitForOutputSettled(stdout, step);
    step = stdout.output;
    stdin.press('\x1b[B');
    await waitForOutputSettled(stdout, step);
    step = stdout.output;
    stdin.press('\x1b[C');
    await waitForOutputSettled(stdout, step);

    const lines = lastFrameLines(stdout.output);
    const autoMemoryCategory = lines.filter((l) => l.includes('Auto Memory (3)'));
    expect(autoMemoryCategory).toHaveLength(1);
    const memoryItem = lines.find((l) => l.includes('MEMORY.md'));
    expect(memoryItem).toBeDefined();
    expect(memoryItem).not.toContain('(3)');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('hint block never fuses: launch and skills rows stay free of lifecycle fragments', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderWideApp('en');

    const baseline = stdout.output;
    stdin.press('\x1b[C');
    await waitForOutputSettled(stdout, baseline);

    const lines = lastFrameLines(stdout.output);
    const launchRow = lines.find((l) => l.includes('[l] Launch'));
    const skillsRow = lines.find((l) => l.includes('[a] Add skill'));
    // Both hint rows stay visible (the fixed-height block must clamp, not drop).
    expect(launchRow).toBeDefined();
    expect(skillsRow).toBeDefined();
    // The wrapping lifecycle hint above them must not bleed fragments into
    // either row (`…te  [E] Export` after `[L] Dir…`, `x] Remove` after
    // `[a] Add skill` in the audit frames).
    expect(launchRow).not.toContain('Export');
    expect(skillsRow).not.toContain('Remove');
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('zh locale: 自动记忆 category row keeps its count and the first item row survives', async () => {
    resetWelcomeSessionForTests();
    const { instance, stdout, stdin } = await renderWideApp('zh');

    const baseline = stdout.output;
    stdin.press('\x1b[C');
    await waitForOutputSettled(stdout, baseline);

    // Issue #101: second expansion level — ↓↓ onto 自动记忆, then → expands it.
    let step = stdout.output;
    stdin.press('\x1b[B');
    await waitForOutputSettled(stdout, step);
    step = stdout.output;
    stdin.press('\x1b[B');
    await waitForOutputSettled(stdout, step);
    step = stdout.output;
    stdin.press('\x1b[C');
    await waitForOutputSettled(stdout, step);

    const lines = lastFrameLines(stdout.output);
    expect(lines.filter((l) => l.includes('自动记忆 (3)'))).toHaveLength(1);
    const memoryItem = lines.find((l) => l.includes('MEMORY.md'));
    expect(memoryItem).toBeDefined();
    expect(memoryItem).not.toContain('(3)');
    instance.unmount();
    await instance.waitUntilExit();
  });
});
