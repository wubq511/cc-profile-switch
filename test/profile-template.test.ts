import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProfileFromTemplate, getProfileTemplate, listProfileTemplates } from '../src/core/profile-template';

const fixedClock = () => new Date('2026-01-02T03:04:05.000Z');

describe('profile templates', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-profile-template-'));
    tempRoots.push(root);
    return join(root, '.cc-profile-switch');
  }

  it('defines all MVP templates', () => {
    expect(listProfileTemplates()).toEqual(['coding', 'study', 'work', 'research', 'general', 'blank']);
    expect(getProfileTemplate('coding').description).toContain('software development');
  });

  it('materializes the final profile directory structure', async () => {
    const appHome = await makeAppHome();
    const { config, paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: fixedClock,
    });

    expect(config).toMatchObject({
      name: 'coding',
      template: 'coding',
      launch: {
        mcpMode: 'merge',
        pluginDirs: [],
        disableAutoMemory: false,
        skipPermissions: true,
        claudeArgs: [],
      },
      createdAt: '2026-01-02T03:04:05.000Z',
    });

    await expect(fs.pathExists(paths.profileConfigPath)).resolves.toBe(true);
    await expect(fs.pathExists(paths.claudeMdPath)).resolves.toBe(true);
    await expect(fs.pathExists(paths.settingsPath)).resolves.toBe(true);
    expect(paths.memoryPath).toBe(join(paths.claudeHomePath, 'memory'));
    expect(paths.autoMemoryPath).toBe(join(paths.claudeHomePath, 'memory', 'auto'));
    expect(paths.pluginsPath).toBe(join(paths.claudeHomePath, 'plugins'));
    await expect(fs.pathExists(paths.memoryPath)).resolves.toBe(true);
    await expect(fs.pathExists(paths.autoMemoryPath)).resolves.toBe(true);
    await expect(fs.pathExists(paths.autoMemoryEntrypointPath)).resolves.toBe(true);
    await expect(fs.pathExists(paths.skillsPath)).resolves.toBe(true);
    await expect(fs.pathExists(paths.agentsPath)).resolves.toBe(true);
    await expect(fs.pathExists(paths.mcpConfigPath)).resolves.toBe(true);
    await expect(fs.pathExists(paths.pluginsPath)).resolves.toBe(true);
  });

  it('writes valid JSON objects for profile files', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'research',
      template: 'research',
      clock: fixedClock,
    });

    await expect(fs.readJson(paths.profileConfigPath)).resolves.toMatchObject({
      name: 'research',
      template: 'research',
    });
    await expect(fs.readJson(paths.settingsPath)).resolves.toEqual({
      autoMemoryDirectory: paths.autoMemoryPath,
      env: {
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      },
    });
    await expect(fs.readJson(paths.mcpConfigPath)).resolves.toEqual({ mcpServers: {} });
  });

  it('writes the default attribution env for every profile template', async () => {
    const appHome = await makeAppHome();

    for (const template of listProfileTemplates()) {
      const { paths } = await createProfileFromTemplate({
        appHomePath: appHome,
        name: `${template}_profile`,
        template,
        clock: fixedClock,
      });

      await expect(fs.readJson(paths.settingsPath)).resolves.toMatchObject({
        env: {
          CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        },
      });
    }
  });

  it('makes CLAUDE.md explicit about profile-scoped memory and user-level global config', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'study',
      template: 'study',
      clock: fixedClock,
    });

    const claudeMd = await fs.readFile(paths.claudeMdPath, 'utf8');

    expect(claudeMd).toContain('user-level global profile');
    expect(claudeMd).toContain('CLAUDE_CONFIG_DIR');
    expect(claudeMd).toContain('profile-scoped user memory');
    expect(claudeMd).toContain('Project-level CLAUDE.md');
  });

  it('refuses to overwrite an existing profile by default', async () => {
    const appHome = await makeAppHome();

    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'general',
      template: 'general',
      clock: fixedClock,
    });

    await expect(
      createProfileFromTemplate({
        appHomePath: appHome,
        name: 'general',
        template: 'general',
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({
      code: 'PROFILE_ALREADY_EXISTS',
    });
  });
});
