import fs from 'fs-extra';
import { spawn as cpSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  atomicWriteJson,
  atomicWriteJsonSync,
  CCPS_TEMP_PREFIX,
  cleanupTmpResidue,
  createTempSiblingPath,
  encodeTempToken,
  jsonWriteIo,
  loadVersionedJson,
  parseTempName,
  saveVersionedJson,
  type VersionedJsonSpec,
} from '../src/core/versioned-json';
import { CcpsError } from '../src/utils/errors';

// Minimal v1→v2 migration spec for testing
const v2Schema = z
  .object({
    version: z.literal(2),
    name: z.string().default('default'),
    addedField: z.boolean().default(true),
  })
  .strict();

type TestV2 = z.infer<typeof v2Schema>;

const testSpec: VersionedJsonSpec<TestV2, 2> = {
  fileName: 'test.json',
  currentVersion: 2,
  currentSchema: v2Schema,
  migrate: (raw: unknown, rawVersion: number): TestV2 => {
    if (rawVersion === 1 && typeof raw === 'object' && raw !== null) {
      const old = raw as Record<string, unknown>;
      return {
        version: 2,
        name: typeof old.name === 'string' ? old.name : 'default',
        addedField: true,
      };
    }
    throw new CcpsError('TEST_MIGRATION_FAILED', `Cannot migrate from version ${rawVersion}.`, {
      guidance: 'This is a test error.',
    });
  },
  errorPrefix: 'TEST_CONFIG',
};

describe('atomicWriteJson', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-atomic-'));
    tempRoots.push(dir);
    return dir;
  }

  it('writes valid JSON with trailing newline', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 1, name: 'test' });

    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('{\n  "version": 1,\n  "name": "test"\n}\n');
  });

  it('overwrites an existing file atomically', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 1 });
    await atomicWriteJson(filePath, { version: 2 });

    const content = await fs.readFile(filePath, 'utf8');
    expect(JSON.parse(content)).toEqual({ version: 2 });
  });

  it('leaves no temp file on success', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 1 });

    const files = await fs.readdir(dir);
    expect(files).toEqual(['test.json']);
  });

  it('never leaves a partial target behind when the final rename fails (EISDIR)', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    // No target exists beforehand; the fault hits after the temp write. The
    // contract under test: a failed publish must not leave a half-published
    // target at filePath.
    await fs.writeFile(join(dir, 'payload.tmp'), 'stale', 'utf8');
    vi.spyOn(jsonWriteIo, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('target is a directory'), { code: 'EISDIR' }),
    );

    await expect(atomicWriteJson(filePath, { version: 1 })).rejects.toMatchObject({
      code: 'EISDIR',
    });

    await expect(fs.pathExists(filePath)).resolves.toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['payload.tmp']);
    vi.restoreAllMocks();
  });
});

describe('atomicWriteJsonSync', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-atomic-sync-'));
    tempRoots.push(dir);
    return dir;
  }

  it('mirrors the async contract (payload, exclusive create, no residue)', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    atomicWriteJsonSync(filePath, { version: 1, name: 'sync' });

    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('{\n  "version": 1,\n  "name": "sync"\n}\n');
    expect(await fs.readdir(dir)).toEqual(['test.json']);
  });

  it('removes its own temp when the write fails', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    const writeSpy = vi.spyOn(jsonWriteIo, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });

    expect(() => atomicWriteJsonSync(filePath, { version: 1 })).toThrow();

    expect(await fs.readdir(dir)).toEqual([]);
    writeSpy.mockRestore();
  });

  it('removes its own temp when the rename fails', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    const renameSpy = vi.spyOn(jsonWriteIo, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    });

    expect(() => atomicWriteJsonSync(filePath, { version: 1 })).toThrow();

    expect(await fs.readdir(dir)).toEqual([]);
    renameSpy.mockRestore();
  });
});

