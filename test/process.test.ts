import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSpawnCommand } from '../src/platform/process';

describe('process spawning', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  it('resolves npm cmd shims to the underlying executable on Windows', async () => {
    const binDir = join(await makeTempRoot('ccps-process-'), 'npm bin');
    const exePath = join(binDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const shimPath = join(binDir, 'claude.cmd');
    await fs.ensureFile(exePath);
    await fs.writeFile(
      shimPath,
      '@ECHO off\r\nSETLOCAL\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
      'utf8',
    );

    const resolved = await resolveSpawnCommand('claude', ['--version'], {
      PATH: binDir,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    });

    expect(resolved).toEqual({
      command: exePath,
      args: ['--version'],
    });
  });
});
