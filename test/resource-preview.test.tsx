import React from 'react';
import { describe, expect, it } from 'vitest';

import { ResourcePreview } from '../src/tui/workbench/resource-preview';
import { makeProfile, renderWithLocale, stripAnsi } from './render-helpers';

/**
 * Issue #87 acceptance (L3 finding): the preview content area was hardcoded
 * to a 12-line window, so on a tall terminal only the top strip of the file
 * rendered and the rest of the pane stayed empty. The content window must be
 * derived from the actual pane height (minus the surrounding chrome rows),
 * like the diff view already does.
 */
describe('ResourcePreview content height (issue #87)', () => {
  const noSession = undefined;
  const editFallback = { systemEditor: () => {}, retry: () => {}, dismiss: () => {} };

  it('renders beyond 12 lines when the pane is taller', async () => {
    const content = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n');
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourcePreview, {
        profile: makeProfile(),
        category: 'user-memory',
        resourceName: 'CLAUDE.md',
        content,
        scrollOffset: 0,
        session: noSession,
        width: 60,
        height: 30,
        editFallback,
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    // Past the old hardcoded 12-line window.
    expect(output).toContain('line-13');
    expect(output).toContain('line-20');
    instance.unmount();
  });

  it('still windows the content when the file is longer than the pane', async () => {
    const content = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join('\n');
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourcePreview, {
        profile: makeProfile(),
        category: 'user-memory',
        resourceName: 'CLAUDE.md',
        content,
        scrollOffset: 0,
        session: noSession,
        width: 60,
        height: 20,
        editFallback,
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('line-1');
    // 60 lines cannot all fit in a 20-row pane; the window cuts somewhere.
    expect(output).not.toContain('line-60');
    instance.unmount();
  });

  it('scrolls with the derived window', async () => {
    const content = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join('\n');
    const { instance, stdout } = renderWithLocale(
      React.createElement(ResourcePreview, {
        profile: makeProfile(),
        category: 'user-memory',
        resourceName: 'CLAUDE.md',
        content,
        scrollOffset: 59,
        session: noSession,
        width: 60,
        height: 20,
        editFallback,
      }),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('line-60');
    instance.unmount();
  });
});