describe('cleanupTmpResidue', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-cleanup-'));
    tempRoots.push(dir);
    return dir;
  }

  it('preserves user .tmp files, directories, unknown formats and old CCPS names', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(join(dir, 'user-notes.tmp'), 'authored', 'utf8');
    await fs.ensureDir(join(dir, 'user-scratch.tmp'));
    await fs.writeFile(join(dir, '.ccps-tmp-garbage-no-meta'), 'not the protocol', 'utf8');
    await fs.writeFile(join(dir, 'config.json.tmp'), '{}', 'utf8');

    await cleanupTmpResidue(dir);

    expect(await fs.readFile(join(dir, 'user-notes.tmp'), 'utf8')).toBe('authored');
    expect(await fs.pathExists(join(dir, 'user-scratch.tmp'))).toBe(true);
    expect(await fs.pathExists(join(dir, '.ccps-tmp-garbage-no-meta'))).toBe(true);
    expect(await fs.pathExists(join(dir, 'config.json.tmp'))).toBe(true);
  });

  /** Build a protocol temp file named for `targetName` (optionally nested at
   * `relDir` below `dir`) whose recorded writer pid is `pid`. Mirrors the
   * real writer: meta.f records the target's basename. */
  async function plantResidue(
    dir: string,
    targetName: string,
    pid: number,
    relDir = '',
  ): Promise<string> {
    const leaf = basename(targetName);
    const meta = { f: leaf, p: pid, t: Date.now(), n: 'aaaabbbbcccc' };
    const name = `${CCPS_TEMP_PREFIX}${encodeTempToken(leaf)}-${encodeTempToken(
      JSON.stringify(meta),
    )}`;
    const tempPath = relDir ? join(dir, relDir, name) : join(dir, name);
    await fs.writeFile(tempPath, '{}', 'utf8');
    return tempPath;
  }

  /** Spawn a short-lived `node -e` process, wait for it to exit, and return
   * its pid — a genuinely ended writer for liveness-probe assertions. */
  async function spawnExitedPid(): Promise<number> {
    return new Promise<number>((resolveChild, rejectChild) => {
      const child = cpSpawn(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: 'ignore',
      });
      child.on('error', rejectChild);
      child.on('close', () => resolveChild(child.pid as number));
    });
  }

  it('removes residue whose recorded writer is confirmed ended', async () => {
    const dir = await makeTempDir();
    const deadPid = await spawnExitedPid();
    const residue = await plantResidue(dir, 'config.json', deadPid);
    // A second ended writer whose pid no live process can hold: 2**30 is
    // above every real pid_max (Linux caps at 2**22, macOS at 99998) yet
    // still inside the signal-0 addressable range, so the probe answers
    // ESRCH deterministically — unlike deadPid + N guesses, which can
    // collide with a live pid on high-pid_max hosts.
    const guaranteedDeadPid = 2 ** 30;
    const residue2 = await plantResidue(dir, 'config.json', guaranteedDeadPid);

    await cleanupTmpResidue(dir);

    expect(await fs.pathExists(residue)).toBe(false);
    expect(await fs.pathExists(residue2)).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('preserves residue whose recorded writer pid belongs to a live process', async () => {
    const dir = await makeTempDir();
    const child = cpSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    });
    child.unref();
    const liveChildPid = child.pid as number;
    try {
      const residue = await plantResidue(dir, 'config.json', liveChildPid);
      const residue2 = await plantResidue(dir, 'config.json', process.pid);

      await cleanupTmpResidue(dir);

      expect(await fs.pathExists(residue)).toBe(true);
      expect(await fs.pathExists(residue2)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('preserves residue when writer liveness cannot be determined', async () => {
    const dir = await makeTempDir();
    const deadPid = await spawnExitedPid();
    const residue = await plantResidue(dir, 'config.json', deadPid);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('unknown'), { code: 'EBADF' });
    });

    await cleanupTmpResidue(dir);

    expect(await fs.pathExists(residue)).toBe(true);
    killSpy.mockRestore();
  });

  it('removes nested protocol residue under profiles/ but not user .tmp files', async () => {
    const dir = await makeTempDir();
    await fs.ensureDir(join(dir, 'profiles', 'alpha', 'claude-home'));
    await fs.writeFile(join(dir, 'profiles', 'alpha', 'profile.json'), '{}', 'utf8');
    const deadPid = await spawnExitedPid();
    const residue = await plantResidue(
      dir,
      join('profiles', 'alpha', 'profile.json'),
      deadPid,
      'profiles/alpha',
    );
    const claudeHomeResidue = await plantResidue(
      dir,
      'settings.json',
      deadPid,
      'profiles/alpha/claude-home',
    );
    await fs.writeFile(join(dir, 'profiles', 'alpha', 'user-notes.tmp'), 'authored', 'utf8');

    await cleanupTmpResidue(dir);

    expect(await fs.pathExists(residue)).toBe(false);
    expect(await fs.pathExists(claudeHomeResidue)).toBe(false);
    expect(await fs.readFile(join(dir, 'profiles', 'alpha', 'user-notes.tmp'), 'utf8')).toBe(
      'authored',
    );
    expect(await fs.pathExists(join(dir, 'profiles', 'alpha', 'profile.json'))).toBe(true);
  });

  it('does not traverse backups/ (durable store stays untouched)', async () => {
    const dir = await makeTempDir();
    await fs.ensureDir(join(dir, 'backups', 'alpha-2026-01-01', 'claude-home'));
    const residue = createTempSiblingPath(
      join(dir, 'backups', 'alpha-2026-01-01', 'claude-home', 'settings.json'),
    );
    await fs.writeFile(residue, '{}', 'utf8');

    await cleanupTmpResidue(dir);

    expect(await fs.pathExists(residue)).toBe(true);
  });

  it('does not descend into symlinked directories', async () => {
    const dir = await makeTempDir();
    const outside = await mkdtemp(join(tmpdir(), 'ccps-cleanup-outside-'));
    tempRoots.push(outside);
    const outsideResidue = createTempSiblingPath(join(outside, 'config.json'));
    await fs.writeFile(outsideResidue, '{}', 'utf8');
    await fs.ensureDir(join(dir, 'profiles'));
    await fs.symlink(outside, join(dir, 'profiles', 'linked'));

    await cleanupTmpResidue(dir);

    expect(await fs.pathExists(outsideResidue)).toBe(true);
    // Cleanup never materializes or removes foreign content behind a link.
    expect(await fs.pathExists(join(dir, 'profiles', 'linked'))).toBe(true);
  });

  it('does not treat a symlinked file as removable residue', async () => {
    const dir = await makeTempDir();
    const outside = await mkdtemp(join(tmpdir(), 'ccps-cleanup-link2-'));
    tempRoots.push(outside);
    const outsideFile = join(outside, 'real');
    await fs.writeFile(outsideFile, 'keep me', 'utf8');
    await fs.ensureDir(join(dir, 'profiles', 'alpha'));
    const linkName = createTempSiblingPath(join(dir, 'profiles', 'alpha', 'config.json'));
    await fs.symlink(outsideFile, linkName);

    await cleanupTmpResidue(dir);

    expect(await fs.readFile(outsideFile, 'utf8')).toBe('keep me');
  });

  it('does not descend past the bounded depth into Claude-managed bulk', async () => {
    const dir = await makeTempDir();
    const deepDir = join(dir, 'profiles', 'alpha', 'claude-home', 'projects');
    await fs.ensureDir(deepDir);
    const deepResidue = createTempSiblingPath(join(deepDir, 'session.json'));
    await fs.writeFile(deepResidue, '{}', 'utf8');

    await cleanupTmpResidue(dir);

    expect(await fs.pathExists(deepResidue)).toBe(true);
  });

  it('is a no-op when no CCPS residue exists', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(join(dir, 'config.json'), '{}', 'utf8');

    await cleanupTmpResidue(dir);

    expect(await fs.readdir(dir)).toEqual(['config.json']);
  });

  it('tolerates an app home without profiles/ or backups/', async () => {
    const dir = await makeTempDir();

    await expect(cleanupTmpResidue(dir)).resolves.toBeUndefined();
  });
});

