import { Readable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../src/tui/workbench/i18n/react';
import { InstallWizard, type InstallWizardCallbacks } from '../src/tui/workbench/skills/install-wizard';
import type { CatalogedLocalSkillSource } from '../src/core/skills-install';
import { FakeTtyStdout, flatten, stripAnsi } from './render-helpers';

/**
 * Component tests for the install wizard's source-list step (issue #98,
 * F3/V4): the list is virtualized with a follow-cursor window, the
 * manual-entry row is pinned below the window, and every row is a single
 * right-truncated terminal line with a visible `▸` cursor.
 */

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

function makeSources(count: number): CatalogedLocalSkillSource[] {
  return Array.from({ length: count }, (_, i) => ({
    sourcePath: `/home/.cc-profile-switch/profiles/profile-${String(i % 3).padStart(3, '0')}/claude-home/skills/skill-${String(i + 1).padStart(3, '0')}`,
    readable: true,
    skillMdPresent: true,
    suggestedName: `skill-${String(i + 1).padStart(3, '0')}`,
    originProfile: `profile-${String(i % 3).padStart(3, '0')}`,
  }));
}

function makeCallbacks(sources: CatalogedLocalSkillSource[]): InstallWizardCallbacks {
  return {
    onListLocalSources: async () => sources,
    onResolveSource: vi.fn(),
    onComputePreview: vi.fn(),
    onInstall: vi.fn(),
    onAcquireRemote: vi.fn(),
    onInstallRemote: vi.fn(),
    onClose: vi.fn(),
    onInstalled: vi.fn(),
  } as unknown as InstallWizardCallbacks;
}

async function waitForOutput(stdout: FakeTtyStdout, needle: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = flatten(stripAnsi(stdout.output));
    if (current.includes(needle)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return flatten(stripAnsi(stdout.output));
}

async function renderWizard(sources: CatalogedLocalSkillSource[], height = 24, width = 80) {
  const stdout = new FakeTtyStdout();
  stdout.columns = width;
  stdout.rows = height;
  const stdin = new FakeTtyStdin();
  const instance = render(
    React.createElement(
      I18nProvider,
      { initialLocale: 'en' as const },
      React.createElement(InstallWizard, {
        profileName: 'coding',
        profileRootPath: '/tmp/coding',
        callbacks: makeCallbacks(sources),
        width,
        height,
      }),
    ),
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

/** From the kind picker, Enter confirms Local and lands on the source list. */
async function enterSourceList(stdin: FakeTtyStdin, stdout: FakeTtyStdout): Promise<void> {
  stdin.press('\r');
  await waitForOutput(stdout, 'Local Skill Source');
}

describe('Install wizard source list (issue #98 F3/V4)', () => {
  it('pins the manual-entry row and shows an N/M indicator without scrolling', async () => {
    const { instance, stdout, stdin } = await renderWizard(makeSources(50));
    try {
      await enterSourceList(stdin, stdout);
      const out = await waitForOutput(stdout, '1/51');
      // The manual row is reachable from the first frame even with 50 sources…
      expect(out).toContain('Enter path manually…');
      // …and the cursor row carries the standard ▸ marker.
      expect(out).toContain('▸ skill-001');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('follow-cursor window scrolls while the manual row stays pinned', async () => {
    const { instance, stdout, stdin } = await renderWizard(makeSources(50));
    try {
      await enterSourceList(stdin, stdout);
      await waitForOutput(stdout, '1/51');

      stdout.snapshot();
      stdin.press('\x1b[B'.repeat(30));
      const out = await waitForOutput(stdout, '31/51');
      expect(out).toContain('▸ skill-031');
      // Window scrolled: the first source is out of the fresh frames…
      expect(out).not.toContain('skill-001 ');
      // …but manual entry is still one keypress away.
      expect(out).toContain('Enter path manually…');

      stdin.press('\x1b[B'.repeat(20));
      const tail = await waitForOutput(stdout, '51/51');
      expect(tail).toContain('▸ Enter path manually…');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('right-truncates long source names to one terminal row', async () => {
    const sources = makeSources(3);
    sources[0] = { ...sources[0], suggestedName: `skill-${'x'.repeat(100)}` };
    const { instance, stdout, stdin } = await renderWizard(sources);
    try {
      await enterSourceList(stdin, stdout);
      const out = await waitForOutput(stdout, '1/4');
      // The name segment is JS-capped with an ellipsis so it can never eat
      // the whole row; the path segment stays visible and right-truncates
      // at the viewport edge.
      expect(out).toContain(`skill-${'x'.repeat(21)}…`);
      expect(out).toContain('/home/.cc-profile-switch/prof');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('paints every windowed row — no blank or overwritten rows (issue #98 follow-up)', async () => {
    // 950 sources at 80x24: the window mounts in one async burst; rows must
    // land one per terminal line, contiguously (regression: an overflowing
    // column under the fixed-height root made yoga hand freshly-mounted rows
    // a zero-height layout — one row per frame painted blank).
    const { instance, stdout, stdin } = await renderWizard(makeSources(950), 24, 80);
    try {
      await enterSourceList(stdin, stdout);
      await waitForOutput(stdout, '1/951');
      await instance.waitUntilRenderFlush();
      // eslint-disable-next-line no-control-regex
      const segments = stdout.output.split(/(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G/);
      const last = segments[segments.length - 1];
      const frame = stripAnsi(last);
      const windowSize = 24 - 7;
      for (let n = 1; n <= windowSize; n++) {
        expect(frame).toContain(`skill-${String(n).padStart(3, '0')}`);
      }
      expect(frame).toContain('Enter path manually…');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });

  it('empty catalog renders the empty note plus the manual row', async () => {
    const { instance, stdout, stdin } = await renderWizard([]);
    try {
      await enterSourceList(stdin, stdout);
      const out = await waitForOutput(stdout, '1/1');
      expect(out).toContain('No discovered local sources');
      expect(out).toContain('▸ Enter path manually…');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  });
});
