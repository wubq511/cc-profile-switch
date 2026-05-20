import fs from 'fs-extra';

import { type AppConfig } from '../schemas/config';
import { profileConfigSchema, type ProfileConfig } from '../schemas/profile';
import { CcpsError } from '../utils/errors';
import { validateProfileName } from '../platform/windows-path';
import {
  getAppHomePaths,
  loadAppConfig,
  saveAppConfig,
  type Clock,
  writeJsonFile,
} from './app-config';
import { backupProfile } from './profile';
import { getProfileTemplatePaths, type ProfileTemplatePaths } from './profile-template';
import {
  isLaunchBlocking,
  validateProfile,
  type ProfileValidationResult,
  type ValidationStatus,
} from './validator';

export type ProfileSummary = {
  name: string;
  description: string;
  status: ValidationStatus;
  isDefault: boolean;
  isLastUsed: boolean;
  profileRootPath: string;
  claudeHomePath: string;
};

export type ProfileManagementOptions = {
  appHomePath?: string;
};

export type CopyProfileOptions = ProfileManagementOptions & {
  from: string;
  to: string;
  clock?: Clock;
};

export type CopyProfileResult = {
  sourceName: string;
  targetName: string;
  sourcePath: string;
  targetPath: string;
};

export type RenameProfileOptions = ProfileManagementOptions & {
  oldName: string;
  newName: string;
  clock?: Clock;
};

export type RenameProfileResult = {
  oldName: string;
  newName: string;
  oldPath: string;
  newPath: string;
};

export type RemoveProfileOptions = ProfileManagementOptions & {
  name: string;
  confirmation: string;
  clock?: Clock;
};

export type RemoveProfileResult = {
  profileName: string;
  removedPath: string;
  backupPath: string;
};

export type DefaultProfileOptions = ProfileManagementOptions & {
  clock?: Clock;
};

export type SetDefaultProfileOptions = DefaultProfileOptions & {
  name: string;
};

export type ResolveLaunchProfileOptions = ProfileManagementOptions & {
  requestedProfile?: string;
};

type ConfigUpdater = (config: AppConfig) => AppConfig;

