import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import {
  backfillSettings,
  diffProfileSettings,
  editSettingsKey,
  inspectSettings,
  previewSettings,
  removeSettingsKey,
  searchSettings,
  validateSettings,
} from '../src/core/settings-resource';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { listRecoveryBinItems } from '../src/core/recovery-bin';

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');

// A token shape matching the credential-insulation regexes (fixtures/credentials.ts),
// used to prove redaction across every view.
const TOKEN_SHAPE = 'sk-ant-api03-' + 'x'.repeat(24);

describe('settings resource service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    // Restore permissions on recovery-bin items (0600 dirs can't be deleted by fs.remove)
    for (const root of tempRoots) {
      const binDir = join(root, 'userhome', '.cc-profile-switch', 'recovery-bin');
      if (await fs.pathExists(binDir)) {
        try {
          await restorePermissions(binDir);
        } catch {
          // Best effort
        }
      }
    }
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function restorePermissions(dirPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        try {
          await fs.chmod(fullPath, 0o755);
        } catch {
          // Windows may not support chmod
        }
        await restorePermissions(fullPath);
      }
    }
  }

  async function makeAppHome(): Promise<{ userHome: string; appHome: string }> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-settings-resource-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    const appHome = path.join(userHome, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    return { userHome, appHome };
  }

  async function makeProfile(appHome: string, name: string): Promise<void> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: FIXED_CLOCK,
    });
  }

  async function writeSettingsWithSecrets(appHome: string, name: string): Promise<void> {
    const paths = getProfileTemplatePaths(appHome, name);
    await fs.writeJson(paths.settingsPath, {
      autoMemoryDirectory: paths.autoMemoryPath,
      claudeMdExcludes: ['/real/.claude/CLAUDE.md'],
      model: 'claude-sonnet-4-5',
      env: {
        ANTHROPIC_API_KEY: TOKEN_SHAPE,
        ANTHROPIC_BASE_URL: 'https://relay.example.com',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      },
    });
  }

  describe('inspectSettings', () => {
    it('lists flattened keys and marks managed fields', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await writeSettingsWithSecrets(appHome, 'coding');

      const result = await inspectSettings(appHome, 'coding');

      expect(result.malformed).toBe(false);
      expect(result.keys).toContain('env.ANTHROPIC_API_KEY');
      expect(result.keys).toContain('env.CLAUDE_CODE_ATTRIBUTION_HEADER');
      expect(result.keys).toContain('autoMemoryDirectory');
      expect(result.managedKeys).toEqual(
        expect.arrayContaining([
          'autoMemoryDirectory',
          'claudeMdExcludes',
          'env.CLAUDE_CODE_ATTRIBUTION_HEADER',
        ]),
      );
      expect(result.hasMcpServers).toBe(false);
    });

    it('flags malformed files without throwing', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeFile(paths.settingsPath, '{not-json', 'utf8');

      const result = await inspectSettings(appHome, 'coding');
      expect(result.malformed).toBe(true);
      expect(result.keys).toEqual([]);
    });
  });

  describe('previewSettings (redaction)', () => {
    it('renders credential-class values as key names only', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await writeSettingsWithSecrets(appHome, 'coding');

      const result = await previewSettings(appHome, 'coding');

      expect(result.hasSecrets).toBe(true);
      const apiKeyEntry = result.entries.find((e) => e.keyPath === 'env.ANTHROPIC_API_KEY');
      expect(apiKeyEntry?.displayValue).toBe('<redacted>');
      expect(apiKeyEntry?.isSecret).toBe(true);

      // Every env.ANTHROPIC_* value is redacted (key names only), matching the
      // export contract §11.2.
      const baseUrlEntry = result.entries.find((e) => e.keyPath === 'env.ANTHROPIC_BASE_URL');
      expect(baseUrlEntry?.displayValue).toBe('<redacted>');

      // Non-credential keys still show their values (redaction is selective).
      const modelEntry = result.entries.find((e) => e.keyPath === 'model');
      expect(modelEntry?.displayValue).toBe('claude-sonnet-4-5');

      // The token shape never appears anywhere in the preview output.
      const serialized = JSON.stringify(result.entries);
      expect(serialized).not.toContain(TOKEN_SHAPE);

      // Managed field is marked.
      const autoEntry = result.entries.find((e) => e.keyPath === 'autoMemoryDirectory');
      expect(autoEntry?.isManaged).toBe(true);
    });

    it('returns empty entries for a malformed file', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeFile(paths.settingsPath, '{bad', 'utf8');

      const result = await previewSettings(appHome, 'coding');
      expect(result.malformed).toBe(true);
      expect(result.entries).toEqual([]);
    });

    it('redacts credential-marker env keys beyond ANTHROPIC_* (e.g. OPENAI_API_KEY)', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeJson(paths.settingsPath, {
        env: {
          OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
          GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
          NODE_ENV: 'production', // not credential-class
        },
      });

      const result = await previewSettings(appHome, 'coding');

      const openai = result.entries.find((e) => e.keyPath === 'env.OPENAI_API_KEY');
      expect(openai?.displayValue).toBe('<redacted>');
      const github = result.entries.find((e) => e.keyPath === 'env.GITHUB_TOKEN');
      expect(github?.displayValue).toBe('<redacted>');
      // Non-credential env values still render.
      const nodeEnv = result.entries.find((e) => e.keyPath === 'env.NODE_ENV');
      expect(nodeEnv?.displayValue).toBe('production');
    });
  });

  describe('searchSettings', () => {
    it('matches key names only, never values', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await writeSettingsWithSecrets(appHome, 'coding');

      const result = await searchSettings(appHome, 'coding', 'ANTHROPIC');
      expect(result.matches).toContain('env.ANTHROPIC_API_KEY');
      expect(result.matches).toContain('env.ANTHROPIC_BASE_URL');
      // Searching for a secret VALUE finds nothing.
      const secretSearch = await searchSettings(appHome, 'coding', TOKEN_SHAPE);
      expect(secretSearch.matches).toEqual([]);
    });
  });

  describe('editSettingsKey (restricted)', () => {
    it('refuses mcpServers outright', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await editSettingsKey({
        appHomePath: appHome,
        profileName: 'coding',
        keyPath: 'mcpServers',
        value: { some: 'server' },
        clock: FIXED_CLOCK,
      });

      expect(result.refused).toBe('mcpServers');
    });

    it('refuses ccps-managed fields read-only', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await editSettingsKey({
        appHomePath: appHome,
        profileName: 'coding',
        keyPath: 'autoMemoryDirectory',
        value: '/tmp/elsewhere',
        clock: FIXED_CLOCK,
      });

      expect(result.refused).toBe('managed');
    });

    it('refuses editing the parent env key to prevent bypassing managed fields', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      // Assigning the whole `env` object would overwrite the managed
      // env.CLAUDE_CODE_ATTRIBUTION_HEADER — must be refused.
      const result = await editSettingsKey({
        appHomePath: appHome,
        profileName: 'coding',
        keyPath: 'env',
        value: { OTHER: 'x' },
        clock: FIXED_CLOCK,
      });

      expect(result.refused).toBe('managed');
    });

    it('saves plain-key edits atomically without touching other keys', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await writeSettingsWithSecrets(appHome, 'coding');

      const result = await editSettingsKey({
        appHomePath: appHome,
        profileName: 'coding',
        keyPath: 'model',
        value: 'claude-opus-4-1',
        clock: FIXED_CLOCK,
      });

      expect(result.refused).toBeUndefined();
      const paths = getProfileTemplatePaths(appHome, 'coding');
      const saved = await fs.readJson(paths.settingsPath);
      expect(saved.model).toBe('claude-opus-4-1');
      // Unrelated fields untouched.
      expect(saved.env.ANTHROPIC_API_KEY).toBe(TOKEN_SHAPE);
      expect(saved.autoMemoryDirectory).toBe(paths.autoMemoryPath);
    });

    it('supports nested key edits under env', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await writeSettingsWithSecrets(appHome, 'coding');

      await editSettingsKey({
        appHomePath: appHome,
        profileName: 'coding',
        keyPath: 'env.ANTHROPIC_MODEL',
        value: 'claude-x',
        clock: FIXED_CLOCK,
      });

      const paths = getProfileTemplatePaths(appHome, 'coding');
      const saved = await fs.readJson(paths.settingsPath);
      expect(saved.env.ANTHROPIC_MODEL).toBe('claude-x');
    });

    it('throws on a malformed file', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeFile(paths.settingsPath, '{bad', 'utf8');

      await expect(
        editSettingsKey({
          appHomePath: appHome,
          profileName: 'coding',
          keyPath: 'model',
          value: 'x',
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'SETTINGS_MALFORMED' });
    });
  });

  describe('removeSettingsKey → fragment Bin item', () => {
    it('creates a fragment Bin item and removes the key atomically', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await writeSettingsWithSecrets(appHome, 'coding');

      const result = await removeSettingsKey({
        appHomePath: appHome,
        profileName: 'coding',
        keyPath: 'model',
        clock: FIXED_CLOCK,
      });

      expect(result.binItem.shape).toBe('fragment');
      expect(result.binItem.kind).toBe('settings-field');
      expect(result.binItem.origin).toBe('remove');
      expect(result.binItem.coordinates).toMatchObject({
        file: 'claude-home/settings.json',
        keyPath: 'model',
      });

      const paths = getProfileTemplatePaths(appHome, 'coding');
      const saved = await fs.readJson(paths.settingsPath);
      expect(saved).not.toHaveProperty('model');

      const binItems = await listRecoveryBinItems(appHome);
      expect(binItems).toHaveLength(1);
      expect(binItems[0].kind).toBe('settings-field');
    });

    it('marks secret-bearing keys as 0600', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await writeSettingsWithSecrets(appHome, 'coding');

      const result = await removeSettingsKey({
        appHomePath: appHome,
        profileName: 'coding',
        keyPath: 'env.ANTHROPIC_API_KEY',
        clock: FIXED_CLOCK,
      });

      expect(result.binItem.secretBearing).toBe(true);
    });

    it('refuses removing mcpServers', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeJson(paths.settingsPath, { mcpServers: {} });

      await expect(
        removeSettingsKey({
          appHomePath: appHome,
          profileName: 'coding',
          keyPath: 'mcpServers',
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'SETTINGS_MCPSERVERS_REFUSED' });
    });

    it('refuses removing managed fields', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        removeSettingsKey({
          appHomePath: appHome,
          profileName: 'coding',
          keyPath: 'autoMemoryDirectory',
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'SETTINGS_MANAGED_FIELD_READONLY' });
    });

    it('refuses removing the parent env key (managed-field bypass)', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        removeSettingsKey({
          appHomePath: appHome,
          profileName: 'coding',
          keyPath: 'env',
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'SETTINGS_MANAGED_FIELD_READONLY' });
    });

    it('throws when the key does not exist', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        removeSettingsKey({
          appHomePath: appHome,
          profileName: 'coding',
          keyPath: 'nonexistent',
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'SETTINGS_KEY_NOT_FOUND' });
    });
  });

  describe('backfillSettings', () => {
    it('backfills missing managed fields without touching unrelated keys', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      // Settings missing all managed fields but with an unrelated custom key.
      await fs.writeJson(paths.settingsPath, { model: 'claude-sonnet-4-5' });

      const result = await backfillSettings({
        appHomePath: appHome,
        profileName: 'coding',
        clock: FIXED_CLOCK,
      });

      expect(result.backfilledKeys).toEqual(
        expect.arrayContaining(['autoMemoryDirectory', 'claudeMdExcludes', 'env.CLAUDE_CODE_ATTRIBUTION_HEADER']),
      );

      const saved = await fs.readJson(paths.settingsPath);
      expect(saved.model).toBe('claude-sonnet-4-5'); // untouched
      expect(saved.autoMemoryDirectory).toBe(paths.autoMemoryPath);
      // claudeMdExcludes points at the real user CLAUDE.md path (backfill uses real home).
      expect(saved.claudeMdExcludes).toEqual(
        expect.arrayContaining([expect.stringContaining('.claude/CLAUDE.md')]),
      );
      expect(saved.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    });

    it('creates a settings file when missing', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await rm(paths.settingsPath);

      const result = await backfillSettings({
        appHomePath: appHome,
        profileName: 'coding',
        clock: FIXED_CLOCK,
      });

      expect(result.created).toBe(true);
      const saved = await fs.readJson(paths.settingsPath);
      expect(saved.autoMemoryDirectory).toBe(paths.autoMemoryPath);
      expect(saved.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    });

    it('refuses to backfill a malformed file', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeFile(paths.settingsPath, '{bad', 'utf8');

      await expect(
        backfillSettings({ appHomePath: appHome, profileName: 'coding', clock: FIXED_CLOCK }),
      ).rejects.toMatchObject({ code: 'SETTINGS_MALFORMED' });
    });

    it('does not clobber a non-record env value when backfilling', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      // Malformed env shape — backfill must not overwrite it.
      await fs.writeJson(paths.settingsPath, { env: 'not-an-object' });

      const result = await backfillSettings({
        appHomePath: appHome,
        profileName: 'coding',
        clock: FIXED_CLOCK,
      });

      expect(result.backfilledKeys).not.toContain('env.CLAUDE_CODE_ATTRIBUTION_HEADER');
      const saved = await fs.readJson(paths.settingsPath);
      expect(saved.env).toBe('not-an-object'); // preserved untouched
      expect(saved.autoMemoryDirectory).toBe(paths.autoMemoryPath);
    });
  });

  describe('diffProfileSettings', () => {
    it('returns key-level verdicts with values never included', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');

      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeJson(paths.settingsPath, {
        model: 'sonnet',
        env: { ANTHROPIC_API_KEY: 'secret-a', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
      });
      const studyPaths = getProfileTemplatePaths(appHome, 'study');
      await fs.writeJson(studyPaths.settingsPath, {
        model: 'opus',
        env: { ANTHROPIC_API_KEY: 'secret-b', CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
        permissions: { deny: 'Bash(rm -rf *)' },
      });

      const result = await diffProfileSettings(appHome, 'coding', 'study');

      expect(result).toContainEqual({ key: 'model', verdict: 'changed' });
      expect(result).toContainEqual({ key: 'env.ANTHROPIC_API_KEY', verdict: 'changed' });
      expect(result).toContainEqual({ key: 'permissions.deny', verdict: 'only-b' });
      // Values never rendered — every entry has exactly { key, verdict }.
      for (const entry of result) {
        expect(Object.keys(entry)).toEqual(['key', 'verdict']);
      }
      // Neither secret value leaks into the result.
      expect(JSON.stringify(result)).not.toContain('secret-a');
      expect(JSON.stringify(result)).not.toContain('secret-b');
    });
  });

  describe('credential insulation across views', () => {
    it('never leaks a token shape through inspect/preview/search/diff', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');
      await writeSettingsWithSecrets(appHome, 'coding');
      const studyPaths = getProfileTemplatePaths(appHome, 'study');
      await fs.writeJson(studyPaths.settingsPath, { env: { ANTHROPIC_API_KEY: 'other-secret' } });

      const inspect = await inspectSettings(appHome, 'coding');
      const preview = await previewSettings(appHome, 'coding');
      const search = await searchSettings(appHome, 'coding', 'ANTHROPIC');
      const diff = await diffProfileSettings(appHome, 'coding', 'study');

      expect(JSON.stringify(inspect)).not.toContain(TOKEN_SHAPE);
      expect(JSON.stringify(preview)).not.toContain(TOKEN_SHAPE);
      expect(JSON.stringify(search)).not.toContain(TOKEN_SHAPE);
      expect(JSON.stringify(diff)).not.toContain(TOKEN_SHAPE);
    });

    it('does not leak a token through the malformed-file error path', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      // Malformed JSON whose raw text embeds a token shape.
      await fs.writeFile(paths.settingsPath, `{ "env": { "ANTHROPIC_API_KEY": ${JSON.stringify(TOKEN_SHAPE)} `, 'utf8');

      const inspect = await inspectSettings(appHome, 'coding');
      const preview = await previewSettings(appHome, 'coding');
      const search = await searchSettings(appHome, 'coding', 'ANTHROPIC');

      expect(JSON.stringify(inspect)).not.toContain(TOKEN_SHAPE);
      expect(JSON.stringify(preview)).not.toContain(TOKEN_SHAPE);
      expect(JSON.stringify(search)).not.toContain(TOKEN_SHAPE);
    });
  });

  describe('validateSettings', () => {
    it('returns valid for a well-formed object', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');

      const result = await validateSettings(paths.settingsPath);
      expect(result.valid).toBe(true);
    });

    it('flags malformed JSON as an error blocker', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeFile(paths.settingsPath, '{bad', 'utf8');

      const result = await validateSettings(paths.settingsPath);
      expect(result.valid).toBe(false);
      expect(result.finding).toMatchObject({
        severity: 'error',
        code: 'SETTINGS_MALFORMED',
        path: paths.settingsPath,
      });
    });

    it('flags a non-object as invalid', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeJson(paths.settingsPath, [1, 2, 3]);

      const result = await validateSettings(paths.settingsPath);
      expect(result.valid).toBe(false);
      expect(result.finding?.code).toBe('SETTINGS_INVALID');
    });
  });
});
