import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import {
  addMcpServer,
  buildMcpAddArgs,
  copyMcpServerToProfile,
  deriveTransport,
  diffMcpServers,
  editMcpServer,
  inspectMcpServers,
  isLegacyMcpConfigured,
  parseMcpListOutput,
  previewMcpServer,
  redactServerPreview,
  removeMcpServer,
  restoreMcpServer,
  getClaudeJsonPath,
} from '../src/core/mcp-servers';
import { listRecoveryBinItems } from '../src/core/recovery-bin';
import { validateProfile } from '../src/core/validator';
import type { CaptureProcess } from '../src/platform/process';
import type { ProcessCaptureResult } from '../src/platform/process';
import { CcpsError } from '../src/utils/errors';
import { findCredentialShapes } from './fixtures/credentials';
import type { McpAddOptions } from '../src/schemas/mcp';

// A real-shape credential token, assembled from fragments so the repo
// credential-insulation scan (which reads source text) never sees a contiguous
// real shape. Used only to assert redaction never leaks it.
const SECRET_TOKEN = 'sk-ant-' + 'api03-' + 'a'.repeat(30);

const tempRoots: string[] = [];

afterEach(async () => {
  // Restore permissions on recovery-bin items (0700 dirs can't be deleted by fs.remove)
  for (const root of tempRoots) {
    const binDir = path.join(root, '.cc-profile-switch', 'recovery-bin');
    if (await fs.pathExists(binDir)) {
      try {
        await restorePermissions(binDir);
      } catch {
        // Best effort
      }
    }
  }
  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeAppHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ccps-mcp-'));
  tempRoots.push(root);
  return path.join(root, '.cc-profile-switch');
}

async function makeProfile(name = 'coding'): Promise<{ appHome: string; profileRootPath: string }> {
  const appHome = await makeAppHome();
  await createAppConfig(appHome);
  await createProfileFromTemplate({ appHomePath: appHome, name, template: 'coding' });
  const paths = getProfileTemplatePaths(appHome, name);
  return { appHome, profileRootPath: paths.profileRootPath };
}

async function writeProfileClaudeJson(profileRootPath: string, mcpServers: Record<string, unknown>): Promise<void> {
  const filePath = getClaudeJsonPath(profileRootPath);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, { mcpServers }, { spaces: 2 });
}

async function readProfileClaudeJson(profileRootPath: string): Promise<Record<string, unknown>> {
  return fs.readJson(getClaudeJsonPath(profileRootPath));
}

// --- mock `claude mcp` delegation ------------------------------------------------
// Simulates Claude Code's filesystem effect: `mcp add` writes the entry to
// $CLAUDE_CONFIG_DIR/.claude.json; `mcp remove` deletes it; `mcp list` returns
// canned stdout. This mirrors the real-home isolation contract (writes land
// under CLAUDE_CONFIG_DIR only).

type RecordedCall = { args: string[]; env: NodeJS.ProcessEnv; cwd: string };
type ListHandler = ProcessCaptureResult | ((call: RecordedCall) => ProcessCaptureResult);

