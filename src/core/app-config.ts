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
