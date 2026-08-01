import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli';
import { createAppConfig } from '../src/core/app-config';
import { exportProfile } from '../src/core/profile-export';
import {
  importProfile,
  type ImportConfirmFn,
  type ImportPreview,
} from '../src/core/profile-import';
import { getClaudeJsonPath } from '../src/core/mcp-servers';
import {
  createProfileFromTemplate,
  getProfileTemplatePaths,
} from '../src/core/profile-template';
import type { CaptureProcess } from '../src/platform/process';

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');
// Assembled from fragments so the repo credential-insulation scan never sees a
// contiguous real shape. Used only to assert redaction/insulation.
const SECRET_TOKEN = 'sk-ant-' + 'api03-' + 'a'.repeat(30);
const MCP_TOKEN = 'ghp_' + 'secret' + '_token_456';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeAppHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ccps-import-'));
  tempRoots.push(root);
  const appHome = path.join(root, '.cc-profile-switch');
  await createAppConfig(appHome, { clock: FIXED_CLOCK });
  return appHome;
}

async function makeProfile(appHome: string, name: string): Promise<void> {
  await createProfileFromTemplate({
    appHomePath: appHome,
    name,
    template: 'coding',
    clock: FIXED_CLOCK,
  });
}

async function injectSecrets(appHome: string, name: string): Promise<void> {
  const paths = getProfileTemplatePaths(appHome, name);
  await fs.writeJson(paths.settingsPath, {
    autoMemoryDirectory: paths.autoMemoryPath,
    claudeMdExcludes: [],
    env: {
      ANTHROPIC_API_KEY: SECRET_TOKEN,
      ANTHROPIC_MODEL: 'claude-x',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    },
  });
  await fs.writeJson(paths.claudeUserConfigPath, {
    mcpServers: {
      github: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontext/server-github'],
        env: { GITHUB_TOKEN: MCP_TOKEN, EXTRA: 'plain' },
      },
      filesystem: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontext/server-filesystem'],
        env: { ROOT: '/tmp' },
      },
    },
  });
}

async function injectLegacyMcp(appHome: string, name: string): Promise<void> {
  const paths = getProfileTemplatePaths(appHome, name);
  await fs.writeJson(paths.mcpConfigPath, {
    mcpServers: {
      legacy: { command: 'node', args: ['s.js'], env: { LEGACY_TOKEN: 'legacy-secret' } },
    },
  });
}

async function exportBundle(
  appHome: string,
  name: string,
  options: { includeSecrets?: boolean } = {},
): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'ccps-import-bundle-'));
  tempRoots.push(outDir);
  const bundlePath = path.join(outDir, 'bundle.tar.gz');
  await exportProfile({
    appHomePath: appHome,
    name,
    outputPath: bundlePath,
    includeSecrets: options.includeSecrets,
    clock: FIXED_CLOCK,
  });
  return bundlePath;
}

// --- mock `claude mcp add` delegation -------------------------------------------
// Mirrors Claude Code's filesystem effect: `mcp add --scope user` writes the
// entry to $CLAUDE_CONFIG_DIR/.claude.json. `failOn` forces a non-zero exit for
// a named server so import's "failures listed, don't abort" path can be tested.

type RecordedCall = { args: string[]; claudeConfigDir: string };

function mockClaudeAdd(
  failOn?: (name: string) => boolean,
): { capture: CaptureProcess; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const capture: CaptureProcess = async (_command, args, options) => {
    const claudeConfigDir = options.env?.CLAUDE_CONFIG_DIR as string;
    calls.push({ args, claudeConfigDir });
    if (args[0] === 'mcp' && args[1] === 'add') {
      const name = parseAddName(args);
      if (name && failOn?.(name)) {
        return { exitCode: 1, stdout: '', stderr: 'mock add failure', timedOut: false };
      }
      applyMcpAdd(claudeConfigDir, args);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }
    return { exitCode: 1, stdout: '', stderr: 'no mock match', timedOut: false };
  };
  return { capture, calls };
}

