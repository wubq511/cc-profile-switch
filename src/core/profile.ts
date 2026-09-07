import fs from 'fs-extra';

import {
  createAppConfig,
  ensureAppHomeStructure,
  getAppHomePaths,
  loadAppConfig,
  type Clock,
} from './app-config';
import {
  allocateBackupDirPath,
  createBackupStagingDir,
  discardBackupStagingDir,
  publishBackupWithCollisionRetry,
} from './backup';
import {
  createProfileFromTemplate,
  ensureCcpsProfileRule,
  ensureDefaultProfileSettingsEnv,
  ensureProfileClaudeMdExcludes,
  getProfileTemplatePaths,
  type ProfileTemplateName,
  type ProfileTemplatePaths,
} from './profile-template';
import { importClaudeApiSettings, type ImportClaudeApiSettingsResult } from './claude-settings';
import { CcpsError } from '../utils/errors';

export const defaultProfileNames: ProfileTemplateName[] = [
  'coding',
  'study',
  'work',
  'research',
  'general',
];

export type InitProfilesOptions = {
  appHomePath?: string;
  clock?: Clock;
};

export type InitProfilesResult = {
  appHomePath: string;
  configCreated: boolean;
  createdProfiles: ProfileTemplateName[];
  preservedProfiles: ProfileTemplateName[];
  apiSettingsImport: ImportClaudeApiSettingsResult;
};

export type CreateProfileOptions = {
  appHomePath?: string;
  name: string;
  template?: ProfileTemplateName;
  clock?: Clock;
};

export type CreateProfileResult = {
  name: string;
  template: ProfileTemplateName | undefined;
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
  const apiSettingsImport = await importClaudeApiSettings({ appHomePath: paths.appHomePath });
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
    apiSettingsImport,
  };
}

async function ensureExistingProfileSettingsEnv(
  appHomePath: string,
  profilesPath: string,
): Promise<void> {
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
        await ensureProfileClaudeMdExcludes(profilePaths.settingsPath);
        await ensureCcpsProfileRule(profilePaths.ccpsProfileRulePath);
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
      guidance: `Create the profile first: ccps create ${options.name}`,
    });
  }

  // The shared Backup ID protocol (issue #107): unique same-second
  // allocation, staging before publish, and an atomic-rename publish whose
  // race retry only ever changes the id. The returned path is the RESOLVED
  // publish target — the directory that actually holds the payload.
  const allocatedPath = await allocateBackupDirPath(
    appPaths.backupsPath,
    options.name,
    options.clock ?? (() => new Date()),
  );
  const stagingDir = await createBackupStagingDir(appPaths.backupsPath);
  let backupPath: string;
  try {
    await fs.copy(paths.profileRootPath, stagingDir, { overwrite: false, errorOnExist: true });
    backupPath = await publishBackupWithCollisionRetry(
      stagingDir,
      allocatedPath,
      appPaths.backupsPath,
      options.name,
      options.clock ?? (() => new Date()),
    );
  } catch (error) {
    await discardBackupStagingDir(stagingDir).catch(() => {});
    throw error;
  }

  return {
    profileName: options.name,
    sourcePath: paths.profileRootPath,
    backupPath,
  };
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
