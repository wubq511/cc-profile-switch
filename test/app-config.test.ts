import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAppConfig,
  createInitialAppConfig,
  getAppHomePaths,
  loadAppConfig,
  saveAppConfig,
} from '../src/core/app-config';
import { CcpsError } from '../src/utils/errors';

const fixedClock = () => new Date('2026-01-02T03:04:05.000Z');
const laterClock = () => new Date('2026-01-02T04:05:06.000Z');

describe('app config', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-app-config-'));
    tempRoots.push(root);
    return join(root, '.cc-profile-switch');
  }

  it('builds deterministic initial config', () => {
    expect(createInitialAppConfig(fixedClock)).toEqual({
      version: 1,
      lastUsedProfile: null,
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('creates app home folders and config without touching the real app home', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });
    const paths = getAppHomePaths(appHome);

    expect(config.version).toBe(1);
    expect(await fs.pathExists(paths.configPath)).toBe(true);
    expect(await fs.pathExists(paths.profilesPath)).toBe(true);
    expect(await fs.pathExists(paths.backupsPath)).toBe(true);
  });

  it('loads and validates config.json', async () => {
    const appHome = await makeAppHome();

    await createAppConfig(appHome, { clock: fixedClock });

    await expect(loadAppConfig(appHome)).resolves.toMatchObject({
      version: 1,
      lastUsedProfile: null,
    });
  });

  it('rejects invalid JSON when loading config', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);

    await fs.ensureDir(appHome);
    await fs.writeFile(paths.configPath, '{not-json', 'utf8');

    await expect(loadAppConfig(appHome)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID_JSON',
    });
  });

  it('refuses to overwrite config on create', async () => {
    const appHome = await makeAppHome();

    await createAppConfig(appHome, { clock: fixedClock });

    await expect(createAppConfig(appHome, { clock: fixedClock })).rejects.toBeInstanceOf(CcpsError);
    await expect(createAppConfig(appHome, { clock: fixedClock })).rejects.toMatchObject({
      code: 'FILE_ALREADY_EXISTS',
    });
  });

  it('saves parsed config and updates timestamp deterministically', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });

    const saved = await saveAppConfig(
      appHome,
      {
        ...config,
        defaultProfile: 'coding',
        lastUsedProfile: 'coding',
      },
      { clock: laterClock },
    );

    expect(saved).toMatchObject({
      defaultProfile: 'coding',
      lastUsedProfile: 'coding',
      updatedAt: '2026-01-02T04:05:06.000Z',
    });
    await expect(loadAppConfig(appHome)).resolves.toMatchObject(saved);
  });
});