function parseAddName(args: string[]): string | undefined {
  let i = 2;
  while (i < args.length) {
    const a = args[i];
    if (a === '--scope' || a === '--transport') {
      i += 2;
      continue;
    }
    if (a === '-e' || a === '--env') {
      i += 2;
      continue;
    }
    return a;
  }
  return undefined;
}

function applyMcpAdd(claudeConfigDir: string, args: string[]): void {
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
    break;
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
  writeMcpServer(claudeConfigDir, name, entry);
}

function writeMcpServer(claudeConfigDir: string, name: string, entry: Record<string, unknown>): void {
  const file = path.join(claudeConfigDir, '.claude.json');
  let json: Record<string, unknown> = {};
  try {
    json = fs.readJsonSync(file);
  } catch {
    json = {};
  }
  if (!isRecord(json.mcpServers)) {
    json.mcpServers = {};
  }
  (json.mcpServers as Record<string, unknown>)[name] = entry;
  fs.outputJsonSync(file, json, { spaces: 2 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- confirm callbacks ----------------------------------------------------------

function proceedConfirm(capture?: { previews: ImportPreview[] }): ImportConfirmFn {
  return async (preview) => {
    capture?.previews.push(preview);
    return { action: 'proceed' };
  };
}

function renameConfirm(newName: string, capture?: { previews: ImportPreview[] }): ImportConfirmFn {
  return async (preview) => {
    capture?.previews.push(preview);
    if (preview.collision) {
      return { action: 'proceed-as-new-name', targetName: newName };
    }
    return { action: 'proceed' };
  };
}

function abortConfirm(capture?: { previews: ImportPreview[] }): ImportConfirmFn {
  return async (preview) => {
    capture?.previews.push(preview);
    return { action: 'abort' };
  };
}

// =============================================================================

describe('profile import service', () => {
  it('surfaces the manifest preview and creates nothing before confirmation', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');

    const targetPaths = getProfileTemplatePaths(appHome, 'imported');
    let existedDuringConfirm = true;
    const seen: ImportPreview[] = [];
    const confirm: ImportConfirmFn = async (preview) => {
      existedDuringConfirm = await fs.pathExists(targetPaths.profileRootPath);
      seen.push(preview);
      return { action: 'proceed' };
    };

    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm,
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    expect(seen).toHaveLength(1);
    const preview = seen[0];
    expect(preview.collision).toBe(false);
    expect(preview.targetName).toBe('imported');
    expect(preview.manifest.profileName).toBe('coding');
    expect(preview.manifest.exporterVersion).toBe('0.1.0');
    // categories/counts present
    expect(preview.manifest.resources).toEqual({
      userMemory: 1,
      autoMemory: 1,
      skills: 0,
      agents: 0,
      mcpServers: 0,
      settings: 1,
      launchConfig: 1,
    });
    // nothing was created before the confirm callback returned
    expect(existedDuringConfirm).toBe(false);
    expect('aborted' in result).toBe(false);
    // the profile lands only after proceed
    expect(await fs.pathExists(targetPaths.profileRootPath)).toBe(true);
  });

  it('creates the profile from a default-mode bundle and auto-validates', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');

    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm: proceedConfirm(),
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;

    expect(result.profileName).toBe('imported');
    const paths = getProfileTemplatePaths(appHome, 'imported');
    expect(await fs.pathExists(paths.profileRootPath)).toBe(true);
    expect(await fs.pathExists(paths.claudeMdPath)).toBe(true);
    expect(await fs.pathExists(paths.profileConfigPath)).toBe(true);
    // profile.json re-stamped with the new name
    const profileJson = await fs.readJson(paths.profileConfigPath);
    expect(profileJson.name).toBe('imported');
    // auto-validate ran
    expect(result.validation.profileName).toBe('imported');
    expect(result.validation.status).toBe('valid');
  });

  it('refuses exact-name collision by default and offers import-as-new-name', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');

    const seen: ImportPreview[] = [];
    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      // no targetName → defaults to manifest.profileName = 'coding', which exists
      confirm: renameConfirm('coding-imported', { previews: seen }),
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;

    // The collision preview surfaces the conflict; choosing a new name commits
    // to proceed, so no second y/N preview is asked (the rename IS confirmation).
    expect(seen).toHaveLength(1);
    expect(seen[0].collision).toBe(true);
    expect(seen[0].targetName).toBe('coding');

    expect(result.profileName).toBe('coding-imported');
    const importedPaths = getProfileTemplatePaths(appHome, 'coding-imported');
    expect(await fs.pathExists(importedPaths.profileRootPath)).toBe(true);
  });

  it('aborts on collision when the user declines import-as-new-name', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');

    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      confirm: abortConfirm(),
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(true);
    // no new profile created
    expect(await fs.pathExists(getProfileTemplatePaths(appHome, 'coding').profileRootPath)).toBe(true);
  });

  it('re-registers MCP servers via delegated claude mcp add (never direct .claude.json writes)', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');

    const { capture, calls } = mockClaudeAdd();
    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm: proceedConfirm(),
      captureProcess: capture,
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;

    // each server re-registered through `claude mcp add --scope user`
    const addCalls = calls.filter((c) => c.args[1] === 'add');
    expect(addCalls.length).toBe(2);
    for (const call of addCalls) {
      expect(call.args).toContain('--scope');
      expect(call.args).toContain('user');
      // env values are NEVER passed during import (secret-in-memory rule)
      expect(call.args).not.toContain('-e');
      expect(call.args.some((a) => a.startsWith('ghp_'))).toBe(false);
    }

    // the imported profile's .claude.json carries the servers (written by
    // delegation), with command/args but no env values
    const claudeJson = await fs.readJson(getClaudeJsonPath(result.profileRootPath));
    const servers = claudeJson.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers).sort()).toEqual(['filesystem', 'github']);
    expect(servers.github.command).toBe('npx');
    expect(servers.github.args).toEqual(['-y', '@modelcontext/server-github']);
    // no env carried over from the bundle's direct write
    expect(servers.github.env).toBeUndefined();

    // per-server env key names reported for guided re-entry
    const github = result.mcpServers.find((s) => s.name === 'github');
    expect(github?.reRegistered).toBe(true);
    expect(github?.envKeysToReenter).toEqual(['EXTRA', 'GITHUB_TOKEN']);
  });

  it('lists MCP re-registration failures without aborting the rest or validate', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');

    // github fails, filesystem succeeds
    const { capture } = mockClaudeAdd((name) => name === 'github');
    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm: proceedConfirm(),
      captureProcess: capture,
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;

    const github = result.mcpServers.find((s) => s.name === 'github');
    const filesystem = result.mcpServers.find((s) => s.name === 'filesystem');
    expect(github?.reRegistered).toBe(false);
    expect(github?.failureMessage).toBeTruthy();
    expect(filesystem?.reRegistered).toBe(true);

    // profile still created and validated
    expect(await fs.pathExists(result.profileRootPath)).toBe(true);
    expect(result.validation.status).toBe('valid');
  });

  it('keeps stripped secrets as key-name placeholders and reports guided re-entry', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding'); // default mode strips

    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm: proceedConfirm(),
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;

    const paths = getProfileTemplatePaths(appHome, 'imported');
    const settings = await fs.readJson(paths.settingsPath);
    // placeholder values remain in the imported settings.json
    expect(settings.env.ANTHROPIC_API_KEY).toBe('<redacted>');
    expect(settings.env.ANTHROPIC_MODEL).toBe('<redacted>');
    expect(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');

    // guided re-entry reports the settings-env key names
    expect(result.settingsSecretKeysToReenter).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']),
    );

    // real secret value never lands in the imported profile tree
    expect(await treeContains(paths.profileRootPath, SECRET_TOKEN)).toBe(false);
    expect(await treeContains(paths.profileRootPath, MCP_TOKEN)).toBe(false);
  });

  it('include-secrets bundle restores settings.json values; MCP env still not passed via CLI', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding', { includeSecrets: true });

    const { capture, calls } = mockClaudeAdd();
    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm: proceedConfirm(),
      captureProcess: capture,
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;

    const paths = getProfileTemplatePaths(appHome, 'imported');
    const settings = await fs.readJson(paths.settingsPath);
    // real value restored (includeSecrets opt-in)
    expect(settings.env.ANTHROPIC_API_KEY).toBe(SECRET_TOKEN);
    // no settings-env re-entry needed
    expect(result.settingsSecretKeysToReenter).toEqual([]);

    // MCP env STILL never passed via `claude mcp add -e` during import
    const addCalls = calls.filter((c) => c.args[1] === 'add');
    expect(addCalls.length).toBe(2);
    for (const call of addCalls) {
      expect(call.args).not.toContain('-e');
    }
    // MCP env key names still reported for re-entry
    const github = result.mcpServers.find((s) => s.name === 'github');
    expect(github?.envKeysToReenter).toEqual(['EXTRA', 'GITHUB_TOKEN']);
  });

  it('preserves legacy mcp.json with redacted placeholders and reports re-entry keys', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectLegacyMcp(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');

    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm: proceedConfirm(),
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;

    const paths = getProfileTemplatePaths(appHome, 'imported');
    const mcpJson = await fs.readJson(paths.mcpConfigPath);
    expect(mcpJson.mcpServers.legacy.env.LEGACY_TOKEN).toBe('<redacted>');
    expect(result.legacyMcpEnvKeysToReenter).toEqual([{ server: 'legacy', keys: ['LEGACY_TOKEN'] }]);
  });

  it('repairs autoMemoryDirectory so validate passes for the new profile', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');

    const result = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm: proceedConfirm(),
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;

    const paths = getProfileTemplatePaths(appHome, 'imported');
    const settings = await fs.readJson(paths.settingsPath);
    expect(settings.autoMemoryDirectory).toBe(paths.autoMemoryPath);
    // no memory-directory mismatch finding
    expect(result.validation.findings.some((f) => f.code === 'PROFILE_MEMORY_DIRECTORY_MISMATCH')).toBe(false);
  });

  it('refuses a missing bundle', async () => {
    const appHome = await makeAppHome();
    await expect(
      importProfile({
        appHomePath: appHome,
        bundlePath: path.join(appHome, 'nope.tar.gz'),
        confirm: proceedConfirm(),
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_BUNDLE_NOT_FOUND' });
  });

  it('refuses a bundle with an invalid manifest', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const bundlePath = await exportBundle(appHome, 'coding');
    // tamper: rebuild the tar with a bad manifest
    const tampered = await rebuildBundleWithManifest(bundlePath, { not: 'a-manifest' });

    await expect(
      importProfile({
        appHomePath: appHome,
        bundlePath: tampered,
        confirm: proceedConfirm(),
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_MANIFEST_INVALID' });
  });

  it('refuses a tar that is not a ccps bundle (missing profile tree)', async () => {
    const appHome = await makeAppHome();
    const dir = await mkdtemp(join(tmpdir(), 'ccps-import-notbundle-'));
    tempRoots.push(dir);
    await fs.writeJson(path.join(dir, 'manifest.json'), { unrelated: true });
    const notBundle = path.join(dir, 'not.tar.gz');
    await tarPack(notBundle, dir, ['manifest.json']);

    await expect(
      importProfile({
        appHomePath: appHome,
        bundlePath: notBundle,
        confirm: proceedConfirm(),
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_BUNDLE_INVALID' });
  });
});

// --- CLI command ----------------------------------------------------------------

describe('import command output', () => {
  async function runCli(
    userHome: string,
    args: string[],
    options: { inputs?: string[]; capture?: CaptureProcess } = {},
  ): Promise<{ output: string; prompts: string[] }> {
    const output: string[] = [];
    const prompts: string[] = [];
    const inputs = [...(options.inputs ?? [])];
    const program = createProgram({
      writeOut: (value) => output.push(value),
      readInput: async (prompt) => {
        prompts.push(prompt);
        return inputs.shift() ?? '';
      },
      captureProcess: options.capture ?? mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    const originalHome = process.env.HOME;
    process.env.HOME = userHome;
    program.exitOverride();
    try {
      await program.parseAsync(['node', 'ccps', ...args], { from: 'node' });
      return { output: output.join(''), prompts };
    } finally {
      process.env.HOME = originalHome;
    }
  }

  async function setup(userHome: string): Promise<string> {
    const appHome = path.join(userHome, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: FIXED_CLOCK,
    });
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(paths.settingsPath, {
      autoMemoryDirectory: paths.autoMemoryPath,
      claudeMdExcludes: [],
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-secret-123',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      },
    });
    await fs.writeJson(paths.claudeUserConfigPath, {
      mcpServers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { GITHUB_TOKEN: 'ghp_secret' } },
      },
    });
    const outDir = await mkdtemp(join(tmpdir(), 'ccps-import-cli-out-'));
    tempRoots.push(outDir);
    const bundlePath = path.join(outDir, 'bundle.tar.gz');
    await exportProfile({ appHomePath: appHome, name: 'coding', outputPath: bundlePath, clock: FIXED_CLOCK });
    return bundlePath;
  }

  it('prints the manifest preview and result for a confirmed import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-import-cli-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    await fs.mkdir(userHome);
    const bundlePath = await setup(userHome);

    const { output } = await runCli(userHome, ['import', bundlePath, 'imported'], { inputs: ['y'] });

    expect(output).toContain('Bundle: ccps profile-bundle');
    expect(output).toContain('exporter ccps 0.1.0');
    expect(output).toContain('Import as: imported');
    expect(output).toContain('MCP servers: github');
    expect(output).toContain('Secrets: excluded');
    expect(output).toContain('Imported profile "imported"');
    expect(output).toContain('MCP servers re-registered: github');
    expect(output).toContain('MCP env keys to re-enter: github (GITHUB_TOKEN)');
    expect(output).toContain('Secrets to re-enter in settings.json: ANTHROPIC_API_KEY');
    expect(output).toContain('Validation: valid');
  });

  it('offers import-as-new-name on collision and imports under the new name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-import-cli-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    await fs.mkdir(userHome);
    const bundlePath = await setup(userHome);
    // 'coding' already exists → collision; typing a new name commits to proceed
    // (no second y/N — the rename is the confirmation).
    const { output, prompts } = await runCli(userHome, ['import', bundlePath], {
      inputs: ['coding-2'],
    });

    expect(prompts.some((p) => p.includes('A profile named "coding" already exists.'))).toBe(true);
    expect(output).toContain('Import as: coding (NAME EXISTS)');
    expect(output).toContain('Import as: coding-2');
    expect(output).toContain('Imported profile "coding-2"');
  });

  it('aborts when the user declines the collision prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-import-cli-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    await fs.mkdir(userHome);
    const bundlePath = await setup(userHome);
    // empty input at the collision prompt → abort
    const { output, prompts } = await runCli(userHome, ['import', bundlePath], { inputs: [''] });

    expect(prompts.some((p) => p.includes('A profile named "coding" already exists.'))).toBe(true);
    expect(output).toContain('Import as: coding (NAME EXISTS)');
    expect(output).toContain('Import aborted.');
    expect(output).not.toContain('Imported profile');
  });
});

// --- helpers --------------------------------------------------------------------

async function treeContains(dir: string, needle: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await treeContains(full, needle)) return true;
    } else if (entry.isFile()) {
      const content = await fs.readFile(full, 'utf8').catch(() => '');
      if (content.includes(needle)) return true;
    }
  }
  return false;
}

async function rebuildBundleWithManifest(
  bundlePath: string,
  manifest: unknown,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ccps-import-tamper-'));
  tempRoots.push(dir);
  const tar = await import('tar');
  await tar.x({ file: bundlePath, cwd: dir });
  await fs.writeJson(path.join(dir, 'manifest.json'), manifest);
  const out = path.join(dir, 'tampered.tar.gz');
  await tar.c({ gzip: true, file: out, cwd: dir, portable: true }, ['manifest.json', 'profile']);
  return out;
}

async function tarPack(outFile: string, cwd: string, entries: string[]): Promise<void> {
  const tar = await import('tar');
  await tar.c({ gzip: true, file: outFile, cwd, portable: true }, entries);
}
