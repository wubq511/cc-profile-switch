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
    const originalUserProfile = process.env.USERPROFILE;
    const output: string[] = [];
    const program = createProgram({
      writeOut: (value) => output.push(value),
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

    await expect(fs.readFile(codingPaths.claudeMdPath, 'utf8')).resolves.toBe('# user edited profile\n');
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

    await expect(runCli(userHome, ['create', 'focus', '--template', 'blank'])).rejects.toMatchObject({
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
});
