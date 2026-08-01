import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  buildPluginCommandPlan,
  detectRestartRequired,
  parseComponentInventory,
  parseInstalledPlugins,
  parsePluginSelector,
  runPluginCommand,
  validateMarketplaceSource,
} from '../src/core/plugins';
import type { CaptureProcess } from '../src/platform/process';
import { CcpsError } from '../src/utils/errors';

const PROBED_DETAILS_OUTPUT = `probe-plugin 0.1.0
  probe plugin
  Source: probe-plugin@probe-marketplace

Component inventory
  Skills (0)
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~0 tok   added to every session
`;

describe('plugins delegated service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-plugins-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    return appHome;
  }

  async function makeProfile(appHome: string, name: string): Promise<void> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
  }

  function fakeCapture(result: {
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
  }): CaptureProcess {
    return async () => ({
      exitCode: result.exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.timedOut ?? false,
    });
  }

  function expectCcpsError(run: () => unknown, code: string): void {
    expect(run).toThrowError(CcpsError);
    try {
      run();
    } catch (error) {
      expect((error as CcpsError).code).toBe(code);
      return;
    }
    throw new Error(`Expected a CcpsError with code ${code}.`);
  }

  describe('buildPluginCommandPlan', () => {
    it('delegates to claude plugin with CLAUDE_CONFIG_DIR set to the profile claude-home', () => {
      const plan = buildPluginCommandPlan({
        appHomePath: '/tmp/app-home',
        profileName: 'coding',
        args: ['list', '--json'],
      });

      expect(plan.command).toBe('claude');
      expect(plan.args).toEqual(['plugin', 'list', '--json']);
      expect(plan.cwd).toBe(join('/tmp/app-home', 'profiles', 'coding', 'claude-home'));
      expect(plan.envChanges).toEqual({
        CLAUDE_CONFIG_DIR: join('/tmp/app-home', 'profiles', 'coding', 'claude-home'),
      });
    });

    it('rejects profile names that escape or are reserved', () => {
      expect(() =>
        buildPluginCommandPlan({ appHomePath: '/tmp/a', profileName: '..', args: [] }),
      ).toThrow();
    });
  });

  describe('runPluginCommand', () => {
    it('returns stdout and stderr on a zero exit', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const result = await runPluginCommand({
        appHomePath: appHome,
        profileName: 'coding',
        args: ['list', '--json'],
        captureProcess: fakeCapture({ exitCode: 0, stdout: '[]' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('[]');
    });

    it('classifies a timeout distinctly', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        runPluginCommand({
          appHomePath: appHome,
          profileName: 'coding',
          args: ['update', 'p@m'],
          captureProcess: fakeCapture({ exitCode: null, timedOut: true }),
        }),
      ).rejects.toMatchObject({ code: 'PLUGIN_COMMAND_TIMEOUT' });
    });

    it('classifies network failures as offline', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        runPluginCommand({
          appHomePath: appHome,
          profileName: 'coding',
          args: ['marketplace', 'add', 'owner/repo'],
          captureProcess: fakeCapture({ exitCode: 1, stderr: 'TypeError: fetch failed' }),
        }),
      ).rejects.toMatchObject({ code: 'PLUGIN_COMMAND_OFFLINE' });
    });

    it('reports non-offline failures with upstream diagnostics', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        runPluginCommand({
          appHomePath: appHome,
          profileName: 'coding',
          args: ['install', 'p@m'],
          captureProcess: fakeCapture({ exitCode: 1, stderr: 'Invalid marketplace source format' }),
        }),
      ).rejects.toMatchObject({ code: 'PLUGIN_COMMAND_FAILED' });
    });

    it('reports a missing profile before spawning', async () => {
      const appHome = await makeAppHome();

      await expect(
        runPluginCommand({
          appHomePath: appHome,
          profileName: 'missing',
          args: ['list', '--json'],
          captureProcess: fakeCapture({ exitCode: 0 }),
        }),
      ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    });
  });

  describe('parsePluginSelector', () => {
    it('splits plugin@marketplace', () => {
      expect(parsePluginSelector('probe-plugin@probe-marketplace')).toEqual({
        plugin: 'probe-plugin',
        marketplace: 'probe-marketplace',
      });
    });

    it('rejects a selector without a marketplace', () => {
      expectCcpsError(() => parsePluginSelector('probe-plugin'), 'PLUGIN_INVALID_SELECTOR');
      expectCcpsError(() => parsePluginSelector('@m'), 'PLUGIN_INVALID_SELECTOR');
      expectCcpsError(() => parsePluginSelector('p@'), 'PLUGIN_INVALID_SELECTOR');
    });
  });

  describe('validateMarketplaceSource', () => {
    it('rejects file:// URLs', () => {
      expectCcpsError(
        () => validateMarketplaceSource('file:///tmp/marketplace'),
        'PLUGIN_MARKETPLACE_FILE_URL_REJECTED',
      );
    });

    it('passes owner/repo shorthand through', () => {
      expect(validateMarketplaceSource('wubq511/agy-plugin-cc')).toBe('wubq511/agy-plugin-cc');
    });

    it('passes https URLs through', () => {
      expect(validateMarketplaceSource('https://github.com/wubq511/agy-plugin-cc')).toBe(
        'https://github.com/wubq511/agy-plugin-cc',
      );
    });

    it('resolves an existing local path to absolute', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ccps-mp-source-'));
      tempRoots.push(root);

      expect(validateMarketplaceSource(root)).toBe(root);
    });

    it('rejects a non-existent local path', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ccps-mp-x-'));
      tempRoots.push(root);

      expectCcpsError(
        () => validateMarketplaceSource(join(root, 'nope')),
        'PLUGIN_MARKETPLACE_INVALID_SOURCE',
      );
    });
  });

  describe('detectRestartRequired', () => {
    it('detects the restart notice in update output', () => {
      expect(
        detectRestartRequired(
          '✔ Plugin "probe-plugin" updated from 0.1.0 to 0.2.0 for scope user. Restart to apply changes.',
          '',
        ),
      ).toBe(true);
    });

    it('matches the "Restart required to apply" variant', () => {
      expect(detectRestartRequired('Plugin updated. Restart required to apply changes.', '')).toBe(
        true,
      );
    });

    it('is false when no notice is present', () => {
      expect(detectRestartRequired('probe-plugin is already at the latest version (0.1.0).', '')).toBe(
        false,
      );
    });
  });

  describe('parseInstalledPlugins', () => {
    it('parses the probed installed plugin JSON shape', () => {
      const plugins = parseInstalledPlugins(
        JSON.stringify([
          {
            id: 'probe-plugin@probe-marketplace',
            version: '0.1.0',
            scope: 'user',
            enabled: true,
            installPath: '/tmp/claude-home/plugins/cache/probe-marketplace/probe-plugin/0.1.0',
            installedAt: '2026-08-01T08:31:50.471Z',
            lastUpdated: '2026-08-01T08:31:50.471Z',
          },
        ]),
      );

      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        id: 'probe-plugin@probe-marketplace',
        version: '0.1.0',
        enabled: true,
      });
    });

    it('tolerates an empty list', () => {
      expect(parseInstalledPlugins('[]')).toEqual([]);
    });

    it('rejects non-array output', () => {
      expectCcpsError(() => parseInstalledPlugins('{}'), 'PLUGIN_LIST_INVALID_OUTPUT');
    });
  });

  describe('parseComponentInventory', () => {
    it('parses the probed details component inventory', () => {
      expect(parseComponentInventory(PROBED_DETAILS_OUTPUT)).toEqual({
        skills: 0,
        agents: 0,
        hooks: 0,
        mcpServers: 0,
        lspServers: 0,
      });
    });

    it('returns null when no Component inventory block exists', () => {
      expect(parseComponentInventory('no inventory here')).toBeNull();
    });
  });
});
