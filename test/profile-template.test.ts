import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createProfileFromTemplate,
  ensureCcpsProfileRule,
  ensureProfileClaudeMdExcludes,
  getProfileTemplate,
  getProfileTemplateForCreate,
  getRealClaudeMdExcludePaths,
  listProfileTemplates,
} from '../src/core/profile-template';

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
        mcpMode: 'none',
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
    await expect(fs.pathExists(paths.mcpConfigPath)).resolves.toBe(false);
    await expect(fs.pathExists(paths.pluginsPath)).resolves.toBe(true);
    await expect(
      fs.pathExists(join(paths.claudeHomePath, 'rules', 'ccps-profile.md')),
    ).resolves.toBe(true);
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
    const profileRule = await fs.readFile(
      join(paths.claudeHomePath, 'rules', 'ccps-profile.md'),
      'utf8',
    );
    expect(profileRule).toContain('claude mcp add --scope user');
    expect(profileRule).toContain('CLAUDE_CONFIG_DIR');
    expect(profileRule).toContain('.claude.json');
    expect(profileRule).toContain('.mcp.json');
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
    const withoutExcludes = { ...settings };
    Reflect.deleteProperty(withoutExcludes, 'claudeMdExcludes');
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
    expect(after.claudeMdExcludes).toEqual(expect.arrayContaining(getRealClaudeMdExcludePaths()));
  });

  it('preserves unmanaged content while adding the ccps profile boundary', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'custom_rule',
      template: 'coding',
      clock: fixedClock,
    });
    await fs.writeFile(paths.ccpsProfileRulePath, '# User-owned rule\n', 'utf8');

    const updated = await ensureCcpsProfileRule(paths.ccpsProfileRulePath);

    expect(updated).toBe(true);
    const content = await fs.readFile(paths.ccpsProfileRulePath, 'utf8');
    expect(content).toContain('# User-owned rule');
    expect(content).toContain('ccps-managed-profile-boundary:start:v2');
    expect(content).toContain('claude mcp add --scope user');
  });

  it('refreshes an older ccps-managed profile rule', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'managed_rule',
      template: 'coding',
      clock: fixedClock,
    });
    await fs.writeFile(
      paths.ccpsProfileRulePath,
      '# Old\n\n<!-- ccps-managed-profile-boundary:v1 -->\n',
      'utf8',
    );

    const updated = await ensureCcpsProfileRule(paths.ccpsProfileRulePath);
    const content = await fs.readFile(paths.ccpsProfileRulePath, 'utf8');

    expect(updated).toBe(true);
    expect(content).toContain('claude mcp add --scope user');
  });

  it('refreshes only the managed block and preserves surrounding content', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'managed_block',
      template: 'coding',
      clock: fixedClock,
    });
    await fs.writeFile(
      paths.ccpsProfileRulePath,
      [
        '# User preface',
        '',
        '<!-- ccps-managed-profile-boundary:start:v2 -->',
        'stale managed content',
        '<!-- ccps-managed-profile-boundary:end:v2 -->',
        '',
        '# User suffix',
        '',
      ].join('\n'),
      'utf8',
    );

    const updated = await ensureCcpsProfileRule(paths.ccpsProfileRulePath);
    const content = await fs.readFile(paths.ccpsProfileRulePath, 'utf8');

    expect(updated).toBe(true);
    expect(content).toContain('# User preface');
    expect(content).toContain('# User suffix');
    expect(content).not.toContain('stale managed content');
    expect(content).toContain('claude mcp add --scope user');
  });

  it('repairs an orphaned start marker without retaining stale managed instructions', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'orphaned_marker',
      template: 'coding',
      clock: fixedClock,
    });
    await fs.writeFile(
      paths.ccpsProfileRulePath,
      '# User content\n\n<!-- ccps-managed-profile-boundary:start:v2 -->\npartial\n',
      'utf8',
    );

    await ensureCcpsProfileRule(paths.ccpsProfileRulePath);
    const content = await fs.readFile(paths.ccpsProfileRulePath, 'utf8');

    expect(content).toContain('# User content');
    expect(content).not.toContain('partial');
    expect(content.match(/ccps-managed-profile-boundary:start:v2/g)).toHaveLength(1);
    expect(content.match(/ccps-managed-profile-boundary:end:v2/g)).toHaveLength(1);
  });

  it('fails closed when managed markers cannot be repaired without risking user content', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'orphaned_end_marker',
      template: 'coding',
      clock: fixedClock,
    });
    await fs.writeFile(
      paths.ccpsProfileRulePath,
      '# Ambiguous content\n\n<!-- ccps-managed-profile-boundary:end:v2 -->\n',
      'utf8',
    );

    await expect(ensureCcpsProfileRule(paths.ccpsProfileRulePath)).rejects.toMatchObject({
      code: 'CCPS_PROFILE_RULE_CORRUPT',
    });
  });

  it('migrates the original v2 layout without duplicating the managed heading', async () => {
    const appHome = await makeAppHome();
    const { paths } = await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'old_v2_layout',
      template: 'coding',
      clock: fixedClock,
    });
    await fs.writeFile(
      paths.ccpsProfileRulePath,
      [
        '# CCPS Profile Boundary',
        '',
        '<!-- ccps-managed-profile-boundary:start:v2 -->',
        'old payload',
        '<!-- ccps-managed-profile-boundary:end:v2 -->',
        '',
      ].join('\n'),
      'utf8',
    );

    await ensureCcpsProfileRule(paths.ccpsProfileRulePath);
    const content = await fs.readFile(paths.ccpsProfileRulePath, 'utf8');

    expect(content.match(/# CCPS Profile Boundary/g)).toHaveLength(1);
    expect(content).not.toContain('old payload');
  });
});
