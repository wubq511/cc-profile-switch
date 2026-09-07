import React from 'react';
import { describe, expect, it } from 'vitest';

import { DirectoryScreen } from '../src/tui/workbench/launch/directory-screen';
import type { LaunchState } from '../src/tui/workbench/lifecycle';
import { renderWithLocale, stripAnsi } from './render-helpers';

/**
 * Issue #98, V14: long paths used to wrap with no indent or ellipsis, so the
 * continuation sat at column 0 looking like a new entry. Paths now render on
 * one row with leading-ellipsis truncation (`…/Projects/cc-profile-switch`).
 */
const LONG_DIR = '/Users/someone/Documents/Projects/very/deeply/nested/project-directory';
const LONG_RECENT = '/Users/someone/another/extremely/long/path/to/a/recent/launch/directory';

function makeLaunch(): LaunchState {
  return {
    phase: 'dir-screen',
    dir: LONG_DIR,
    dirInput: LONG_DIR,
    recentDirs: [{ path: LONG_RECENT, lastUsedAt: '2026-08-01T00:00:00Z' }],
    recentIndex: 0,
    dryRunPlan: null,
    validationFindings: [],
    exitCode: null,
  };
}

describe('DirectoryScreen long paths (issue #98, V14)', () => {
  it('keeps the current dir, recents, and the path input on single truncated rows', async () => {
    const { instance, stdout } = renderWithLocale(
      React.createElement(DirectoryScreen, { launch: makeLaunch(), width: 50, height: 20 }),
    );
    await instance.waitUntilRenderFlush();
    const rows = stripAnsi(stdout.output).split('\n');

    // No row starts flush at column 0 with a path tail (the wrap signature:
    // a bare path fragment like `nested/project-directory` on its own row).
    expect(rows.some((r) => r.trimStart() === 'nested/project-directory')).toBe(false);
    expect(rows.some((r) => r.trimStart().startsWith('/directory'))).toBe(false);
    // Leading-ellipsis truncation keeps the informative tail of each path.
    expect(rows.some((r) => r.includes('…') && r.includes('project-directory'))).toBe(true);
    expect(rows.some((r) => r.includes('…') && r.includes('directory'))).toBe(true);
    instance.unmount();
  });

  it('renders short paths in full without ellipsis', async () => {
    const launch = {
      ...makeLaunch(),
      dir: '/tmp/proj',
      dirInput: '/tmp/proj',
      recentDirs: [{ path: '/tmp/rec', lastUsedAt: '2026-08-01T00:00:00Z' }],
    } as LaunchState;
    const { instance, stdout } = renderWithLocale(
      React.createElement(DirectoryScreen, { launch, width: 50, height: 20 }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('/tmp/proj');
    expect(output).toContain('/tmp/rec');
    expect(output).not.toContain('…');
    instance.unmount();
  });
});
