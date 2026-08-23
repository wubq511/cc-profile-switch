import { describe, expect, it } from 'vitest';

import { resolveBannerOptions } from '../src/tui/workbench/welcome-banner/render';

const baseDeps = {
  isTTY: true,
  columns: 80,
  platform: 'darwin',
  env: {},
  chalkLevel: 2 as const,
  configEnabled: true,
};

describe('resolveBannerOptions', () => {
  it('returns null when not a TTY', () => {
    const result = resolveBannerOptions({ ...baseDeps, isTTY: false });
    expect(result).toBeNull();
  });

  it('returns null when config disables the banner', () => {
    const result = resolveBannerOptions({ ...baseDeps, configEnabled: false });
    expect(result).toBeNull();
  });

  it('forces plain tier when CI is set', () => {
    const result = resolveBannerOptions({ ...baseDeps, env: { CI: 'true' } });
    expect(result).not.toBeNull();
    expect(result?.widthTier).toBe('plain');
    expect(result?.charset).toBe('unicode');
    expect(result?.colorLevel).toBe('full');
  });

  it.each([
    { platform: 'darwin', env: {}, expected: 'unicode' },
    { platform: 'linux', env: {}, expected: 'unicode' },
    { platform: 'darwin', env: { LC_ALL: 'en_US.UTF-8' }, expected: 'unicode' },
    { platform: 'linux', env: { LANG: 'C.UTF-8' }, expected: 'unicode' },
    { platform: 'darwin', env: { LC_CTYPE: 'ISO-8859-1' }, expected: 'ascii' },
    { platform: 'linux', env: { LANG: 'en_US' }, expected: 'ascii' },
  ] as const)('resolves $platform charset with $env', ({ platform, env, expected }) => {
    const result = resolveBannerOptions({ ...baseDeps, platform, env });
    expect(result?.charset).toBe(expected);
  });

  it.each([
    { env: { WT_SESSION: '1' }, expected: 'unicode' },
    { env: { TERM_PROGRAM: ' mintty' }, expected: 'unicode' },
    { env: { TERM: 'xterm-256color' }, expected: 'unicode' },
    { env: { TERM: 'cygwin' }, expected: 'unicode' },
    { env: {}, expected: 'ascii' },
    { env: { TERM: 'dumb' }, expected: 'ascii' },
  ] as const)('resolves win32 charset for $env', ({ env, expected }) => {
    const result = resolveBannerOptions({ ...baseDeps, platform: 'win32', env });
    expect(result?.charset).toBe(expected);
  });

  it.each([
    { columns: 80, expected: 'full' },
    { columns: 36, expected: 'full' },
    { columns: 35, expected: 'compact' },
    { columns: 18, expected: 'compact' },
    { columns: 17, expected: 'plain' },
    { columns: 1, expected: 'plain' },
  ] as const)('selects $expected tier for $columns columns', ({ columns, expected }) => {
    const result = resolveBannerOptions({ ...baseDeps, columns });
    expect(result?.widthTier).toBe(expected);
  });

  it('CI overrides wide columns to plain', () => {
    const result = resolveBannerOptions({
      ...baseDeps,
      columns: 80,
      env: { CI: '1' },
    });
    expect(result?.widthTier).toBe('plain');
  });

  it.each([
    { env: { NO_COLOR: '1' }, chalkLevel: 2 as const, expected: 'none' },
    { env: {}, chalkLevel: 0 as const, expected: 'none' },
    { env: {}, chalkLevel: 1 as const, expected: 'basic' },
    { env: {}, chalkLevel: 2 as const, expected: 'full' },
    { env: {}, chalkLevel: 3 as const, expected: 'full' },
  ] as const)('maps color constraints to $expected', ({ env, chalkLevel, expected }) => {
    const result = resolveBannerOptions({ ...baseDeps, env, chalkLevel });
    expect(result?.colorLevel).toBe(expected);
  });

  it('empty NO_COLOR does not disable color', () => {
    const result = resolveBannerOptions({
      ...baseDeps,
      env: { NO_COLOR: '' },
      chalkLevel: 2,
    });
    expect(result?.colorLevel).toBe('full');
  });
});
