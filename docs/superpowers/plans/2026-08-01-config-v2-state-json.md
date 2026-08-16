# config.json v2, state.json, and Universal JSON Migration Rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade config.json to v2 with recovery/workbench settings, add state.json for recent project directories, and enforce universal versioned-JSON migration rules with atomic writes across all ccps-owned JSON files.

**Architecture:** A generic `versioned-json` framework module enforces §13.4 migration rules (version literal, strict schema, loud failure, lazy migrate-on-load, atomic writes). config.json v2 and state.json are instances of this framework. The existing `writeJsonFile` is replaced with atomic writes. Launch integration adds state.json recording after successful real launches.

**Tech Stack:** TypeScript, Zod, fs-extra, Vitest, Node.js `fs` (rename for atomicity)

## Global Constraints

- Node.js >=22, TypeScript strict mode
- Zod `.strict()` on all versioned JSON schemas — unknown fields always rejected
- `CcpsError` with `code`, `message`, `guidance` for all error paths
- Error codes follow `<PREFIX>_<VIOLATION>` pattern (e.g. `APP_CONFIG_INVALID`)
- Atomic writes: temp file + `fs.rename`, never direct `fs.writeFile` to target
- Read paths never write (lazy migrate-on-load fills defaults in memory only)
- `areSameFilesystemPath` for path dedupe (case-insensitive on Windows)
- All tests use temp directories, never the real app home

---

### Task 1: Versioned JSON framework — atomic writes and load/save

**Files:**
- Create: `src/core/versioned-json.ts`
- Test: `test/versioned-json.test.ts`

**Interfaces:**
- Produces: `VersionedJsonSpec<T>`, `loadVersionedJson(spec, filePath)`, `saveVersionedJson(spec, filePath, data, options?)`, `atomicWriteJson(filePath, value)`, `cleanupTmpResidue(dirPath)`

- [ ] **Step 1: Write failing tests for atomicWriteJson**

```typescript
// test/versioned-json.test.ts
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { atomicWriteJson, cleanupTmpResidue } from '../src/core/versioned-json';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/versioned-json.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement atomicWriteJson and cleanupTmpResidue**

```typescript
// src/core/versioned-json.ts
import fs from 'fs-extra';
import path from 'node:path';

import { CcpsError } from '../utils/errors';

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
}

