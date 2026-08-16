import React from 'react';
import { describe, expect, it } from 'vitest';

import { ResourcePreview } from '../src/tui/workbench/resource-preview';
import type { EditSession } from '../src/core/edit-session/types';
import { makeProfile, renderWithLocale, stripAnsi } from './render-helpers';

/**
 * Issue #98, V15: with a missing-file edit session the preview rendered the
 * "file deleted or renamed" title twice, one line apart — once on the badge
 * row and again on the missing-overlay's own title row. The overlay carries
 * the title (plus the hint and last-known content); the badge row yields.
 */
describe('ResourcePreview missing session (issue #98, V15)', () => {
  it('renders the missing title exactly once', async () => {
    const session: EditSession = {
      phase: 'missing',
      filePath: '/tmp/profiles/coding/claude-home/CLAUDE.md',
      changeCount: 0,
      lastEvent: null,
      lastContent: '# profile-001 Profile\n\nlast known body',
      lastUpdated: null,
      openFailedReason: null,
    };
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourcePreview, {
        profile: makeProfile(),
        category: 'user-memory',
        resourceName: 'CLAUDE.md',
        content: null,
        scrollOffset: 0,
        session,
        width: 60,
        height: 24,
        editFallback: { systemEditor: () => {}, retry: () => {}, dismiss: () => {} },
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    const title = 'File deleted or renamed';
    const occurrences = output.split(title).length - 1;
    expect(occurrences).toBe(1);
    // The overlay's hint and last-known content still render.
    expect(output).toContain('last known body');
    instance.unmount();
  });

  it('still shows the watching badge for an active session', async () => {
    const session: EditSession = {
      phase: 'watching',
      filePath: '/tmp/profiles/coding/claude-home/CLAUDE.md',
      changeCount: 2,
      lastEvent: null,
      lastContent: null,
      lastUpdated: null,
      openFailedReason: null,
    };
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourcePreview, {
        profile: makeProfile(),
        category: 'user-memory',
        resourceName: 'CLAUDE.md',
        content: 'body text',
        scrollOffset: 0,
        session,
        width: 60,
        height: 24,
        editFallback: { systemEditor: () => {}, retry: () => {}, dismiss: () => {} },
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('body text');
    instance.unmount();
  });
});
