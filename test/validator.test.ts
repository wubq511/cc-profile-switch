import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { validateProfile } from '../src/core/validator';

describe('profile validator', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-validator-'));
    tempRoots.push(root);
    return join(root, '.cc-profile-switch');
  }

  async function makeProfile(name = 'coding'): Promise<{ appHome: string; paths: ReturnType<typeof getProfileTemplatePaths> }> {
    const appHome = await makeAppHome();
    await createAppConfig(appHome);
    await createProfileFromTemplate({ appHomePath: appHome, name, template: 'coding' });
    return { appHome, paths: getProfileTemplatePaths(appHome, name) };
  }

  it('reports valid when a profile has the required structure and JSON files', async () => {
    const { appHome } = await makeProfile();

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.status).toBe('valid');
    expect(result.findings).toEqual([]);
  });

  it('requires profile-scoped auto memory files and settings', async () => {
    const { appHome, paths } = await makeProfile();
    await rm(paths.autoMemoryPath, { recursive: true, force: true });
    await fs.writeJson(paths.settingsPath, {
      autoMemoryDirectory: join(paths.profileRootPath, 'elsewhere'),
    });

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.status).toBe('error');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'REQUIRED_DIRECTORY_MISSING',
          path: paths.autoMemoryPath,
        }),
        expect.objectContaining({
          severity: 'error',
          code: 'PROFILE_MEMORY_DIRECTORY_MISMATCH',
          path: paths.settingsPath,
        }),
      ]),
    );
  });

  it('reports errors for missing required files and directories', async () => {
    const { appHome, paths } = await makeProfile();
    await rm(paths.settingsPath);
    await rm(paths.pluginsPath, { recursive: true });

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.status).toBe('error');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'REQUIRED_FILE_MISSING', path: paths.settingsPath }),
        expect.objectContaining({ severity: 'error', code: 'REQUIRED_DIRECTORY_MISSING', path: paths.pluginsPath }),
      ]),
    );
  });

  it('reports invalid JSON and invalid profile manifest shape', async () => {
    const { appHome, paths } = await makeProfile();
    await fs.writeFile(paths.profileConfigPath, '{"name":"coding","template":"unknown"}', 'utf8');
    await fs.writeFile(paths.mcpConfigPath, '{not-json', 'utf8');

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.status).toBe('error');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'PROFILE_MANIFEST_INVALID' }),
        expect.objectContaining({ severity: 'error', code: 'JSON_INVALID', path: paths.mcpConfigPath }),
      ]),
    );
  });

  it('detects path traversal in launch plugin directories', async () => {
    const { appHome, paths } = await makeProfile();
    const manifest = await fs.readJson(paths.profileConfigPath);
    await fs.writeJson(paths.profileConfigPath, {
      ...manifest,
      launch: {
        pluginDirs: ['..\\outside'],
      },
    });

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.status).toBe('error');
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'PROFILE_PATH_TRAVERSAL' }),
    );
  });

  it('reports high-risk sensitive filenames as errors and medium-risk names as warnings', async () => {
    const { appHome, paths } = await makeProfile();
    await fs.writeFile(join(paths.claudeHomePath, 'oauth-token.json'), '{}', 'utf8');
    await fs.writeFile(join(paths.claudeHomePath, 'chat-history.log'), '', 'utf8');

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.status).toBe('error');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'SENSITIVE_FILENAME_HIGH' }),
        expect.objectContaining({ severity: 'warning', code: 'SENSITIVE_FILENAME_MEDIUM' }),
      ]),
    );
  });

  it('warns but does not block Claude-created profile state names', async () => {
    const { appHome, paths } = await makeProfile();
    await fs.writeFile(join(paths.claudeHomePath, '.claude.json'), '{}', 'utf8');
    await fs.ensureDir(join(paths.claudeHomePath, 'sessions'));
    await fs.ensureDir(join(paths.pluginsPath, 'example-plugin'));
    await fs.writeFile(join(paths.pluginsPath, 'example-plugin', 'session-start.sh'), '', 'utf8');

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.status).toBe('warning');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', code: 'SENSITIVE_FILENAME_MEDIUM' }),
      ]),
    );
    expect(result.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'SENSITIVE_FILENAME_HIGH' }),
      ]),
    );
  });
});
