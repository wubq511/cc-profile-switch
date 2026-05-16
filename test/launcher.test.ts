import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { buildLaunchPlan, formatLaunchDryRun } from '../src/core/launcher';

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
    expect(plan.args).toEqual(['--mcp-config', paths.mcpConfigPath]);
    expect(plan.envChanges).toEqual({ CLAUDE_CONFIG_DIR: paths.claudeHomePath });
  });

  it('uses the current process cwd when no explicit cwd is provided', async () => {
    const { appHome } = await makeProfile();

    const plan = await buildLaunchPlan({ appHomePath: appHome, profileName: 'coding' });

    expect(plan.cwd).toBe(process.cwd());
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
    expect(plan.args).toEqual(['--mcp-config', paths.mcpConfigPath, '--strict-mcp-config']);
  });

  it('omits MCP args when the profile selects none mode', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    await updateLaunchConfig(paths.profileConfigPath, { mcpMode: 'none' });

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    expect(plan.mcpMode).toBe('none');
    expect(plan.args).toEqual([]);
  });

  it('resolves configured plugin dirs inside the selected profile root', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');
    const customPluginDir = join(paths.profileRootPath, 'custom-plugins');
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
    expect(output).toContain('--mcp-config');
    expect(output).toContain(`CLAUDE_CONFIG_DIR=${paths.claudeHomePath}`);
    expect(output).toContain('Validation: warning');
    expect(output).toContain('SENSITIVE_FILENAME_MEDIUM');
    expect(output).toContain('Project config: preserved because Claude starts in the launch cwd.');
    expect(output).toContain('Dry run: Claude Code was not started.');
  });
});
