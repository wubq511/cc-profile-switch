import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import {
  createPluginItem,
  getRecoveryItem,
  listRecoveryBinItems,
  restoreRecoveryItem,
} from '../src/core/recovery-bin';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { recoveryItemSchema } from '../src/schemas/recovery-bin';

describe('Recovery Bin plugin items', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-bin-plugin-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    return appHome;
  }

  async function makeProfile(appHome: string): Promise<void> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
  }

  const fixedClock = () => new Date('2026-07-31T16:13:29.000Z');

  describe('createPluginItem', () => {
    it('creates a schema-valid plugin item that round-trips through the bin', async () => {
      const appHome = await makeAppHome();

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

      expect(item.kind).toBe('plugin');
      expect(item.shape).toBe('plugin');
      expect(item.sizeBytes).toBe(0);
      expect(item.secretBearing).toBe(false);
      expect(item.id).toBe('20260731T161329-coding-probe-plugin-probe-marketplace');

      // The stored item.json parses against the schema (item itself carries itemDirPath).
      const raw = await fs.readJson(join(item.itemDirPath, 'item.json'));
      expect(recoveryItemSchema.safeParse(raw).success).toBe(true);

      const listed = await listRecoveryBinItems(appHome);
      expect(listed).toHaveLength(1);
      expect(listed[0].coordinates).toEqual(item.coordinates);

      const fetched = await getRecoveryItem(item.id, appHome);
      expect(fetched.shape).toBe('plugin');
    });

    it('resolves id collisions with a counter suffix', async () => {
      const appHome = await makeAppHome();
      const coords = { plugin: 'p', marketplace: 'm', enabled: false };

      const first = await createPluginItem({ appHomePath: appHome, origin: 'remove', profile: 'coding', coordinates: coords, clock: fixedClock });
      const second = await createPluginItem({ appHomePath: appHome, origin: 'remove', profile: 'coding', coordinates: coords, clock: fixedClock });

      expect(second.id).toBe(`${first.id}-2`);
    });
  });

  describe('restore dispatch', () => {
    it('calls the injected handler and consumes the item on success', async () => {
      const appHome = await makeAppHome();
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'probe-plugin', marketplace: 'probe-marketplace', enabled: true },
        clock: fixedClock,
      });

      const restored: string[] = [];
      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        pluginRestore: async (handled) => {
          restored.push(handled.id);
        },
      });

      expect(restored).toEqual([item.id]);
      expect(result.restoredProfile).toBe('coding');
      expect(result.consumed).toBe(true);
      expect(await listRecoveryBinItems(appHome)).toHaveLength(0);
    });

    it('throws PLUGIN_RESTORE_UNAVAILABLE without a handler and keeps the item', async () => {
      const appHome = await makeAppHome();
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'probe-plugin', marketplace: 'probe-marketplace', enabled: false },
        clock: fixedClock,
      });

      await expect(
        restoreRecoveryItem({ appHomePath: appHome, itemId: item.id }),
      ).rejects.toMatchObject({ code: 'PLUGIN_RESTORE_UNAVAILABLE' });

      expect(await listRecoveryBinItems(appHome)).toHaveLength(1);
    });

    it('surfaces a handler failure without consuming the item', async () => {
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
        restoreRecoveryItem({
          appHomePath: appHome,
          itemId: item.id,
          pluginRestore: async () => {
            throw new Error('marketplace gone');
          },
        }),
      ).rejects.toThrow('marketplace gone');

      expect(await listRecoveryBinItems(appHome)).toHaveLength(1);
    });
  });

  describe('item.json schema', () => {
    it('rejects a plugin item whose coordinates are incomplete', async () => {
      const appHome = await makeAppHome();
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'p', marketplace: 'm', enabled: false },
        clock: fixedClock,
      });

      const raw = await fs.readJson(join(item.itemDirPath, 'item.json'));
      delete (raw.coordinates as Record<string, unknown>).plugin;
      expect(recoveryItemSchema.safeParse(raw).success).toBe(false);
    });

    it('defaults userConfigKeys to empty when omitted', async () => {
      const appHome = await makeAppHome();
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'p', marketplace: 'm', enabled: false },
        clock: fixedClock,
      });

      const raw = await fs.readJson(join(item.itemDirPath, 'item.json'));
      const parsed = recoveryItemSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.data.shape === 'plugin') {
        // userConfigKeys is defaulted by the schema when omitted from the record.
        expect(parsed.data.coordinates).toEqual({
          plugin: 'p',
          marketplace: 'm',
          enabled: false,
          userConfigKeys: [],
        });
      }
    });
  });
});