function mockClaude(handlers: { list?: ListHandler; default?: ProcessCaptureResult } = {}): {
  capture: CaptureProcess;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const capture: CaptureProcess = async (_command, args, options) => {
    const call: RecordedCall = { args, env: options.env, cwd: options.cwd };
    calls.push(call);
    const claudeConfigDir = options.env?.CLAUDE_CONFIG_DIR;
    if (args[0] === 'mcp' && args[1] === 'add') {
      applyMcpAdd(claudeConfigDir as string, args);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (args[0] === 'mcp' && args[1] === 'remove') {
      applyMcpRemove(claudeConfigDir as string, args);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (args[0] === 'mcp' && args[1] === 'list') {
      const h = handlers.list;
      if (typeof h === 'function') return h(call);
      if (h) return h;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }
    return handlers.default ?? { exitCode: 1, stdout: '', stderr: 'no mock match', timedOut: false };
  };
  return { capture, calls };
}

function applyMcpAdd(claudeConfigDir: string, args: string[]): void {
  // args: ['mcp', 'add', '--scope', 'user', ('--transport', X)?, ('-e', K=V)*, <name>, ...]
  let i = 2;
  let transport: 'stdio' | 'sse' | 'http' = 'stdio';
  const env: Record<string, string> = {};
  while (i < args.length) {
    const a = args[i];
    if (a === '--scope') { i += 2; continue; }
    if (a === '--transport') { transport = args[i + 1] as 'sse' | 'http'; i += 2; continue; }
    if (a === '-e' || a === '--env') {
      const pair = args[i + 1];
      const eq = pair.indexOf('=');
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 2;
      continue;
    }
    break; // first positional = name
  }
  const name = args[i];
  i += 1;
  const entry: Record<string, unknown> = {};
  if (transport !== 'stdio') entry.type = transport;
  if (transport === 'sse' || transport === 'http') {
    entry.url = args[i];
  } else {
    if (args[i] === '--') i += 1;
    entry.command = args[i];
    i += 1;
    if (i < args.length) entry.args = args.slice(i);
  }
  if (Object.keys(env).length > 0) entry.env = env;
  writeMcpServerToClaudeJson(claudeConfigDir, name, entry);
}

function applyMcpRemove(claudeConfigDir: string, args: string[]): void {
  // args: ['mcp', 'remove', '--scope', 'user', <name>]
  let i = 2;
  let name: string | undefined;
  while (i < args.length) {
    if (args[i] === '--scope') { i += 2; continue; }
    name = args[i];
    break;
  }
  if (!name) return;
  const file = path.join(claudeConfigDir, '.claude.json');
  let json: Record<string, unknown>;
  try {
    json = fs.readJsonSync(file);
  } catch {
    return;
  }
  if (isRecord(json.mcpServers) && json.mcpServers[name] !== undefined) {
    delete json.mcpServers[name];
    fs.outputJsonSync(file, json, { spaces: 2 });
  }
}

function writeMcpServerToClaudeJson(claudeConfigDir: string, name: string, entry: Record<string, unknown>): void {
  const file = path.join(claudeConfigDir, '.claude.json');
  let json: Record<string, unknown> = {};
  try {
    json = fs.readJsonSync(file);
  } catch {
    // missing file → start empty
  }
  if (!isRecord(json.mcpServers)) json.mcpServers = {};
  json.mcpServers[name] = entry;
  fs.outputJsonSync(file, json, { spaces: 2 });
}

function throwingCapture(): CaptureProcess {
  return async () => {
    throw new Error('spawn claude ENOENT');
  };
}

async function expectCcpsError(thunk: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await thunk();
  } catch (error) {
    expect(error).toBeInstanceOf(CcpsError);
    expect((error as CcpsError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a CcpsError with code ${code}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoCredentialShapes(value: unknown, where: string): void {
  const hits = findCredentialShapes(JSON.stringify(value));
  expect(hits, `credential shape leaked in ${where}`).toEqual([]);
}

async function restorePermissions(dirPath: string): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      try {
        await fs.chmod(fullPath, 0o755);
      } catch {
        // Windows may not support chmod
      }
      await restorePermissions(fullPath);
    }
  }
}

const stdioOptions = (overrides: Partial<McpAddOptions> = {}): McpAddOptions => ({
  name: 'weather',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// buildMcpAddArgs
// ---------------------------------------------------------------------------

describe('buildMcpAddArgs', () => {
  it('builds stdio args with --scope user and -- separator', () => {
    const args = buildMcpAddArgs(stdioOptions());
    expect(args).toEqual(['add', '--scope', 'user', 'weather', '--', 'node', 'server.js']);
  });

  it('includes -e KEY=VALUE for env (delegated handoff)', () => {
    const args = buildMcpAddArgs(stdioOptions({ env: { API_KEY: 'v', OTHER: 'x' } }));
    expect(args).toEqual([
      'add', '--scope', 'user',
      '-e', 'API_KEY=v', '-e', 'OTHER=x',
      'weather', '--', 'node', 'server.js',
    ]);
  });

  it('builds sse args with --transport sse and url', () => {
    const args = buildMcpAddArgs({ name: 'remote', transport: 'sse', url: 'https://example.com/sse' });
    expect(args).toEqual(['add', '--scope', 'user', '--transport', 'sse', 'remote', 'https://example.com/sse']);
  });

  it('builds http args with --transport http and url', () => {
    const args = buildMcpAddArgs({ name: 'remote', transport: 'http', url: 'https://example.com/mcp' });
    expect(args).toEqual(['add', '--scope', 'user', '--transport', 'http', 'remote', 'https://example.com/mcp']);
  });
});

// ---------------------------------------------------------------------------
// deriveTransport / redactServerPreview / isLegacyMcpConfigured
// ---------------------------------------------------------------------------

describe('deriveTransport', () => {
  it('uses the type field when present', () => {
    expect(deriveTransport({ type: 'sse', url: 'u' })).toBe('sse');
    expect(deriveTransport({ type: 'http', url: 'u' })).toBe('http');
    expect(deriveTransport({ type: 'stdio', command: 'c' })).toBe('stdio');
  });

  it('defaults to stdio when a command is present without a type', () => {
    expect(deriveTransport({ command: 'node', args: ['x'] })).toBe('stdio');
  });

  it('returns unknown when only a url is present without a type', () => {
    expect(deriveTransport({ url: 'u' })).toBe('unknown');
  });

  it('returns unknown for an empty entry', () => {
    expect(deriveTransport({})).toBe('unknown');
  });
});

describe('redactServerPreview', () => {
  it('shows command/args and env KEY NAMES only (never values)', () => {
    const preview = redactServerPreview('weather', {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: SECRET_TOKEN, OTHER: 'x' },
    });
    expect(preview).toMatchObject({
      name: 'weather',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      envKeyNames: ['API_KEY', 'OTHER'],
    });
    expect(JSON.stringify(preview)).not.toContain(SECRET_TOKEN);
  });

  it('shows url for sse/http and sorts env key names', () => {
    const preview = redactServerPreview('remote', {
      type: 'sse',
      url: 'https://example.com/sse',
      env: { ZED: '1', ALPHA: '2' },
    });
    expect(preview).toMatchObject({ transport: 'sse', url: 'https://example.com/sse', envKeyNames: ['ALPHA', 'ZED'] });
    expect(preview.command).toBeUndefined();
  });

  it('returns empty envKeyNames when env is absent', () => {
    const preview = redactServerPreview('s', { command: 'c' });
    expect(preview.envKeyNames).toEqual([]);
  });
});

describe('isLegacyMcpConfigured', () => {
  it('is true when mcpServers is a non-empty object', () => {
    expect(isLegacyMcpConfigured({ mcpServers: { a: {} } })).toBe(true);
  });
  it('is false when mcpServers is empty or absent', () => {
    expect(isLegacyMcpConfigured({ mcpServers: {} })).toBe(false);
    expect(isLegacyMcpConfigured({})).toBe(false);
    expect(isLegacyMcpConfigured(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseMcpListOutput
// ---------------------------------------------------------------------------

describe('parseMcpListOutput', () => {
  it('parses connected and failed servers', () => {
    const stdout = 'weather  ✓ connected\nremote   ✗ failed to connect\n';
    const map = parseMcpListOutput(stdout);
    expect(map.get('weather')).toBe('connected');
    expect(map.get('remote')).toBe('failed');
  });

  it('parses word markers (no glyphs)', () => {
    const map = parseMcpListOutput('weather connected\nremote failed\nthird error\n');
    expect(map.get('weather')).toBe('connected');
    expect(map.get('remote')).toBe('failed');
    expect(map.get('third')).toBe('failed');
  });

  it('records unknown for unparseable status lines', () => {
    const map = parseMcpListOutput('mystery  ???\n');
    expect(map.get('mystery')).toBe('unknown');
  });

  it('skips header rows and blank lines', () => {
    const map = parseMcpListOutput('\nName  Status\nweather connected\n');
    expect(map.has('Name')).toBe(false);
    expect(map.get('weather')).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// AC1: addMcpServer (delegated)
// ---------------------------------------------------------------------------

describe('addMcpServer', () => {
  it('delegates to `claude mcp add --scope user` and lands the entry in the profile .claude.json', async () => {
    const { profileRootPath } = await makeProfile();
    const { capture, calls } = mockClaude();

    await addMcpServer(profileRootPath, stdioOptions(), { captureProcess: capture });

    // Delegation argv shape.
    expect(calls[0].args).toEqual(['mcp', 'add', '--scope', 'user', 'weather', '--', 'node', 'server.js']);
    // CLAUDE_CONFIG_DIR points at THIS profile's claude-home (real-home isolation).
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(path.join(profileRootPath, 'claude-home'));

    const json = await readProfileClaudeJson(profileRootPath);
    expect(json.mcpServers).toMatchObject({
      weather: { command: 'node', args: ['server.js'] },
    });
  });

  it('passes env via -e and lands the entry with env', async () => {
    const { profileRootPath } = await makeProfile();
    const { capture, calls } = mockClaude();

    await addMcpServer(profileRootPath, stdioOptions({ env: { API_KEY: 'secret-val' } }), { captureProcess: capture });

    expect(calls[0].args).toContain('-e');
    expect(calls[0].args).toContain('API_KEY=secret-val');
    const json = await readProfileClaudeJson(profileRootPath);
    expect((json.mcpServers as Record<string, Record<string, unknown>>).weather.env).toEqual({ API_KEY: 'secret-val' });
  });

  it('refuses when the server already exists', async () => {
    const { profileRootPath } = await makeProfile();
    const { capture } = mockClaude();
    await addMcpServer(profileRootPath, stdioOptions(), { captureProcess: capture });

    await expectCcpsError(
      () => addMcpServer(profileRootPath, stdioOptions(), { captureProcess: capture }),
      'MCP_SERVER_EXISTS',
    );
  });

  it('rejects stdio without a command', async () => {
    const { profileRootPath } = await makeProfile();
    const { capture } = mockClaude();
    await expectCcpsError(
      () => addMcpServer(profileRootPath, { name: 'x', transport: 'stdio' }, { captureProcess: capture }),
      'MCP_INVALID_CONFIG',
    );
  });

  it('rejects sse without a url', async () => {
    const { profileRootPath } = await makeProfile();
    const { capture } = mockClaude();
    await expectCcpsError(
      () => addMcpServer(profileRootPath, { name: 'x', transport: 'sse' }, { captureProcess: capture }),
      'MCP_INVALID_CONFIG',
    );
  });

  it('throws MCP_CLAUDE_UNAVAILABLE when claude cannot start', async () => {
    const { profileRootPath } = await makeProfile();
    await expectCcpsError(
      () => addMcpServer(profileRootPath, stdioOptions(), { captureProcess: throwingCapture() }),
      'MCP_CLAUDE_UNAVAILABLE',
    );
  });

  it('throws MCP_ADD_FAILED when claude exits non-zero', async () => {
    const { profileRootPath } = await makeProfile();
    const failing: CaptureProcess = async () => ({ exitCode: 1, stdout: '', stderr: 'bad', timedOut: false });
    await expectCcpsError(
      () => addMcpServer(profileRootPath, stdioOptions(), { captureProcess: failing }),
      'MCP_ADD_FAILED',
    );
  });

  it('does not touch the real home .claude.json (real-home isolation)', async () => {
    const { appHome, profileRootPath } = await makeProfile();
    // Sentinel "real home" outside the app home / profile tree.
    const realHome = path.join(path.dirname(appHome), 'real-home');
    await fs.ensureDir(realHome);
    await fs.writeJson(path.join(realHome, '.claude.json'), { sentinel: true }, { spaces: 2 });

    const originalHome = process.env.HOME;
    process.env.HOME = realHome;
    try {
      const { capture } = mockClaude();
      await addMcpServer(profileRootPath, stdioOptions(), { captureProcess: capture });

      // Profile .claude.json gained the entry.
      const profileJson = await readProfileClaudeJson(profileRootPath);
      expect((profileJson.mcpServers as Record<string, unknown>).weather).toBeDefined();
      // Real home .claude.json untouched.
      const realJson = await fs.readJson(path.join(realHome, '.claude.json'));
      expect(realJson).toEqual({ sentinel: true });
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

// ---------------------------------------------------------------------------
// AC1/AC6: removeMcpServer (delegated + fragment Bin item, zero-confirm)
// ---------------------------------------------------------------------------

describe('removeMcpServer', () => {
  it('delegates `claude mcp remove --scope user`, removes the entry, and creates a fragment Bin item', async () => {
    const { appHome, profileRootPath } = await makeProfile();
    const { capture, calls } = mockClaude();
    await addMcpServer(profileRootPath, stdioOptions({ env: { API_KEY: SECRET_TOKEN } }), { captureProcess: capture });

    const result = await removeMcpServer(profileRootPath, 'weather', {
      appHomePath: appHome,
      captureProcess: capture,
    });

    // Delegation argv.
    const removeCall = calls.find((c) => c.args[1] === 'remove');
    expect(removeCall?.args).toEqual(['mcp', 'remove', '--scope', 'user', 'weather']);
    expect(removeCall?.env.CLAUDE_CONFIG_DIR).toBe(path.join(profileRootPath, 'claude-home'));

    // Entry gone from .claude.json.
    const json = await readProfileClaudeJson(profileRootPath);
    expect((json.mcpServers as Record<string, unknown>).weather).toBeUndefined();

    // Fragment Bin item created with the right shape.
    const items = await listRecoveryBinItems(appHome);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe('mcp-server');
    expect(item.shape).toBe('fragment');
    expect(item.origin).toBe('remove');
    expect(item.profile).toBe('coding');
    expect(item.coordinates).toMatchObject({
      file: 'claude-home/.claude.json',
      keyPath: 'mcpServers.weather',
    });
    // env present → secret-bearing → 0700 directory.
    expect(item.secretBearing).toBe(true);
    // The fragment value carries the entry (for restore).
    const coords = item.coordinates as { value: Record<string, unknown> };
    expect(coords.value).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(result.recoveryItemDirPath).toBe(item.itemDirPath);
  });

  it('marks secretBearing false when the entry has no env', async () => {
    const { appHome, profileRootPath } = await makeProfile();
    const { capture } = mockClaude();
    await addMcpServer(profileRootPath, stdioOptions(), { captureProcess: capture });

    await removeMcpServer(profileRootPath, 'weather', { appHomePath: appHome, captureProcess: capture });

    const items = await listRecoveryBinItems(appHome);
    expect(items[0].secretBearing).toBe(false);
  });

  it('throws MCP_SERVER_NOT_FOUND and creates no Bin item when the server is absent', async () => {
    const { appHome, profileRootPath } = await makeProfile();
    const { capture } = mockClaude();

    await expectCcpsError(
      () => removeMcpServer(profileRootPath, 'nope', { appHomePath: appHome, captureProcess: capture }),
      'MCP_SERVER_NOT_FOUND',
    );
    expect(await listRecoveryBinItems(appHome)).toHaveLength(0);
  });

  it('throws MCP_REMOVE_FAILED and creates no Bin item when claude exits non-zero', async () => {
    const { appHome, profileRootPath } = await makeProfile();
    const addMock = mockClaude();
    await addMcpServer(profileRootPath, stdioOptions(), { captureProcess: addMock.capture });
    const failing: CaptureProcess = async () => ({ exitCode: 1, stdout: '', stderr: 'x', timedOut: false });

    await expectCcpsError(
      () => removeMcpServer(profileRootPath, 'weather', { appHomePath: appHome, captureProcess: failing }),
      'MCP_REMOVE_FAILED',
    );
    // No orphan Bin item.
    expect(await listRecoveryBinItems(appHome)).toHaveLength(0);
    // Entry still present (delegation failed).
    const json = await readProfileClaudeJson(profileRootPath);
    expect((json.mcpServers as Record<string, unknown>).weather).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC1: editMcpServer (remove + re-add, no Bin item)
// ---------------------------------------------------------------------------

describe('editMcpServer', () => {
  it('delegates remove then add, lands the new config, and creates no Bin item', async () => {
    const { appHome, profileRootPath } = await makeProfile();
    const { capture, calls } = mockClaude();
    await addMcpServer(profileRootPath, stdioOptions({ command: 'old-bin' }), { captureProcess: capture });

    await editMcpServer(
      profileRootPath,
      'weather',
      stdioOptions({ command: 'new-bin', args: ['v2.js'] }),
      { captureProcess: capture },
    );

    // remove then add sequence.
    const ops = calls.map((c) => c.args[1]);
    expect(ops).toContain('remove');
    expect(ops).toContain('add');
    // New config live.
    const json = await readProfileClaudeJson(profileRootPath);
    expect(json.mcpServers).toMatchObject({ weather: { command: 'new-bin', args: ['v2.js'] } });
    // No Bin item for edit.
    expect(await listRecoveryBinItems(appHome)).toHaveLength(0);
  });

  it('throws MCP_SERVER_NOT_FOUND when editing an absent server', async () => {
    const { profileRootPath } = await makeProfile();
    const { capture } = mockClaude();
    await expectCcpsError(
      () => editMcpServer(profileRootPath, 'nope', stdioOptions(), { captureProcess: capture }),
      'MCP_SERVER_NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// AC2: inspectMcpServers
// ---------------------------------------------------------------------------

describe('inspectMcpServers', () => {
  it('reports names, scope, transport, and connection state from `claude mcp list`', async () => {
    const { profileRootPath } = await makeProfile();
    await writeProfileClaudeJson(profileRootPath, {
      weather: { type: 'stdio', command: 'node', args: ['s.js'] },
      remote: { type: 'sse', url: 'https://example.com/sse' },
    });
    const { capture } = mockClaude({
      list: { exitCode: 0, stdout: 'weather  ✓ connected\nremote   ✗ failed\n', stderr: '', timedOut: false },
    });

    const result = await inspectMcpServers(profileRootPath, { captureProcess: capture });

    expect(result.connectionAvailable).toBe(true);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toMatchObject({ name: 'remote', transport: 'sse', connection: 'failed' });
    expect(result.servers[1]).toMatchObject({ name: 'weather', transport: 'stdio', connection: 'connected', scope: 'user' });
    expect(result.legacyMcpActive).toBe(false);
  });

  it('degrades all connections to unknown when claude is unavailable (no throw)', async () => {
    const { profileRootPath } = await makeProfile();
    await writeProfileClaudeJson(profileRootPath, { weather: { command: 'node' } });

    const result = await inspectMcpServers(profileRootPath, { captureProcess: throwingCapture() });

    expect(result.connectionAvailable).toBe(false);
    expect(result.servers[0].connection).toBe('unknown');
  });

  it('degrades to unknown when `claude mcp list` exits non-zero', async () => {
    const { profileRootPath } = await makeProfile();
    await writeProfileClaudeJson(profileRootPath, { weather: { command: 'node' } });
    const failing: CaptureProcess = async () => ({ exitCode: 1, stdout: '', stderr: 'x', timedOut: false });

    const result = await inspectMcpServers(profileRootPath, { captureProcess: failing });

    expect(result.connectionAvailable).toBe(false);
    expect(result.servers[0].connection).toBe('unknown');
  });

  it('returns an empty server list and skips the list call when no servers exist', async () => {
    const { profileRootPath } = await makeProfile();
    const { capture, calls } = mockClaude();

    const result = await inspectMcpServers(profileRootPath, { captureProcess: capture });

    expect(result.servers).toEqual([]);
    expect(result.connectionAvailable).toBe(false);
    expect(calls).toHaveLength(0); // no `claude mcp list` invocation
  });
});

// ---------------------------------------------------------------------------
// AC3: previewMcpServer (redacted)
// ---------------------------------------------------------------------------

describe('previewMcpServer', () => {
  it('returns a redacted view (command/args/env key names; never values)', async () => {
    const { profileRootPath } = await makeProfile();
    await writeProfileClaudeJson(profileRootPath, {
      weather: { type: 'stdio', command: 'node', args: ['s.js'], env: { API_KEY: SECRET_TOKEN } },
    });

    const preview = await previewMcpServer(profileRootPath, 'weather');

    expect(preview).toMatchObject({
      name: 'weather',
      transport: 'stdio',
      command: 'node',
      args: ['s.js'],
      envKeyNames: ['API_KEY'],
    });
    expect(JSON.stringify(preview)).not.toContain(SECRET_TOKEN);
  });

  it('throws MCP_SERVER_NOT_FOUND for an absent server', async () => {
    const { profileRootPath } = await makeProfile();
    await expectCcpsError(() => previewMcpServer(profileRootPath, 'nope'), 'MCP_SERVER_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// AC4: diffMcpServers (inventory only — never config values)
// ---------------------------------------------------------------------------

describe('diffMcpServers', () => {
  it('compares server inventory (name/transport/connection) with no config values', async () => {
    const a = await makeProfile('a');
    const b = await makeProfile('b');
    await writeProfileClaudeJson(a.profileRootPath, {
      shared: { type: 'stdio', command: 'node', args: ['s.js'], env: { API_KEY: SECRET_TOKEN } },
      onlyA: { type: 'sse', url: 'https://a.example.com/sse' },
    });
    await writeProfileClaudeJson(b.profileRootPath, {
      shared: { type: 'http', url: 'https://shared.example.com/mcp' },
      onlyB: { command: 'node' },
    });
    const { capture } = mockClaude({
      list: (call) => {
        // Distinguish profiles by cwd (profileRootPath) so the "shared" server
        // has different connection states across the two profiles.
        if (call.cwd === a.profileRootPath) {
          return { exitCode: 0, stdout: 'shared connected\nonlyA failed\n', stderr: '', timedOut: false };
        }
        return { exitCode: 0, stdout: 'shared failed\nonlyB connected\n', stderr: '', timedOut: false };
      },
    });

    const diff = await diffMcpServers(a.profileRootPath, b.profileRootPath, { captureProcess: capture });

    expect(diff.onlyInA).toEqual(['onlyA']);
    expect(diff.onlyInB).toEqual(['onlyB']);
    expect(diff.inBoth).toEqual([
      { name: 'shared', transportVerdict: 'different', connectionVerdict: 'different' },
    ]);
    // No config values leak into the diff result.
    assertNoCredentialShapes(diff, 'diff result');
    expect(JSON.stringify(diff)).not.toContain('node');
    expect(JSON.stringify(diff)).not.toContain('https://a.example.com');
  });
});

// ---------------------------------------------------------------------------
// AC5: copyMcpServerToProfile (non-secret fields, secrets prompted)
// ---------------------------------------------------------------------------

describe('copyMcpServerToProfile', () => {
  it('delegates add on the target with non-secret fields and returns stripped env key names', async () => {
    const src = await makeProfile('src');
    const tgt = await makeProfile('tgt');
    await writeProfileClaudeJson(src.profileRootPath, {
      weather: { type: 'stdio', command: 'node', args: ['s.js'], env: { API_KEY: SECRET_TOKEN, OTHER: 'x' } },
    });
    const { capture, calls } = mockClaude();

    const result = await copyMcpServerToProfile({
      sourceProfileRootPath: src.profileRootPath,
      sourceName: 'weather',
      targetProfileRootPath: tgt.profileRootPath,
      captureProcess: capture,
    });

    expect(result).toEqual({ copiedName: 'weather', strippedEnvKeys: ['API_KEY', 'OTHER'] });
    // Delegation targeted the TARGET profile claude-home (real-home isolation).
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(path.join(tgt.profileRootPath, 'claude-home'));
    // No -e flag (env values never copied).
    expect(calls[0].args.some((a) => a === '-e')).toBe(false);
    // Target landed with non-secret fields, no env.
    const tgtJson = await readProfileClaudeJson(tgt.profileRootPath);
    expect(tgtJson.mcpServers).toMatchObject({ weather: { command: 'node', args: ['s.js'] } });
    expect((tgtJson.mcpServers as Record<string, Record<string, unknown>>).weather.env).toBeUndefined();
    assertNoCredentialShapes(result, 'copy result');
  });

  it('copies an sse server (url, no env)', async () => {
    const src = await makeProfile('src');
    const tgt = await makeProfile('tgt');
    await writeProfileClaudeJson(src.profileRootPath, {
      remote: { type: 'sse', url: 'https://example.com/sse' },
    });
    const { capture } = mockClaude();

    const result = await copyMcpServerToProfile({
      sourceProfileRootPath: src.profileRootPath,
      sourceName: 'remote',
      targetProfileRootPath: tgt.profileRootPath,
      captureProcess: capture,
    });

    expect(result.strippedEnvKeys).toEqual([]);
    const tgtJson = await readProfileClaudeJson(tgt.profileRootPath);
    expect(tgtJson.mcpServers).toMatchObject({ remote: { type: 'sse', url: 'https://example.com/sse' } });
  });

  it('supports renaming on copy via targetName', async () => {
    const src = await makeProfile('src');
    const tgt = await makeProfile('tgt');
    await writeProfileClaudeJson(src.profileRootPath, { weather: { command: 'node' } });
    const { capture } = mockClaude();

    const result = await copyMcpServerToProfile({
      sourceProfileRootPath: src.profileRootPath,
      sourceName: 'weather',
      targetProfileRootPath: tgt.profileRootPath,
      targetName: 'weather-copy',
      captureProcess: capture,
    });

    expect(result.copiedName).toBe('weather-copy');
    const tgtJson = await readProfileClaudeJson(tgt.profileRootPath);
    expect((tgtJson.mcpServers as Record<string, unknown>)['weather-copy']).toBeDefined();
  });

  it('refuses when the target name already exists', async () => {
    const src = await makeProfile('src');
    const tgt = await makeProfile('tgt');
    await writeProfileClaudeJson(src.profileRootPath, { weather: { command: 'node' } });
    await writeProfileClaudeJson(tgt.profileRootPath, { weather: { command: 'other' } });
    const { capture } = mockClaude();

    await expectCcpsError(
      () =>
        copyMcpServerToProfile({
          sourceProfileRootPath: src.profileRootPath,
          sourceName: 'weather',
          targetProfileRootPath: tgt.profileRootPath,
          captureProcess: capture,
        }),
      'MCP_SERVER_EXISTS',
    );
  });

  it('throws MCP_SERVER_NOT_FOUND when the source server is absent', async () => {
    const src = await makeProfile('src');
    const tgt = await makeProfile('tgt');
    const { capture } = mockClaude();
    await expectCcpsError(
      () =>
        copyMcpServerToProfile({
          sourceProfileRootPath: src.profileRootPath,
          sourceName: 'nope',
          targetProfileRootPath: tgt.profileRootPath,
          captureProcess: capture,
        }),
      'MCP_SERVER_NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// AC6: restoreMcpServer (entry-level collision rules)
// ---------------------------------------------------------------------------

describe('restoreMcpServer', () => {
  async function setupRemovedServer(profileName = 'coding'): Promise<{
    appHome: string;
    profileRootPath: string;
    itemId: string;
  }> {
    const { appHome, profileRootPath } = await makeProfile(profileName);
    const { capture } = mockClaude();
    await addMcpServer(profileRootPath, stdioOptions({ env: { API_KEY: 'v' } }), { captureProcess: capture });
    await removeMcpServer(profileRootPath, 'weather', { appHomePath: appHome, captureProcess: capture });
    const items = await listRecoveryBinItems(appHome);
    return { appHome, profileRootPath, itemId: items[0].id };
  }

  it('writes the entry back and consumes the item on a clean restore', async () => {
    const { appHome, profileRootPath, itemId } = await setupRemovedServer();

    const result = await restoreMcpServer({ appHomePath: appHome, itemId });

    expect(result).toMatchObject({ restoredProfile: 'coding', restoredServerName: 'weather', consumed: true });
    const json = await readProfileClaudeJson(profileRootPath);
    expect(json.mcpServers).toMatchObject({ weather: { command: 'node' } });
    // Item consumed.
    expect(await listRecoveryBinItems(appHome)).toHaveLength(0);
  });

  it('refuses when a server with the same name already exists', async () => {
    const { appHome, profileRootPath, itemId } = await setupRemovedServer();
    // Re-create the server (so the name collides on restore).
    await writeProfileClaudeJson(profileRootPath, { weather: { command: 'other' } });

    await expectCcpsError(
      () => restoreMcpServer({ appHomePath: appHome, itemId }),
      'RESTORE_COLLISION',
    );
    // Item NOT consumed on refuse.
    expect(await listRecoveryBinItems(appHome)).toHaveLength(1);
  });

  it('restore-as-new-name writes under the new server name', async () => {
    const { appHome, profileRootPath, itemId } = await setupRemovedServer();
    await writeProfileClaudeJson(profileRootPath, { weather: { command: 'other' } });

    const result = await restoreMcpServer({
      appHomePath: appHome,
      itemId,
      collisionResolution: 'restore-as-new-name',
      newName: 'weather-restored',
    });

    expect(result.restoredServerName).toBe('weather-restored');
    const json = await readProfileClaudeJson(profileRootPath);
    expect((json.mcpServers as Record<string, unknown>)['weather-restored']).toBeDefined();
    expect((json.mcpServers as Record<string, unknown>).weather).toBeDefined(); // conflicting one kept
    expect(await listRecoveryBinItems(appHome)).toHaveLength(0);
  });

  it('restore-as-new-name requires a new name', async () => {
    const { appHome, itemId } = await setupRemovedServer();
    await expectCcpsError(
      () => restoreMcpServer({ appHomePath: appHome, itemId, collisionResolution: 'restore-as-new-name' }),
      'RESTORE_NEW_NAME_REQUIRED',
    );
  });

  it('delete-and-restore auto-bins the conflicting entry then restores', async () => {
    const { appHome, profileRootPath, itemId } = await setupRemovedServer();
    await writeProfileClaudeJson(profileRootPath, { weather: { command: 'conflict', env: { X: 'y' } } });

    await restoreMcpServer({ appHomePath: appHome, itemId, collisionResolution: 'delete-and-restore' });

    const json = await readProfileClaudeJson(profileRootPath);
    // Restored entry (original) is back.
    expect(json.mcpServers).toMatchObject({ weather: { command: 'node' } });
    // The conflicting entry became its own Bin item; the restore item was consumed.
    const items = await listRecoveryBinItems(appHome);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('mcp-server');
    const coords = items[0].coordinates as { value: Record<string, unknown> };
    expect(coords.value).toMatchObject({ command: 'conflict' });
  });
});

// ---------------------------------------------------------------------------
// AC7: validator legacy mcp.json finding
// ---------------------------------------------------------------------------

describe('validator LEGACY_MCP_CONFIG_ACTIVE finding', () => {
  it('warns when mcpMode is not none and legacy mcp.json has servers', async () => {
    const { appHome, paths } = await makeProfileWithLegacyMcp('strict');
    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'LEGACY_MCP_CONFIG_ACTIVE' }),
    );
    expect(result.status).toBe('warning'); // non-blocking
    expect(paths).toBeDefined();
  });

  it('warns for merge mode too (any non-none mcpMode)', async () => {
    const { appHome } = await makeProfileWithLegacyMcp('merge');
    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'LEGACY_MCP_CONFIG_ACTIVE' }),
    );
  });

  it('does not warn when mcpMode is none', async () => {
    const { appHome } = await makeProfileWithLegacyMcp('none');
    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });
    expect(result.findings.some((f) => f.code === 'LEGACY_MCP_CONFIG_ACTIVE')).toBe(false);
  });

  it('does not warn when legacy mcp.json has no servers', async () => {
    const { appHome, paths } = await makeProfileWithLegacyMcp('strict');
    await fs.writeJson(paths.mcpConfigPath, { mcpServers: {} }, { spaces: 2 });
    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });
    expect(result.findings.some((f) => f.code === 'LEGACY_MCP_CONFIG_ACTIVE')).toBe(false);
  });
});

async function makeProfileWithLegacyMcp(
  mcpMode: 'merge' | 'strict' | 'none',
): Promise<{ appHome: string; paths: ReturnType<typeof getProfileTemplatePaths> }> {
  const appHome = await makeAppHome();
  await createAppConfig(appHome);
  await createProfileFromTemplate({ appHomePath: appHome, name: 'coding', template: 'coding' });
  const paths = getProfileTemplatePaths(appHome, 'coding');
  // Set mcpMode and write a legacy mcp.json with a server.
  const profile = (await fs.readJson(paths.profileConfigPath)) as Record<string, unknown>;
  const launch = profile.launch as Record<string, unknown>;
  launch.mcpMode = mcpMode;
  await fs.writeJson(paths.profileConfigPath, profile, { spaces: 2 });
  await fs.writeJson(paths.mcpConfigPath, { mcpServers: { legacy: { command: 'node' } } }, { spaces: 2 });
  return { appHome, paths };
}

// ---------------------------------------------------------------------------
// Credential insulation across all view models
// ---------------------------------------------------------------------------

describe('credential insulation', () => {
  it('inspect never leaks a secret env value', async () => {
    const { profileRootPath } = await makeProfile();
    await writeProfileClaudeJson(profileRootPath, {
      weather: { type: 'stdio', command: 'node', env: { API_KEY: SECRET_TOKEN } },
    });
    const { capture } = mockClaude({
      list: { exitCode: 0, stdout: 'weather connected\n', stderr: '', timedOut: false },
    });
    const result = await inspectMcpServers(profileRootPath, { captureProcess: capture });
    assertNoCredentialShapes(result, 'inspect');
  });

  it('preview never leaks a secret env value', async () => {
    const { profileRootPath } = await makeProfile();
    await writeProfileClaudeJson(profileRootPath, {
      weather: { command: 'node', env: { API_KEY: SECRET_TOKEN } },
    });
    assertNoCredentialShapes(await previewMcpServer(profileRootPath, 'weather'), 'preview');
  });
});