describe('temp protocol names', () => {
  it('round-trips through parse and never collides across writers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-protocol-'));
    try {
      const names = new Set<string>();
      for (let i = 0; i < 50; i += 1) {
        const tempPath = createTempSiblingPath(join(dir, 'config.json'));
        expect(tempPath.startsWith(join(dir, CCPS_TEMP_PREFIX))).toBe(true);
        const parsed = parseTempName(basename(tempPath));
        expect(parsed?.targetName).toBe('config.json');
        expect(parsed?.meta.p).toBe(process.pid);
        expect(parsed?.meta.n).toHaveLength(12);
        names.add(tempPath);
      }
      expect(names.size).toBe(50);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects foreign and malformed names', () => {
    expect(parseTempName('config.json.tmp')).toBeNull();
    expect(parseTempName('.ccps-tmp-')).toBeNull();
    expect(parseTempName('.ccps-tmp-abc')).toBeNull();
    expect(parseTempName('.ccps-tmp-a~b-c!d')).toBeNull();
    // Target name containing a path separator is refused.
    const traversal = `${CCPS_TEMP_PREFIX}${encodeTempToken('..\\x')}-${encodeTempToken(
      JSON.stringify({ f: '..\\x', p: 1, t: 1, n: 'n' }),
    )}`;
    expect(parseTempName(traversal)).toBeNull();
  });
});

