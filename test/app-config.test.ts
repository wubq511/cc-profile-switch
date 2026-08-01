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

  it('builds deterministic initial v2 config', () => {
    expect(createInitialAppConfig(fixedClock)).toEqual({
      version: 2,
      lastUsedProfile: null,
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
      recovery: { retentionDays: 30 },
      workbench: { skillsDiscoveryExperimental: true },
    });
  });

  it('creates app home folders and v2 config without touching the real app home', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });
    const paths = getAppHomePaths(appHome);

    expect(config.version).toBe(2);
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);
    expect(await fs.pathExists(paths.configPath)).toBe(true);
    expect(await fs.pathExists(paths.profilesPath)).toBe(true);
    expect(await fs.pathExists(paths.backupsPath)).toBe(true);
  });

  it('loads and validates v2 config.json', async () => {
    const appHome = await makeAppHome();
    await createAppConfig(appHome, { clock: fixedClock });

    const config = await loadAppConfig(appHome);
    expect(config.version).toBe(2);
    expect(config.lastUsedProfile).toBeNull();
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);
  });

  it('migrates a v1 config to v2 in memory without writing', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    await fs.ensureDir(appHome);
    await fs.ensureDir(paths.profilesPath);
    await fs.ensureDir(paths.backupsPath);
    // Write a v1 config directly
    await fs.writeJson(paths.configPath, {
      version: 1,
      defaultProfile: 'coding',
      lastUsedProfile: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const config = await loadAppConfig(appHome);
    expect(config.version).toBe(2);
    expect(config.defaultProfile).toBe('coding');
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);

    // Read path never writes — file on disk is still v1
    const onDisk = await fs.readJson(paths.configPath);
    expect(onDisk.version).toBe(1);
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

  it('rejects a future version config', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);

    await fs.ensureDir(appHome);
    await fs.writeJson(paths.configPath, { version: 99 });

    await expect(loadAppConfig(appHome)).rejects.toMatchObject({
      code: 'APP_CONFIG_FUTURE_VERSION',
    });
  });

  it('rejects unknown fields in config', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);

    await fs.ensureDir(appHome);
    await fs.writeJson(paths.configPath, { version: 2, unknownField: true });

    await expect(loadAppConfig(appHome)).rejects.toMatchObject({
      code: 'APP_CONFIG_INVALID',
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

  it('saves v2 config with recovery and workbench settings', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });

    const saved = await saveAppConfig(
      appHome,
      {
        ...config,
        recovery: { retentionDays: 7 },
        workbench: { skillsDiscoveryExperimental: false, language: 'zh' },
      },
      { clock: laterClock },
    );

    expect(saved.recovery.retentionDays).toBe(7);
    expect(saved.workbench.skillsDiscoveryExperimental).toBe(false);
    expect(saved.workbench.language).toBe('zh');
  });

  it('writes config atomically (no .tmp residue)', async () => {
    const appHome = await makeAppHome();
    const config = await createAppConfig(appHome, { clock: fixedClock });

    await saveAppConfig(appHome, config, { clock: laterClock });

    const files = await fs.readdir(appHome);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('exposes statePath in app home paths', () => {
    const paths = getAppHomePaths('/fake/home/.cc-profile-switch');
    expect(paths.statePath).toBe(
      join('/fake/home/.cc-profile-switch', 'state.json'),
    );
  });
});
