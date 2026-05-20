import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths, saveAppConfig } from '../src/core/app-config';
import {
  clearDefaultProfile,
  copyProfile,
  getDefaultProfile,
  listProfilesForDisplay,
  removeProfile,
  renameProfile,
  resolveLaunchProfile,
  setDefaultProfile,
} from '../src/core/profile-management';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';

describe('profile management services', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-profile-management-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-05-20T08:00:00Z') });
    return appHome;
  }

  async function makeProfile(appHome: string, name: string, template = 'coding'): Promise<void> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: template as Parameters<typeof createProfileFromTemplate>[0]['template'],
      clock: () => new Date('2026-05-20T08:00:00Z'),
    });
  }

  it('lists profile summaries with validation, default, last-used, and description', async () => {
    const appHome = await makeAppHome();
    const appPaths = getAppHomePaths(appHome);
    await makeProfile(appHome, 'coding', 'coding');
    await makeProfile(appHome, 'study', 'study');
    const config = await fs.readJson(appPaths.configPath);
    await fs.writeJson(appPaths.configPath, {
      ...config,
      defaultProfile: 'coding',
      lastUsedProfile: 'study',
    });

    const summaries = await listProfilesForDisplay({ appHomePath: appHome });

    expect(summaries).toEqual([
      expect.objectContaining({
        name: 'coding',
        status: 'valid',
        isDefault: true,
        isLastUsed: false,
        description: 'Focused software development profile.',
      }),
      expect.objectContaining({
        name: 'study',
        status: 'valid',
        isDefault: false,
        isLastUsed: true,
        description: 'Learning and note-taking profile.',
      }),
    ]);
  });

  it('copies a profile without changing the source and repairs target metadata and memory path', async () => {
    const appHome = await makeAppHome();
    const sourcePaths = getProfileTemplatePaths(appHome, 'coding');
    const targetPaths = getProfileTemplatePaths(appHome, 'deep_work');
    await makeProfile(appHome, 'coding', 'coding');
    await fs.writeFile(sourcePaths.claudeMdPath, '# user edited source\n', 'utf8');
    await fs.writeJson(sourcePaths.settingsPath, {
      autoMemoryDirectory: sourcePaths.autoMemoryPath,
      theme: 'dark',
      env: {
        ANTHROPIC_MODEL: 'profile-model',
      },
    });

    const result = await copyProfile({
      appHomePath: appHome,
      from: 'coding',
      to: 'deep_work',
      clock: () => new Date('2026-05-20T09:15:00Z'),
    });

    expect(result).toMatchObject({
      sourceName: 'coding',
      targetName: 'deep_work',
      sourcePath: sourcePaths.profileRootPath,
      targetPath: targetPaths.profileRootPath,
    });
    await expect(fs.readFile(sourcePaths.claudeMdPath, 'utf8')).resolves.toBe('# user edited source\n');
    await expect(fs.readFile(targetPaths.claudeMdPath, 'utf8')).resolves.toBe('# user edited source\n');
    await expect(fs.readJson(targetPaths.profileConfigPath)).resolves.toMatchObject({
      name: 'deep_work',
      template: 'coding',
      createdAt: '2026-05-20T09:15:00.000Z',
      updatedAt: '2026-05-20T09:15:00.000Z',
    });
    await expect(fs.readJson(targetPaths.settingsPath)).resolves.toEqual({
      autoMemoryDirectory: targetPaths.autoMemoryPath,
      theme: 'dark',
      env: {
        ANTHROPIC_MODEL: 'profile-model',
      },
    });
  });

  it('renames a profile, repairs metadata and memory path, and updates config references', async () => {
    const appHome = await makeAppHome();
    const oldPaths = getProfileTemplatePaths(appHome, 'coding');
    const newPaths = getProfileTemplatePaths(appHome, 'focus');
    await makeProfile(appHome, 'coding', 'coding');
    await saveAppConfig(
      appHome,
      {
        version: 1,
        defaultProfile: 'coding',
        lastUsedProfile: 'coding',
      },
      { clock: () => new Date('2026-05-20T08:05:00Z') },
    );

    const result = await renameProfile({
      appHomePath: appHome,
      oldName: 'coding',
      newName: 'focus',
      clock: () => new Date('2026-05-20T09:30:00Z'),
    });

    expect(result).toMatchObject({
      oldName: 'coding',
      newName: 'focus',
      oldPath: oldPaths.profileRootPath,
      newPath: newPaths.profileRootPath,
    });
    await expect(fs.pathExists(oldPaths.profileRootPath)).resolves.toBe(false);
    await expect(fs.readJson(newPaths.profileConfigPath)).resolves.toMatchObject({
      name: 'focus',
      createdAt: '2026-05-20T08:00:00.000Z',
      updatedAt: '2026-05-20T09:30:00.000Z',
    });
    await expect(fs.readJson(newPaths.settingsPath)).resolves.toMatchObject({
      autoMemoryDirectory: newPaths.autoMemoryPath,
    });
    await expect(fs.readJson(getAppHomePaths(appHome).configPath)).resolves.toMatchObject({
      defaultProfile: 'focus',
      lastUsedProfile: 'focus',
    });
  });

  it('removes only the confirmed profile after creating a backup and clears matching config references', async () => {
    const appHome = await makeAppHome();
    const codingPaths = getProfileTemplatePaths(appHome, 'coding');
    const studyPaths = getProfileTemplatePaths(appHome, 'study');
    const backupPath = join(appHome, 'backups', 'coding-20260520-094500');
    await makeProfile(appHome, 'coding', 'coding');
    await makeProfile(appHome, 'study', 'study');
    await saveAppConfig(
      appHome,
      {
        version: 1,
        defaultProfile: 'coding',
        lastUsedProfile: 'coding',
      },
      { clock: () => new Date('2026-05-20T08:05:00Z') },
    );

    const result = await removeProfile({
      appHomePath: appHome,
      name: 'coding',
      confirmation: 'coding',
      clock: () => new Date('2026-05-20T09:45:00Z'),
    });

    expect(result).toMatchObject({
      profileName: 'coding',
      removedPath: codingPaths.profileRootPath,
      backupPath,
    });
    await expect(fs.pathExists(codingPaths.profileRootPath)).resolves.toBe(false);
    await expect(fs.pathExists(studyPaths.profileRootPath)).resolves.toBe(true);
    await expect(fs.pathExists(join(backupPath, 'profile.json'))).resolves.toBe(true);
    await expect(fs.readJson(getAppHomePaths(appHome).configPath)).resolves.toEqual(
      expect.not.objectContaining({
        defaultProfile: expect.any(String),
      }),
    );
    await expect(fs.readJson(getAppHomePaths(appHome).configPath)).resolves.toMatchObject({
      lastUsedProfile: null,
    });
  });

  it('allows removing the last profile while leaving config valid', async () => {
    const appHome = await makeAppHome();
    const codingPaths = getProfileTemplatePaths(appHome, 'coding');
    await makeProfile(appHome, 'coding', 'coding');
    await setDefaultProfile({ appHomePath: appHome, name: 'coding' });

    await removeProfile({
      appHomePath: appHome,
      name: 'coding',
      confirmation: 'coding',
      clock: () => new Date('2026-05-20T09:45:00Z'),
    });

    await expect(fs.pathExists(codingPaths.profileRootPath)).resolves.toBe(false);
    await expect(listProfilesForDisplay({ appHomePath: appHome })).resolves.toEqual([]);
    await expect(getDefaultProfile({ appHomePath: appHome })).resolves.toBeUndefined();
  });

  it('gets, sets, clears, and resolves default profiles', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding', 'coding');

    await expect(getDefaultProfile({ appHomePath: appHome })).resolves.toBeUndefined();
    await expect(resolveLaunchProfile({ appHomePath: appHome, requestedProfile: 'coding' })).resolves.toBe('coding');

    await setDefaultProfile({
      appHomePath: appHome,
      name: 'coding',
      clock: () => new Date('2026-05-20T10:00:00Z'),
    });

    await expect(getDefaultProfile({ appHomePath: appHome })).resolves.toBe('coding');
    await expect(resolveLaunchProfile({ appHomePath: appHome })).resolves.toBe('coding');

    await clearDefaultProfile({
      appHomePath: appHome,
      clock: () => new Date('2026-05-20T10:05:00Z'),
    });

    await expect(getDefaultProfile({ appHomePath: appHome })).resolves.toBeUndefined();
    await expect(resolveLaunchProfile({ appHomePath: appHome })).rejects.toMatchObject({
      code: 'DEFAULT_PROFILE_NOT_SET',
    });
  });

  it('rejects invalid names, missing profiles, invalid source profiles, target collisions, and wrong removal confirmation', async () => {
    const appHome = await makeAppHome();
    const codingPaths = getProfileTemplatePaths(appHome, 'coding');
    await makeProfile(appHome, 'coding', 'coding');
    await makeProfile(appHome, 'study', 'study');

    await expect(copyProfile({ appHomePath: appHome, from: 'coding', to: '..' })).rejects.toMatchObject({
      code: 'INVALID_PROFILE_NAME',
    });
    await expect(copyProfile({ appHomePath: appHome, from: 'missing', to: 'copy' })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
    await expect(copyProfile({ appHomePath: appHome, from: 'coding', to: 'study' })).rejects.toMatchObject({
      code: 'PROFILE_ALREADY_EXISTS',
    });
    await rm(codingPaths.settingsPath);
    await expect(copyProfile({ appHomePath: appHome, from: 'coding', to: 'copy' })).rejects.toMatchObject({
      code: 'PROFILE_VALIDATION_FAILED',
    });
    await expect(
      removeProfile({
        appHomePath: appHome,
        name: 'study',
        confirmation: 'wrong',
      }),
    ).rejects.toMatchObject({
      code: 'PROFILE_DELETE_CONFIRMATION_MISMATCH',
    });
  });
});
