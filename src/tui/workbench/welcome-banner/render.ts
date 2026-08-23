import chalk from 'chalk';

import { getBannerArt, type BannerCharset, type BannerWidthTier } from './art';

export type BannerOptions = {
  charset: BannerCharset;
  widthTier: BannerWidthTier;
  colorLevel: 'full' | 'basic' | 'none';
};

const START_COLOR = { r: 0x22, g: 0xd3, b: 0xee };
const END_COLOR = { r: 0x3b, g: 0x82, b: 0xf6 };

function hexComponent(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

function gradientColor(column: number, width: number): string {
  if (width <= 1) {
    return `#${hexComponent(START_COLOR.r)}${hexComponent(START_COLOR.g)}${hexComponent(START_COLOR.b)}`;
  }
  const t = column / (width - 1);
  const r = Math.round(START_COLOR.r + (END_COLOR.r - START_COLOR.r) * t);
  const g = Math.round(START_COLOR.g + (END_COLOR.g - START_COLOR.g) * t);
  const b = Math.round(START_COLOR.b + (END_COLOR.b - START_COLOR.b) * t);
  return `#${hexComponent(r)}${hexComponent(g)}${hexComponent(b)}`;
}

/** Highlight = lerp toward white by `factor`. */
function highlight(
  color: { r: number; g: number; b: number },
  factor: number,
): { r: number; g: number; b: number } {
  return {
    r: Math.round(color.r * (1 - factor) + 255 * factor),
    g: Math.round(color.g * (1 - factor) + 255 * factor),
    b: Math.round(color.b * (1 - factor) + 255 * factor),
  };
}

type HighlightKind = 'solid' | 'grain' | null;

/** Dissolve depth (columns) at each edge of the sweep window. */
const GRAIN_COLUMNS = 6;

/** Width (columns) of the sparse grain spray ahead of the sweep front. */
const STRAY_COLUMNS = 3;

/** Stable per-cell spatial hash — fixed across frames, so the sweep's grain
 *  edge is ragged but never flickers. The finalizer keeps the low bits (used
 *  by the `%` thresholds below) well distributed. */
function grainHash(x: number, y: number): number {
  let h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Sweep window width: wide enough for a solid core plus deep dissolve zones. */
function sweepWindowWidth(tierWidth: number): number {
  return Math.min(Math.round(tierWidth * 0.4), Math.floor(tierWidth / 2));
}

/** Pixel-grain sweep: a solid bright core with a deep dissolve zone on both
 *  sides, plus a sparse spray of grains ahead of the front. Inside a grain
 *  zone a cell is lit with probability ramping from ~0 at the outer edge to 1
 *  at the core boundary, keyed by the stable spatial hash. */
function highlightKind(
  x: number,
  sweepColumn: number,
  frameWidth: number,
  hash: number,
): HighlightKind {
  const d = x - sweepColumn;
  if (d >= frameWidth) {
    return d < frameWidth + STRAY_COLUMNS && hash % 10 === 0 ? 'grain' : null;
  }
  if (d < 0) return null;
  // Dissolve zones take the window minus a solid core of at least 2 columns.
  const grain = Math.min(GRAIN_COLUMNS, Math.max(1, Math.floor((frameWidth - 2) / 2)));
  const edge = Math.min(d, frameWidth - 1 - d);
  if (edge >= grain) return 'solid';
  return hash % grain <= edge ? 'grain' : null;
}

function formatColor(
  column: number,
  width: number,
  colorLevel: BannerOptions['colorLevel'],
  kind: HighlightKind,
  hash: number,
): ((text: string) => string) | null {
  if (colorLevel === 'none') return null;

  if (colorLevel === 'basic') {
    const isLeft = column < width / 2;
    if (kind !== null) {
      return isLeft ? chalk.cyanBright : chalk.blueBright;
    }
    return isLeft ? chalk.cyan : chalk.blue;
  }

  const base = gradientColor(column, width);
  if (kind === null) {
    return chalk.hex(base);
  }

  // Grain cells sparkle brighter than the solid sweep core, with per-cell
  // brightness jitter from the spatial hash so the dissolve reads as
  // individual particles rather than a smooth band.
  const factor = kind === 'grain' ? 0.7 + ((hash >>> 8) % 64) / 256 : 0.55;
  const r = parseInt(base.slice(1, 3), 16);
  const g = parseInt(base.slice(3, 5), 16);
  const b = parseInt(base.slice(5, 7), 16);
  const lit = highlight({ r, g, b }, factor);
  return chalk.hex(`#${hexComponent(lit.r)}${hexComponent(lit.g)}${hexComponent(lit.b)}`);
}

/** Brand caption. Truecolor full tier: extend the wordmark's horizontal
 *  gradient into the caption, aligned by absolute column so both share the
 *  same color phase. Everything else keeps the quiet gray caption. */
function renderBrandLine(line: string, width: number, opts: BannerOptions): string {
  if (opts.colorLevel === 'none') return line;
  if (opts.colorLevel === 'basic' || opts.widthTier !== 'full') {
    return chalk.gray(line);
  }
  let output = '';
  for (let x = 0; x < line.length; x++) {
    const char = line[x] ?? ' ';
    if (char === ' ') {
      output += char;
      continue;
    }
    output += chalk.hex(gradientColor(x, width))(char);
  }
  return output;
}

function renderBanner(opts: BannerOptions, sweepColumn: number, frameWidth: number): string {
  const art = getBannerArt(opts.widthTier, opts.charset);
  // Gradient and sweep run over the padded tier width: compact-tier rows are
  // centered within `tierWidth`, so glyph columns extend past `artWidth`.
  const width = art.tierWidth;

  const coloredRows = art.artRows.map((row, y) => {
    let output = '';
    for (let x = 0; x < row.length; x++) {
      const char = row[x] ?? ' ';
      if (char === ' ') {
        output += char;
        continue;
      }
      const hash = grainHash(x, y);
      const kind = highlightKind(x, sweepColumn, frameWidth, hash);
      const styler = formatColor(x, width, opts.colorLevel, kind, hash);
      output += styler ? styler(char) : char;
    }
    return output;
  });

  const lines: string[] = coloredRows;
  if (art.brandLine.length > 0) {
    lines.push(renderBrandLine(art.brandLine, width, opts));
  }

  return lines.join('\n');
}

export function renderWelcomeBanner(opts: BannerOptions): string {
  const art = getBannerArt(opts.widthTier, opts.charset);
  // Sweep past the end: no highlight window covers the art.
  return renderBanner(opts, art.tierWidth, sweepWindowWidth(art.tierWidth));
}

export function renderWelcomeBannerFrame(opts: BannerOptions, sweepColumn: number): string {
  const art = getBannerArt(opts.widthTier, opts.charset);
  return renderBanner(opts, sweepColumn, sweepWindowWidth(art.tierWidth));
}

/** Sweep path for frame `frame` of `frameCount`: the window enters from
 *  off-screen left and exits off-screen right, so the grain front visibly
 *  crosses the whole wordmark. */
export function welcomeBannerSweepColumn(
  tierWidth: number,
  frame: number,
  frameCount: number,
): number {
  const windowWidth = sweepWindowWidth(tierWidth);
  return -windowWidth + (frame * (tierWidth + windowWidth)) / frameCount;
}

function resolveCharset(platform: string, env: NodeJS.ProcessEnv): BannerCharset {
  if (platform === 'win32') {
    const supportsUnicode =
      Boolean(env.WT_SESSION) ||
      Boolean(env.TERM_PROGRAM) ||
      (env.TERM ? /xterm|cygwin|mintty/i.test(env.TERM) : false);
    return supportsUnicode ? 'unicode' : 'ascii';
  }

  const localeVars = [env.LC_ALL, env.LC_CTYPE, env.LANG].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (localeVars.length === 0) return 'unicode';
  return localeVars.every((value) => /utf-?8/i.test(value)) ? 'unicode' : 'ascii';
}

export function resolveBannerOptions(deps: {
  isTTY: boolean;
  columns: number;
  platform: string;
  env: NodeJS.ProcessEnv;
  chalkLevel: 0 | 1 | 2 | 3;
  configEnabled: boolean;
}): BannerOptions | null {
  if (!deps.isTTY || !deps.configEnabled) return null;

  const charset = resolveCharset(deps.platform, deps.env);

  let widthTier: BannerWidthTier;
  if (deps.env.CI) {
    widthTier = 'plain';
  } else if (deps.columns >= 36) {
    widthTier = 'full';
  } else if (deps.columns >= 18) {
    widthTier = 'compact';
  } else {
    widthTier = 'plain';
  }

  let colorLevel: BannerOptions['colorLevel'];
  if (deps.env.NO_COLOR || deps.chalkLevel === 0) {
    colorLevel = 'none';
  } else if (deps.chalkLevel === 1) {
    colorLevel = 'basic';
  } else {
    colorLevel = 'full';
  }

  return { charset, widthTier, colorLevel };
}