describe('permissions', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-perms-'));
    tempRoots.push(dir);
    return dir;
  }

  it('replaces an existing 0600 file without widening (async and sync)', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'secret.json');
    await fs.writeFile(filePath, '{}', { mode: 0o600 });
    await fs.chmod(filePath, 0o600);

    await atomicWriteJson(filePath, { replaced: true });
    // Cross-platform behavior check (win32 included): the replacement exists
    // and is writable by the owner.
    let stats = await fs.stat(filePath);
    expect(stats.mode & 0o200).toBe(0o200);
    expect(await fs.readFile(filePath, 'utf8')).toBe(
      JSON.stringify({ replaced: true }, null, 2) + '\n',
    );

    // POSIX-only mode bits (S99 RM-Windows carve-out): libuv on win32
    // synthesizes st_mode from the read-only flag alone (writable 0o666,
    // read-only 0o444), so mode-bit equality is unverifiable there.
    if (process.platform !== 'win32') {
      expect(stats.mode & 0o777).toBe(0o600);
    }

    atomicWriteJsonSync(filePath, { replaced: 'sync' });
    expect(await fs.readFile(filePath, 'utf8')).toBe(
      JSON.stringify({ replaced: 'sync' }, null, 2) + '\n',
    );
    if (process.platform !== 'win32') {
      stats = await fs.stat(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the temp file 0600 while it exists for a restricted replacement', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'secret.json');
    await fs.writeFile(filePath, '{}', { mode: 0o600 });
    await fs.chmod(filePath, 0o600);

    let tempSeen: string | null = null;
    const renameSpy = vi.spyOn(jsonWriteIo, 'rename').mockImplementationOnce(async (from, to) => {
      tempSeen = from;
      // The temp carries the restricted mode before the rename (POSIX only:
      // libuv on win32 synthesizes st_mode from the read-only flag, so the
      // 0600 bit pattern is not observable there).
      if (process.platform !== 'win32') {
        const tempStats = await fs.stat(from);
        expect(tempStats.mode & 0o777).toBe(0o600);
      }
      return jsonWriteIo.rename(from, to);
    });

    await atomicWriteJson(filePath, { replaced: true });
    expect(tempSeen).not.toBeNull();
    expect(await fs.readdir(dir)).toEqual(['secret.json']);
    renameSpy.mockRestore();
  });

  it('replicates an existing 0644 file without widening it (chmod works here)', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'plain.json');
    await fs.writeFile(filePath, '{}', { mode: 0o644 });
    await fs.chmod(filePath, 0o644);

    await atomicWriteJson(filePath, { replaced: true });
    expect(await fs.readFile(filePath, 'utf8')).toBe(
      JSON.stringify({ replaced: true }, null, 2) + '\n',
    );
    // POSIX-only mode bits (S99 RM-Windows carve-out).
    if (process.platform !== 'win32') {
      const stats = await fs.stat(filePath);
      expect(stats.mode & 0o777).toBe(0o644);
    }
  });

  it('never widens when chmod is ineffective on the temp', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'plain.json');
    await fs.writeFile(filePath, '{}', { mode: 0o644 });
    await fs.chmod(filePath, 0o644);

    const chmodSpy = vi.spyOn(jsonWriteIo, 'chmod').mockRejectedValueOnce(new Error('EBADF'));

    await atomicWriteJson(filePath, { replaced: true });
    // Cross-platform behavior check (win32 included): the replacement exists
    // and is owner-writable — i.e. the failed chmod never produced a
    // read-only file.
    expect(await fs.readFile(filePath, 'utf8')).toBe(
      JSON.stringify({ replaced: true }, null, 2) + '\n',
    );
    // POSIX-only mode bits (S99 RM-Windows carve-out): the failed chmod
    // leaves the replacement at the temp's 0600 — tighter than the old
    // 0644, never wider.
    if (process.platform !== 'win32') {
      const stats = await fs.stat(filePath);
      expect(stats.mode & 0o077).toBe(0);
      expect(stats.mode & 0o400).toBe(0o400);
    }
    chmodSpy.mockRestore();
  });

  it('creates new files with default permissions (umask applies as before)', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'fresh.json');

    await atomicWriteJson(filePath, { fresh: true });
    expect(await fs.readFile(filePath, 'utf8')).toBe(
      JSON.stringify({ fresh: true }, null, 2) + '\n',
    );
    // POSIX-only mode bits (S99 RM-Windows carve-out): 0o666 creation mode
    // with the process umask applied, exactly as the previous
    // writeFile-based behavior.
    if (process.platform !== 'win32') {
      const stats = await fs.stat(filePath);
      expect(stats.mode & 0o777).toBe(0o644 & ~process.umask());
    }
  });
});

