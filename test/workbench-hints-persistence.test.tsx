import { Readable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { Box, Text, render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import {
  loadAppStateSync,
  recordHintUseSync,
  recordRecentProjectDir,
} from '../src/core/app-state';
import {
  HINT_RETIRE_AFTER,
  HintsProvider,
  useHints,
  type HintsApi,
} from '../src/tui/workbench/guidance';
import { FakeTtyStdout, stripAnsi } from './render-helpers';

const fixedClock = () => new Date('2026-01-02T03:04:05.000Z');

// Hint retirement is permanent (issue #76): use counts persist in state.json
// (hintUsage, additive optional — spec §13.4), so a hint retires for good once
// its key reaches HINT_RETIRE_AFTER across sessions.
describe('hint usage persistence in state.json (issue #76)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-hint-state-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome);
    return appHome;
  }

  it('increments use counts across sessions and reaches the retirement threshold at exactly 3', async () => {
    const appHome = await makeAppHome();

    // Session 1: two uses, then "reload" from disk.
    recordHintUseSync(appHome, 'l');
    recordHintUseSync(appHome, 'l');
    expect(loadAppStateSync(appHome).hintUsage).toEqual({ l: 2 });

    // Session 2: the third use lands exactly on HINT_RETIRE_AFTER.
    recordHintUseSync(appHome, 'l');
    const state = loadAppStateSync(appHome);
    expect(state.hintUsage).toEqual({ l: 3 });
    expect(state.hintUsage?.l).toBe(HINT_RETIRE_AFTER);
  });

  it('loads a pre-#76 state.json (no hintUsage) and starts counting additively', async () => {
    const appHome = await makeAppHome();
    const { statePath } = getAppHomePaths(appHome);
    await fs.writeJson(statePath, {
      version: 1,
      recentProjectDirs: [{ path: '/project/a', lastUsedAt: '2026-01-01T00:00:00.000Z' }],
    });

    const loaded = loadAppStateSync(appHome);
    expect(loaded.hintUsage).toBeUndefined();

    recordHintUseSync(appHome, 'e');
    const next = loadAppStateSync(appHome);
    expect(next.hintUsage).toEqual({ e: 1 });
    expect(next.recentProjectDirs).toEqual([
      { path: '/project/a', lastUsedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('recording a recent project dir preserves hint use counts', async () => {
    const appHome = await makeAppHome();
    recordHintUseSync(appHome, 'l');

    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });

    const state = loadAppStateSync(appHome);
    expect(state.hintUsage).toEqual({ l: 1 });
    expect(state.recentProjectDirs[0]?.path).toBe('/project/alpha');
  });

  it('writes hint usage atomically (no .tmp residue)', async () => {
    const appHome = await makeAppHome();
    recordHintUseSync(appHome, 'l');

    const files = await fs.readdir(appHome);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('HintsProvider persistence wiring (issue #76)', () => {
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

  async function renderProvider(props: {
    initialUsage?: Record<string, number>;
    onMarkUsed?: (key: string) => void;
  }): Promise<{ instance: ReturnType<typeof render>; stdout: FakeTtyStdout }> {
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(HintsProvider, props, React.createElement(HintProbe)),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new Readable({ read() {} }) as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        // Snapshot-free provider probes still need live frames on CI (CI=true
        // would otherwise defer every render to unmount).
        interactive: true,
      },
    );
    await instance.waitUntilRenderFlush();
    return { instance, stdout };
  }

  it('a hint retired in a previous session stays retired after reload (seeded counts)', async () => {
    const { instance, stdout } = await renderProvider({ initialUsage: { l: 3 } });

    expect(stripAnsi(stdout.output)).toContain('live:b');
    expect(hintApi!.isRetired('l')).toBe(true);
    expect(hintApi!.liveKeys(['l', 'b'])).toEqual(['b']);
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('retires at exactly the third use across sessions and reports the use for persistence', async () => {
    const persisted: string[] = [];
    const { instance, stdout } = await renderProvider({
      initialUsage: { l: 2 },
      onMarkUsed: (key) => {
        persisted.push(key);
      },
    });

    // Two prior uses: the hint is still live.
    expect(stripAnsi(stdout.output)).toContain('live:lb');

    hintApi!.markUsed('l');
    // Ink throttles renders, so a single waitUntilRenderFlush can resolve on a
    // pre-update frame — poll until the retirement actually lands.
    const deadline = Date.now() + 2000;
    while (!hintApi!.isRetired('l') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(hintApi!.isRetired('l')).toBe(true);
    expect(hintApi!.liveKeys(['l', 'b'])).toEqual(['b']);
    expect(persisted).toEqual(['l']);
    instance.unmount();
    await instance.waitUntilExit();
  });

  it('without persistence props it degrades to session-only tracking', async () => {
    const { instance } = await renderProvider({});

    for (let i = 0; i < HINT_RETIRE_AFTER; i++) {
      hintApi!.markUsed('l');
      await instance.waitUntilRenderFlush();
    }

    expect(hintApi!.isRetired('l')).toBe(true);
    instance.unmount();
    await instance.waitUntilExit();
  });
});
