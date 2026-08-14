#!/usr/bin/env node
// Replay a raw PTY byte stream through @xterm/headless and dump the visible
// screen as JSON for the Pillow renderer (issue #97 visual audit).
//
//   node replay.mjs <raw.bin> <cols> <rows> > screen.json
//
// JSON shape: { cols, rows, cursor:{x,y}, cells: [[{ch,fg,bg,bold,dim,wide}...] ...] }
// fg/bg: palette index 0-15, 256-color index, or [r,g,b]; null = default.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { Terminal } = createRequire(import.meta.url)('@xterm/headless');

const [rawPath, colsArg, rowsArg] = process.argv.slice(2);
const cols = Number(colsArg);
const rows = Number(rowsArg);

const term = new Terminal({
  cols,
  rows,
  allowProposedApi: true,
  scrollback: 0,
});
term.write(readFileSync(rawPath), () => {
  const buffer = term.buffer.active;
  const cells = [];
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const row = [];
    if (!line) {
      cells.push(row);
      continue;
    }
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      if (!cell) {
        row.push({ ch: ' ', fg: null, bg: null, bold: false, dim: false, inv: false, wide: 1 });
        continue;
      }
      const wide = cell.getWidth();
      row.push({
        ch: cell.getChars(),
        fg: colorOf(cell, true),
        bg: colorOf(cell, false),
        bold: !!cell.isBold(),
        dim: !!cell.isDim(),
        inv: !!cell.isInverse(),
        wide,
      });
      if (wide === 2) x++; // skip the padding cell after a wide glyph
    }
    cells.push(row);
  }
  process.stdout.write(JSON.stringify({ cols, rows, cells }));
});

function colorOf(cell, isFg) {
  const rgb = isFg ? cell.isFgRGB() : cell.isBgRGB();
  const palette = isFg ? cell.isFgPalette() : cell.isBgPalette();
  const isDefault = isFg ? cell.isFgDefault() : cell.isBgDefault();
  const value = isFg ? cell.getFgColor() : cell.getBgColor();
  if (isDefault) return null;
  if (palette) return value; // 16/256-color palette index
  if (rgb) return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return null;
}
