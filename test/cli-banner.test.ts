import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCliBanner } from '../src/cli';

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

// eslint-disable-next-line no-control-regex
const ANSI_ESC = /\x1b\[/;

describe('buildCliBanner', () => {
  let originalLevel: number;

  beforeEach(() => {
    originalLevel = chalk.level;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  const baseDeps = {
    isTTY: true,
    columns: 80,
    platform: 'darwin',
    env: {},
    chalkLevel: 2 as const,
    configEnabled: true,
  };

  it('returns a non-empty banner in a TTY with the banner enabled', () => {
    chalk.level = 3;
    const banner = buildCliBanner(baseDeps);
    expect(banner.length).toBeGreaterThan(0);
    // Full tier (80 cols) carries the letter-spaced caption.
    expect(stripAnsi(banner)).toContain('C C - P r o f i l e - S w i t c h');
  });

  it('returns an empty string when not a TTY', () => {
    chalk.level = 2;
    const banner = buildCliBanner({ ...baseDeps, isTTY: false });
    expect(banner).toBe('');
  });

  it('returns an empty string when the banner is disabled', () => {
    chalk.level = 2;
    const banner = buildCliBanner({ ...baseDeps, configEnabled: false });
    expect(banner).toBe('');
  });

  it('returns plain tier in CI', () => {
    chalk.level = 3;
    const banner = buildCliBanner({ ...baseDeps, env: { CI: 'true' } });
    expect(stripAnsi(banner)).toContain('ccps');
    expect(stripAnsi(banner)).toContain('CC-Profile-Switch');
    expect(banner.split('\n')).toHaveLength(1);
  });

  it('suppresses color codes when color level is none', () => {
    chalk.level = 0;
    const banner = buildCliBanner({ ...baseDeps, chalkLevel: 0 });
    expect(banner.length).toBeGreaterThan(0);
    expect(banner).not.toMatch(ANSI_ESC);
  });
});
