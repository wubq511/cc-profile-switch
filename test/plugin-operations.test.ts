import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import {
  addMarketplace,
  disablePlugin,
  enablePlugin,
  getPluginDetails,
  installPlugin,
  listAvailablePlugins,
  listMarketplaces,
  listPlugins,
  removeMarketplace,
  uninstallPlugin,
  updateMarketplace,
  updatePlugin,
} from '../src/core/plugins';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { listRecoveryBinItems } from '../src/core/recovery-bin';
import type { CaptureProcess } from '../src/platform/process';

const PROBED_AVAILABLE_JSON = JSON.stringify({
  installed: [],
  available: [
    {
      pluginId: 'probe-plugin@probe-marketplace',
      name: 'probe-plugin',
      marketplaceName: 'probe-marketplace',
      source: './plugins/probe-plugin',
    },
  ],
});

const PROBED_DETAILS_OUTPUT = `probe-plugin 0.1.0
  probe plugin
  Source: probe-plugin@probe-marketplace

Component inventory
  Skills (1)
  Agents (0)
  Hooks (2)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~0 tok   added to every session
`;

describe('plugin operations', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-plugin-ops-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    return appHome;
  }

  async function makeProfile(appHome: string, name = 'coding'): Promise<string> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    return getProfileTemplatePaths(appHome, name).claudeHomePath;
  }

  function recordingCapture(
    results: Array<{ stdout?: string; stderr?: string; exitCode?: number }> = [],
  ): { calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>; capture: CaptureProcess } {
    const calls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const capture: CaptureProcess = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env });
      const result = results.shift() ?? {};
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: false,
      };
    };
    return { calls, capture };
  }

  describe('listPlugins', () => {
    it('delegates plugin list --json and parses the probed shape', async () => {
      const appHome = await makeAppHome();
      const claudeHome = await makeProfile(appHome);
      const { calls, capture } = recordingCapture([
        {
          stdout: JSON.stringify([
            {
              id: 'probe-plugin@probe-marketplace',
              version: '0.1.0',
              scope: 'user',
              enabled: false,
              installPath: join(claudeHome, 'plugins', 'cache', 'probe-marketplace', 'probe-plugin', '0.1.0'),
              installedAt: '2026-08-01T08:31:50.471Z',
              lastUpdated: '2026-08-01T08:31:50.471Z',
            },
          ]),
        },
      ]);

      const plugins = await listPlugins({ appHomePath: appHome, profileName: 'coding', captureProcess: capture });

      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(['plugin', 'list', '--json']);
      expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(claudeHome);
      expect(plugins[0]).toMatchObject({ id: 'probe-plugin@probe-marketplace', enabled: false });
    });
  });

  describe('listAvailablePlugins', () => {
    it('delegates plugin list --available --json', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture([{ stdout: PROBED_AVAILABLE_JSON }]);

      const result = await listAvailablePlugins({ appHomePath: appHome, profileName: 'coding', captureProcess: capture });

      expect(calls[0].args).toEqual(['plugin', 'list', '--available', '--json']);
      expect(result.available).toEqual([
        { pluginId: 'probe-plugin@probe-marketplace', name: 'probe-plugin', marketplaceName: 'probe-marketplace', source: './plugins/probe-plugin' },
      ]);
    });
  });

  describe('getPluginDetails', () => {
    it('delegates plugin details and parses the component inventory', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture([{ stdout: PROBED_DETAILS_OUTPUT }]);

      const details = await getPluginDetails({
        appHomePath: appHome,
        profileName: 'coding',
        selector: 'probe-plugin@probe-marketplace',
        captureProcess: capture,
      });

      expect(calls[0].args).toEqual(['plugin', 'details', 'probe-plugin@probe-marketplace']);
      expect(details.components).toEqual({ skills: 1, agents: 0, hooks: 2, mcpServers: 0, lspServers: 0 });
      expect(details.raw).toContain('Component inventory');
    });
  });

  describe('installPlugin', () => {
    it('delegates install at user scope and forwards config pairs', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture();

      await installPlugin({
        appHomePath: appHome,
        profileName: 'coding',
        selector: 'probe-plugin@probe-marketplace',
        config: { model: 'probe-model' },
        captureProcess: capture,
      });

      expect(calls[0].args).toEqual([
        'plugin',
        'install',
        'probe-plugin@probe-marketplace',
        '--scope',
        'user',
        '--config',
        'model=probe-model',
      ]);
    });

    it('omits --config when none are given', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture();

      await installPlugin({ appHomePath: appHome, profileName: 'coding', selector: 'p@m', captureProcess: capture });

      expect(calls[0].args).toEqual(['plugin', 'install', 'p@m', '--scope', 'user']);
    });
  });

  describe('enable/disable/update', () => {
    it('delegates enable and disable', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture([{}, {}]);

      await enablePlugin({ appHomePath: appHome, profileName: 'coding', selector: 'p@m', captureProcess: capture });
      await disablePlugin({ appHomePath: appHome, profileName: 'coding', selector: 'p@m', captureProcess: capture });

      expect(calls[0].args).toEqual(['plugin', 'enable', 'p@m']);
      expect(calls[1].args).toEqual(['plugin', 'disable', 'p@m']);
    });

    it('surfaces the restart notice from update output', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { capture } = recordingCapture([
        { stdout: '✔ Plugin "probe-plugin" updated from 0.1.0 to 0.2.0. Restart to apply changes.' },
      ]);

      const result = await updatePlugin({ appHomePath: appHome, profileName: 'coding', selector: 'p@m', captureProcess: capture });

      expect(result.restartRequired).toBe(true);
    });
  });

  describe('marketplace mutation', () => {
    it('validates then delegates marketplace add', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture();

      await addMarketplace({ appHomePath: appHome, profileName: 'coding', source: 'wubq511/agy-plugin-cc', captureProcess: capture });

      expect(calls[0].args).toEqual(['plugin', 'marketplace', 'add', 'wubq511/agy-plugin-cc']);
    });

    it('rejects file:// sources before spawning', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture();

      await expect(
        addMarketplace({ appHomePath: appHome, profileName: 'coding', source: 'file:///tmp/x', captureProcess: capture }),
      ).rejects.toMatchObject({ code: 'PLUGIN_MARKETPLACE_FILE_URL_REJECTED' });

      expect(calls).toHaveLength(0);
    });

    it('delegates marketplace update and remove', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture([{}, {}]);

      await updateMarketplace({ appHomePath: appHome, profileName: 'coding', name: 'pm', captureProcess: capture });
      await removeMarketplace({ appHomePath: appHome, profileName: 'coding', name: 'pm', captureProcess: capture });

      expect(calls[0].args).toEqual(['plugin', 'marketplace', 'update', 'pm']);
      expect(calls[1].args).toEqual(['plugin', 'marketplace', 'remove', 'pm']);
    });
  });

  describe('uninstallPlugin', () => {
    it('captures enable state from the delegated list and creates a plugin Recovery item', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { calls, capture } = recordingCapture([
        {
          stdout: JSON.stringify([
            {
              id: 'probe-plugin@probe-marketplace',
              version: '0.1.0',
              scope: 'user',
              enabled: true,
            },
          ]),
        },
        { stdout: '✔ Successfully uninstalled plugin' },
      ]);

      const { binItem } = await uninstallPlugin({
        appHomePath: appHome,
        profileName: 'coding',
        selector: 'probe-plugin@probe-marketplace',
        userConfigKeys: ['apiKey'],
        captureProcess: capture,
      });

      expect(calls[0].args).toEqual(['plugin', 'list', '--json']);
      expect(calls[1].args).toEqual(['plugin', 'uninstall', 'probe-plugin@probe-marketplace']);
      expect(binItem.kind).toBe('plugin');
      expect(binItem.shape).toBe('plugin');
      expect(binItem.coordinates).toEqual({
        plugin: 'probe-plugin',
        marketplace: 'probe-marketplace',
        enabled: true,
        userConfigKeys: ['apiKey'],
      });
      expect(binItem.sizeBytes).toBe(0);

      const listed = await listRecoveryBinItems(appHome);
      expect(listed.some((item) => item.id === binItem.id)).toBe(true);
    });

    it('records disabled state when the delegated list shows it disabled', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);
      const { capture } = recordingCapture([
        { stdout: JSON.stringify([{ id: 'probe-plugin@probe-marketplace', version: '0.1.0', enabled: false }]) },
      ]);

      const { binItem } = await uninstallPlugin({
        appHomePath: appHome,
        profileName: 'coding',
        selector: 'probe-plugin@probe-marketplace',
        captureProcess: capture,
      });

      expect((binItem.coordinates as { enabled: boolean }).enabled).toBe(false);
    });
  });

  describe('listMarketplaces', () => {
    it('merges settings declarations and the resolved metadata cache', async () => {
      const appHome = await makeAppHome();
      const claudeHome = await makeProfile(appHome);
      await fs.writeJson(join(claudeHome, 'settings.json'), {
        enabledPlugins: { 'probe-plugin@probe-marketplace': true },
        extraKnownMarketplaces: {
          'directory-mp': { source: { source: 'directory', path: '/tmp/dir-mp' } },
        },
      });
      await fs.ensureDir(join(claudeHome, 'plugins'));
      await fs.writeJson(join(claudeHome, 'plugins', 'known_marketplaces.json'), {
        'directory-mp': {
          source: { source: 'directory', path: '/tmp/dir-mp' },
          installLocation: '/tmp/dir-mp',
          lastUpdated: '2026-08-01T08:31:35.950Z',
        },
        'git-mp': {
          source: { source: 'git', url: 'https://github.com/wubq511/agy-plugin-cc' },
          installLocation: join(claudeHome, 'plugins', 'marketplaces', 'git-mp'),
          lastUpdated: '2026-08-01T08:32:00.000Z',
        },
      });

      const entries = await listMarketplaces({ appHomePath: appHome, profileName: 'coding' });

      expect(entries).toEqual([
        {
          name: 'directory-mp',
          sourceKind: 'directory',
          sourcePath: '/tmp/dir-mp',
          installLocation: '/tmp/dir-mp',
          lastUpdated: '2026-08-01T08:31:35.950Z',
        },
        {
          name: 'git-mp',
          sourceKind: 'git',
          sourceUrl: 'https://github.com/wubq511/agy-plugin-cc',
          installLocation: join(claudeHome, 'plugins', 'marketplaces', 'git-mp'),
          lastUpdated: '2026-08-01T08:32:00.000Z',
        },
      ]);
    });

    it('returns an empty list for a fresh profile', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome);

      expect(await listMarketplaces({ appHomePath: appHome, profileName: 'coding' })).toEqual([]);
    });
  });
});
