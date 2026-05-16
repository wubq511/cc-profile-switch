import fs from 'fs-extra';

import {
  createAppConfig,
  ensureAppHomeStructure,
  getAppHomePaths,
  loadAppConfig,
  type Clock,
} from './app-config';
import {
  createProfileFromTemplate,
  getProfileTemplatePaths,
  type ProfileTemplateName,
  type ProfileTemplatePaths,
} from './profile-template';

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

export async function initProfiles(options: InitProfilesOptions = {}): Promise<InitProfilesResult> {
  const appHomePath = options.appHomePath;
  const paths = await ensureAppHomeStructure(appHomePath);
  const configCreated = await ensureConfig(paths.appHomePath, options.clock);
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

async function ensureConfig(appHomePath: string, clock?: Clock): Promise<boolean> {
  const { configPath } = getAppHomePaths(appHomePath);

  if (await fs.pathExists(configPath)) {
    await loadAppConfig(appHomePath);
    return false;
  }

  await createAppConfig(appHomePath, { clock });
  return true;
}
