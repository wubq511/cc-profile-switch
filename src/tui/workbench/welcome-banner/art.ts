/** Pure data module for the Workbench welcome banner wordmark.
 *
 * Tiers:
 * - `full`: 6-row unicode block letters, 35 columns.
 * - `compact`: 3-row unicode mini blocks, ~12 columns of art centered in a
 *   17-column tier driven by the brand line.
 * - `plain`: single text line.
 *
 * Each tier has a `unicode` and an `ascii` charset variant.
 */

export type BannerWidthTier = 'full' | 'compact' | 'plain';
export type BannerCharset = 'unicode' | 'ascii';

export type BannerArt = {
  /** Width (in columns) used for centering the art + brand line. */
  tierWidth: number;
  /** Width of the art glyph rows only. */
  artWidth: number;
  /** Visual art rows. */
  artRows: string[];
  /** Brand line rendered below the art (already centered). */
  brandLine: string;
};

const BRAND_TEXT = 'CC-Profile-Switch';

/** Full-tier caption: letter-spaced so it reads as a designed caption under
 *  the wordmark rather than a plain text line (17 → 33 columns, centered). */
const BRAND_TEXT_SPACED = 'C C - P r o f i l e - S w i t c h';

function center(text: string, width: number): string {
  if (text.length >= width) return text;
  const left = Math.floor((width - text.length) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - text.length - left);
}

function makeArt(tierWidth: number, artRows: string[], brandText: string): BannerArt {
  const artWidth = artRows.length > 0 ? artRows[0].length : tierWidth;
  return {
    tierWidth,
    artWidth,
    artRows: artRows.map((row) => center(row, tierWidth)),
    brandLine: brandText.length > 0 ? center(brandText, tierWidth) : '',
  };
}

const FULL_UNICODE_ROWS = [
  ' ██████╗  ██████╗ ██████╗  ███████╗',
  '██╔════╝ ██╔════╝ ██╔══██╗ ██╔════╝',
  '██║      ██║      ██████╔╝ ███████╗',
  '██║      ██║      ██╔═══╝  ╚════██║',
  '╚██████╗ ╚██████╗ ██║      ███████║',
  ' ╚═════╝  ╚═════╝ ╚═╝      ╚══════╝',
];

const FULL_ASCII_ROWS = [
  ' #####   #####  #####    #####',
  '##      ##     ##  ##  ##',
  '##      ##     ##  ##   ####',
  '##      ##     #####       ##',
  '##      ##     ##          ##',
  ' #####   #####  ##      #####',
];

const COMPACT_UNICODE_ROWS = ['┌─ ┌─ ┌─┐┌─┐', '│  │  ├─┘└─┐', '└─ └─ │  └─┘'];

const COMPACT_ASCII_ROWS = [' #  #  ##  ##', '#   #  # # # ', ' ## #  ##  ##'];

export function getBannerArt(tier: BannerWidthTier, charset: BannerCharset): BannerArt {
  if (tier === 'plain') {
    const line = charset === 'unicode' ? 'ccps — CC-Profile-Switch' : 'ccps - CC-Profile-Switch';
    return makeArt(line.length, [line], '');
  }

  if (tier === 'compact') {
    const rows = charset === 'unicode' ? COMPACT_UNICODE_ROWS : COMPACT_ASCII_ROWS;
    // Brand line length (17) drives the compact tier width.
    return makeArt(BRAND_TEXT.length, rows, BRAND_TEXT);
  }

  const rows = charset === 'unicode' ? FULL_UNICODE_ROWS : FULL_ASCII_ROWS;
  // The spaced caption (33 cols) is wider than the ascii art (30): let the
  // caption drive the tier width, art rows stay centered above it.
  return makeArt(Math.max(rows[0].length, BRAND_TEXT_SPACED.length), rows, BRAND_TEXT_SPACED);
}
