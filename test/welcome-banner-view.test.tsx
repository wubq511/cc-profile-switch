import React from 'react';
import { render } from 'ink';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WelcomeBanner } from '../src/tui/workbench/welcome-banner/WelcomeBanner';
import { renderWelcomeBanner } from '../src/tui/workbench/welcome-banner/render';
import { FakeTtyStdout, stripAnsi } from './render-helpers';

async function renderFrame(element: React.ReactElement): Promise<string> {
  const stdout = new FakeTtyStdout();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  await instance.waitUntilRenderFlush();
  const out = stdout.output;
  instance.unmount();
  return out;
}

describe('WelcomeBanner Ink component', () => {
  let originalLevel: number;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 0;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it('renders nothing when config disables the banner', async () => {
    const out = await renderFrame(
      React.createElement(WelcomeBanner, { columns: 80, configEnabled: false }),
    );
    expect(out).toBe('');
  });

  it('advances through animation and lands on the static frame', async () => {
    const tickCallbacks: Array<() => void> = [];
    const cancelSpies: Array<ReturnType<typeof vi.fn>> = [];
    const tickIntervals: number[] = [];
    const tick = (cb: () => void, ms: number) => {
      tickCallbacks.push(cb);
      tickIntervals.push(ms);
      const spy = vi.fn();
      cancelSpies.push(spy);
      return spy;
    };

    const stdout = new FakeTtyStdout();
    stdout.columns = 80;
    const instance = render(
      React.createElement(WelcomeBanner, {
        columns: 80,
        configEnabled: true,
        tick,
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      },
    );
    await instance.waitUntilRenderFlush();
    const initialFrame = stdout.output;
    // Full tier (80 cols) carries the letter-spaced caption.
    expect(stripAnsi(initialFrame)).toContain('C C - P r o f i l e - S w i t c h');

    // Advance the sweep until the component stops scheduling ticks: the frame
    // after the last step is the static banner (frame count stays unpinned,
    // only the cadence is).
    expect(tickIntervals[0]).toBe(90);
    for (let guard = 0; guard < 30; guard++) {
      const scheduled = tickCallbacks.length;
      const cb = tickCallbacks[scheduled - 1];
      expect(cb).toBeDefined();
      cb();
      await instance.waitUntilRenderFlush();
      if (tickCallbacks.length === scheduled) break; // no new interval → final frame
    }

    const staticBanner = renderWelcomeBanner({
      charset: 'unicode',
      widthTier: 'full',
      colorLevel: 'none',
    });
    // Ink trims trailing whitespace per line; normalize both sides for comparison.
    const normalize = (text: string): string[] =>
      text
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => line.trimEnd());
    expect(normalize(stripAnsi(stdout.output))).toEqual(normalize(stripAnsi(staticBanner)));

    instance.unmount();
    // The last registered interval must have been cancelled.
    const lastCancel = cancelSpies[cancelSpies.length - 1];
    expect(lastCancel).toHaveBeenCalled();
  });

  it('plain tier renders statically and does not start an interval', async () => {
    const tick = vi.fn();
    const stdout = new FakeTtyStdout();
    stdout.columns = 17;
    const instance = render(
      React.createElement(WelcomeBanner, {
        columns: 17,
        configEnabled: true,
        tick,
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      },
    );
    await instance.waitUntilRenderFlush();
    expect(tick).not.toHaveBeenCalled();
    expect(stripAnsi(stdout.output)).toContain('ccps');
    expect(stripAnsi(stdout.output)).toContain('CC-Profile-Switch');
    instance.unmount();
  });
});
