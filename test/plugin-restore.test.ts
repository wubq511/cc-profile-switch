import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import { restorePluginItem } from '../src/core/plugins';
import { createPluginItem } from '../src/core/recovery-bin';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import type { CaptureProcess } from '../src/platform/process';

describe('plugin restore', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-plugin-restore-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    return appHome;
  }

  async function makeProfile(appHome: string): Promise<string> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    return getProfileTemplatePaths(appHome, 'coding').claudeHomePath;
  }

  async function addMarketplaceDeclaration(appHome: string, name: string): Promise<string> {
    const claudeHome = await makeProfile(appHome);
    await fs.writeJson(join(claudeHome, 'settings.json'), {
      extraKnownMarketplaces: {
        [name]: { source: { source: 'directory', path: '/tmp/mp' } },
      },
    });
    return claudeHome;
  }

  function recordingCapture(
    results: Array<{ stdout?: string; exitCode?: number }> = [],
  ): { calls: string[][]; capture: CaptureProcess } {
    const calls: string[][] = [];
    const capture: CaptureProcess = async (_command, args) => {
      calls.push(args);
      const result = results.shift() ?? {};
      return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: '', timedOut: false };
    };
    return { calls, capture };
  }

  const fixedClock = () => new Date('2026-07-31T16:13:29.000Z');

  it('reinstalls the current marketplace version and re-applies enable state', async () => {
    const appHome = await makeAppHome();
    const claudeHome = await addMarketplaceDeclaration(appHome, 'probe-marketplace');

    const item = await createPluginItem({
      appHomePath: appHome,
      origin: 'remove',
      profile: 'coding',
      coordinates: {
        plugin: 'probe-plugin',
        marketplace: 'probe-marketplace',
        enabled: true,
        userConfigKeys: ['apiKey'],
      },
      clock: fixedClock,
    });

    // Install leaves the plugin disabled; restore must re-enable it.
    const { calls, capture } = recordingCapture([
      {}, // install
      {
        stdout: JSON.stringify([
          {
            id: 'probe-plugin@probe-marketplace',
            version: '0.2.0',
            scope: 'user',
            enabled: false,
            installPath: join(claudeHome, 'plugins', 'cache', 'probe-marketplace', 'probe-plugin', '0.2.0'),
            installedAt: '2026-08-01T08:32:28.031Z',
            lastUpdated: '2026-08-01T08:32:28.678Z',
          },
        ]),
      },
      {}, // enable
    ]);

    const outcome = await restorePluginItem({ item, appHomePath: appHome, captureProcess: capture });

    expect(calls[0]).toEqual(['plugin', 'install', 'probe-plugin@probe-marketplace', '--scope', 'user']);
    expect(calls[1]).toEqual(['plugin', 'list', '--json']);
    expect(calls[2]).toEqual(['plugin', 'enable', 'probe-plugin@probe-marketplace']);
    expect(outcome).toEqual({
      installedVersion: '0.2.0',
      reenabled: true,
      userConfigKeys: ['apiKey'],
    });
  });

  it('does not fail the enable step when install already enabled the plugin', async () => {
    const appHome = await makeAppHome();
    const claudeHome = await addMarketplaceDeclaration(appHome, 'probe-marketplace');

    const item = await createPluginItem({
      appHomePath: appHome,
      origin: 'remove',
      profile: 'coding',
      coordinates: {
        plugin: 'probe-plugin',
        marketplace: 'probe-marketplace',
        enabled: true,
        userConfigKeys: [],
      },
      clock: fixedClock,
    });

    const { calls, capture } = recordingCapture([
      {}, // install
      {
        stdout: JSON.stringify([
          {
            id: 'probe-plugin@probe-marketplace',
            version: '0.2.0',
            scope: 'user',
            enabled: true,
            installPath: join(claudeHome, 'plugins', 'cache', 'probe-marketplace', 'probe-plugin', '0.2.0'),
            installedAt: '2026-08-01T08:32:28.031Z',
            lastUpdated: '2026-08-01T08:32:28.678Z',
          },
        ]),
      },
    ]);

    const outcome = await restorePluginItem({ item, appHomePath: appHome, captureProcess: capture });

    expect(calls.map((args) => args[1])).toEqual(['install', 'list']);
    expect(outcome).toMatchObject({ installedVersion: '0.2.0', reenabled: false });
  });

  it('disables when the recorded state was disabled but install re-enabled it', async () => {
    const appHome = await makeAppHome();
    await addMarketplaceDeclaration(appHome, 'probe-marketplace');

    const item = await createPluginItem({
      appHomePath: appHome,
      origin: 'remove',
      profile: 'coding',
      coordinates: { plugin: 'probe-plugin', marketplace: 'probe-marketplace', enabled: false },
      clock: fixedClock,
    });

    const { calls, capture } = recordingCapture([
      {},
      { stdout: JSON.stringify([{ id: 'probe-plugin@probe-marketplace', version: '0.1.0', enabled: true }]) },
      {},
    ]);

    const outcome = await restorePluginItem({ item, appHomePath: appHome, captureProcess: capture });

    expect(calls.map((args) => args[1])).toEqual(['install', 'list', 'disable']);
    expect(outcome.reenabled).toBe(false);
  });

  it('fails when the reinstall is not registered, so the item is retained', async () => {
    const appHome = await makeAppHome();
    await addMarketplaceDeclaration(appHome, 'probe-marketplace');

    const item = await createPluginItem({
      appHomePath: appHome,
      origin: 'remove',
      profile: 'coding',
      coordinates: { plugin: 'probe-plugin', marketplace: 'probe-marketplace', enabled: true },
      clock: fixedClock,
    });

    const { capture } = recordingCapture([
      {}, // install
      { stdout: '[]' }, // list: plugin not registered
    ]);

    await expect(
      restorePluginItem({ item, appHomePath: appHome, captureProcess: capture }),
    ).rejects.toMatchObject({ code: 'PLUGIN_RESTORE_UNVERIFIED' });
  });

  it('fails visibly when the marketplace is missing', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome);

    const item = await createPluginItem({
      appHomePath: appHome,
      origin: 'remove',
      profile: 'coding',
      coordinates: { plugin: 'probe-plugin', marketplace: 'gone-marketplace', enabled: true },
      clock: fixedClock,
    });

    await expect(
      restorePluginItem({ item, appHomePath: appHome }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MARKETPLACE_MISSING' });
  });

  it('fails visibly when no marketplace was recorded', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome);

    const item = await createPluginItem({
      appHomePath: appHome,
      origin: 'remove',
      profile: 'coding',
      coordinates: { plugin: 'probe-plugin', marketplace: '', enabled: true },
      clock: fixedClock,
    });

    await expect(
      restorePluginItem({ item, appHomePath: appHome }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MARKETPLACE_MISSING' });
  });
});
