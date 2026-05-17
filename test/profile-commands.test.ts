import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli';
import { getAppHomePaths } from '../src/core/app-config';
import { getProfileTemplatePaths } from '../src/core/profile-template';

type CliRun = {
  output: string;
};

describe('profile lifecycle commands', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeUserHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-profile-commands-'));
    tempRoots.push(root);
    return root;
  }

  async function runCli(userHome: string, args: string[]): Promise<CliRun> {
    return runCliWithOptions(userHome, args);
  }

  async function runCliWithOptions(
    userHome: string,
    args: string[],
    options: {
      openedTargets?: string[];
      clock?: () => Date;
      spawnCalls?: Array<{ command: string; args: string[]; cwd: string }>;
    } = {},
  ): Promise<CliRun> {
    const originalUserProfile = process.env.USERPROFILE;
    const output: string[] = [];
    const program = createProgram({
      writeOut: (value) => output.push(value),
      openTarget: async (targetPath) => {
        options.openedTargets?.push(targetPath);
      },
      spawnProcess: async (command, args, spawnOptions) => {
        options.spawnCalls?.push({ command, args, cwd: spawnOptions.cwd });
        return { exitCode: 0 };
      },
      clock: options.clock,
    });

    process.env.USERPROFILE = userHome;
    program.exitOverride();

    try {
      await program.parseAsync(['node', 'ccps', ...args], { from: 'node' });
      return { output: output.join('') };
    } finally {
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
  }

  it('init creates app home, config, profile folders, backups, and default profiles', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');

    const result = await runCli(userHome, ['init']);

    const appPaths = getAppHomePaths(appHome);
    expect(await fs.pathExists(appPaths.configPath)).toBe(true);
    expect(await fs.pathExists(appPaths.profilesPath)).toBe(true);
    expect(await fs.pathExists(appPaths.backupsPath)).toBe(true);

    for (const profileName of ['coding', 'study', 'work', 'research', 'general']) {
      const profilePaths = getProfileTemplatePaths(appHome, profileName);

      expect(await fs.pathExists(profilePaths.profileConfigPath)).toBe(true);
      expect(await fs.pathExists(profilePaths.claudeMdPath)).toBe(true);
    }

    expect(result.output).toContain('Initialized ccps app home');
    expect(result.output).toContain('Next: ccps list');
  });

  it('init can be run repeatedly without overwriting user-edited profile files', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const codingPaths = getProfileTemplatePaths(appHome, 'coding');

    await runCli(userHome, ['init']);
    await fs.writeFile(codingPaths.claudeMdPath, '# user edited profile\n', 'utf8');

    const result = await runCli(userHome, ['init']);

    await expect(fs.readFile(codingPaths.claudeMdPath, 'utf8')).resolves.toBe(
      '# user edited profile\n',
    );
    expect(result.output).toContain('Preserved existing profiles');
  });

  it('create makes a profile from the selected template', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');

    await runCli(userHome, ['init']);
    const result = await runCli(userHome, ['create', 'deep_work', '--template', 'work']);

    const profilePaths = getProfileTemplatePaths(appHome, 'deep_work');
    await expect(fs.readJson(profilePaths.profileConfigPath)).resolves.toMatchObject({
      name: 'deep_work',
      template: 'work',
    });
    expect(result.output).toContain('Created profile "deep_work"');
    expect(result.output).toContain('Next: ccps launch deep_work --dry-run');
  });

  it('create refuses to overwrite an existing profile', async () => {
    const userHome = await makeUserHome();

    await runCli(userHome, ['init']);
    await runCli(userHome, ['create', 'focus', '--template', 'blank']);

    await expect(
      runCli(userHome, ['create', 'focus', '--template', 'blank']),
    ).rejects.toMatchObject({
      code: 'PROFILE_ALREADY_EXISTS',
    });
  });

  it('create rejects invalid profile names', async () => {
    const userHome = await makeUserHome();

    await runCli(userHome, ['init']);

    await expect(runCli(userHome, ['create', '..', '--template', 'blank'])).rejects.toMatchObject({
      code: 'INVALID_PROFILE_NAME',
    });
  });

  it('list prompts for init when the app home is missing', async () => {
    const userHome = await makeUserHome();

    const result = await runCli(userHome, ['list']);

    expect(result.output).toContain('No ccps app home found');
    expect(result.output).toContain('Next: ccps init');
  });

  it('list shows profile status, last-used marker, and description', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const appPaths = getAppHomePaths(appHome);

    await runCli(userHome, ['init']);
    const config = await fs.readJson(appPaths.configPath);
    await fs.writeJson(appPaths.configPath, { ...config, lastUsedProfile: 'coding' });

    const result = await runCli(userHome, ['list']);

    expect(result.output).toContain('coding');
    expect(result.output).toContain('valid');
    expect(result.output).toContain('last-used');
    expect(result.output).toContain('Focused software development profile.');
  });

  it('show displays profile paths, required file status, JSON status, and preservation notes', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const profilePaths = getProfileTemplatePaths(appHome, 'coding');

    await runCli(userHome, ['init']);

    const result = await runCli(userHome, ['show', 'coding']);

    expect(result.output).toContain(`Profile path: ${profilePaths.profileRootPath}`);
    expect(result.output).toContain(`Claude home: ${profilePaths.claudeHomePath}`);
    expect(result.output).toContain(`User memory: ${profilePaths.claudeMdPath}`);
    expect(result.output).toContain(`Auto memory: ${profilePaths.autoMemoryPath}`);
    expect(result.output).toContain('profile.json: present');
    expect(result.output).toContain('settings.json: valid JSON');
    expect(result.output).toContain('Project config: preserved from the launch cwd');
  });

  it('validate reports error findings for invalid profiles', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const profilePaths = getProfileTemplatePaths(appHome, 'coding');

    await runCli(userHome, ['init']);
    await fs.writeFile(profilePaths.settingsPath, '{not-json', 'utf8');

    const result = await runCli(userHome, ['validate', 'coding']);

    expect(result.output).toContain('Status: error');
    expect(result.output).toContain('JSON_INVALID');
    expect(result.output).toContain(profilePaths.settingsPath);
  });

  it('backup copies the profile into a timestamped backup directory without modifying the source', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const profilePaths = getProfileTemplatePaths(appHome, 'coding');
    const backupRoot = join(appHome, 'backups', 'coding-20260516-142530');

    await runCli(userHome, ['init']);
    await fs.writeFile(profilePaths.claudeMdPath, '# user edited profile\n', 'utf8');

    const result = await runCliWithOptions(userHome, ['backup', 'coding'], {
      clock: () => new Date('2026-05-16T14:25:30Z'),
    });

    await expect(fs.readFile(profilePaths.claudeMdPath, 'utf8')).resolves.toBe(
      '# user edited profile\n',
    );
    await expect(fs.pathExists(join(backupRoot, 'profile.json'))).resolves.toBe(true);
    await expect(fs.pathExists(join(backupRoot, 'claude-home', 'CLAUDE.md'))).resolves.toBe(true);
    await expect(fs.pathExists(join(backupRoot, 'mcp.json'))).resolves.toBe(true);
    await expect(fs.pathExists(join(backupRoot, 'claude-home', 'plugins'))).resolves.toBe(true);
    await expect(fs.readFile(join(backupRoot, 'claude-home', 'CLAUDE.md'), 'utf8')).resolves.toBe(
      '# user edited profile\n',
    );
    expect(result.output).toContain(`Backup created: ${backupRoot}`);
  });

  it('edit opens the profile folder, known aliases, and existing relative targets', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const profilePaths = getProfileTemplatePaths(appHome, 'coding');
    const openedTargets: string[] = [];

    await runCli(userHome, ['init']);

    await runCliWithOptions(userHome, ['edit', 'coding'], { openedTargets });
    await runCliWithOptions(userHome, ['edit', 'coding', 'CLAUDE.md'], { openedTargets });
    await runCliWithOptions(userHome, ['edit', 'coding', 'settings.json'], { openedTargets });
    await runCliWithOptions(userHome, ['edit', 'coding', 'mcp.json'], { openedTargets });
    await runCliWithOptions(userHome, ['edit', 'coding', 'profile.json'], { openedTargets });
    await runCliWithOptions(userHome, ['edit', 'coding', 'claude-home'], { openedTargets });
    await runCliWithOptions(userHome, ['edit', 'coding', 'claude-home\\skills'], { openedTargets });

    expect(openedTargets).toEqual([
      profilePaths.profileRootPath,
      profilePaths.claudeMdPath,
      profilePaths.settingsPath,
      profilePaths.mcpConfigPath,
      profilePaths.profileConfigPath,
      profilePaths.claudeHomePath,
      profilePaths.skillsPath,
    ]);
  });

  it('edit rejects path traversal, sensitive targets, and missing targets without opening anything', async () => {
    const userHome = await makeUserHome();
    const openedTargets: string[] = [];

    await runCli(userHome, ['init']);

    await expect(
      runCliWithOptions(userHome, ['edit', 'coding', '..\\settings.json'], { openedTargets }),
    ).rejects.toMatchObject({
      code: 'INVALID_EDIT_TARGET',
    });
    await expect(
      runCliWithOptions(userHome, ['edit', 'coding', 'tokens.json'], { openedTargets }),
    ).rejects.toMatchObject({
      code: 'INVALID_EDIT_TARGET',
    });
    await expect(
      runCliWithOptions(userHome, ['edit', 'coding', 'missing.md'], { openedTargets }),
    ).rejects.toMatchObject({
      code: 'EDIT_TARGET_NOT_FOUND',
    });
    expect(openedTargets).toEqual([]);
  });

  it('launch dry-run prints the launch plan without starting Claude Code', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const profilePaths = getProfileTemplatePaths(appHome, 'coding');
    const projectCwd = await makeUserHome();

    await runCli(userHome, ['init']);

    const result = await runCli(userHome, ['launch', 'coding', '--dry-run', '--cwd', projectCwd]);

    expect(result.output).toContain('Launch dry-run for profile "coding"');
    expect(result.output).toContain(`Profile path: ${profilePaths.profileRootPath}`);
    expect(result.output).toContain(`Claude home: ${profilePaths.claudeHomePath}`);
    expect(result.output).toContain(`Cwd: ${projectCwd}`);
    expect(result.output).toContain('Command: claude');
    expect(result.output).toContain('--mcp-config');
    expect(result.output).toContain(`CLAUDE_CONFIG_DIR=${profilePaths.claudeHomePath}`);
    expect(result.output).toContain(`auto: ${profilePaths.autoMemoryPath}`);
    expect(result.output).toContain('Validation: valid');
    expect(result.output).toContain('Dry run: Claude Code was not started.');
  });

  it('launch starts Claude Code when dry-run is not requested', async () => {
    const userHome = await makeUserHome();
    const projectCwd = await makeUserHome();
    const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> = [];

    await runCli(userHome, ['init']);

    const result = await runCliWithOptions(
      userHome,
      ['launch', 'coding', '--cwd', projectCwd],
      { spawnCalls, clock: () => new Date('2026-05-16T15:45:00Z') },
    );

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: 'claude',
      cwd: projectCwd,
    });
    expect(spawnCalls[0].args).toContain('--mcp-config');
    expect(result.output).toContain('Launching Claude Code with profile "coding"');
  });
});
