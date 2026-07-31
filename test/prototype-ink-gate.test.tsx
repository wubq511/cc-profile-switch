// PROTOTYPE (throwaway) — issue #36
// Deterministic render checks for the Ink gate app against a fake TTY.
// ink-testing-library is avoided on purpose (v4 does not declare Ink 7
// compatibility); Ink's own render() accepts custom streams instead.

import { Readable, Writable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import { CJK_END, CJK_TEXT, InkGateApp } from '../src/tui/prototype-ink-gate/app';

class FakeTtyStdout extends Writable {
  // Ink checks isTTY to decide interactive mode and raw-mode support.
  public readonly isTTY = true;
  public columns = 100;
  public rows = 30;
  private readonly chunks: Buffer[] = [];

  public override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  public get output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function dummyStdin(): Readable {
  // No isTTY → Ink never tries raw mode on it.
  return new Readable({
    read() {
      // stays open, never emits input
    },
  });
}

async function renderOnce(): Promise<string> {
  const stdout = new FakeTtyStdout();
  const instance = render(React.createElement(InkGateApp, { headless: true }), {
    stdout: stdout as NodeJS.WriteStream,
    stdin: dummyStdin() as NodeJS.ReadStream,
    exitOnCtrlC: false,
    // vitest wraps global console, so patch-console's `new console.Console()`
    // blows up; console patching is irrelevant to these frame assertions.
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();
  instance.unmount();
  await instance.waitUntilExit();
  return stdout.output;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

describe('prototype ink gate (issue #36)', () => {
  it('renders byte-identical frames across repeated renders', async () => {
    const frames = await Promise.all([renderOnce(), renderOnce(), renderOnce()]);
    expect(frames[0].length).toBeGreaterThan(0);
    expect(frames[1]).toBe(frames[0]);
    expect(frames[2]).toBe(frames[0]);
  });

  it('renders the CJK ruler at the expected display width', async () => {
    const output = stripAnsi(await renderOnce());
    const cjkLine = output
      .split('\n')
      .find((line) => line.includes(CJK_TEXT));
    expect(cjkLine).toBeDefined();

    // The line is `cjk   |<CJK><marker>`: a 7-column prefix, then the
    // 20-column CJK string, so the marker sits at display column 27 using
    // the same string-width semantics Ink uses for layout.
    const markerIndex = cjkLine!.indexOf(CJK_END);
    expect(markerIndex).toBeGreaterThan(-1);
    expect(stringWidth(cjkLine!.slice(0, markerIndex))).toBe(27);

    // The ruler digit directly above the marker is column index 20.
    const rulerLine = output.split('\n').find((line) => line.includes('ruler |'));
    expect(rulerLine).toBeDefined();
    expect(rulerLine!.charAt(27)).toBe('0');
  });

  it('renders the simplified screen-reader form', async () => {
    const stdout = new FakeTtyStdout();
    const instance = render(React.createElement(InkGateApp, { headless: true }), {
      stdout: stdout as NodeJS.WriteStream,
      stdin: dummyStdin() as NodeJS.ReadStream,
      exitOnCtrlC: false,
      isScreenReaderEnabled: true,
      patchConsole: false,
    });
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    const output = stripAnsi(stdout.output);
    expect(output).toContain('INK-GATE screen-reader summary');
    expect(output).not.toContain('ruler |');
  });
});
