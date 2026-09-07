// Import commit boundary (issue #109, spec Implementation Decisions 6/11/12).
//
// Real import core service against synthetic bundles: the commit point is the
// publish rename of the fully validated + repaired staging tree into
// profiles/<name>. This suite pins the pre-commit/post-commit line:
//
//  - pre-commit failures (invalid profile.json schema, missing / directory /
//    corrupt / null / array / primitive / linked settings.json, links in any
//    surviving content) reject with IMPORT_* errors, create NO final
//    directory, leave existing profiles and external sentinels untouched, and
//    keep the name free for an immediate retry with a valid bundle;
//  - links inside swept-away runtime content are removed by the sweep and do
//    NOT abort the import (older bundles stay importable);
//  - post-commit MCP registration failures resolve with the ACTUAL published
//    profile + per-server statuses; the name is genuinely occupied afterwards
//    (never reported as a no-side-effect failure).

import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import {
  importProfile,
  type ImportConfirmFn,
  type ImportPreview,
} from '../src/core/profile-import';
import { getClaudeJsonPath } from '../src/core/mcp-servers';
import { exportProfile } from '../src/core/profile-export';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import type { CaptureProcess } from '../src/platform/process';

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeAppHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ccps-import-boundary-'));
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

/** Export `name` (default 'coding') from the app home as a fresh bundle. */
async function exportBundle(
  appHome: string,
  name = 'coding',
): Promise<{ bundlePath: string; outDir: string }> {
  const outDir = await mkdtemp(join(tmpdir(), 'ccps-import-boundary-bundle-'));
  tempRoots.push(outDir);
  const bundlePath = path.join(outDir, 'bundle.tar.gz');
  await exportProfile({
    appHomePath: appHome,
    name,
    outputPath: bundlePath,
    clock: FIXED_CLOCK,
  });
  return { bundlePath, outDir };
}

/**
 * Extract a real bundle, run `mutate` on the extracted tree (paths relative
 * to the tar root, e.g. `profile/claude-home/settings.json`), and repack.
 */
async function rebuildBundle(
  bundlePath: string,
  mutate: (tarRoot: string) => Promise<void>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ccps-import-boundary-tamper-'));
  tempRoots.push(dir);
  const tar = await import('tar');
  await tar.x({ file: bundlePath, cwd: dir });
  await mutate(dir);
  const out = path.join(dir, 'tampered.tar.gz');
  await tar.c({ gzip: true, file: out, cwd: dir, portable: true }, ['manifest.json', 'profile']);
  return out;
}

async function importBundle(
  appHome: string,
  bundlePath: string,
  options: {
    targetName?: string;
    confirm?: ImportConfirmFn;
    captureProcess?: CaptureProcess;
    previews?: ImportPreview[];
  } = {},
) {
  const confirm =
    options.confirm ??
    (async (preview: ImportPreview) => {
      options.previews?.push(preview);
      return { action: 'proceed' as const };
    });
  return importProfile({
    appHomePath: appHome,
    bundlePath,
    targetName: options.targetName ?? 'imported',
    confirm,
    captureProcess: options.captureProcess ?? mockClaudeAdd().capture,
    clock: FIXED_CLOCK,
  });
}

function profilePaths(appHome: string, name: string) {
  return getProfileTemplatePaths(appHome, name);
}

function profileNames(appHome: string): Promise<string[]> {
  return fs.readdir(path.join(appHome, 'profiles'));
}

async function stagingResidue(appHome: string): Promise<string[]> {
  return (await fs.readdir(appHome)).filter((name) => name.startsWith('.ccps-import-'));
}

