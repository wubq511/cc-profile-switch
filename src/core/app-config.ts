import fs from 'fs-extra';

import { getAppHomePath, resolveInside } from '../platform/path';
import { appConfigV2Schema, appConfigV1Schema, type AppConfig } from '../schemas/config';
import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';
import {
  loadVersionedJson,
  loadVersionedJsonSync,
  saveVersionedJson,
  saveVersionedJsonSync,
  atomicWriteJson,
  cleanupTmpResidue,
  type VersionedJsonSpec,
} from './versioned-json';
import { type Clock } from './types';

export type { Clock } from './types';

export type AppHomePaths = {
  appHomePath: string;
  configPath: string;
  apiSettingsPath: string;
  statePath: string;
  profilesPath: string;
  backupsPath: string;
  recoveryBinPath: string;
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
    recoveryBinPath: resolveInside(appHomePath, 'recovery-bin'),
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
  await fs.ensureDir(paths.recoveryBinPath);
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

/** Synchronous variant of loadAppConfig — identical parse/migrate/errors. */
export function loadAppConfigSync(appHomePath = getAppHomePath()): AppConfig {
  const { configPath } = getAppHomePaths(appHomePath);
  return loadVersionedJsonSync(appConfigSpec, configPath);
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

/** Synchronous variant of saveAppConfig — identical schema parse, updatedAt
 * stamp, and atomic write. Skips ensureAppHomeStructure: the only caller
 * (Workbench launch, post-spawnSync) runs against an initialized app home. */
export function saveAppConfigSync(
  appHomePath: string,
  config: AppConfig,
  options: AppConfigWriteOptions = {},
): AppConfig {
  const { configPath } = getAppHomePaths(appHomePath);
  const nextConfig = appConfigV2Schema.parse({
    ...config,
    updatedAt: (options.clock ?? (() => new Date()))().toISOString(),
  });

  return saveVersionedJsonSync(appConfigSpec, configPath, nextConfig);
}

/** Write-back for the in-Workbench language switch (issue #54, spec §14):
 * the resolution chain starts from `workbench.language`, so a switch persists
 * here. Load-modify-save through the schema — every other field survives —
 * with the standard atomic write. */
export function saveWorkbenchLanguageSync(
  appHomePath: string,
  language: 'zh' | 'en',
  options: AppConfigWriteOptions = {},
): AppConfig {
  const config = loadAppConfigSync(appHomePath);
  return saveAppConfigSync(
    appHomePath,
    { ...config, workbench: { ...config.workbench, language } },
    options,
  );
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
  options: { overwrite: boolean },
): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;

  if (options.overwrite) {
    await atomicWriteJson(filePath, value);
  } else {
    // Create-only: use wx flag for race-free exclusive creation
    try {
      await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
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
}