export async function listProfilesForDisplay(options: ProfileManagementOptions = {}): Promise<ProfileSummary[]> {
  const appHomePath = resolveAppHomePath(options.appHomePath);
  const config = await loadAppConfig(appHomePath);
  const { profilesPath } = getAppHomePaths(appHomePath);

  if (!(await fs.pathExists(profilesPath))) {
    return [];
  }

  const entries = await fs.readdir(profilesPath, { withFileTypes: true });
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<ProfileSummary | undefined> => {
        let validation: ProfileValidationResult;

        try {
          validation = await validateProfile({ appHomePath, name: entry.name });
        } catch (error) {
          if (error instanceof CcpsError && error.code === 'INVALID_PROFILE_NAME') {
            return undefined;
          }

          throw error;
        }

        return {
          name: validation.profileName,
          description: validation.config?.description ?? '',
          status: validation.status,
          isDefault: config.defaultProfile === validation.profileName,
          isLastUsed: config.lastUsedProfile === validation.profileName,
          profileRootPath: validation.profileRootPath,
          claudeHomePath: validation.claudeHomePath,
        };
      }),
  );

  return summaries
    .filter((summary): summary is ProfileSummary => summary !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function copyProfile(options: CopyProfileOptions): Promise<CopyProfileResult> {
  const appHomePath = resolveAppHomePath(options.appHomePath);
  await loadAppConfig(appHomePath);

  const source = await validateExistingProfile(appHomePath, options.from);
  const targetName = validateProfileName(options.to);
  const targetPaths = getProfileTemplatePaths(appHomePath, targetName);

  await ensureTargetDoesNotExist(targetName, targetPaths);

  await fs.copy(source.profileRootPath, targetPaths.profileRootPath, {
    overwrite: false,
    errorOnExist: true,
  });

  const timestamp = resolveTimestamp(options.clock);
  await writeProfileManifest(targetPaths.profileConfigPath, {
    ...requireProfileConfig(source),
    name: targetName,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await repairProfileSettings(targetPaths);

  return {
    sourceName: source.profileName,
    targetName,
    sourcePath: source.profileRootPath,
    targetPath: targetPaths.profileRootPath,
  };
}

export async function renameProfile(options: RenameProfileOptions): Promise<RenameProfileResult> {
  const appHomePath = resolveAppHomePath(options.appHomePath);
  await loadAppConfig(appHomePath);

  const source = await validateExistingProfile(appHomePath, options.oldName);
  const newName = validateProfileName(options.newName);
  const newPaths = getProfileTemplatePaths(appHomePath, newName);

  await ensureTargetDoesNotExist(newName, newPaths);
  await fs.move(source.profileRootPath, newPaths.profileRootPath, { overwrite: false });

  await writeProfileManifest(newPaths.profileConfigPath, {
    ...requireProfileConfig(source),
    name: newName,
    updatedAt: resolveTimestamp(options.clock),
  });
  await repairProfileSettings(newPaths);
  await updateConfig(appHomePath, (config) => renameConfigReferences(config, source.profileName, newName), options.clock);

  return {
    oldName: source.profileName,
    newName,
    oldPath: source.profileRootPath,
    newPath: newPaths.profileRootPath,
  };
}

export async function removeProfile(options: RemoveProfileOptions): Promise<RemoveProfileResult> {
  const appHomePath = resolveAppHomePath(options.appHomePath);
  await loadAppConfig(appHomePath);

  const profileName = validateProfileName(options.name);
  if (options.confirmation !== profileName) {
    throw new CcpsError('PROFILE_DELETE_CONFIRMATION_MISMATCH', 'Profile removal confirmation did not match.', {
      guidance: `Type the exact profile name to remove it: ${profileName}`,
    });
  }

  const profile = await validateExistingProfile(appHomePath, profileName);
  const backup = await backupProfile({
    appHomePath,
    name: profile.profileName,
    clock: options.clock,
  });

  await fs.remove(profile.profileRootPath);
  await updateConfig(appHomePath, (config) => clearConfigReferences(config, profile.profileName), options.clock);

  return {
    profileName: profile.profileName,
    removedPath: profile.profileRootPath,
    backupPath: backup.backupPath,
  };
}

export async function getDefaultProfile(options: ProfileManagementOptions = {}): Promise<string | undefined> {
  const config = await loadAppConfig(resolveAppHomePath(options.appHomePath));
  return config.defaultProfile;
}

export async function setDefaultProfile(options: SetDefaultProfileOptions): Promise<string> {
  const appHomePath = resolveAppHomePath(options.appHomePath);
  const profile = await validateExistingProfile(appHomePath, options.name);

  await updateConfig(
    appHomePath,
    (config) => ({
      ...config,
      defaultProfile: profile.profileName,
    }),
    options.clock,
  );

  return profile.profileName;
}

export async function clearDefaultProfile(options: DefaultProfileOptions = {}): Promise<void> {
  const appHomePath = resolveAppHomePath(options.appHomePath);
  await updateConfig(appHomePath, clearDefaultReference, options.clock);
}

export async function resolveLaunchProfile(options: ResolveLaunchProfileOptions): Promise<string> {
  const appHomePath = resolveAppHomePath(options.appHomePath);

  if (options.requestedProfile !== undefined) {
    const requestedProfile = validateProfileName(options.requestedProfile);
    await ensureProfileExists(appHomePath, requestedProfile);
    return requestedProfile;
  }

  const defaultProfile = await getDefaultProfile({ appHomePath });
  if (defaultProfile === undefined) {
    throw new CcpsError('DEFAULT_PROFILE_NOT_SET', 'No profile was requested and no default profile is configured.', {
      guidance: 'Pass a profile name or set one with ccps default set <profile>.',
    });
  }

  await ensureProfileExists(appHomePath, defaultProfile);
  return defaultProfile;
}

function resolveAppHomePath(appHomePath?: string): string {
  return appHomePath ?? getAppHomePaths().appHomePath;
}

async function validateExistingProfile(appHomePath: string, name: string): Promise<ProfileValidationResult> {
  const profileName = validateProfileName(name);
  await ensureProfileExists(appHomePath, profileName);

  const validation = await validateProfile({ appHomePath, name: profileName });
  if (isLaunchBlocking(validation)) {
    throw new CcpsError('PROFILE_VALIDATION_FAILED', 'Profile validation failed; refusing profile mutation.', {
      guidance: `Run ccps validate ${profileName} and fix error findings before changing this profile.`,
    });
  }

  requireProfileConfig(validation);
  return validation;
}

async function ensureProfileExists(appHomePath: string, profileName: string): Promise<void> {
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  if (!(await fs.pathExists(paths.profileRootPath))) {
    throw new CcpsError('PROFILE_NOT_FOUND', 'Profile does not exist.', {
      guidance: `Create the profile first: ccps create ${profileName} --template blank`,
    });
  }
}

async function ensureTargetDoesNotExist(targetName: string, paths: ProfileTemplatePaths): Promise<void> {
  if (await fs.pathExists(paths.profileRootPath)) {
    throw new CcpsError('PROFILE_ALREADY_EXISTS', 'Refusing to overwrite an existing profile.', {
      guidance: `Choose a different profile name or remove the existing profile intentionally: ${targetName}`,
    });
  }
}

function requireProfileConfig(validation: ProfileValidationResult): ProfileConfig {
  if (validation.config === undefined) {
    throw new CcpsError('PROFILE_CONFIG_UNAVAILABLE', 'Profile config could not be loaded after validation.', {
      guidance: `Run ccps validate ${validation.profileName} and fix profile.json.`,
    });
  }

  return validation.config;
}

async function writeProfileManifest(profileConfigPath: string, config: ProfileConfig): Promise<void> {
  await writeJsonFile(profileConfigPath, profileConfigSchema.parse(config), { overwrite: true });
}

async function repairProfileSettings(paths: ProfileTemplatePaths): Promise<void> {
  const settingsJson: unknown = await fs.readJson(paths.settingsPath);
  const settings = isRecord(settingsJson) ? settingsJson : {};

  await writeJsonFile(
    paths.settingsPath,
    {
      ...settings,
      autoMemoryDirectory: paths.autoMemoryPath,
    },
    { overwrite: true },
  );
}

async function updateConfig(appHomePath: string, updater: ConfigUpdater, clock?: Clock): Promise<AppConfig> {
  const config = await loadAppConfig(appHomePath);
  return saveAppConfig(appHomePath, updater(config), { clock });
}

function renameConfigReferences(config: AppConfig, oldName: string, newName: string): AppConfig {
  return {
    ...config,
    defaultProfile: config.defaultProfile === oldName ? newName : config.defaultProfile,
    lastUsedProfile: config.lastUsedProfile === oldName ? newName : config.lastUsedProfile,
  };
}

function clearConfigReferences(config: AppConfig, profileName: string): AppConfig {
  const nextConfig: AppConfig = {
    ...config,
    lastUsedProfile: config.lastUsedProfile === profileName ? null : config.lastUsedProfile,
  };

  if (nextConfig.defaultProfile === profileName) {
    delete nextConfig.defaultProfile;
  }

  return nextConfig;
}

function clearDefaultReference(config: AppConfig): AppConfig {
  const nextConfig = { ...config };
  delete nextConfig.defaultProfile;
  return nextConfig;
}

function resolveTimestamp(clock: Clock = () => new Date()): string {
  return clock().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
