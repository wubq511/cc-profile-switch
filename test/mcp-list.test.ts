import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import {
  createProfileFromTemplate,
  getProfileTemplatePaths,
} from '../src/core/profile-template';
import { listMcpServers, parseFailedMcpNames } from '../src/core/mcp-list';

describe('parseFailedMcpNames', () => {
  const configured = ['ok', 'broken'];

  it('parses healthy and failed servers from claude mcp list output', () => {
    const output = [
      'Checking MCP server health…',
      '',
      'ok: echo hi - ✓ Connected',
      'broken: nope - ✘ Failed to connect — ENOENT: not found',
    ].join('\n');
    const failed = parseFailedMcpNames(output, configured);
    expect([...failed]).toEqual(['broken']);
  });

  it('ignores lines whose prefix is not a configured server (project scope)', () => {
    const output = 'project-server: npx foo - ✘ Failed to connect — boom\n';
    const failed = parseFailedMcpNames(output, configured);
    expect([...failed]).toEqual([]);
  });

  it('ignores unparseable lines', () => {
    const output = 'Checking MCP server health…\n(no servers)\n';
    expect([...parseFailedMcpNames(output, configured)]).toEqual([]);
  });

  it('does not treat connected servers as failed', () => {
    const output = 'broken: npx foo - ✓ Connected\n';
    expect([...parseFailedMcpNames(output, configured)]).toEqual([]);
  });
});

function fakeSpawn(output: string): typeof spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: () => void;
    };
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.push(Buffer.from(output, 'utf8'));
      child.stdout.push(null); // triggers 'end' after data is delivered
    });
    process.nextTick(() => child.stderr.push(null));
    // Close only after stdout has been fully delivered (real pipe semantics:
    // close follows the stream's end, never races ahead of its data).
    child.stdout.on('end', () => process.nextTick(() => child.emit('close')));
    return child;
  }) as unknown as typeof spawn;
}

describe('listMcpServers', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeProfile(servers: Record<string, unknown>): Promise<{
    appHome: string;
    claudeHome: string;
  }> {
    const appHome = join(await mkdtemp(join(tmpdir(), 'ccps-mcp-')), '.cc-profile-switch');
    await createAppConfig(appHome);
    await createProfileFromTemplate({ appHomePath: appHome, name: 'coding', template: 'coding' });
    const { claudeHomePath } = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(join(claudeHomePath, '.claude.json'), { mcpServers: servers });
    return { appHome, claudeHome: claudeHomePath };
  }

  it('returns [] when the profile has no MCP servers configured', async () => {
    const { appHome } = await makeProfile({});
    const result = await listMcpServers({ appHomePath: appHome, profileName: 'coding' });
    expect(result).toEqual([]);
  });

  it('marks failed servers from the delegated claude mcp list output', async () => {
    const { appHome } = await makeProfile({
      ok: { type: 'stdio', command: 'echo', args: ['hi'] },
      broken: { type: 'stdio', command: 'nope' },
    });
    const result = await listMcpServers({
      appHomePath: appHome,
      profileName: 'coding',
      spawnImpl: fakeSpawn(
        'Checking MCP server health…\n\n' +
          'ok: echo hi - ✓ Connected\n' +
          'broken: nope - ✘ Failed to connect — ENOENT: not found\n',
      ),
    });
    expect(result).toEqual([
      { name: 'ok', failed: false },
      { name: 'broken', failed: true },
    ]);
  });

  it('fails closed (no failed servers) when the claude binary is missing', async () => {
    const { appHome } = await makeProfile({
      broken: { type: 'stdio', command: 'nope' },
    });
    const result = await listMcpServers({
      appHomePath: appHome,
      profileName: 'coding',
      claudeCommand: 'definitely-not-a-real-binary-xyz',
    });
    expect(result).toEqual([{ name: 'broken', failed: false }]);
  });

  it('fails closed when the probe times out', async () => {
    const { appHome } = await makeProfile({
      slow: { type: 'stdio', command: 'echo' },
    });
    // A spawn that never delivers data or closes → the timeout resolves null.
    const hangingSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        kill: () => void;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.kill = () => {};
      return child;
    }) as unknown as typeof spawn;
    const result = await listMcpServers({
      appHomePath: appHome,
      profileName: 'coding',
      spawnImpl: hangingSpawn,
      timeoutMs: 20,
    });
    expect(result).toEqual([{ name: 'slow', failed: false }]);
  });
});
