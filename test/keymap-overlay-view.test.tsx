import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box } from 'ink';

import { KeymapOverlay } from '../src/tui/workbench/keymap';
import { renderWithLocale, stripAnsi } from './render-helpers';

/**
 * Issue #98, V5: at compact widths the help sheet's content is taller than
 * the viewport, and squeezing it tore group headings into the chip rows
 * above them (and dropped zh characters in the Concepts section). The sheet
 * now keeps its natural layout inside a clipped, scrollable viewport, so a
 * heading is always its own row and off-viewport content is clipped (never
 * overlapped) until scrolled to.
 */
describe('KeymapOverlay layout (issue #98, V5)', () => {
  it('keeps group headings on their own rows at 80 cols', async () => {
    const { instance, stdout } = renderWithLocale(
      React.createElement(
        Box,
        { width: 80, height: 24, flexDirection: 'column' },
        React.createElement(KeymapOverlay, { visible: true }),
      ),
    );
    await instance.waitUntilRenderFlush();
    const rows = stripAnsi(stdout.output).split('\n');
    // The squeeze used to fuse this heading with the chips above it
    // (` Pr[l] Launch profilerk[L] Dir…`); it must be a clean row.
    expect(rows.some((r) => r.trim() === 'Profile actions')).toBe(true);
    instance.unmount();
  });

  it('clips below-viewport content instead of overlapping it', async () => {
    const { instance, stdout } = renderWithLocale(
      React.createElement(
        Box,
        { width: 80, height: 24, flexDirection: 'column' },
        React.createElement(KeymapOverlay, { visible: true }),
      ),
    );
    await instance.waitUntilRenderFlush();
    const output = stripAnsi(stdout.output);
    // The Concepts tail sits below the initial 24-row viewport: hidden until
    // scrolled (the old sheet overlapped it onto the visible rows).
    expect(output).not.toContain('Claude-managed');
    expect(output).toContain('Keyboard Shortcuts');
    instance.unmount();
  });

  it('keeps zh group headings intact at 80 cols', async () => {
    const { instance, stdout } = renderWithLocale(
      React.createElement(
        Box,
        { width: 80, height: 24, flexDirection: 'column' },
        React.createElement(KeymapOverlay, { visible: true }),
      ),
      'zh',
    );
    await instance.waitUntilRenderFlush();
    const rows = stripAnsi(stdout.output).split('\n');
    expect(rows.some((r) => r.trim() === '配置操作')).toBe(true);
    expect(stripAnsi(stdout.output)).toContain('键盘快捷键');
    instance.unmount();
  });
});
