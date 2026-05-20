import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { buildLaunchPlan, formatLaunchDryRun, launchProfile } from '../src/core/launcher';

describe('launcher', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  async function makeProfile(name = 'coding'): Promise<{
    appHome: string;
    paths: ReturnType<typeof getProfileTemplatePaths>;
  }> {
    const appHome = join(await makeTempRoot('ccps-launcher-'), '.cc-profile-switch');
    await createAppConfig(appHome);
    await createProfileFromTemplate({ appHomePath: appHome, name, template: 'coding' });
    return { appHome, paths: getProfileTemplatePaths(appHome, name) };
  }

  async function updateLaunchConfig(
    profileConfigPath: string,
    launch: Record<string, unknown>,
  ): Promise<void> {
    const manifest = await fs.readJson(profileConfigPath);
    await fs.writeJson(profileConfigPath, {
      ...manifest,
      launch: {
        ...manifest.launch,
        ...launch,
      },
    });
  }

  it('builds a default merge-mode launch plan without changing cwd', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    expect(plan).toMatchObject({
      profileName: 'coding',
      profileRootPath: paths.profileRootPath,
      claudeHomePath: paths.claudeHomePath,
      cwd: projectCwd,
      command: 'claude',
      mcpMode: 'merge',
      pluginDirs: [],
      validationStatus: 'valid',
      warnings: [],
    });
    expect(plan.args).toEqual([
      '--dangerously-skip-permissions',
      '--mcp-config',
      paths.mcpConfigPath,
    ]);
    expect(plan.envChanges).toEqual({ CLAUDE_CONFIG_DIR: paths.claudeHomePath });
    expect(plan.memoryConfig).toEqual({
      userMemoryPath: paths.claudeMdPath,
      autoMemoryDirectory: paths.autoMemoryPath,
      autoMemoryEntrypointPath: paths.autoMemoryEntrypointPath,
    });
  });

  it('merges common API settings and profile settings env with profile values taking priority', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    const appPaths = getAppHomePaths(appHome);
    await fs.writeJson(appPaths.apiSettingsPath, {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'common-token',
        ANTHROPIC_BASE_URL: 'https://common.example.test',
        ANTHROPIC_MODEL: 'common-model',
      },
    });
    await fs.writeJson(paths.settingsPath, {
      theme: 'dark',
      autoMemoryDirectory: paths.autoMemoryPath,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'profile-token',
      },
    });

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });
    const output = formatLaunchDryRun(plan);

    expect(plan.apiEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'profile-token',
      ANTHROPIC_BASE_URL: 'https://common.example.test',
      ANTHROPIC_MODEL: 'common-model',
    });
    expect(plan.apiConfig).toEqual({
      common: { path: appPaths.apiSettingsPath, present: true, keys: [
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
      ] },
      profile: { path: paths.settingsPath, present: true, keys: ['ANTHROPIC_AUTH_TOKEN'] },
      keys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
    });
    expect(output).toContain('API config:');
    expect(output).toContain('common: present');
    expect(output).toContain('profile: present');
    expect(output).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(output).toContain('ANTHROPIC_BASE_URL');
    expect(output).not.toContain('common-token');
    expect(output).not.toContain('profile-token');
    expect(output).not.toContain('https://common.example.test');
  });

  it('rejects invalid API settings before launching Claude Code', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await fs.writeJson(getAppHomePaths(appHome).apiSettingsPath, {
      env: {
        ANTHROPIC_AUTH_TOKEN: 123,
      },
    });

    await expect(
      buildLaunchPlan({
        appHomePath: appHome,
        profileName: 'coding',
        cwd: projectCwd,
      }),
    ).rejects.toMatchObject({
      code: 'API_SETTINGS_INVALID',
    });
  });

  it('rejects invalid profile settings env before launching Claude Code', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await fs.writeJson(paths.settingsPath, {
      autoMemoryDirectory: paths.autoMemoryPath,
      env: {
        ANTHROPIC_AUTH_TOKEN: 123,
      },
    });

    await expect(
      buildLaunchPlan({
        appHomePath: appHome,
        profileName: 'coding',
        cwd: projectCwd,
      }),
    ).rejects.toMatchObject({
      code: 'API_SETTINGS_INVALID',
    });
  });

  it('uses the current process cwd when no explicit cwd is provided', async () => {
    const { appHome } = await makeProfile();

    const plan = await buildLaunchPlan({ appHomePath: appHome, profileName: 'coding' });

    expect(plan.cwd).toBe(process.cwd());
  });

  it('resolves an omitted launch profile from the configured default profile', async () => {
    const { appHome, paths } = await makeProfile('coding');
    const projectCwd = await makeTempRoot('ccps-project-');
    const config = await fs.readJson(join(appHome, 'config.json'));
    await fs.writeJson(join(appHome, 'config.json'), {
      ...config,
      defaultProfile: 'coding',
    });

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      cwd: projectCwd,
    });
    const output = formatLaunchDryRun(plan);

    expect(plan).toMatchObject({
      profileName: 'coding',
      profileRootPath: paths.profileRootPath,
      claudeHomePath: paths.claudeHomePath,
      cwd: projectCwd,
    });
    expect(output).toContain('Launch dry-run for profile "coding"');
  });

  it('lets an explicit launch profile take precedence over the configured default profile', async () => {
    const { appHome } = await makeProfile('coding');
    await createProfileFromTemplate({ appHomePath: appHome, name: 'study', template: 'study' });
    const studyPaths = getProfileTemplatePaths(appHome, 'study');
    const projectCwd = await makeTempRoot('ccps-project-');
    const config = await fs.readJson(join(appHome, 'config.json'));
    await fs.writeJson(join(appHome, 'config.json'), {
      ...config,
      defaultProfile: 'coding',
    });

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'study',
      cwd: projectCwd,
    });

    expect(plan.profileName).toBe('study');
    expect(plan.profileRootPath).toBe(studyPaths.profileRootPath);
  });

  it('launches with the configured default profile when no profile is requested', async () => {
    const { appHome, paths } = await makeProfile('coding');
    const projectCwd = await makeTempRoot('ccps-project-');
    const config = await fs.readJson(join(appHome, 'config.json'));
    await fs.writeJson(join(appHome, 'config.json'), {
      ...config,
      defaultProfile: 'coding',
    });
    const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const result = await launchProfile({
      appHomePath: appHome,
      cwd: projectCwd,
      spawnProcess: async (command, args, options) => {
        spawnCalls.push({ command, args, cwd: options.cwd });
        return { exitCode: 0 };
      },
      clock: () => new Date('2026-05-20T11:30:00Z'),
    });

    expect(result.plan.profileName).toBe('coding');
    expect(spawnCalls).toEqual([
      {
        command: 'claude',
        args: ['--dangerously-skip-permissions', '--mcp-config', paths.mcpConfigPath],
        cwd: projectCwd,
      },
    ]);
    await expect(fs.readJson(join(appHome, 'config.json'))).resolves.toMatchObject({
      lastUsedProfile: 'coding',
      updatedAt: '2026-05-20T11:30:00.000Z',
    });
  });

  it('rejects omitted launch profiles when no default profile is configured', async () => {
    const { appHome } = await makeProfile('coding');

    await expect(buildLaunchPlan({ appHomePath: appHome })).rejects.toMatchObject({
      code: 'DEFAULT_PROFILE_NOT_SET',
      guidance: 'Pass a profile name or set one with ccps default <profile>.',
    });
  });

  it('rejects omitted launch profiles when the configured default profile is missing', async () => {
    const { appHome } = await makeProfile('coding');
    const config = await fs.readJson(join(appHome, 'config.json'));
    await fs.writeJson(join(appHome, 'config.json'), {
      ...config,
      defaultProfile: 'missing',
    });

    await expect(buildLaunchPlan({ appHomePath: appHome })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
  });

  it('rejects an explicit cwd that does not exist', async () => {
    const { appHome } = await makeProfile();

    await expect(
      buildLaunchPlan({
        appHomePath: appHome,
        profileName: 'coding',
        cwd: join(await makeTempRoot('ccps-project-'), 'missing'),
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_LAUNCH_CWD',
    });
  });

  it('adds strict MCP only when the profile explicitly selects strict mode', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await updateLaunchConfig(paths.profileConfigPath, { mcpMode: 'strict' });

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    expect(plan.mcpMode).toBe('strict');
    expect(plan.args).toEqual([
      '--dangerously-skip-permissions',
      '--mcp-config',
      paths.mcpConfigPath,
      '--strict-mcp-config',
    ]);
  });

  it('omits MCP args but keeps default permission skipping when the profile selects none mode', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await updateLaunchConfig(paths.profileConfigPath, { mcpMode: 'none' });

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    expect(plan.mcpMode).toBe('none');
    expect(plan.args).toEqual(['--dangerously-skip-permissions']);
  });

  it('does not add permission skipping when the profile disables it', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await updateLaunchConfig(paths.profileConfigPath, { skipPermissions: false });

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    expect(plan.args).toEqual(['--mcp-config', paths.mcpConfigPath]);
  });

  it('resolves configured plugin dirs inside the selected Claude home', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    const customPluginDir = join(paths.claudeHomePath, 'custom-plugins');
    await fs.ensureDir(customPluginDir);
    await updateLaunchConfig(paths.profileConfigPath, {
      pluginDirs: ['plugins', 'custom-plugins'],
    });

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    expect(plan.pluginDirs).toEqual([paths.pluginsPath, customPluginDir]);
    expect(plan.args).toEqual([
      '--dangerously-skip-permissions',
      '--mcp-config',
      paths.mcpConfigPath,
      '--plugin-dir',
      paths.pluginsPath,
      '--plugin-dir',
      customPluginDir,
    ]);
  });

  it('blocks launch plans when profile validation has errors', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await rm(paths.settingsPath);

    await expect(
      buildLaunchPlan({ appHomePath: appHome, profileName: 'coding', cwd: projectCwd }),
    ).rejects.toMatchObject({
      code: 'PROFILE_VALIDATION_FAILED',
    });
  });

  it('formats dry-run output with validation, env, args, warnings, and project config message', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await fs.writeFile(join(paths.claudeHomePath, 'chat-history.log'), '', 'utf8');

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });
    const output = formatLaunchDryRun(plan);

    expect(output).toContain('Launch dry-run for profile "coding"');
    expect(output).toContain(`Profile path: ${paths.profileRootPath}`);
    expect(output).toContain(`Claude home: ${paths.claudeHomePath}`);
    expect(output).toContain(`Cwd: ${projectCwd}`);
    expect(output).toContain('MCP mode: merge');
    expect(output).toContain('Command: claude');
    expect(output).toContain('--dangerously-skip-permissions');
    expect(output).toContain('--mcp-config');
    expect(output).toContain(`CLAUDE_CONFIG_DIR=${paths.claudeHomePath}`);
    expect(output).toContain('Memory:');
    expect(output).toContain(`user: ${paths.claudeMdPath}`);
    expect(output).toContain(`auto: ${paths.autoMemoryPath}`);
    expect(output).toContain('Validation: warning');
    expect(output).toContain('SENSITIVE_FILENAME_MEDIUM');
    expect(output).toContain('Project config: preserved because Claude starts in the launch cwd.');
    expect(output).toContain('Dry run: Claude Code was not started.');
  });

  it('spawns Claude Code with the launch plan cwd, args array, inherited stdio, and env changes', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await fs.writeJson(getAppHomePaths(appHome).apiSettingsPath, {
      env: {
        ANTHROPIC_BASE_URL: 'https://common.example.test',
        ANTHROPIC_MODEL: 'common-model',
      },
    });
    await fs.writeJson(paths.settingsPath, {
      autoMemoryDirectory: paths.autoMemoryPath,
      env: {
        ANTHROPIC_MODEL: 'profile-model',
      },
    });
    const spawnCalls: Array<{
      command: string;
      args: string[];
      options: { cwd: string; stdio: string; shell: boolean; env: NodeJS.ProcessEnv };
    }> = [];

    const result = await launchProfile({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
      spawnProcess: async (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { exitCode: 0 };
      },
      clock: () => new Date('2026-05-16T15:45:00Z'),
    });

    expect(result.plan.cwd).toBe(projectCwd);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--mcp-config', paths.mcpConfigPath],
      options: {
        cwd: projectCwd,
        stdio: 'inherit',
        shell: false,
      },
    });
    expect(spawnCalls[0].options.env.CLAUDE_CONFIG_DIR).toBe(paths.claudeHomePath);
    expect(spawnCalls[0].options.env.ANTHROPIC_BASE_URL).toBe('https://common.example.test');
    expect(spawnCalls[0].options.env.ANTHROPIC_MODEL).toBe('profile-model');
  });

  it('updates last-used metadata only after the launch reaches process execution', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    await launchProfile({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
      spawnProcess: async () => ({ exitCode: 0 }),
      clock: () => new Date('2026-05-16T15:45:00Z'),
    });

    await expect(fs.readJson(join(appHome, 'config.json'))).resolves.toMatchObject({
      lastUsedProfile: 'coding',
      updatedAt: '2026-05-16T15:45:00.000Z',
    });
  });

  it('does not update last-used metadata when profile validation blocks launch', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await rm(paths.settingsPath);

    await expect(
      launchProfile({
        appHomePath: appHome,
        profileName: 'coding',
        cwd: projectCwd,
        spawnProcess: async () => ({ exitCode: 0 }),
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_VALIDATION_FAILED' });
    await expect(fs.readJson(join(appHome, 'config.json'))).resolves.toMatchObject({
      lastUsedProfile: null,
    });
  });

  it('wraps spawn failures with launch guidance', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    await expect(
      launchProfile({
        appHomePath: appHome,
        profileName: 'coding',
        cwd: projectCwd,
        spawnProcess: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toMatchObject({
      code: 'CLAUDE_LAUNCH_FAILED',
    });
  });
});
