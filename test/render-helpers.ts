import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { vi } from 'vitest';

import { I18nProvider, type Locale } from '../src/tui/workbench/i18n/react';
import type { WorkbenchProfile } from '../src/tui/workbench/profile-data';

/**
 * Shared test helpers for Ink render tests: ANSI stripping, output flattening,
 * a canonical WorkbenchProfile factory, a controlled successful spawn, and an
 * I18nProvider-wrapped render. Per-file fixture defaults layer on top of
 * `makeProfile` via overrides instead of re-declaring the constructor.
 */

export class FakeTtyStdout extends Writable {
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

  /** Return and clear the accumulated writes so a later frame can be asserted alone. */
  public snapshot(): string {
    const out = this.output;
    this.chunks.length = 0;
    return out;
  }
}

function dummyStdin(): Readable {
  return new Readable({ read() {} });
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

/** Flatten wrapped render output (borders included) for substring assertions. */
export function flatten(text: string): string {
  return stripAnsi(text)
    .replace(/[│╭╰╮╯─┌┐└┘┃┏┓┗┛]/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/[ ]+/g, ' ')
    .trim();
}

/** Canonical WorkbenchProfile base; per-file fixtures override via params. */
export function makeProfile(overrides: Partial<WorkbenchProfile> = {}): WorkbenchProfile {
  return {
    name: 'coding',
    description: 'Daily coding profile',
    isDefault: true,
    isLastUsed: false,
    status: 'valid',
    resourceCounts: { userMemory: 1, autoMemory: 1, skills: 1, agents: 1, mcp: 0, settings: 1, launchConfig: 1 },
    resourceDetails: {
      userMemory: { kind: 'user-memory', name: 'CLAUDE.md', relativePath: 'claude-home/CLAUDE.md', exists: true, lineCount: 12, excerpt: '' },
      agents: [],
      skills: [],
      autoMemory: [],
      settings: [],
    },
    mcpServers: [],
    validation: null,
    ...overrides,
  };
}

/** Controlled spawn: emits a successful exit so the edit session reaches
 *  'watching'. `delayMs` tunes the close-event timing for frame-sensitive
 *  integration tests (0 for unit-level manager tests). Requires the caller's
 *  test file to `vi.mock('node:child_process')`. */
export function setupSpawnSuccess(delayMs = 0): void {
  vi.mocked(spawn).mockImplementation((() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    setTimeout(() => child.emit('close', 0), delayMs);
    return child;
  }) as never);
}

/** Render a component inside the I18nProvider (default `en`). Callers await
 *  `instance.waitUntilRenderFlush()` before asserting on `stdout.output`. */
export function renderWithLocale(element: React.ReactElement, initialLocale: Locale = 'en') {
  const stdout = new FakeTtyStdout();
  const instance = render(
    React.createElement(I18nProvider, { initialLocale }, element),
    { stdout, stdin: dummyStdin(), debug: true },
  );
  return { instance, stdout };
}
