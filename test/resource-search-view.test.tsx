import React from 'react';
import { describe, expect, it } from 'vitest';

import { ResourceSearchView } from '../src/tui/workbench/resource-search-view';
import { I18nProvider } from '../src/tui/workbench/i18n/react';
import type { SearchResult } from '../src/core/resource/types';
import { renderWithLocale, stripAnsi } from './render-helpers';

/**
 * Issue #98, V13: result rows used to take three rows per hit (label row +
 * match row + margin), so a realistic result list squeezed until the label
 * overwrote the match text mid-row (`agent-01rofile-001`). The view now
 * renders one row per hit with fixed column slots — item ref, label, match
 * text — each truncated inside its slot, through a clipped follow-cursor
 * window.
 */
function makeHit(index: number, profileName?: string): SearchResult {
  const pad = String(index).padStart(2, '0');
  return {
    profileName: profileName ?? `profile-${pad}`,
    category: 'agents',
    itemName: `agent-${pad}`,
    relativePath: `agents/agent-${pad}.md`,
    matchLine: `# agent-${pad} handles the request`,
    lineNumber: index,
  };
}

function renderSearch(
  results: SearchResult[],
  selectedIndex: number,
  width = 54,
  height = 24,
  locale: 'en' | 'zh' = 'en',
) {
  return renderWithLocale(
    React.createElement(ResourceSearchView, {
      query: 'agent',
      results,
      selectedIndex,
      width,
      height,
    }),
    locale,
  );
}

describe('ResourceSearchView rows (issue #98, V13)', () => {
  it('renders one row per hit with distinct slots at compact width', async () => {
    const hits = Array.from({ length: 25 }, (_, i) => makeHit(i + 1));
    const { instance, stdout } = renderSearch(hits, 0);
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);

    // Ref and label survive as separated segments on the cursor row.
    expect(output).toContain('▸ agent-01:1 · Agent match in profile-01 · ');
    // The pre-fix fusion signature never appears.
    expect(output).not.toMatch(/agent-01rofile/);
    // One row per hit: the window clips at the viewport instead of squeezing
    // three-row hit blocks into it, so the tail is simply not rendered yet.
    expect(output).not.toContain('agent-25');
    instance.unmount();
  });

  it('keeps the full match text when the width allows it', async () => {
    const hits = Array.from({ length: 3 }, (_, i) => makeHit(i + 1));
    const { instance, stdout } = renderSearch(hits, 0, 100, 24);
    await instance.waitUntilRenderFlush();
    // The label slot pads to its fixed width — that padding IS the column
    // alignment — so assert the segments, not the exact spacing.
    expect(stripAnsi(stdout.output)).toMatch(
      /▸ agent-01:1 · Agent match in profile-01\s+· # agent-01 handles the request/,
    );
    instance.unmount();
  });

  it('truncates a long profile name inside its slot with …', async () => {
    const hits = [makeHit(1, 'a-very-long-profile-name-0123456789')];
    const { instance, stdout } = renderSearch(hits, 0, 100, 24);
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    // The label slot truncates at 30 cells (29 + …)…
    expect(output).toContain('Agent match in a-very-long-pr…');
    // …and the match text still gets the remainder of the row.
    expect(output).toContain('# agent-01 handles the request');
    instance.unmount();
  });

  it('follows the cursor: re-rendering at the last hit shows the tail row', async () => {
    const hits = Array.from({ length: 25 }, (_, i) => makeHit(i + 1));
    const { instance, stdout } = renderSearch(hits, 0);
    await instance.waitUntilRenderFlush();
    stdout.snapshot();
    // renderWithLocale wraps the element in the I18nProvider, so rerender
    // must re-supply the same wrapper with the moved cursor.
    instance.rerender(
      React.createElement(
        I18nProvider,
        { initialLocale: 'en' as const },
        React.createElement(ResourceSearchView, {
          query: 'agent',
          results: hits,
          selectedIndex: 24,
          width: 54,
          height: 24,
        }),
      ),
    );
    await instance.waitUntilRenderFlush();
    expect(stripAnsi(stdout.output)).toContain('▸ agent-25:25');
    instance.unmount();
  });

  it('keeps the label slot intact in zh at compact width', async () => {
    const hits = Array.from({ length: 25 }, (_, i) => makeHit(i + 1));
    const { instance, stdout } = renderSearch(hits, 0, 54, 24, 'zh');
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    expect(output).toMatch(/▸ agent-01:1 · 在 profile-01 中代理匹配\s+· /);
    instance.unmount();
  });
});