describe('loadVersionedJson', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-load-'));
    tempRoots.push(dir);
    return dir;
  }

  it('loads a current-version file', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 2, name: 'mine' });

    const result = await loadVersionedJson(testSpec, filePath);
    expect(result).toEqual({ version: 2, name: 'mine', addedField: true });
  });

  it('migrates an old-version file filling defaults in memory without writing', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 1, name: 'old' });

    const result = await loadVersionedJson(testSpec, filePath);
    expect(result).toEqual({ version: 2, name: 'old', addedField: true });

    // Read path never writes — file on disk is still v1
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(onDisk.version).toBe(1);
  });

  it('rejects unknown fields loudly', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 2, name: 'ok', unknownExtra: true });

    await expect(loadVersionedJson(testSpec, filePath)).rejects.toMatchObject({
      code: 'TEST_CONFIG_INVALID',
    });
  });

  it('rejects a future version with upgrade advice', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 99 });

    await expect(loadVersionedJson(testSpec, filePath)).rejects.toMatchObject({
      code: 'TEST_CONFIG_FUTURE_VERSION',
    });
  });

  it('rejects a missing version field', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { name: 'noversion' });

    await expect(loadVersionedJson(testSpec, filePath)).rejects.toMatchObject({
      code: 'TEST_CONFIG_INVALID_VERSION',
    });
  });

  it('rejects a non-numeric version field', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 'two' });

    await expect(loadVersionedJson(testSpec, filePath)).rejects.toMatchObject({
      code: 'TEST_CONFIG_INVALID_VERSION',
    });
  });

  it('rejects corrupt JSON', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await fs.writeFile(filePath, '{broken', 'utf8');

    await expect(loadVersionedJson(testSpec, filePath)).rejects.toMatchObject({
      code: 'TEST_CONFIG_INVALID_JSON',
    });
  });

  it('rejects a missing file', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');

    await expect(loadVersionedJson(testSpec, filePath)).rejects.toMatchObject({
      code: 'TEST_CONFIG_NOT_FOUND',
    });
  });
});