/** Mirror of the Claude Code `mcp add --scope user` filesystem effect. */
function mockClaudeAdd(failOn?: (name: string) => boolean): {
  capture: CaptureProcess;
  calls: { args: string[]; claudeConfigDir: string }[];
} {
  const calls: { args: string[]; claudeConfigDir: string }[] = [];
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
  while (i < args.length) {
    const a = args[i];
    if (a === '--scope') {
      i += 2;
      continue;
    }
    if (a === '--transport') {
      transport = args[i + 1] as 'sse' | 'http';
      i += 2;
      continue;
    }
    if (a === '-e' || a === '--env') {
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
  writeMcpServer(claudeConfigDir, name, entry);
}

function writeMcpServer(
  claudeConfigDir: string,
  name: string,
  entry: Record<string, unknown>,
): void {
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

/** Give the source profile a native `.claude.json` with two servers. */
async function injectNativeMcpServers(appHome: string, name: string): Promise<void> {
  const paths = profilePaths(appHome, name);
  await fs.writeJson(paths.claudeUserConfigPath, {
    mcpServers: {
      github: { type: 'stdio', command: 'npx', args: ['-y', 'github-server'] },
      filesystem: { type: 'stdio', command: 'npx', args: ['-y', 'fs-server'] },
    },
  });
}

async function expectRejectedWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<{ message: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return { message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error(`expected rejection with code ${code}`);
}

// =============================================================================

describe('profile import commit boundary (issue #109)', () => {
  it('rejects a schema-invalid profile.json pre-commit; the name stays free for retry', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const { bundlePath } = await exportBundle(appHome);

    const tampered = await rebuildBundle(bundlePath, async (root) => {
      // profile.json present but not a Profile manifest (missing name).
      await fs.writeJson(path.join(root, 'profile', 'profile.json'), {
        template: 'coding',
        description: 'not a manifest',
      });
    });

    const { message } = await expectRejectedWithCode(
      importBundle(appHome, tampered),
      'IMPORT_PROFILE_INVALID',
    );
    expect(message).toMatch(/does not match the profile schema/);

    const target = profilePaths(appHome, 'imported');
    expect(await fs.pathExists(target.profileRootPath)).toBe(false);
    expect(await profileNames(appHome)).toEqual(['coding']);
    expect(await stagingResidue(appHome)).toEqual([]);

    // Same-name retry with a valid bundle succeeds immediately.
    const result = await importBundle(appHome, bundlePath, { targetName: 'imported' });
    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;
    expect(result.profileName).toBe('imported');
    expect(result.validation.status).toBe('valid');
    expect(await fs.pathExists(target.profileRootPath)).toBe(true);
  });

  it('rejects a bundle without settings.json and leaves no final directory', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const { bundlePath } = await exportBundle(appHome);

    const tampered = await rebuildBundle(bundlePath, async (root) => {
      await fs.remove(path.join(root, 'profile', 'claude-home', 'settings.json'));
    });

    const { message } = await expectRejectedWithCode(
      importBundle(appHome, tampered),
      'IMPORT_SETTINGS_INVALID',
    );
    expect(message).toMatch(/settings\.json is missing/);
    expect(await fs.pathExists(profilePaths(appHome, 'imported').profileRootPath)).toBe(false);
    expect(await stagingResidue(appHome)).toEqual([]);
  });

  it('rejects settings.json that is a directory, corrupt JSON, null, array, or primitive — never an empty-object fallback', async () => {
    const variants: { label: string; content: unknown; expected: string }[] = [
      { label: 'directory', content: 'DIRECTORY', expected: 'is not a file' },
      { label: 'corrupt JSON', content: '{ nope', expected: 'cannot be parsed as JSON' },
      { label: 'null', content: 'null', expected: 'is not a JSON object' },
      { label: 'array', content: '[]', expected: 'is not a JSON object' },
      { label: 'primitive string', content: '"just a string"', expected: 'is not a JSON object' },
      { label: 'primitive number', content: '42', expected: 'is not a JSON object' },
    ];

    for (const variant of variants) {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const { bundlePath } = await exportBundle(appHome);

      const tampered = await rebuildBundle(bundlePath, async (root) => {
        const settingsPath = path.join(root, 'profile', 'claude-home', 'settings.json');
        if (variant.content === 'DIRECTORY') {
          await fs.remove(settingsPath);
          await fs.ensureDir(settingsPath);
          await fs.writeFile(path.join(settingsPath, 'inner'), 'x');
        } else {
          await fs.writeFile(settingsPath, String(variant.content), 'utf8');
        }
      });

      const { message } = await expectRejectedWithCode(
        importBundle(appHome, tampered),
        'IMPORT_SETTINGS_INVALID',
      );
      expect(message).toContain(variant.expected);
      expect(
        await fs.pathExists(profilePaths(appHome, 'imported').profileRootPath),
        `settings variant: ${variant.label}`,
      ).toBe(false);
      // No staging residue for any variant.
      expect(await stagingResidue(appHome), `settings variant: ${variant.label}`).toEqual([]);
    }
  });

  it('refuses settings.json as a link at the resource boundary; external sentinel untouched', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const { bundlePath, outDir } = await exportBundle(appHome);

    // A sentinel outside the app home that a linked settings.json would point
    // at. If the import ever read or wrote THROUGH the link, this changes.
    const sentinelPath = path.join(outDir, 'external-settings-sentinel.json');
    await fs.writeJson(sentinelPath, { external: true, value: 'keep-me' });

    const tampered = await rebuildBundle(bundlePath, async (root) => {
      const settingsPath = path.join(root, 'profile', 'claude-home', 'settings.json');
      await fs.remove(settingsPath);
      await fs.symlink(sentinelPath, settingsPath);
    });

    const { message } = await expectRejectedWithCode(
      importBundle(appHome, tampered),
      'IMPORT_LINK_FORBIDDEN',
    );
    expect(message).toMatch(/claude-home\/settings\.json/);
    expect(await fs.readJson(sentinelPath)).toEqual({ external: true, value: 'keep-me' });
    expect(await fs.pathExists(profilePaths(appHome, 'imported').profileRootPath)).toBe(false);
    expect(await stagingResidue(appHome)).toEqual([]);
  });

  it('refuses claude-home and profile.json as links before anything is read or swept', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const { bundlePath, outDir } = await exportBundle(appHome);

    const sentinel = path.join(outDir, 'claude-home-sentinel');
    await fs.ensureDir(sentinel);
    await fs.writeJson(path.join(sentinel, 'settings.json'), { external: true });
    await fs.writeFile(path.join(sentinel, 'marker.txt'), 'sentinel', 'utf8');

    // claude-home as a link to an external directory: the sweep must never
    // readdir/remove through it (external marker stays), and no final profile
    // may appear.
    const claudeHomeLink = await rebuildBundle(bundlePath, async (root) => {
      await fs.remove(path.join(root, 'profile', 'claude-home'));
      await fs.symlink(sentinel, path.join(root, 'profile', 'claude-home'), 'dir');
    });
    await expectRejectedWithCode(importBundle(appHome, claudeHomeLink), 'IMPORT_LINK_FORBIDDEN');
    expect(await fs.readFile(path.join(sentinel, 'marker.txt'), 'utf8')).toBe('sentinel');
    expect(await fs.pathExists(profilePaths(appHome, 'imported').profileRootPath)).toBe(false);

    // profile.json as a link to an external file.
    const profileJsonLink = await rebuildBundle(bundlePath, async (root) => {
      const profileConfigPath = path.join(root, 'profile', 'profile.json');
      await fs.remove(profileConfigPath);
      await fs.symlink(path.join(outDir, 'external-profile.json'), profileConfigPath);
    });
    await fs.writeJson(path.join(outDir, 'external-profile.json'), { external: true });
    const { message } = await expectRejectedWithCode(
      importBundle(appHome, profileJsonLink),
      'IMPORT_LINK_FORBIDDEN',
    );
    expect(message).toMatch(/profile\.json/);
    expect(await fs.pathExists(profilePaths(appHome, 'imported').profileRootPath)).toBe(false);
  });

  it('refuses a link deep inside surviving content (auto-memory entrypoint)', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const { bundlePath, outDir } = await exportBundle(appHome);
    const sentinelPath = path.join(outDir, 'external-memory.md');
    await fs.writeFile(sentinelPath, '# external\n', 'utf8');

    const tampered = await rebuildBundle(bundlePath, async (root) => {
      const entrypoint = path.join(root, 'profile', 'claude-home', 'memory', 'auto', 'MEMORY.md');
      await fs.remove(entrypoint);
      await fs.symlink(sentinelPath, entrypoint);
    });

    const { message } = await expectRejectedWithCode(
      importBundle(appHome, tampered),
      'IMPORT_LINK_FORBIDDEN',
    );
    expect(message).toMatch(/memory\/auto\/MEMORY\.md/);
    expect(await fs.readFile(sentinelPath, 'utf8')).toBe('# external\n');
    expect(await fs.pathExists(profilePaths(appHome, 'imported').profileRootPath)).toBe(false);
  });

  it('keeps importing old bundles whose links live only in swept-away runtime content', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const { bundlePath, outDir } = await exportBundle(appHome);
    const sentinelPath = path.join(outDir, 'runtime-sentinel.txt');
    await fs.writeFile(sentinelPath, 'sentinel', 'utf8');

    // A pre-policy exporter could carry links inside runtime entries; the
    // sweep removes the whole runtime entry (link included) and the import
    // must not abort on it — only surviving content must be link-free.
    const tampered = await rebuildBundle(bundlePath, async (root) => {
      const sessionsDir = path.join(root, 'profile', 'claude-home', 'sessions');
      await fs.ensureDir(sessionsDir);
      await fs.symlink(sentinelPath, path.join(sessionsDir, 'linked.jsonl'));
    });

    const result = await importBundle(appHome, tampered);
    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;
    // Runtime content never landed; sentinel never touched.
    expect(
      await fs.pathExists(path.join(profilePaths(appHome, 'imported').claudeHomePath, 'sessions')),
    ).toBe(false);
    expect(await fs.readFile(sentinelPath, 'utf8')).toBe('sentinel');
    expect(result.validation.status).toBe('valid');
  });

  it('repairs a missing auto-memory entrypoint in staging (shared M1 identity repair)', async () => {
    // The bundle lacks memory/auto/MEMORY.md; the staged identity repair
    // (the same operation Backup/Restore uses, issue #108) recreates the
    // entrypoint before the publish, so the imported Profile is launchable
    // and validates clean instead of failing REQUIRED_FILE_MISSING.
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const { bundlePath } = await exportBundle(appHome);

    const tampered = await rebuildBundle(bundlePath, async (root) => {
      await fs.remove(path.join(root, 'profile', 'claude-home', 'memory', 'auto', 'MEMORY.md'));
    });

    const result = await importBundle(appHome, tampered);
    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;
    const target = profilePaths(appHome, 'imported');
    expect(await fs.pathExists(path.join(target.autoMemoryPath, 'MEMORY.md'))).toBe(true);
    expect(result.validation.status).toBe('valid');
  });

  it('rejects a staged .claude.json that cannot be read, before any publish', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectNativeMcpServers(appHome, 'coding');
    const { bundlePath } = await exportBundle(appHome);

    const tampered = await rebuildBundle(bundlePath, async (root) => {
      await fs.writeFile(
        path.join(root, 'profile', 'claude-home', '.claude.json'),
        '{ corrupt',
        'utf8',
      );
    });

    await expectRejectedWithCode(importBundle(appHome, tampered), 'IMPORT_CLAUDE_JSON_INVALID');
    expect(await fs.pathExists(profilePaths(appHome, 'imported').profileRootPath)).toBe(false);
    expect(await stagingResidue(appHome)).toEqual([]);
  });

  it('leaves an existing profile and an external sentinel byte-identical after a failed import', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'keeper');
    const keeperPaths = profilePaths(appHome, 'keeper');
    const before = {
      profileJson: await fs.readFile(keeperPaths.profileConfigPath, 'utf8'),
      settingsJson: await fs.readFile(keeperPaths.settingsPath, 'utf8'),
      claudeMd: await fs.readFile(keeperPaths.claudeMdPath, 'utf8'),
    };

    const sentinelPath = path.join(path.dirname(appHome), 'outside-sentinel.txt');
    await fs.writeFile(sentinelPath, 'outside-content', 'utf8');

    // Failing bundle targeting a FREE name (pre-commit rejection).
    const { bundlePath } = await exportBundle(appHome, 'keeper');
    const tampered = await rebuildBundle(bundlePath, async (root) => {
      await fs.writeFile(
        path.join(root, 'profile', 'claude-home', 'settings.json'),
        'null',
        'utf8',
      );
    });
    await expectRejectedWithCode(importBundle(appHome, tampered), 'IMPORT_SETTINGS_INVALID');

    // Existing profile byte-identical; sentinel untouched; only this staging
    // cleaned; no new profile dir.
    expect(await fs.readFile(keeperPaths.profileConfigPath, 'utf8')).toBe(before.profileJson);
    expect(await fs.readFile(keeperPaths.settingsPath, 'utf8')).toBe(before.settingsJson);
    expect(await fs.readFile(keeperPaths.claudeMdPath, 'utf8')).toBe(before.claudeMd);
    expect(await fs.readFile(sentinelPath, 'utf8')).toBe('outside-content');
    expect(await profileNames(appHome)).toEqual(['keeper']);
    expect(await stagingResidue(appHome)).toEqual([]);
  });

  it('post-commit MCP failures resolve with the actual published profile and per-server status', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectNativeMcpServers(appHome, 'coding');
    const { bundlePath } = await exportBundle(appHome);

    // github fails to re-register after the publish; filesystem succeeds.
    const { capture } = mockClaudeAdd((name) => name === 'github');
    const result = await importBundle(appHome, bundlePath, {
      targetName: 'imported',
      captureProcess: capture,
    });

    // NOT an error: the import succeeded and reports the actual outcome.
    expect('aborted' in result).toBe(false);
    if ('aborted' in result) return;
    expect(result.profileName).toBe('imported');

    const github = result.mcpServers.find((s) => s.name === 'github');
    const filesystem = result.mcpServers.find((s) => s.name === 'filesystem');
    expect(github?.reRegistered).toBe(false);
    expect(github?.failureMessage).toBeTruthy();
    expect(filesystem?.reRegistered).toBe(true);
    expect(result.validation.status).toBe('valid');

    // The profile is REALLY there — the published tree is not rolled back and
    // the failing server is visible as absent while the successful one lives
    // in the delegated-written .claude.json.
    const target = profilePaths(appHome, 'imported');
    expect(await fs.pathExists(target.profileRootPath)).toBe(true);
    const claudeJson = await fs.readJson(getClaudeJsonPath(target.profileRootPath));
    const servers = (claudeJson.mcpServers ?? {}) as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(['filesystem']);

    // The name is genuinely occupied: a retry surfaces a collision instead of
    // pretending the failed step left no side effects.
    const previews: ImportPreview[] = [];
    const retry = await importProfile({
      appHomePath: appHome,
      bundlePath,
      targetName: 'imported',
      confirm: async (preview) => {
        previews.push(preview);
        return { action: 'abort' };
      },
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });
    expect(previews).toHaveLength(1);
    expect(previews[0].collision).toBe(true);
    expect('aborted' in retry).toBe(true);
  });
});
