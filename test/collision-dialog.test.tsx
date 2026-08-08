import { Readable, Writable } from 'node:stream';

import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';

import { CollisionDialog } from '../src/tui/workbench/resources/collision-dialog';

class FakeTtyStdout extends Writable {
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
  return new Readable({ read() {} });
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

describe('CollisionDialog render', () => {
  async function renderDialog(): Promise<string> {
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(CollisionDialog, {
        resourceName: 'topics.md',
        suggestedName: 'topics-2.md',
        onResolve: () => {},
        headless: true,
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: dummyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    return stripAnsi(stdout.output);
  }

  it('renders the collision header, resource name, and the three options', async () => {
    const output = await renderDialog();
    // Locale-independent structure: the header (either locale), the colliding
    // resource, and the three key hints shared by both locales.
    expect(output).toMatch(/Restore blocked|恢复被阻止/);
    expect(output).toContain('topics.md');
    expect(output).toContain('[r]');
    expect(output).toContain('[d]');
    expect(output).toContain('[esc]');
  });

  it('renders the numbered-explanation panel making each option consequence explicit (issue #94)', async () => {
    const output = await renderDialog();
    // Three numbered rows; option 3 (refuse) is the default and is dimmed.
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[123]\. /.test(line));
    expect(lines).toHaveLength(3);
    // Locale-independent consequence copy on each row.
    expect(lines[0]).toMatch(/(restores under a new name|以新名称恢复)/);
    expect(lines[1]).toMatch(/(moves the existing entry|移入恢复回收站)/);
    expect(lines[2]).toMatch(/(nothing changes|不做任何更改)/);
    // No silent overwrite: each option is a numbered explanation, never a bare key hint.
    expect(output).toMatch(/1\. /);
    expect(output).toMatch(/2\. /);
    expect(output).toMatch(/3\. /);
  });
});
