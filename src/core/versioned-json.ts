import fs from 'fs-extra';
import path from 'node:path';
import { z } from 'zod';

import { CcpsError } from '../utils/errors';

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
