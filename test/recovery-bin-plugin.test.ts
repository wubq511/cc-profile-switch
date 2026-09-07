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
import { EXPIRED_SWEEP_DATE, fixedClockAt, steppedClock } from './fixtures/clock';

const FIXTURE_CLOCK_ISO = '2026-07-31T16:00:00Z';

/**
 * Plugin Recovery Items across the full stack (issue #104): core item shape +
 * round-trip, then the same item through the WIRED CLI restore handler —
 * fixture creation and CLI runtime share one injected Clock so fixed dates
 * never mix with the real system date.
 */

type CliRun = {
  output: string;
};

describe('Recovery Bin plugin items', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeUserHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-bin-plugin-'));
    tempRoots.push(root);
    return root;
  }

  function appHomeOf(userHome: string): string {
    return join(userHome, '.cc-profile-switch');
  }

  async function makeProfile(appHome: string): Promise<void> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: fixedClockAt(FIXTURE_CLOCK_ISO),
    });
  }

  /**
   * The delegated restore checks the marketplace is still configured for the
   * profile; this mirrors the real pre-uninstall state in settings.json (the
   * declaration itself is user-managed state, never probed).
   */
  async function ensureMarketplaceDeclared(appHome: string, name: string): Promise<void> {
    const settingsPath = join(appHome, 'profiles', 'coding', 'claude-home', 'settings.json');
    const settings = await fs.readJson(settingsPath);
    await fs.writeJson(
      settingsPath,
      {
        ...settings,
        extraKnownMarketplaces: {
          ...settings.extraKnownMarketplaces,
          [name]: { source: { source: 'directory', path: '/tmp/probe-marketplace' } },
        },
      },
      { spaces: 2 },
    );
  }

  /**
   * `ccps init` already creates the default `coding` profile; this variant is
   * for flows that just need the profile to exist (idempotent no-op then).
   */
  async function ensureProfile(appHome: string): Promise<void> {
    if (await fs.pathExists(join(appHome, 'profiles', 'coding'))) return;
    await makeProfile(appHome);
  }

  const fixedClock = fixedClockAt('2026-07-31T16:13:29.000Z');

  // ─── Core item shape (unchanged contract) ─────────────────────────────

  describe('createPluginItem', () => {
    it('creates a schema-valid plugin item that round-trips through the bin', async () => {
      const appHome = join(await makeUserHome(), '.cc-profile-switch');
      await createAppConfig(appHome, { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });

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
      const appHome = join(await makeUserHome(), '.cc-profile-switch');
      await createAppConfig(appHome, { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });
      const coords = { plugin: 'p', marketplace: 'm', enabled: false, userConfigKeys: [] as string[] };

      const first = await createPluginItem({ appHomePath: appHome, origin: 'remove', profile: 'coding', coordinates: coords, clock: fixedClock });
      const second = await createPluginItem({ appHomePath: appHome, origin: 'remove', profile: 'coding', coordinates: coords, clock: fixedClock });

      expect(second.id).toBe(`${first.id}-2`);
    });
  });

  describe('restore dispatch', () => {
    it('calls the injected handler and consumes the item on success', async () => {
      const appHome = join(await makeUserHome(), '.cc-profile-switch');
      await createAppConfig(appHome, { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'probe-plugin', marketplace: 'probe-marketplace', enabled: true, userConfigKeys: [] },
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
      const appHome = join(await makeUserHome(), '.cc-profile-switch');
      await createAppConfig(appHome, { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'probe-plugin', marketplace: 'probe-marketplace', enabled: false, userConfigKeys: [] },
        clock: fixedClock,
      });

      await expect(
        restoreRecoveryItem({ appHomePath: appHome, itemId: item.id }),
      ).rejects.toMatchObject({ code: 'PLUGIN_RESTORE_UNAVAILABLE' });

      expect(await listRecoveryBinItems(appHome)).toHaveLength(1);
    });

    it('surfaces a handler failure without consuming the item', async () => {
      const appHome = join(await makeUserHome(), '.cc-profile-switch');
      await createAppConfig(appHome, { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });
      await makeProfile(appHome);
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'probe-plugin', marketplace: 'gone-marketplace', enabled: true, userConfigKeys: [] },
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
      const appHome = join(await makeUserHome(), '.cc-profile-switch');
      await createAppConfig(appHome, { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'p', marketplace: 'm', enabled: false, userConfigKeys: [] },
        clock: fixedClock,
      });

      const raw = await fs.readJson(join(item.itemDirPath, 'item.json'));
      delete (raw.coordinates as Record<string, unknown>).plugin;
      expect(recoveryItemSchema.safeParse(raw).success).toBe(false);
    });

    it('defaults userConfigKeys to empty when omitted', async () => {
      const appHome = join(await makeUserHome(), '.cc-profile-switch');
      await createAppConfig(appHome, { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });
      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'p', marketplace: 'm', enabled: false, userConfigKeys: [] },
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

  // ─── Wired CLI restore flow, shared Clock (issue #104) ────────────────

  describe('wired CLI restore flow (shared injected Clock)', () => {
    it('restores an unexpired plugin item through the wired handler with version and profile result', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init'], { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });
      await ensureProfile(appHomeOf(userHome));
      await ensureMarketplaceDeclared(appHomeOf(userHome), 'probe-marketplace');

      const item = await createPluginItem({
        appHomePath: appHomeOf(userHome),
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'probe-plugin', marketplace: 'probe-marketplace', enabled: true, userConfigKeys: [] },
        clock: fixedClock,
      });

      // Same clock family as the fixture: the CLI sweep on this run also
      // evaluates expiry at 2026-07-31, so the item is unexpired and listed.
      const listing = await runCli(userHome, ['bin', 'list'], { clock: fixedClock });
      expect(listing.output).toContain(item.id);

      // The delegated handler is the REAL wired one: a recording capture
      // process stands in for `claude plugin` and the CLI prints the
      // reinstalled version plus the restored profile.
      const calls: string[][] = [];
      const restoreRun = await runCli(userHome, ['bin', 'restore', item.id], {
        clock: fixedClock,
        captureProcess: async (_command, args) => {
          calls.push(args);
          if (args[0] === 'plugin' && args[1] === 'list' && args[2] === '--json') {
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  id: 'probe-plugin@probe-marketplace',
                  version: '2.0.0',
                  scope: 'user',
                  enabled: true,
                },
              ]),
              stderr: '',
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: 'installed', stderr: '', timedOut: false };
        },
      });

      expect(calls[0]).toEqual(
        expect.arrayContaining(['install', 'probe-plugin@probe-marketplace']),
      );
      expect(restoreRun.output).toContain('version 2.0.0');
      expect(restoreRun.output).toContain('Restored item for profile "coding".');
      expect(await listRecoveryBinItems(appHomeOf(userHome))).toHaveLength(0);
    });

    it('sweeps the same fixture item expired under one fixed date and keeps it under another, verdicts consistent without real time', async () => {
      const userHome = await makeUserHome();
      await runCli(userHome, ['init'], { clock: fixedClockAt(FIXTURE_CLOCK_ISO) });
      await ensureProfile(appHomeOf(userHome));

      const item = await createPluginItem({
        appHomePath: appHomeOf(userHome),
        origin: 'remove',
        profile: 'coding',
        coordinates: { plugin: 'probe-plugin', marketplace: 'probe-marketplace', enabled: true, userConfigKeys: [] },
        clock: fixedClock,
      });

      // Within retention (2026-08-14, 14 days after removal): listed and
      // untouched by the startup sweep.
      const freshRun = await runCli(userHome, ['bin', 'list'], {
        clock: fixedClockAt('2026-08-14T10:00:00Z'),
      });
      expect(freshRun.output).toContain(item.id);
      expect(await listRecoveryBinItems(appHomeOf(userHome))).toHaveLength(1);

      // Beyond retention (2026-11-15): the SAME item is swept by the startup
      // sweep and the Bin reads empty. Both verdicts come from injected
      // clocks more than the default 30-day retention apart — no waiting.
      const sweptRun = await runCli(userHome, ['bin', 'list'], {
        clock: fixedClockAt(EXPIRED_SWEEP_DATE),
      });
      expect(sweptRun.output).not.toContain(item.id);
      expect(sweptRun.output).toContain('Recovery Bin is empty.');
      expect(await listRecoveryBinItems(appHomeOf(userHome))).toHaveLength(0);

      // A stepped runtime clock (init-time mutations at a rising timestamp)
      // stays consistent with the fixed fixture date as well.
      const stepped = steppedClock('2026-08-01T00:00:00Z');
      expect(stepped().getTime()).toBe(new Date('2026-08-01T00:00:00Z').getTime());
      expect(stepped().getTime()).toBe(new Date('2026-08-01T00:00:00Z').getTime() + 1000);
    });
  });
});

// ─── CLI harness (wired program, injected runtime) ──────────────────────

type CliRunOptions = {
  clock?: () => Date;
  captureProcess?: (command: string, args: string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
};

async function runCli(userHome: string, args: string[], options: CliRunOptions = {}): Promise<CliRun> {
  const { createProgram } = await import('../src/cli');
  const { captureProcess: defaultCaptureProcess } = await import('../src/platform/process');
  const clock = options.clock ?? fixedClockAt(FIXTURE_CLOCK_ISO);
  const output: string[] = [];
  const program = createProgram({
    writeOut: (value) => output.push(value),
    openTarget: async () => {},
    spawnProcess: async () => ({ exitCode: 0 }),
    captureProcess: options.captureProcess ?? defaultCaptureProcess,
    readInput: async () => '',
    runTui: async () => {},
    clock,
  });
  program.configureOutput({
    writeOut: (value) => output.push(value),
    writeErr: (value) => output.push(value),
  });

  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = userHome;
  process.env.USERPROFILE = userHome;
  program.exitOverride();

  try {
    await program.parseAsync(['node', 'ccps', ...args], { from: 'node' });
    return { output: output.join('') };
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
}