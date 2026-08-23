import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  renderWelcomeBanner,
  renderWelcomeBannerFrame,
  type BannerOptions,
} from '../src/tui/workbench/welcome-banner/render';
import { getBannerArt } from '../src/tui/workbench/welcome-banner/art';

// eslint-disable-next-line no-control-regex
const ANSI_ESC = /\x1b\[/;
const TRUE_COLOR = /38;2;/;
// eslint-disable-next-line no-control-regex
const BASIC_CYAN = /\x1b\[(1;)?36m/;
// eslint-disable-next-line no-control-regex
const BASIC_BLUE = /\x1b\[(1;)?34m/;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

describe('welcome banner renderer', () => {
  let originalLevel: number;

  beforeEach(() => {
    originalLevel = chalk.level;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  const charsets: Array<BannerOptions['charset']> = ['unicode', 'ascii'];
  const tiers: Array<BannerOptions['widthTier']> = ['full', 'compact', 'plain'];

  it.each(charsets.flatMap((charset) => tiers.map((widthTier) => ({ charset, widthTier }))))(
    'renders a shaped banner for $charset × $widthTier',
    ({ charset, widthTier }) => {
      const banner = renderWelcomeBanner({ charset, widthTier, colorLevel: 'none' });
      const lines = stripAnsi(banner).split('\n');

      if (widthTier === 'full') {
        expect(lines).toHaveLength(7); // 6 art rows + brand
        // Full-tier caption is letter-spaced (designed caption, not raw text).
        expect(lines[6]?.trim()).toBe('C C - P r o f i l e - S w i t c h');
        expect(lines[6]).toHaveLength(lines[0]?.length ?? 0);
      } else if (widthTier === 'compact') {
        expect(lines).toHaveLength(4); // 3 art rows + brand
        expect(lines[3]).toBe('CC-Profile-Switch');
      } else {
        expect(lines).toHaveLength(1);
      }
    },
  );

  it('full unicode contains block glyphs and spaced brand caption', () => {
    const banner = renderWelcomeBanner({
      charset: 'unicode',
      widthTier: 'full',
      colorLevel: 'none',
    });
    expect(stripAnsi(banner)).toContain('█');
    expect(stripAnsi(banner)).toContain('╗');
    expect(stripAnsi(banner)).toContain('C C - P r o f i l e - S w i t c h');
  });

  it('full ascii contains # glyphs and spaced brand caption', () => {
    const banner = renderWelcomeBanner({
      charset: 'ascii',
      widthTier: 'full',
      colorLevel: 'none',
    });
    expect(stripAnsi(banner)).toContain('#');
    expect(stripAnsi(banner)).toContain('C C - P r o f i l e - S w i t c h');
  });

  it.each(['unicode', 'ascii'] as const)('plain %s tier is a single text line', (charset) => {
    const banner = renderWelcomeBanner({ charset, widthTier: 'plain', colorLevel: 'none' });
    const lines = banner.split('\n');
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0] ?? '')).toContain('ccps');
    expect(stripAnsi(lines[0] ?? '')).toContain('CC-Profile-Switch');
  });

  it('full color emits 24-bit ANSI sequences', () => {
    chalk.level = 3;
    const banner = renderWelcomeBanner({
      charset: 'unicode',
      widthTier: 'full',
      colorLevel: 'full',
    });
    expect(banner).toMatch(TRUE_COLOR);
    expect(banner).not.toMatch(/38;5;/);
  });

  it('basic color emits cyan and blue ANSI sequences', () => {
    chalk.level = 1;
    const banner = renderWelcomeBanner({
      charset: 'unicode',
      widthTier: 'full',
      colorLevel: 'basic',
    });
    expect(banner).toMatch(BASIC_CYAN);
    expect(banner).toMatch(BASIC_BLUE);
    expect(banner).not.toMatch(TRUE_COLOR);
  });

  it('none color level emits no ANSI escapes', () => {
    chalk.level = 2;
    const banner = renderWelcomeBanner({
      charset: 'unicode',
      widthTier: 'full',
      colorLevel: 'none',
    });
    expect(banner).not.toMatch(ANSI_ESC);
  });

  it('frame with sweep past the end equals the static render', () => {
    const opts: BannerOptions = {
      charset: 'unicode',
      widthTier: 'full',
      colorLevel: 'full',
    };
    const art = getBannerArt(opts.widthTier, opts.charset);
    const staticBanner = renderWelcomeBanner(opts);
    const pastEndBanner = renderWelcomeBannerFrame(opts, art.artWidth);
    expect(pastEndBanner).toBe(staticBanner);
  });

  it('sweep highlight changes the rendered color codes', () => {
    chalk.level = 3;
    const opts: BannerOptions = {
      charset: 'unicode',
      widthTier: 'full',
      colorLevel: 'full',
    };
    const staticBanner = renderWelcomeBanner(opts);
    const frame0 = renderWelcomeBannerFrame(opts, 0);
    expect(frame0).not.toBe(staticBanner);
    expect(frame0).toMatch(TRUE_COLOR);
  });
});