describe('saveVersionedJson', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-save-'));
    tempRoots.push(dir);
    return dir;
  }

  it('validates and writes atomically', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    const result = await saveVersionedJson(testSpec, filePath, {
      version: 2,
      name: 'saved',
      addedField: true,
    });

    expect(result).toEqual({ version: 2, name: 'saved', addedField: true });
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(onDisk).toEqual({ version: 2, name: 'saved', addedField: true });
  });

  it('rejects data that does not match the current schema', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');

    await expect(
      saveVersionedJson(testSpec, filePath, {
        version: 2,
        name: 'ok',
        unknownExtra: true,
      } as TestV2),
    ).rejects.toMatchObject({
      code: 'TEST_CONFIG_INVALID',
    });
  });
});

// ─── Multi-process concurrency (issue #106) ────────────────────────────────
//
// These cases spawn real `node --import tsx` child processes that all
// saveVersionedJson the same file simultaneously — the ENOENT storm from the
// shared `filePath + '.tmp'` temp path was a genuine cross-process failure,
// not an in-process interleaving.

describe('multi-process concurrent whole-document saves', () => {
  const tempRoots: string[] = [];
  let childModulePath: string;

  beforeAll(() => {
    childModulePath = join(__dirname, '..', 'src', 'core', 'versioned-json.ts');
  });

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-concurrent-'));
    tempRoots.push(dir);
    return dir;
  }

  type ChildOutcome = {
    exitCode: number;
    stderr: string;
    pid: number;
  };

  /** Spawn `writerCount` real child processes; half write through
   * saveVersionedJson, half through saveVersionedJsonSync, all on the same
   * target file (20 whole-document publishes per child). */
  async function runConcurrentWriters(dir: string, writerCount: number): Promise<ChildOutcome[]> {
    const childScript = `
      const { saveVersionedJson, saveVersionedJsonSync } = require(${JSON.stringify(
        childModulePath,
      )});
      const target = process.argv[2];
      const tag = process.argv[3];
      const mode = process.argv[4] || 'async';
      const spec = {
        fileName: 'shared.json',
        currentVersion: 2,
        currentSchema: {
          safeParse: (raw) => ({ success: true, data: raw }),
        },
        migrate: (raw) => raw,
        errorPrefix: 'SHARED',
      };
      (async () => {
        for (let i = 0; i < 20; i += 1) {
          if (mode === 'sync') {
            saveVersionedJsonSync(spec, target, { version: 2, tag, pid: process.pid, seq: i });
          } else {
            await saveVersionedJson(spec, target, { version: 2, tag, pid: process.pid, seq: i });
          }
        }
        console.log('done');
        process.exit(0);
      })().catch((error) => {
        console.error(error && error.stack ? error.stack : String(error));
        process.exit(1);
      });
    `;
    const scriptPath = join(dir, `writer-${process.pid}.js`);
    await fs.writeFile(scriptPath, childScript, 'utf8');

    const children: Promise<ChildOutcome>[] = [];
    for (let i = 0; i < writerCount; i += 1) {
      const mode = i % 2 === 0 ? 'async' : 'sync';
      children.push(
        new Promise<ChildOutcome>((resolveChild, rejectChild) => {
          const child = cpSpawn(
            process.execPath,
            ['--import', 'tsx', scriptPath, join(dir, 'shared.json'), `writer-${i}`, mode],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stderr = '';
          child.stdout?.on('data', () => {});
          child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
          });
          child.on('error', rejectChild);
          child.on('close', (exitCode) => {
            resolveChild({ exitCode: exitCode ?? -1, stderr, pid: child.pid ?? -1 });
          });
        }),
      );
    }
    const outcomes = await Promise.all(children);
    await fs.remove(scriptPath);
    return outcomes;
  }

  it('12 concurrent writers publish complete JSON documents without ENOENT', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'shared.json');

    const outcomes = await runConcurrentWriters(dir, 12);

    for (const outcome of outcomes) {
      expect(outcome.exitCode, `writer pid ${outcome.pid} failed: ${outcome.stderr}`).toBe(0);
    }
    // Every published document parses and is a complete single-writer value.
    for (let i = 0; i < 5; i += 1) {
      const published = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(published.version).toBe(2);
      expect(typeof published.pid).toBe('number');
      expect(typeof published.seq).toBe('number');
    }
    // No residue: the last writer out leaves nothing behind.
    const residue = (await fs.readdir(dir)).filter((name) => name.startsWith('.ccps-tmp-'));
    expect(residue).toEqual([]);
  });

  it('mixed sync and async writers leave no temp residue', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'shared.json');

    const outcomes = await runConcurrentWriters(dir, 6);

    for (const outcome of outcomes) {
      expect(outcome.exitCode, `writer failed: ${outcome.stderr}`).toBe(0);
    }
    const published = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(published.version).toBe(2);
    const entries = await fs.readdir(dir);
    expect(entries.sort()).toEqual(['shared.json']);
  });
});

