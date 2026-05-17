import fs from 'fs-extra';

import { getAppHomePath, resolveInside } from '../platform/windows-path';
import { appConfigSchema, type AppConfig } from '../schemas/config';
import { CcpsError } from '../utils/errors';

export type Clock = () => Date;

export type AppHomePaths = {
  appHomePath: string;
  configPath: string;
  apiSettingsPath: string;
  profilesPath: string;
  backupsPath: string;
};

export type AppConfigWriteOptions = {
  clock?: Clock;
};

export function getAppHomePaths(appHomePath = getAppHomePath()): AppHomePaths {
  return {
    appHomePath,
    configPath: resolveInside(appHomePath, 'config.json'),
    apiSettingsPath: resolveInside(appHomePath, 'api-settings.json'),
    profilesPath: resolveInside(appHomePath, 'profiles'),
    backupsPath: resolveInside(appHomePath, 'backups'),
  };
}

export function createInitialAppConfig(clock: Clock = () => new Date()): AppConfig {
  const timestamp = clock().toISOString();

  return {
    version: 1,
    lastUsedProfile: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function ensureAppHomeStructure(appHomePath = getAppHomePath()): Promise<AppHomePaths> {
  const paths = getAppHomePaths(appHomePath);

  await fs.ensureDir(paths.appHomePath);
  await fs.ensureDir(paths.profilesPath);
  await fs.ensureDir(paths.backupsPath);

  return paths;
}

export async function createAppConfig(
  appHomePath = getAppHomePath(),
  options: AppConfigWriteOptions = {},
): Promise<AppConfig> {
  const paths = await ensureAppHomeStructure(appHomePath);
  const config = appConfigSchema.parse(createInitialAppConfig(options.clock));

  await writeJsonFile(paths.configPath, config, { overwrite: false });

  return config;
}

export async function loadAppConfig(appHomePath = getAppHomePath()): Promise<AppConfig> {
  const { configPath } = getAppHomePaths(appHomePath);
  let raw: string;

  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CcpsError('APP_CONFIG_NOT_FOUND', 'App config does not exist.', {
        guidance: 'Run ccps init before loading profiles.',
        cause: error,
      });
    }

    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new CcpsError('APP_CONFIG_INVALID_JSON', 'App config is not valid JSON.', {
      guidance: 'Fix config.json or recreate it from a backup.',
      cause: error,
    });
  }

  const parsedConfig = appConfigSchema.safeParse(parsedJson);
  if (!parsedConfig.success) {
    throw new CcpsError('APP_CONFIG_INVALID', 'App config does not match the expected schema.', {
      guidance: 'Check config.json fields and profile names.',
      cause: parsedConfig.error,
    });
  }

  return parsedConfig.data;
}

export async function saveAppConfig(
  appHomePath: string,
  config: AppConfig,
  options: AppConfigWriteOptions = {},
): Promise<AppConfig> {
  const paths = await ensureAppHomeStructure(appHomePath);
  const nextConfig = appConfigSchema.parse({
    ...config,
    updatedAt: (options.clock ?? (() => new Date()))().toISOString(),
  });

  await writeJsonFile(paths.configPath, nextConfig, { overwrite: true });

  return nextConfig;
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
  options: { overwrite: boolean },
): Promise<void> {
  try {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: options.overwrite ? 'w' : 'wx',
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new CcpsError('FILE_ALREADY_EXISTS', 'Refusing to overwrite an existing file.', {
        guidance: `Choose a new name or remove the existing file intentionally: ${filePath}`,
        cause: error,
      });
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
