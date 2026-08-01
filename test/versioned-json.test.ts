import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { afterEach, describe, expect, it } from 'vitest';

import {
  atomicWriteJson,
  cleanupTmpResidue,
  loadVersionedJson,
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

  it('leaves no .tmp file on success', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');
    await atomicWriteJson(filePath, { version: 1 });

    const files = await fs.readdir(dir);
    expect(files).toEqual(['test.json']);
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

  it('removes .tmp files left by crashed writes', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(join(dir, 'config.json.tmp'), '{}', 'utf8');
    await fs.writeFile(join(dir, 'config.json'), '{}', 'utf8');

    await cleanupTmpResidue(dir);

    const files = await fs.readdir(dir);
    expect(files).toEqual(['config.json']);
  });

  it('is a no-op when no .tmp files exist', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(join(dir, 'config.json'), '{}', 'utf8');

    await cleanupTmpResidue(dir);

    const files = await fs.readdir(dir);
    expect(files).toEqual(['config.json']);
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
    const result = await saveVersionedJson(testSpec, filePath, { version: 2, name: 'saved', addedField: true });

    expect(result).toEqual({ version: 2, name: 'saved', addedField: true });
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(onDisk).toEqual({ version: 2, name: 'saved', addedField: true });
  });

  it('rejects data that does not match the current schema', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');

    await expect(
      saveVersionedJson(testSpec, filePath, { version: 2, name: 'ok', unknownExtra: true } as TestV2),
    ).rejects.toMatchObject({
      code: 'TEST_CONFIG_INVALID',
    });
  });
});