// ─── Publish fault injection (issue #106) ──────────────────────────────────
//
// I/O fault seam: only the versioned-json publish operations are spied, the
// filesystem stays real. Each case asserts the observable contract — the
// write failed, the target was never replaced by a partial document, and
// every temp file this writer created was removed by the writer itself.

describe('publish failure contracts (fault injection)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    vi.restoreAllMocks();
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-fault-'));
    tempRoots.push(dir);
    return dir;
  }

  it('removes its own temp when the write fails and preserves foreign temp files', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    const foreign = createTempSiblingPath(join(dir, 'other.json'));
    await fs.writeFile(foreign, 'other-writer', 'utf8');
    const writeSpy = vi
      .spyOn(jsonWriteIo, 'writeFile')
      .mockRejectedValueOnce(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));

    await expect(atomicWriteJson(filePath, { version: 1 })).rejects.toMatchObject({
      code: 'ENOSPC',
    });

    // The writer removed the temp it created; the foreign temp stays.
    expect(await fs.readdir(dir)).toEqual([foreign.split('/').pop()].filter(Boolean));
    writeSpy.mockRestore();
  });

  it('preserves a live foreign temp file when a write overlaps cleanup', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    // A foreign temp that names a live writer (this process) mid-write.
    const liveTemp = createTempSiblingPath(join(dir, 'test.json'));
    await fs.writeFile(liveTemp, 'live-writer', 'utf8');

    // Cleanup overlaps with the (still active) foreign writer.
    await cleanupTmpResidue(dir);
    expect(await fs.pathExists(liveTemp)).toBe(true);

    // The write itself still succeeds and never reaps the foreign temp.
    await atomicWriteJson(filePath, { version: 1 });
    expect(await fs.readFile(liveTemp, 'utf8')).toBe('live-writer');
    expect(await fs.readdir(dir)).toEqual([liveTemp.split('/').pop(), 'test.json'].sort());
  });

  it('does not touch foreign temp files when the final rename fails', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    const foreign = createTempSiblingPath(join(dir, 'other.json'));
    await fs.writeFile(foreign, 'other-writer', 'utf8');
    const renameSpy = vi
      .spyOn(jsonWriteIo, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('EISDIR'), { code: 'EISDIR' }));

    await expect(atomicWriteJson(filePath, { version: 1 })).rejects.toMatchObject({
      code: 'EISDIR',
    });

    expect(await fs.readFile(foreign, 'utf8')).toBe('other-writer');
    expect(await fs.pathExists(filePath)).toBe(false);
    renameSpy.mockRestore();
  });

  it('publishes the complete document when rename succeeds (mocked seam integrity)', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await fs.writeFile(filePath, 'stale', 'utf8');

    await atomicWriteJson(filePath, { version: 1 });

    const content = await fs.readFile(filePath, 'utf8');
    expect(JSON.parse(content)).toEqual({ version: 1 });
    expect(await fs.readdir(dir)).toEqual(['test.json']);
  });
});
