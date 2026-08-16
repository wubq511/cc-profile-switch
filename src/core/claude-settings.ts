import fs from 'fs-extra';

import { resolveFilesystemPath, resolveUserHome } from '../platform/path';
import { apiSettingsSchema } from '../schemas/api-settings';
import { isNodeError, isRecord } from '../utils/type-guards';
import { getAppHomePaths, writeJsonFile } from './app-config';

export type ImportClaudeApiSettingsOptions = {
  appHomePath: string;
  userHomePath?: string;
};

export type ImportClaudeApiSettingsResult = {
  sourcePath: string;
  targetPath: string;
  importedKeys: string[];
  preservedKeys: string[];
  skipped: boolean;
};

export function getClaudeSettingsPath(userHomePath = resolveUserHome()): string {
  return resolveFilesystemPath(userHomePath, '.claude', 'settings.json');
}

export function extractAnthropicApiEnv(settingsJson: unknown): Record<string, string> {
  if (!isRecord(settingsJson) || !isRecord(settingsJson.env)) {
    return {};
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(settingsJson.env)) {
    if (key.startsWith('ANTHROPIC_') && typeof value === 'string') {
      env[key] = value;
    }
  }

  return env;
}

export async function importClaudeApiSettings(
  options: ImportClaudeApiSettingsOptions,
): Promise<ImportClaudeApiSettingsResult> {
  const sourcePath = getClaudeSettingsPath(options.userHomePath);
  const targetPath = getAppHomePaths(options.appHomePath).apiSettingsPath;
  const sourceSettings = await readJsonIfPresent(sourcePath);
  if (sourceSettings === undefined) {
    return skippedImport(sourcePath, targetPath);
  }

  const sourceEnv = extractAnthropicApiEnv(sourceSettings);
  const sourceKeys = sortedKeys(sourceEnv);
  if (sourceKeys.length === 0) {
    return skippedImport(sourcePath, targetPath);
  }

  const existing = await readExistingApiSettings(targetPath);
  if (existing.invalid) {
    return skippedImport(sourcePath, targetPath);
  }

  const nextEnv = { ...existing.env };
  const importedKeys: string[] = [];
  const updatedKeys: string[] = [];

  for (const key of sourceKeys) {
    if (Object.hasOwn(nextEnv, key)) {
      if (nextEnv[key] !== sourceEnv[key]) {
        nextEnv[key] = sourceEnv[key];
        updatedKeys.push(key);
      }
      continue;
    }

    nextEnv[key] = sourceEnv[key];
    importedKeys.push(key);
  }

  if (importedKeys.length === 0 && updatedKeys.length === 0) {
    return {
      sourcePath,
      targetPath,
      importedKeys,
      preservedKeys: [],
      skipped: true,
    };
  }

  await writeJsonFile(targetPath, { env: nextEnv }, { overwrite: existing.present });

  return {
    sourcePath,
    targetPath,
    importedKeys: [...importedKeys, ...updatedKeys],
    preservedKeys: [],
    skipped: false,
  };
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return await fs.readJson(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }

    if (error instanceof SyntaxError) {
      return undefined;
    }

    throw error;
  }
}

async function readExistingApiSettings(
  filePath: string,
): Promise<{ present: boolean; invalid: boolean; env: Record<string, string> }> {
  const value = await readJsonIfPresent(filePath);
  if (value === undefined) {
    return { present: false, invalid: false, env: {} };
  }

  const parsed = apiSettingsSchema.safeParse(value);
  if (!parsed.success) {
    return { present: true, invalid: true, env: {} };
  }

  return { present: true, invalid: false, env: parsed.data.env };
}

function skippedImport(sourcePath: string, targetPath: string): ImportClaudeApiSettingsResult {
  return {
    sourcePath,
    targetPath,
    importedKeys: [],
    preservedKeys: [],
    skipped: true,
  };
}

function sortedKeys(value: Record<string, string>): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}
