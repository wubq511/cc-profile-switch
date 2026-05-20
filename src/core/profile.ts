import fs from 'fs-extra';

import { resolveInside, validateProfileName } from '../platform/windows-path';
import {
  createAppConfig,
  ensureAppHomeStructure,
  getAppHomePaths,
  loadAppConfig,
  type Clock,
} from './app-config';
import {
  createProfileFromTemplate,
  ensureDefaultProfileSettingsEnv,
  getProfileTemplatePaths,
  type ProfileTemplateName,
  type ProfileTemplatePaths,
} from './profile-template';
import { CcpsError } from '../utils/errors';

export const defaultProfileNames: ProfileTemplateName[] = ['coding', 'study', 'work', 'research', 'general'];

export type InitProfilesOptions = {
  appHomePath?: string;
  clock?: Clock;
};

export type InitProfilesResult = {
  appHomePath: string;
  configCreated: boolean;
  createdProfiles: ProfileTemplateName[];
  preservedProfiles: ProfileTemplateName[];
};

export type CreateProfileOptions = {
  appHomePath?: string;
  name: string;
  template: ProfileTemplateName;
  clock?: Clock;
};

export type CreateProfileResult = {
  name: string;
  template: ProfileTemplateName;
  paths: ProfileTemplatePaths;
};

export type BackupProfileOptions = {
  appHomePath?: string;
  name: string;
  clock?: Clock;
};

export type BackupProfileResult = {
  profileName: string;
  sourcePath: string;
  backupPath: string;
};

export async function initProfiles(options: InitProfilesOptions = {}): Promise<InitProfilesResult> {
  const appHomePath = options.appHomePath;
  const paths = await ensureAppHomeStructure(appHomePath);
  const configCreated = await ensureConfig(paths.appHomePath, options.clock);
  await ensureExistingProfileSettingsEnv(paths.appHomePath, paths.profilesPath);

  const createdProfiles: ProfileTemplateName[] = [];
  const preservedProfiles: ProfileTemplateName[] = [];

  for (const profileName of defaultProfileNames) {
    const profilePaths = getProfileTemplatePaths(paths.appHomePath, profileName);

    if (await fs.pathExists(profilePaths.profileRootPath)) {
      preservedProfiles.push(profileName);
      continue;
    }

    await createProfileFromTemplate({
      appHomePath: paths.appHomePath,
      name: profileName,
      template: profileName,
      clock: options.clock,
    });
    createdProfiles.push(profileName);
  }

  return {
    appHomePath: paths.appHomePath,
    configCreated,
    createdProfiles,
    preservedProfiles,
  };
}

async function ensureExistingProfileSettingsEnv(appHomePath: string, profilesPath: string): Promise<void> {
  const entries = await fs.readdir(profilesPath, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        let profilePaths: ProfileTemplatePaths;

        try {
          profilePaths = getProfileTemplatePaths(appHomePath, entry.name);
        } catch {
          return;
        }

        await ensureDefaultProfileSettingsEnv(profilePaths.settingsPath);
      }),
  );
}

export async function createProfile(options: CreateProfileOptions): Promise<CreateProfileResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;

  await loadAppConfig(appHomePath);

  const { config, paths } = await createProfileFromTemplate({
    appHomePath,
    name: options.name,
    template: options.template,
    clock: options.clock,
  });

  return {
    name: config.name,
    template: config.template,
    paths,
  };
}

export async function backupProfile(options: BackupProfileOptions): Promise<BackupProfileResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const appPaths = await ensureAppHomeStructure(appHomePath);

  await loadAppConfig(appPaths.appHomePath);

  const paths = getProfileTemplatePaths(appPaths.appHomePath, options.name);
  if (!(await fs.pathExists(paths.profileRootPath))) {
    throw new CcpsError('PROFILE_NOT_FOUND', 'Profile does not exist.', {
      guidance: `Create the profile first: ccps create ${options.name} --template blank`,
    });
  }

  const backupPath = getBackupPath(appPaths.backupsPath, options.name, options.clock);
  await fs.copy(paths.profileRootPath, backupPath, {
    overwrite: false,
    errorOnExist: true,
  });

  return {
    profileName: options.name,
    sourcePath: paths.profileRootPath,
    backupPath,
  };
}

function getBackupPath(backupsPath: string, profileName: string, clock: Clock = () => new Date()): string {
  const safeName = validateProfileName(profileName);
  const timestamp = formatBackupTimestamp(clock());
  return resolveInside(backupsPath, `${safeName}-${timestamp}`);
}

function formatBackupTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = padTimestampPart(date.getUTCMonth() + 1);
  const day = padTimestampPart(date.getUTCDate());
  const hours = padTimestampPart(date.getUTCHours());
  const minutes = padTimestampPart(date.getUTCMinutes());
  const seconds = padTimestampPart(date.getUTCSeconds());

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function padTimestampPart(value: number): string {
  return value.toString().padStart(2, '0');
}

async function ensureConfig(appHomePath: string, clock?: Clock): Promise<boolean> {
  const { configPath } = getAppHomePaths(appHomePath);

  if (await fs.pathExists(configPath)) {
    await loadAppConfig(appHomePath);
    return false;
  }

  await createAppConfig(appHomePath, { clock });
  return true;
}
