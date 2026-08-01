import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import {
  diffProfileLaunchConfig,
  editLaunchConfigKey,
  inspectLaunchConfig,
  previewLaunchConfig,
  searchLaunchConfig,
  validateLaunchConfig,
} from '../src/core/launch-config-resource';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');

describe('launch configuration resource service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<{ userHome: string; appHome: string }> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-launch-config-resource-'));
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

  describe('inspectLaunchConfig', () => {
    it('lists launch fields with sensitive/restricted flags', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await inspectLaunchConfig(appHome, 'coding');

      expect(result.malformed).toBe(false);
      const entries = new Map(result.entries.map((e) => [e.key, e]));
      expect(entries.get('mcpMode')?.value).toBe('none');
      expect(entries.get('skipPermissions')?.value).toBe(true);
      expect(entries.get('skipPermissions')?.sensitive).toBe(true);
      expect(entries.get('claudeArgs')?.sensitive).toBe(true);
      expect(entries.get('mcpMode')?.sensitive).toBe(false);
      // `name` is owned by lifecycle Rename — flagged restricted if present.
      const nameEntry = entries.get('name');
      if (nameEntry) {
        expect(nameEntry.restricted).toBe(true);
      }
    });
  });

  describe('previewLaunchConfig', () => {
    it('returns raw profile.json content', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await previewLaunchConfig(appHome, 'coding');
      expect(result.malformed).toBe(false);
      expect(result.rawJson).toContain('"mcpMode"');
    });

    it('reports malformed JSON', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeFile(paths.profileConfigPath, '{bad', 'utf8');

      const result = await previewLaunchConfig(appHome, 'coding');
      expect(result.malformed).toBe(true);
    });
  });

  describe('searchLaunchConfig', () => {
    it('matches key names', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await searchLaunchConfig(appHome, 'coding', 'skip');
      expect(result.matches).toContain('skipPermissions');
    });
  });

  describe('editLaunchConfigKey (restricted)', () => {
    it('refuses `name` — owned by lifecycle Rename', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await editLaunchConfigKey({
        appHomePath: appHome,
        profileName: 'coding',
        key: 'name',
        value: 'new-name',
        clock: FIXED_CLOCK,
      });

      expect(result.refused).toBe('name');
    });

    it('saves a plain field edit and stamps updatedAt', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await editLaunchConfigKey({
        appHomePath: appHome,
        profileName: 'coding',
        key: 'mcpMode',
        value: 'strict',
        clock: FIXED_CLOCK,
      });

      expect(result.refused).toBeUndefined();
      expect(result.requiresWarning).toBe(false);
      const paths = getProfileTemplatePaths(appHome, 'coding');
      const saved = await fs.readJson(paths.profileConfigPath);
      expect(saved.launch.mcpMode).toBe('strict');
      expect(saved.updatedAt).toBe('2026-08-01T00:00:00.000Z');
    });

    it('requires a consequence warning for skipPermissions', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await editLaunchConfigKey({
        appHomePath: appHome,
        profileName: 'coding',
        key: 'skipPermissions',
        value: false,
        clock: FIXED_CLOCK,
      });

      expect(result.requiresWarning).toBe(true);
      expect(result.warningMessage).toContain('--dangerously-skip-permissions');
      // The edit is still applied.
      const paths = getProfileTemplatePaths(appHome, 'coding');
      const saved = await fs.readJson(paths.profileConfigPath);
      expect(saved.launch.skipPermissions).toBe(false);
    });

    it('rejects a value that would make profile.json invalid', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        editLaunchConfigKey({
          appHomePath: appHome,
          profileName: 'coding',
          key: 'claudeArgs',
          value: 'not-an-array',
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'LAUNCH_CONFIG_INVALID' });
    });

    it('rejects unknown keys', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        editLaunchConfigKey({
          appHomePath: appHome,
          profileName: 'coding',
          key: 'description',
          value: 'x',
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'LAUNCH_CONFIG_KEY_INVALID' });
    });
  });

  describe('diffProfileLaunchConfig', () => {
    it('shows values with inline warnings on sensitive fields', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');

      // coding: skipPermissions false (default true overridden), claudeArgs sonnet
      const codingPaths = getProfileTemplatePaths(appHome, 'coding');
      const codingJson = await fs.readJson(codingPaths.profileConfigPath);
      await fs.writeJson(codingPaths.profileConfigPath, {
        ...codingJson,
        launch: { ...codingJson.launch, skipPermissions: false },
      });

      const result = await diffProfileLaunchConfig(appHome, 'coding', 'study');

      const skipRow = result.find((r) => r.key === 'skipPermissions');
      expect(skipRow).toMatchObject({ verdict: 'changed', sensitive: true });
      // Values are shown for launch config (not secret-class).
      expect(skipRow?.valueA).toBe(false);
      expect(skipRow?.valueB).toBe(true);
    });

    it('returns same verdict for identical configs', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');

      const result = await diffProfileLaunchConfig(appHome, 'coding', 'study');
      for (const row of result) {
        expect(row.verdict).toBe('same');
      }
    });
  });

  describe('validateLaunchConfig', () => {
    it('returns valid for a well-formed profile.json', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');

      const result = await validateLaunchConfig(paths.profileConfigPath);
      expect(result.valid).toBe(true);
    });

    it('flags malformed JSON', async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      await fs.writeFile(paths.profileConfigPath, '{bad', 'utf8');

      const result = await validateLaunchConfig(paths.profileConfigPath);
      expect(result.valid).toBe(false);
      expect(result.finding?.code).toBe('JSON_INVALID');
    });
  });
});
