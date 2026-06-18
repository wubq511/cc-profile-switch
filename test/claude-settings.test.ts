import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getAppHomePaths } from '../src/core/app-config';
import {
  extractAnthropicApiEnv,
  getClaudeSettingsPath,
  importClaudeApiSettings,
} from '../src/core/claude-settings';

describe('Claude settings import', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeUserHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-claude-settings-'));
    tempRoots.push(root);
    return root;
  }

  it('resolves Windows and macOS Claude settings paths from the user home', () => {
    expect(getClaudeSettingsPath('C:\\Users\\Robert')).toBe('C:\\Users\\Robert\\.claude\\settings.json');
    expect(getClaudeSettingsPath('/Users/robert')).toBe('/Users/robert/.claude/settings.json');
  });

  it('extracts only string ANTHROPIC env entries from Claude settings', () => {
    expect(
      extractAnthropicApiEnv({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'token',
          ANTHROPIC_BASE_URL: 'https://api.example.test',
          ANTHROPIC_MODEL: 123,
          OPENAI_API_KEY: 'openai',
          CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        },
      }),
    ).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'https://api.example.test',
    });
  });

  it('imports missing ANTHROPIC env entries into common api-settings without overwriting existing values', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const appPaths = getAppHomePaths(appHome);
    const sourceSettingsPath = getClaudeSettingsPath(userHome);

    await fs.ensureDir(join(userHome, '.claude'));
    await fs.ensureDir(appHome);
    await fs.writeJson(sourceSettingsPath, {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'source-token',
        ANTHROPIC_BASE_URL: 'https://source.example.test',
        ANTHROPIC_MODEL: 'source-model',
      },
    });
    await fs.writeJson(appPaths.apiSettingsPath, {
      env: {
        ANTHROPIC_MODEL: 'existing-model',
      },
    });

    const result = await importClaudeApiSettings({ appHomePath: appHome, userHomePath: userHome });

    expect(result).toEqual({
      sourcePath: sourceSettingsPath,
      targetPath: appPaths.apiSettingsPath,
      importedKeys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
      preservedKeys: ['ANTHROPIC_MODEL'],
      skipped: false,
    });
    await expect(fs.readJson(appPaths.apiSettingsPath)).resolves.toEqual({
      env: {
        ANTHROPIC_MODEL: 'existing-model',
        ANTHROPIC_AUTH_TOKEN: 'source-token',
        ANTHROPIC_BASE_URL: 'https://source.example.test',
      },
    });
  });

  it('skips missing or invalid Claude settings without creating api-settings', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const appPaths = getAppHomePaths(appHome);

    await fs.ensureDir(appHome);

    await expect(importClaudeApiSettings({ appHomePath: appHome, userHomePath: userHome })).resolves.toMatchObject({
      skipped: true,
      importedKeys: [],
    });
    await expect(fs.pathExists(appPaths.apiSettingsPath)).resolves.toBe(false);

    await fs.ensureDir(join(userHome, '.claude'));
    await fs.writeFile(getClaudeSettingsPath(userHome), '{not-json', 'utf8');

    await expect(importClaudeApiSettings({ appHomePath: appHome, userHomePath: userHome })).resolves.toMatchObject({
      skipped: true,
      importedKeys: [],
    });
    await expect(fs.pathExists(appPaths.apiSettingsPath)).resolves.toBe(false);
  });
});