export async function cleanupTmpResidue(dirPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.endsWith('.tmp')) {
      await fs.remove(path.join(dirPath, entry));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/versioned-json.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for loadVersionedJson and saveVersionedJson**

Append to `test/versioned-json.test.ts`:

```typescript
import { z } from 'zod';
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
    const result = await saveVersionedJson(testSpec, filePath, { version: 2, name: 'saved' });

    expect(result).toEqual({ version: 2, name: 'saved', addedField: true });
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(onDisk).toEqual({ version: 2, name: 'saved', addedField: true });
  });

  it('rejects data that does not match the current schema', async () => {
    const dir = await makeTempDir();
    const filePath = join(dir, 'test.json');

    await expect(
      saveVersionedJson(testSpec, filePath, { version: 2, name: 'ok', unknownExtra: true } as any),
    ).rejects.toMatchObject({
      code: 'TEST_CONFIG_INVALID',
    });
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run test/versioned-json.test.ts`
Expected: FAIL — `VersionedJsonSpec` not exported

- [ ] **Step 7: Implement loadVersionedJson and saveVersionedJson**

Add to `src/core/versioned-json.ts`:

```typescript
import { z } from 'zod';

export type VersionedJsonSpec<T, V extends number = number> = {
  fileName: string;
  currentVersion: V;
  currentSchema: z.ZodSchema<T>;
  migrate: (raw: unknown, rawVersion: number) => T;
  errorPrefix: string;
};

function prefix(spec: VersionedJsonSpec<any>, suffix: string): string {
  return `${spec.errorPrefix}_${suffix}`;
}

export async function loadVersionedJson<T>(
  spec: VersionedJsonSpec<T>,
  filePath: string,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CcpsError(prefix(spec, 'NOT_FOUND'), `${spec.fileName} does not exist.`, {
        guidance: `Run ccps init to create ${spec.fileName}.`,
        cause: error,
      });
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new CcpsError(prefix(spec, 'INVALID_JSON'), `${spec.fileName} is not valid JSON.`, {
      guidance: `Fix ${spec.fileName} or recreate it from a backup.`,
      cause: error,
    });
  }

  if (!isRecord(parsedJson) || typeof parsedJson.version !== 'number') {
    throw new CcpsError(
      prefix(spec, 'INVALID_VERSION'),
      `${spec.fileName} has a missing or invalid version field.`,
      {
        guidance: `Check the version field in ${spec.fileName}.`,
      },
    );
  }

  const rawVersion = parsedJson.version;

  if (rawVersion > spec.currentVersion) {
    throw new CcpsError(
      prefix(spec, 'FUTURE_VERSION'),
      `${spec.fileName} version ${rawVersion} is newer than supported version ${spec.currentVersion}.`,
      {
        guidance: 'Upgrade ccps to a version that supports this format.',
      },
    );
  }

  let data: T;
  if (rawVersion < spec.currentVersion) {
    data = spec.migrate(parsedJson, rawVersion);
  } else {
    const parsed = spec.currentSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new CcpsError(
        prefix(spec, 'INVALID'),
        `${spec.fileName} does not match the expected schema.`,
        {
          guidance: `Check ${spec.fileName} fields.`,
          cause: parsed.error,
        },
      );
    }
    data = parsed.data;
  }

  return data;
}

export async function saveVersionedJson<T>(
  spec: VersionedJsonSpec<T>,
  filePath: string,
  data: T,
): Promise<T> {
  const parsed = spec.currentSchema.safeParse(data);
  if (!parsed.success) {
    throw new CcpsError(
      prefix(spec, 'INVALID'),
      `${spec.fileName} data does not match the expected schema.`,
      {
        guidance: `Check ${spec.fileName} fields.`,
        cause: parsed.error,
      },
    );
  }

  await atomicWriteJson(filePath, parsed.data);
  return parsed.data;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/versioned-json.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/versioned-json.ts test/versioned-json.test.ts
git commit -m "feat: add versioned-json framework with atomic writes, load/save, and migration"
```

---

### Task 2: config.json v2 schema and migration

**Files:**
- Modify: `src/schemas/config.ts`
- Modify: `test/schemas.test.ts`

**Interfaces:**
- Consumes: `VersionedJsonSpec` from Task 1
- Produces: `appConfigV2Schema`, `AppConfig` (now v2 shape), `appConfigSpec` (VersionedJsonSpec for use by app-config.ts)

- [ ] **Step 1: Write failing tests for v2 schema**

Add to `test/schemas.test.ts`:

```typescript
import { appConfigV2Schema } from '../src/schemas/config';

describe('app config v2 schema', () => {
  it('parses a minimal v2 config with defaults', () => {
    const config = appConfigV2Schema.parse({ version: 2 });

    expect(config.version).toBe(2);
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);
    expect(config.workbench.editor).toBeUndefined();
    expect(config.workbench.language).toBeUndefined();
  });

  it('parses a full v2 config', () => {
    const config = appConfigV2Schema.parse({
      version: 2,
      defaultProfile: 'coding',
      lastUsedProfile: 'study',
      recovery: { retentionDays: 7 },
      workbench: {
        editor: 'vim',
        skillsDiscoveryExperimental: false,
        language: 'zh',
      },
    });

    expect(config.recovery.retentionDays).toBe(7);
    expect(config.workbench.editor).toBe('vim');
    expect(config.workbench.skillsDiscoveryExperimental).toBe(false);
    expect(config.workbench.language).toBe('zh');
  });

  it('accepts retentionDays as 7, 30, 90, or null', () => {
    for (const days of [7, 30, 90, null] as const) {
      const config = appConfigV2Schema.parse({
        version: 2,
        recovery: { retentionDays: days },
      });
      expect(config.recovery.retentionDays).toBe(days);
    }
  });

  it('rejects invalid retentionDays', () => {
    expect(() =>
      appConfigV2Schema.parse({ version: 2, recovery: { retentionDays: 14 } }),
    ).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() =>
      appConfigV2Schema.parse({ version: 2, unknownField: true }),
    ).toThrow();
  });

  it('rejects invalid language values', () => {
    expect(() =>
      appConfigV2Schema.parse({ version: 2, workbench: { language: 'fr' } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/schemas.test.ts`
Expected: FAIL — `appConfigV2Schema` not exported

- [ ] **Step 3: Implement v2 schema**

Replace `src/schemas/config.ts`:

```typescript
import { z } from 'zod';

import { validateProfileName } from '../platform/path';

export const profileNameSchema = z.string().refine(
  (value) => {
    try {
      validateProfileName(value);
      return true;
    } catch {
      return false;
    }
  },
  {
    message: 'Profile name must use only safe characters and cannot be reserved.',
  },
);

// Legacy v1 schema — kept for migration reference
export const appConfigV1Schema = z
  .object({
    version: z.literal(1),
    defaultProfile: profileNameSchema.optional(),
    lastUsedProfile: profileNameSchema.nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

export type AppConfigV1 = z.infer<typeof appConfigV1Schema>;

// Current v2 schema
export const appConfigV2Schema = z
  .object({
    version: z.literal(2),
    defaultProfile: profileNameSchema.optional(),
    lastUsedProfile: profileNameSchema.nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    recovery: z
      .object({
        retentionDays: z
          .union([z.literal(7), z.literal(30), z.literal(90), z.null()])
          .default(30),
      })
      .default({}),
    workbench: z
      .object({
        editor: z.string().optional(),
        skillsDiscoveryExperimental: z.boolean().default(true),
        language: z.enum(['zh', 'en']).optional(),
      })
      .default({}),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigV2Schema>;

// Backward-compatible alias for the current schema
export const appConfigSchema = appConfigV2Schema;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/schemas.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schemas/config.ts test/schemas.test.ts
git commit -m "feat: add config.json v2 schema with recovery and workbench settings"
```

---

### Task 3: Wire app-config.ts to versioned-json framework

**Files:**
- Modify: `src/core/app-config.ts`
- Modify: `src/platform/path.ts`
- Modify: `test/app-config.test.ts`

**Interfaces:**
- Consumes: `VersionedJsonSpec`, `loadVersionedJson`, `saveVersionedJson`, `atomicWriteJson`, `cleanupTmpResidue` from Task 1; `appConfigV2Schema`, `AppConfig`, `AppConfigV1` from Task 2
- Produces: `loadAppConfig(appHomePath) → AppConfig` (now v2), `saveAppConfig(appHomePath, config, options?) → AppConfig`, `createInitialAppConfig(clock?) → AppConfig` (now v2), `writeJsonFile(filePath, value, options)` (now atomic), `getAppHomePaths()` gains `statePath`

- [ ] **Step 1: Write failing tests for v1→v2 migration and v2 features**

Replace `test/app-config.test.ts`:

```typescript
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAppConfig,
  createInitialAppConfig,
  getAppHomePaths,
  loadAppConfig,
  saveAppConfig,
} from '../src/core/app-config';
import { CcpsError } from '../src/utils/errors';

const fixedClock = () => new Date('2026-01-02T03:04:05.000Z');
const laterClock = () => new Date('2026-01-02T04:05:06.000Z');

describe('app config', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-app-config-'));
    tempRoots.push(root);
    return join(root, '.cc-profile-switch');
  }

  it('builds deterministic initial v2 config', () => {
    expect(createInitialAppConfig(fixedClock)).toEqual({
      version: 2,
      lastUsedProfile: null,
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
      recovery: { retentionDays: 30 },
      workbench: { skillsDiscoveryExperimental: true },
    });
  });

  it('creates app home folders and v2 config without touching the real app home', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });
    const paths = getAppHomePaths(appHome);

    expect(config.version).toBe(2);
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);
    expect(await fs.pathExists(paths.configPath)).toBe(true);
    expect(await fs.pathExists(paths.profilesPath)).toBe(true);
    expect(await fs.pathExists(paths.backupsPath)).toBe(true);
  });

  it('loads and validates v2 config.json', async () => {
    const appHome = await makeAppHome();
    await createAppConfig(appHome, { clock: fixedClock });

    const config = await loadAppConfig(appHome);
    expect(config.version).toBe(2);
    expect(config.lastUsedProfile).toBeNull();
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);
  });

  it('migrates a v1 config to v2 in memory without writing', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    await fs.ensureDir(appHome);
    await fs.ensureDir(paths.profilesPath);
    await fs.ensureDir(paths.backupsPath);
    // Write a v1 config directly
    await fs.writeJson(paths.configPath, {
      version: 1,
      defaultProfile: 'coding',
      lastUsedProfile: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const config = await loadAppConfig(appHome);
    expect(config.version).toBe(2);
    expect(config.defaultProfile).toBe('coding');
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);

    // Read path never writes — file on disk is still v1
    const onDisk = await fs.readJson(paths.configPath);
    expect(onDisk.version).toBe(1);
  });

  it('rejects invalid JSON when loading config', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);

    await fs.ensureDir(appHome);
    await fs.writeFile(paths.configPath, '{not-json', 'utf8');

    await expect(loadAppConfig(appHome)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID_JSON',
    });
  });

  it('rejects a future version config', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);

    await fs.ensureDir(appHome);
    await fs.writeJson(paths.configPath, { version: 99 });

    await expect(loadAppConfig(appHome)).rejects.toMatchObject({
      code: 'APP_CONFIG_FUTURE_VERSION',
    });
  });

  it('rejects unknown fields in config', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);

    await fs.ensureDir(appHome);
    await fs.writeJson(paths.configPath, { version: 2, unknownField: true });

    await expect(loadAppConfig(appHome)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
    });
  });

  it('refuses to overwrite config on create', async () => {
    const appHome = await makeAppHome();

    await createAppConfig(appHome, { clock: fixedClock });

    await expect(createAppConfig(appHome, { clock: fixedClock })).rejects.toBeInstanceOf(CcpsError);
    await expect(createAppConfig(appHome, { clock: fixedClock })).rejects.toMatchObject({
      code: 'FILE_ALREADY_EXISTS',
    });
  });

  it('saves parsed config and updates timestamp deterministically', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });

    const saved = await saveAppConfig(
      appHome,
      {
        ...config,
        defaultProfile: 'coding',
        lastUsedProfile: 'coding',
      },
      { clock: laterClock },
    );

    expect(saved).toMatchObject({
      defaultProfile: 'coding',
      lastUsedProfile: 'coding',
      updatedAt: '2026-01-02T04:05:06.000Z',
    });
    await expect(loadAppConfig(appHome)).resolves.toMatchObject(saved);
  });

  it('saves v2 config with recovery and workbench settings', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });

    const saved = await saveAppConfig(
      appHome,
      {
        ...config,
        recovery: { retentionDays: 7 },
        workbench: { skillsDiscoveryExperimental: false, language: 'zh' },
      },
      { clock: laterClock },
    );

    expect(saved.recovery.retentionDays).toBe(7);
    expect(saved.workbench.skillsDiscoveryExperimental).toBe(false);
    expect(saved.workbench.language).toBe('zh');
  });

  it('writes config atomically (no .tmp residue)', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });

    await saveAppConfig(appHome, config, { clock: laterClock });

    const files = await fs.readdir(appHome);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('exposes statePath in app home paths', () => {
    const paths = getAppHomePaths('/fake/home/.cc-profile-switch');
    expect(paths.statePath).toBe(
      join('/fake/home/.cc-profile-switch', 'state.json'),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/app-config.test.ts`
Expected: FAIL — `createInitialAppConfig` returns v1, `statePath` missing

- [ ] **Step 3: Add statePath to AppHomePaths in platform/path.ts**

In `src/platform/path.ts`, no changes needed — `statePath` is added in `app-config.ts`'s `getAppHomePaths`.

Modify `src/core/app-config.ts` — full replacement:

```typescript
import fs from 'fs-extra';

import { getAppHomePath, resolveInside } from '../platform/path';
import { appConfigV2Schema, appConfigV1Schema, type AppConfig, type AppConfigV1 } from '../schemas/config';
import { CcpsError } from '../utils/errors';
import {
  loadVersionedJson,
  saveVersionedJson,
  atomicWriteJson,
  cleanupTmpResidue,
  type VersionedJsonSpec,
} from './versioned-json';

export type Clock = () => Date;

export type AppHomePaths = {
  appHomePath: string;
  configPath: string;
  apiSettingsPath: string;
  statePath: string;
  profilesPath: string;
  backupsPath: string;
};

export type AppConfigWriteOptions = {
  clock?: Clock;
};

const appConfigSpec: VersionedJsonSpec<AppConfig, 2> = {
  fileName: 'config.json',
  currentVersion: 2,
  currentSchema: appConfigV2Schema,
  migrate: (raw: unknown, rawVersion: number): AppConfig => {
    if (rawVersion === 1) {
      const parsed = appConfigV1Schema.safeParse(raw);
      if (!parsed.success) {
        throw new CcpsError('APP_CONFIG_INVALID', 'v1 config does not match the v1 schema.', {
          guidance: 'Check config.json fields and profile names.',
          cause: parsed.error,
        });
      }
      const v1 = parsed.data;
      return {
        version: 2,
        defaultProfile: v1.defaultProfile,
        lastUsedProfile: v1.lastUsedProfile,
        createdAt: v1.createdAt,
        updatedAt: v1.updatedAt,
        recovery: { retentionDays: 30 },
        workbench: { skillsDiscoveryExperimental: true },
      };
    }
    throw new CcpsError(
      'APP_CONFIG_INVALID_VERSION',
      `Cannot migrate config.json from version ${rawVersion}.`,
      {
        guidance: 'Check the version field in config.json.',
      },
    );
  },
  errorPrefix: 'APP_CONFIG',
};

export function getAppHomePaths(appHomePath = getAppHomePath()): AppHomePaths {
  return {
    appHomePath,
    configPath: resolveInside(appHomePath, 'config.json'),
    apiSettingsPath: resolveInside(appHomePath, 'api-settings.json'),
    statePath: resolveInside(appHomePath, 'state.json'),
    profilesPath: resolveInside(appHomePath, 'profiles'),
    backupsPath: resolveInside(appHomePath, 'backups'),
  };
}

export function createInitialAppConfig(clock: Clock = () => new Date()): AppConfig {
  const timestamp = clock().toISOString();

  return {
    version: 2,
    lastUsedProfile: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    recovery: { retentionDays: 30 },
    workbench: { skillsDiscoveryExperimental: true },
  };
}

export async function ensureAppHomeStructure(appHomePath = getAppHomePath()): Promise<AppHomePaths> {
  const paths = getAppHomePaths(appHomePath);

  await fs.ensureDir(paths.appHomePath);
  await fs.ensureDir(paths.profilesPath);
  await fs.ensureDir(paths.backupsPath);
  await cleanupTmpResidue(paths.appHomePath);

  return paths;
}

export async function createAppConfig(
  appHomePath = getAppHomePath(),
  options: AppConfigWriteOptions = {},
): Promise<AppConfig> {
  const paths = await ensureAppHomeStructure(appHomePath);
  const config = appConfigV2Schema.parse(createInitialAppConfig(options.clock));

  await writeJsonFile(paths.configPath, config, { overwrite: false });

  return config;
}

export async function loadAppConfig(appHomePath = getAppHomePath()): Promise<AppConfig> {
  const { configPath } = getAppHomePaths(appHomePath);
  return loadVersionedJson(appConfigSpec, configPath);
}

export async function saveAppConfig(
  appHomePath: string,
  config: AppConfig,
  options: AppConfigWriteOptions = {},
): Promise<AppConfig> {
  const paths = await ensureAppHomeStructure(appHomePath);
  const nextConfig = appConfigV2Schema.parse({
    ...config,
    updatedAt: (options.clock ?? (() => new Date()))().toISOString(),
  });

  await saveVersionedJson(appConfigSpec, paths.configPath, nextConfig);

  return nextConfig;
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
  options: { overwrite: boolean },
): Promise<void> {
  if (!options.overwrite) {
    const exists = await fs.pathExists(filePath);
    if (exists) {
      throw new CcpsError('FILE_ALREADY_EXISTS', 'Refusing to overwrite an existing file.', {
        guidance: `Choose a new name or remove the existing file intentionally: ${filePath}`,
      });
    }
  }

  await atomicWriteJson(filePath, value);
}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: May have errors in other files that import `AppConfig` or `appConfigSchema` — fix any type mismatches. The `appConfigSchema` alias now points to v2, so `version: 1` literals in test files may need updating.

- [ ] **Step 5: Fix any downstream type errors**

Check `test/launcher.test.ts`, `test/profile-commands.test.ts`, and any other files that reference `config.json` version 1. The `loadAppConfig` now returns v2 shape, but tests that read `config.json` directly with `fs.readJson` and check `lastUsedProfile` still work because the v2 schema includes that field.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/app-config.test.ts test/schemas.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/app-config.ts test/app-config.test.ts
git commit -m "feat: wire app-config to versioned-json framework, upgrade to v2, atomic writes"
```

---

### Task 4: state.json schema and app-state module

**Files:**
- Create: `src/schemas/state.ts`
- Create: `src/core/app-state.ts`
- Create: `test/app-state.test.ts`

**Interfaces:**
- Consumes: `VersionedJsonSpec`, `loadVersionedJson`, `saveVersionedJson` from Task 1; `areSameFilesystemPath` from `platform/path`; `getAppHomePaths` from Task 3
- Produces: `AppState`, `loadAppState(appHomePath)`, `recordRecentProjectDir(appHomePath, dirPath, options?)`

- [ ] **Step 1: Write failing tests for state.json**

```typescript
// test/app-state.test.ts
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { loadAppState, recordRecentProjectDir } from '../src/core/app-state';

const fixedClock = () => new Date('2026-01-02T03:04:05.000Z');

describe('app state', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-app-state-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome);
    return appHome;
  }

  it('returns empty state when state.json does not exist', async () => {
    const appHome = await makeAppHome();
    const state = await loadAppState(appHome);

    expect(state).toEqual({ version: 1, recentProjectDirs: [] });
  });

  it('loads an existing state.json', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    await fs.writeJson(paths.statePath, {
      version: 1,
      recentProjectDirs: [{ path: '/project/a', lastUsedAt: '2026-01-01T00:00:00.000Z' }],
    });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(1);
    expect(state.recentProjectDirs[0].path).toBe('/project/a');
  });

  it('records a recent project directory', async () => {
    const appHome = await makeAppHome();
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toEqual([
      { path: '/project/alpha', lastUsedAt: '2026-01-02T03:04:05.000Z' },
    ]);
  });

  it('moves an existing entry to the front (MRU)', async () => {
    const appHome = await makeAppHome();
    const laterClock = () => new Date('2026-01-03T00:00:00.000Z');

    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });
    await recordRecentProjectDir(appHome, '/project/beta', { clock: laterClock });
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: laterClock });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs.map((d) => d.path)).toEqual([
      '/project/alpha',
      '/project/beta',
    ]);
  });

  it('dedupes by filesystem path identity', async () => {
    const appHome = await makeAppHome();
    // On POSIX, /project/Alpha and /project/alpha are different paths
    // On Windows they would be the same — this test verifies the dedupe function is used
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(1);
  });

  it('caps at 10 entries evicting the oldest', async () => {
    const appHome = await makeAppHome();

    for (let i = 0; i < 12; i++) {
      const clock = () => new Date(`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`);
      await recordRecentProjectDir(appHome, `/project/${i}`, { clock });
    }

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(10);
    // Oldest (0, 1) evicted; newest (11) at front
    expect(state.recentProjectDirs[0].path).toBe('/project/11');
    expect(state.recentProjectDirs[9].path).toBe('/project/2');
  });

  it('never prunes dead directories on the read path', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    // Write state with a non-existent directory
    await fs.writeJson(paths.statePath, {
      version: 1,
      recentProjectDirs: [
        { path: '/nonexistent/dead', lastUsedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(1);
    expect(state.recentProjectDirs[0].path).toBe('/nonexistent/dead');
  });

  it('writes state atomically (no .tmp residue)', async () => {
    const appHome = await makeAppHome();
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });

    const files = await fs.readdir(appHome);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('rejects corrupt state.json', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    await fs.writeFile(paths.statePath, '{broken', 'utf8');

    await expect(loadAppState(appHome)).rejects.toMatchObject({
      code: 'APP_STATE_INVALID_JSON',
    });
  });

  it('rejects a future version state.json', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    await fs.writeJson(paths.statePath, { version: 99, recentProjectDirs: [] });

    await expect(loadAppState(appHome)).rejects.toMatchObject({
      code: 'APP_STATE_FUTURE_VERSION',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/app-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create state.json schema**

```typescript
// src/schemas/state.ts
import { z } from 'zod';

export const appStateV1Schema = z
  .object({
    version: z.literal(1),
    recentProjectDirs: z
      .array(
        z.object({
          path: z.string(),
          lastUsedAt: z.string(),
        }),
      )
      .max(10),
  })
  .strict();

export type AppState = z.infer<typeof appStateV1Schema>;
```

- [ ] **Step 4: Create app-state module**

```typescript
// src/core/app-state.ts
import fs from 'fs-extra';

import { areSameFilesystemPath } from '../platform/path';
import { appStateV1Schema, type AppState } from '../schemas/state';
import { CcpsError } from '../utils/errors';
import {
  loadVersionedJson,
  saveVersionedJson,
  type VersionedJsonSpec,
} from './versioned-json';
import { getAppHomePaths } from './app-config';

export type Clock = () => Date;

export type AppStateWriteOptions = {
  clock?: Clock;
};

const appStateSpec: VersionedJsonSpec<AppState, 1> = {
  fileName: 'state.json',
  currentVersion: 1,
  currentSchema: appStateV1Schema,
  migrate: (_raw: unknown, rawVersion: number): AppState => {
    throw new CcpsError(
      'APP_STATE_INVALID_VERSION',
      `Cannot migrate state.json from version ${rawVersion}.`,
      {
        guidance: 'Check the version field in state.json.',
      },
    );
  },
  errorPrefix: 'APP_STATE',
};

export async function loadAppState(appHomePath: string): Promise<AppState> {
  const { statePath } = getAppHomePaths(appHomePath);

  try {
    return await loadVersionedJson(appStateSpec, statePath);
  } catch (error) {
    if (error instanceof CcpsError && error.code === 'APP_STATE_NOT_FOUND') {
      return { version: 1, recentProjectDirs: [] };
    }
    throw error;
  }
}

export async function recordRecentProjectDir(
  appHomePath: string,
  dirPath: string,
  options: AppStateWriteOptions = {},
): Promise<AppState> {
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const state = await loadAppState(appHomePath);

  // Dedupe: remove existing entry for the same filesystem path
  const filtered = state.recentProjectDirs.filter(
    (entry) => !areSameFilesystemPath(entry.path, dirPath),
  );

  // Prepend new entry (MRU — newest first)
  const updated = [{ path: dirPath, lastUsedAt: now }, ...filtered];

  // Cap at 10
  const capped = updated.slice(0, 10);

  const nextState: AppState = {
    version: 1,
    recentProjectDirs: capped,
  };

  const { statePath } = getAppHomePaths(appHomePath);
  return saveVersionedJson(appStateSpec, statePath, nextState);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/app-state.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/schemas/state.ts src/core/app-state.ts test/app-state.test.ts
git commit -m "feat: add state.json with recent project directories and MRU dedupe"
```

---

### Task 5: Launch integration — record recent project dir on successful launch

**Files:**
- Modify: `src/core/launcher.ts`
- Modify: `test/launcher.test.ts`

**Interfaces:**
- Consumes: `recordRecentProjectDir` from Task 4

- [ ] **Step 1: Write failing tests for state.json integration in launcher**

Add to `test/launcher.test.ts`:

```typescript
import { loadAppState } from '../src/core/app-state';

// Add inside the existing describe('launcher', ...) block:

it('records cwd in state.json after a successful real launch', async () => {
  const { appHome } = await makeProfile();
  const projectCwd = await makeTempRoot('ccps-project-');

  await launchProfile({
    appHomePath: appHome,
    profileName: 'coding',
    cwd: projectCwd,
    spawnProcess: async () => ({ exitCode: 0 }),
    clock: () => new Date('2026-05-20T11:30:00Z'),
  });

  const state = await loadAppState(appHome);
  expect(state.recentProjectDirs).toHaveLength(1);
  expect(state.recentProjectDirs[0].path).toBe(projectCwd);
});

it('does not record cwd in state.json on a dry-run launch', async () => {
  const { appHome } = await makeProfile();
  const projectCwd = await makeTempRoot('ccps-project-');

  await buildLaunchPlan({
    appHomePath: appHome,
    profileName: 'coding',
    cwd: projectCwd,
  });

  const state = await loadAppState(appHome);
  expect(state.recentProjectDirs).toHaveLength(0);
});

it('does not record cwd in state.json when profile validation blocks launch', async () => {
  const { appHome, paths } = await makeProfile();
  const projectCwd = await makeTempRoot('ccps-project-');
  await rm(paths.settingsPath);

  await expect(
    launchProfile({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
      spawnProcess: async () => ({ exitCode: 0 }),
    }),
  ).rejects.toMatchObject({ code: 'PROFILE_VALIDATION_FAILED' });

  const state = await loadAppState(appHome);
  expect(state.recentProjectDirs).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/launcher.test.ts`
Expected: FAIL — state.json not written after launch

- [ ] **Step 3: Add recordRecentProjectDir call to launchProfile**

In `src/core/launcher.ts`, add the import and the call:

At the top, add:
```typescript
import { recordRecentProjectDir } from './app-state';
```

In `launchProfile`, after the existing `saveAppConfig` call (after line 241), add:
```typescript
await recordRecentProjectDir(options.appHomePath, plan.cwd, { clock: options.clock });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/launcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/launcher.ts test/launcher.test.ts
git commit -m "feat: record recent project dir in state.json on successful launch"
```

---

### Task 6: Fix downstream tests and run full suite

**Files:**
- Modify: any test files that break due to config v2 migration
- Modify: `test/schemas.test.ts` — update v1 references to v2

**Interfaces:**
- Consumes: All previous tasks

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: Some tests may fail due to config version change

- [ ] **Step 2: Fix any failing tests**

The `schemas.test.ts` already has v2 tests from Task 2, but the original v1 test (`parses app config with optional profile metadata`) needs updating since `appConfigSchema` now points to v2:

Replace the v1 test in `test/schemas.test.ts`:
```typescript
it('parses app config v2 with optional profile metadata', () => {
  const config = appConfigSchema.parse({
    version: 2,
    defaultProfile: 'coding',
    lastUsedProfile: null,
  });

  expect(config.defaultProfile).toBe('coding');
  expect(config.lastUsedProfile).toBeNull();
  expect(config.recovery.retentionDays).toBe(30);
  expect(config.workbench.skillsDiscoveryExperimental).toBe(true);
});
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Run lint and build**

Run: `npm run check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix: update downstream tests for config v2 migration"
```

---

### Task 7: Verify acceptance criteria

- [ ] **Step 1: Verify config.json v2 acceptance criteria**

Check each criterion from issue #55:
- `config.json` v2 holds `recovery.retentionDays` (7/30/90/null, absent = 30) ✓
- `config.json` v2 holds `workbench.editor` / `workbench.skillsDiscoveryExperimental` / `workbench.language` ✓
- v1 configs load with defaults filled in memory ✓
- v1 configs written back only on the next natural save ✓ (read path never writes)

- [ ] **Step 2: Verify state.json acceptance criteria**

- `state.json` records recent project directories on every successful real launch ✓
- Cap 10 MRU ✓
- Filesystem-identity dedupe (case-insensitive on Windows) ✓ (uses `areSameFilesystemPath`)
- Dry-runs and validation-blocked launches write nothing ✓
- Dead directories never pruned on read path ✓

- [ ] **Step 3: Verify migration rules acceptance criteria**

- Unknown fields fail loudly ✓
- Higher versions fail loudly ✓
- Corrupt JSON fails loudly ✓
- Never a silent reset ✓
- Read-only commands never write ✓
- All writes atomic ✓

- [ ] **Step 4: Run final full check**

Run: `npm run check`
Expected: PASS
