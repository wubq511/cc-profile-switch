import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProfileFromTemplate, ensureProfileClaudeMdExcludes, getProfileTemplate, getProfileTemplateForCreate, getRealClaudeMdExcludePaths, listProfileTemplates } from '../src/core/profile-template';

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

  it('defines all named templates', () => {
    expect(listProfileTemplates()).toEqual(['coding', 'study', 'work', 'research', 'general']);
    expect(getProfileTemplate('coding').description).toContain('software development');
  });

  it('resolves omitted template to blank via getProfileTemplateForCreate', () => {
    const template = getProfileTemplateForCreate(undefined);
    expect(template.description).toBe('Minimal empty profile.');
    expect(template.claudeMd).toContain('Blank');
  });

  it('resolves blank template name to blank via getProfileTemplateForCreate', () => {
    const template = getProfileTemplateForCreate('blank');
    expect(template.description).toBe('Minimal empty profile.');
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
      claudeMdExcludes: getRealClaudeMdExcludePaths(),
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

  it('computes real ~/.claude/CLAUDE.md exclude path', () => {
    const paths = getRealClaudeMdExcludePaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('.claude');
    expect(paths[0]).toContain('CLAUDE.md');
  });

  it('computes exclude path from explicit userHome', () => {
    const paths = getRealClaudeMdExcludePaths('/tmp/test-home');
    expect(paths).toEqual(['/tmp/test-home/.claude/CLAUDE.md']);
  });

  it('includes claudeMdExcludes in every profile settings', async () => {
    const appHome = await makeAppHome();

    for (const template of listProfileTemplates()) {
      const { paths } = await createProfileFromTemplate({
        appHomePath: appHome,
        name: `${template}_excl`,
        template,
        clock: fixedClock,
      });

      const settings = await fs.readJson(paths.settingsPath);
      expect(settings).toHaveProperty('claudeMdExcludes');
      expect(Array.isArray(settings.claudeMdExcludes)).toBe(true);
      expect(settings.claudeMdExcludes.length).toBeGreaterThan(0);
    }
  });

  it('ensureProfileClaudeMdExcludes backfills missing exclude path', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'backfill_test',
      template: 'coding',
      clock: fixedClock,
    });

    // Remove claudeMdExcludes to simulate an old profile
    const settings = await fs.readJson(paths.settingsPath);
    const { claudeMdExcludes: _, ...withoutExcludes } = settings as Record<string, unknown> & { claudeMdExcludes: unknown };
    await fs.writeJson(paths.settingsPath, withoutExcludes);

    const updated = await ensureProfileClaudeMdExcludes(paths.settingsPath);
    expect(updated).toBe(true);

    const after = await fs.readJson(paths.settingsPath);
    expect(after.claudeMdExcludes).toEqual(getRealClaudeMdExcludePaths());
  });

  it('ensureProfileClaudeMdExcludes is no-op when exclude already present', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'noop_test',
      template: 'coding',
      clock: fixedClock,
    });

    const updated = await ensureProfileClaudeMdExcludes(paths.settingsPath);
    expect(updated).toBe(false);

    const after = await fs.readJson(paths.settingsPath);
    expect(after.claudeMdExcludes).toEqual(getRealClaudeMdExcludePaths());
  });

  it('ensureProfileClaudeMdExcludes appends to existing excludes without removing user entries', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'append_test',
      template: 'coding',
      clock: fixedClock,
    });

    // Add a user-defined exclude and remove the auto one
    const settings = await fs.readJson(paths.settingsPath);
    await fs.writeJson(paths.settingsPath, {
      ...settings,
      claudeMdExcludes: ['/some/other/CLAUDE.md'],
    });

    const updated = await ensureProfileClaudeMdExcludes(paths.settingsPath);
    expect(updated).toBe(true);

    const after = await fs.readJson(paths.settingsPath);
    expect(after.claudeMdExcludes).toContain('/some/other/CLAUDE.md');
    expect(after.claudeMdExcludes).toEqual(
      expect.arrayContaining(getRealClaudeMdExcludePaths()),
    );
  });
});
