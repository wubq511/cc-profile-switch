import fs from 'fs-extra';
import path from 'node:path';
import { z } from 'zod';

import { CcpsError } from '../utils/errors';
import { isNodeError, isRecord } from '../utils/type-guards';

export type VersionedJsonSpec<T, V extends number = number> = {
  fileName: string;
  currentVersion: V;
  currentSchema: z.ZodSchema<T>;
  migrate: (raw: unknown, rawVersion: number) => T;
  errorPrefix: string;
};

function prefix(spec: VersionedJsonSpec<never>, suffix: string): string {
  return `${spec.errorPrefix}_${suffix}`;
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, filePath);
}

/** Synchronous temp+rename write — same atomicity contract as atomicWriteJson,
 * for call sites that must stay sync (e.g. after spawnSync). */
export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/** App-home subdirectories that hold atomic-write targets (profiles/<name>/, backups/<name>/). */
const TMP_SCAN_SUBDIRS = ['profiles', 'backups'] as const;

/**
 * Directory levels to descend below each scan subdir. Two levels reach
 * profiles/<name>/ and profiles/<name>/claude-home/ without walking
 * Claude-managed bulk (claude-home/projects, sessions, caches).
 */
const TMP_SCAN_DEPTH = 2;

/**
 * Remove orphaned `.tmp` files left by interrupted atomicWriteJson calls.
 * Scans the app-home root plus the known write-target subtrees (profiles/,
 * backups/) bounded to TMP_SCAN_DEPTH levels. Runs from ensureAppHomeStructure
 * (init/backup paths), not on the per-command hot path.
 */
export async function cleanupTmpResidue(dirPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return;
  }

  const pending: Promise<void>[] = [];
  for (const entry of entries) {
    if (entry.endsWith('.tmp')) {
      pending.push(fs.remove(path.join(dirPath, entry)));
    }
  }
  for (const subdir of TMP_SCAN_SUBDIRS) {
    if (entries.includes(subdir)) {
      pending.push(scanTmpResidue(path.join(dirPath, subdir), TMP_SCAN_DEPTH));
    }
  }
  await Promise.all(pending);
}

/** Remove `*.tmp` entries inside dirPath, descending at most `depth` directory levels. */
async function scanTmpResidue(dirPath: string, depth: number): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  const pending: Promise<void>[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) {
        pending.push(scanTmpResidue(entryPath, depth - 1));
      }
    } else if (entry.name.endsWith('.tmp')) {
      pending.push(fs.remove(entryPath));
    }
  }
  await Promise.all(pending);
}

function readVersionedJsonText(spec: VersionedJsonSpec<never>, filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CcpsError(prefix(spec, 'NOT_FOUND'), `${spec.fileName} does not exist.`, {
        guidance: `Run ccps init to create ${spec.fileName}.`,
        cause: error,
      });
    }
    throw error;
  }
}

function parseVersionedJson<T>(spec: VersionedJsonSpec<T>, raw: string): T {
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

  if (rawVersion < spec.currentVersion) {
    return spec.migrate(parsedJson, rawVersion);
  }

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
  return parsed.data;
}

function validateForSave<T>(spec: VersionedJsonSpec<T>, data: T): T {
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
  return parsed.data;
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

  return parseVersionedJson(spec, raw);
}

/** Synchronous variant of loadVersionedJson — identical parse/migrate/errors. */
export function loadVersionedJsonSync<T>(spec: VersionedJsonSpec<T>, filePath: string): T {
  return parseVersionedJson(spec, readVersionedJsonText(spec, filePath));
}

export async function saveVersionedJson<T>(
  spec: VersionedJsonSpec<T>,
  filePath: string,
  data: T,
): Promise<T> {
  const validated = validateForSave(spec, data);
  await atomicWriteJson(filePath, validated);
  return validated;
}

/** Synchronous variant of saveVersionedJson — identical validation + atomic write. */
export function saveVersionedJsonSync<T>(spec: VersionedJsonSpec<T>, filePath: string, data: T): T {
  const validated = validateForSave(spec, data);
  atomicWriteJsonSync(filePath, validated);
  return validated;
}
