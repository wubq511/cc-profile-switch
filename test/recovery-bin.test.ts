import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import {
  createFileTreeItem,
  createFragmentItem,
  listRecoveryBinItems,
  getRecoveryItem,
  restoreRecoveryItem,
  permanentlyDeleteItem,
  emptyRecoveryBin,
  sweepExpiredItems,
  computeRetentionImpact,
  changeRetentionSetting,
  getBinSummary,
  performStartupSweep,
  getLastSweepResult,
  formatSweepSummary,
  formatItemId,
} from '../src/core/recovery-bin';
import { createProfileFromTemplate } from '../src/core/profile-template';

describe('Recovery Bin service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    // Restore permissions on recovery-bin items (0600 dirs can't be deleted by fs.remove)
    for (const root of tempRoots) {
      const binDir = join(root, '.cc-profile-switch', 'recovery-bin');
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

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-recovery-bin-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    return appHome;
  }

  async function makeProfile(appHome: string, name: string): Promise<string> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    const { profilesPath } = getAppHomePaths(appHome);
    return join(profilesPath, name);
  }

  const fixedClock = () => new Date('2026-07-31T16:13:29.000Z');

  // ─── Item ID format ───────────────────────────────────────────────────

  describe('formatItemId', () => {
    it('produces timestamp-first ID with profile-slug suffix', () => {
      const id = formatItemId(new Date('2026-07-31T16:13:29.000Z'), 'coding', 'skills-pdf');
      expect(id).toBe('20260731T161329-coding-skills-pdf');
    });

    it('is lexicographically chronological', () => {
      const earlier = formatItemId(new Date('2026-07-30T00:00:00.000Z'), 'a', 'x');
      const later = formatItemId(new Date('2026-07-31T00:00:00.000Z'), 'a', 'x');
      expect(earlier < later).toBe(true);
    });
  });

  // ─── File-tree item creation ──────────────────────────────────────────

  describe('createFileTreeItem', () => {
    it('creates a file-tree Recovery Item with item.json and payload', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), '# PDF Skill', 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      expect(item.version).toBe(1);
      expect(item.origin).toBe('remove');
      expect(item.kind).toBe('skill');
      expect(item.shape).toBe('file-tree');
      expect(item.profile).toBe('coding');
      expect(item.id).toMatch(/^20260731T161329-coding-/);
      expect(item.secretBearing).toBe(false);
      expect(item.sizeBytes).toBeGreaterThan(0);

      // Verify item.json on disk
      const itemJson = await fs.readJson(join(item.itemDirPath, 'item.json'));
      expect(itemJson.id).toBe(item.id);

      // Verify payload was copied
      const payloadFile = join(item.itemDirPath, 'claude-home', 'skills', 'pdf', 'SKILL.md');
      expect(await fs.pathExists(payloadFile)).toBe(true);
    });

    it('computes sizeBytes once at creation time', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), 'x'.repeat(1000), 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      expect(item.sizeBytes).toBeGreaterThan(0);

      // Mutating the source after creation should not change sizeBytes
      await fs.writeFile(join(skillDir, 'SKILL.md'), 'y'.repeat(5000), 'utf8');
      const reloaded = await fs.readJson(join(item.itemDirPath, 'item.json'));
      expect(reloaded.sizeBytes).toBe(item.sizeBytes);
    });

    it('resolves ID collisions with counter suffix', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      const item1 = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      const item2 = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      expect(item1.id).not.toBe(item2.id);
      expect(item2.id).toContain('-2');
    });

    it('sets directory permissions to 0600 when secretBearing is true', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'secret-skill');
      await fs.ensureDir(skillDir);

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/secret-skill' },
        sourcePath: skillDir,
        secretBearing: true,
        clock: fixedClock,
      });

      expect(item.secretBearing).toBe(true);
      // On POSIX systems, verify the directory permission
      if (process.platform !== 'win32') {
        const stat = await fs.stat(item.itemDirPath);
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });

  // ─── Fragment item creation ───────────────────────────────────────────

  describe('createFragmentItem', () => {
    it('creates a fragment Recovery Item with value in coordinates', async () => {
      const appHome = await makeAppHome();

      const item = await createFragmentItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'mcp-server',
        profile: 'coding',
        coordinates: {
          file: 'claude-home/.claude.json',
          keyPath: 'mcpServers.myServer',
          value: { command: 'node', args: ['server.js'] },
        },
        clock: fixedClock,
      });

      expect(item.version).toBe(1);
      expect(item.shape).toBe('fragment');
      expect(item.sizeBytes).toBe(0);
      expect(item.coordinates).toEqual({
        file: 'claude-home/.claude.json',
        keyPath: 'mcpServers.myServer',
        value: { command: 'node', args: ['server.js'] },
      });
    });

    it('always records sizeBytes as 0 for fragments', async () => {
      const appHome = await makeAppHome();

      const item = await createFragmentItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'settings-field',
        profile: 'coding',
        coordinates: {
          file: 'claude-home/settings.json',
          keyPath: 'someKey',
          value: 'someValue',
        },
        clock: fixedClock,
      });

      expect(item.sizeBytes).toBe(0);
    });
  });

  // ─── Listing ──────────────────────────────────────────────────────────

  describe('listRecoveryBinItems', () => {
    it('returns items in chronological order', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-07-30T10:00:00Z'),
      });

      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-07-31T10:00:00Z'),
      });

      const items = await listRecoveryBinItems(appHome);
      expect(items).toHaveLength(2);
      expect(items[0].id < items[1].id).toBe(true);
    });

    it('returns empty array when bin is empty', async () => {
      const appHome = await makeAppHome();
      const items = await listRecoveryBinItems(appHome);
      expect(items).toEqual([]);
    });

    it('skips directories with malformed item.json', async () => {
      const appHome = await makeAppHome();
      const { recoveryBinPath } = getAppHomePaths(appHome);
      const badDir = join(recoveryBinPath, 'bad-item');
      await fs.ensureDir(badDir);
      await fs.writeJson(join(badDir, 'item.json'), { invalid: true });

      const items = await listRecoveryBinItems(appHome);
      expect(items).toEqual([]);
    });
  });

  // ─── Get single item ──────────────────────────────────────────────────

  describe('getRecoveryItem', () => {
    it('returns item by ID', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      const created = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      const loaded = await getRecoveryItem(created.id, appHome);
      expect(loaded.id).toBe(created.id);
      expect(loaded.profile).toBe('coding');
    });

    it('throws RECOVERY_ITEM_NOT_FOUND for missing item', async () => {
      const appHome = await makeAppHome();
      await expect(getRecoveryItem('nonexistent', appHome)).rejects.toMatchObject({
        code: 'RECOVERY_ITEM_NOT_FOUND',
      });
    });
  });

  // ─── Restore ──────────────────────────────────────────────────────────

  describe('restoreRecoveryItem', () => {
    it('restores a file-tree item and consumes it on success', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), '# PDF', 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      // Remove the original to simulate the removal
      await fs.remove(skillDir);

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        clock: fixedClock,
      });

      expect(result.consumed).toBe(true);
      expect(result.restoredProfile).toBe('coding');

      // Payload should be restored
      expect(await fs.pathExists(skillDir)).toBe(true);

      // Item should be consumed (directory removed)
      expect(await fs.pathExists(item.itemDirPath)).toBe(false);
    });

    it('restores a fragment item and writes value back', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const settingsPath = join(profileDir, 'claude-home', 'settings.json');

      // Create a fragment item for a settings field
      const item = await createFragmentItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'mcp-server',
        profile: 'coding',
        coordinates: {
          file: 'claude-home/settings.json',
          keyPath: 'mcpServers.myServer',
          value: { command: 'node', args: ['server.js'] },
        },
        clock: fixedClock,
      });

      // Remove the key from settings to simulate removal
      const settings = await fs.readJson(settingsPath);
      delete (settings as Record<string, unknown>).mcpServers;
      await fs.writeJson(settingsPath, settings);

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
      });

      expect(result.consumed).toBe(true);

      // Value should be written back
      const restored = await fs.readJson(settingsPath);
      expect((restored as Record<string, unknown>).mcpServers).toEqual({
        myServer: { command: 'node', args: ['server.js'] },
      });

      // Item consumed
      expect(await fs.pathExists(item.itemDirPath)).toBe(false);
    });

    it('refuses restore on collision by default', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), '# PDF', 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      // The original still exists (collision)
      await expect(
        restoreRecoveryItem({ appHomePath: appHome, itemId: item.id }),
      ).rejects.toMatchObject({ code: 'RESTORE_COLLISION' });

      // Item should NOT be consumed
      expect(await fs.pathExists(item.itemDirPath)).toBe(true);
    });

    it('resolves collision with restore-as-new-name', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), '# PDF', 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      // Create a second profile for the new-name restore
      await makeProfile(appHome, 'study');

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        collisionResolution: 'restore-as-new-name',
        newName: 'study',
      });

      expect(result.consumed).toBe(true);
      expect(result.restoredProfile).toBe('coding');

      // Restored under the new profile name
      const { profilesPath } = getAppHomePaths(appHome);
      const restoredPath = join(profilesPath, 'study', 'claude-home', 'skills', 'pdf', 'SKILL.md');
      expect(await fs.pathExists(restoredPath)).toBe(true);
    });

    it('resolves collision with delete-and-restore', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), '# PDF Original', 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      // Overwrite the original to create a collision with different content
      await fs.writeFile(join(skillDir, 'SKILL.md'), '# PDF Conflict', 'utf8');

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        collisionResolution: 'delete-and-restore',
        clock: fixedClock,
      });

      expect(result.consumed).toBe(true);

      // The conflicting target should have been binned and the original restored
      const restoredContent = await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8');
      expect(restoredContent).toBe('# PDF Original');

      // The conflicting version should be in the bin as a new item
      const binItems = await listRecoveryBinItems(appHome);
      expect(binItems.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Permanent deletion ───────────────────────────────────────────────

  describe('permanentlyDeleteItem', () => {
    it('deletes a Recovery Item permanently', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      await permanentlyDeleteItem(item.id, appHome);

      expect(await fs.pathExists(item.itemDirPath)).toBe(false);
      const items = await listRecoveryBinItems(appHome);
      expect(items).toHaveLength(0);
    });
  });

  describe('emptyRecoveryBin', () => {
    it('removes all items from the bin', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-07-30T10:00:00Z'),
      });

      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-07-31T10:00:00Z'),
      });

      await emptyRecoveryBin(appHome);

      const items = await listRecoveryBinItems(appHome);
      expect(items).toHaveLength(0);
    });
  });

  // ─── Retention and sweep ──────────────────────────────────────────────

  describe('sweepExpiredItems', () => {
    it('deletes items past the retention period', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), '# PDF', 'utf8');

      // Create an item 31 days ago (default retention is 30 days)
      const oldClock = () => new Date('2026-06-30T10:00:00Z');
      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: oldClock,
      });

      // Create a recent item (not expired)
      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-07-31T10:00:00Z'),
      });

      const result = await sweepExpiredItems(
        appHome,
        () => new Date('2026-07-31T16:00:00Z'),
      );

      expect(result.deletedCount).toBe(1);
      expect(result.reclaimedBytes).toBeGreaterThan(0);

      const remaining = await listRecoveryBinItems(appHome);
      expect(remaining).toHaveLength(1);
    });

    it('does not delete items when retention is null (Never)', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      // Set retention to Never
      const config = await fs.readJson(getAppHomePaths(appHome).configPath);
      await fs.writeJson(getAppHomePaths(appHome).configPath, {
        ...config,
        recovery: { retentionDays: null },
      });

      // Create a very old item
      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2020-01-01T00:00:00Z'),
      });

      const result = await sweepExpiredItems(appHome);
      expect(result.deletedCount).toBe(0);
    });

    it('applies fixed 3-day TTL for update-origin items', async () => {
      const appHome = await makeHomeWithRetention(30);
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      // Create an update-origin item 4 days ago (should expire under 3-day TTL)
      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'update',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-07-27T10:00:00Z'),
      });

      // Create a remove-origin item 4 days ago (should NOT expire under 30-day retention)
      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-07-27T10:00:00Z'),
      });

      const result = await sweepExpiredItems(
        appHome,
        () => new Date('2026-07-31T16:00:00Z'),
      );

      // Only the update-origin item should be expired (4 days > 3 day TTL)
      expect(result.deletedCount).toBe(1);

      const remaining = await listRecoveryBinItems(appHome);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].origin).toBe('remove');
    });
  });

  describe('computeRetentionImpact', () => {
    it('reports how many items would expire without deleting', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      // Create old items
      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-06-01T10:00:00Z'),
      });

      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-06-15T10:00:00Z'),
      });

      const impact = await computeRetentionImpact(
        7,
        appHome,
        () => new Date('2026-07-31T16:00:00Z'),
      );

      expect(impact.wouldExpireCount).toBe(2);
      expect(impact.wouldExpireIds).toHaveLength(2);

      // Items should still exist
      const items = await listRecoveryBinItems(appHome);
      expect(items).toHaveLength(2);
    });
  });

  describe('changeRetentionSetting', () => {
    it('updates the config and reports impact', async () => {
      const appHome = await makeAppHome();

      const impact = await changeRetentionSetting(7, appHome);

      expect(impact.wouldExpireCount).toBe(0);

      const config = await fs.readJson(getAppHomePaths(appHome).configPath);
      expect(config.recovery.retentionDays).toBe(7);
    });
  });

  // ─── Bin summary ──────────────────────────────────────────────────────

  describe('getBinSummary', () => {
    it('returns item count and total size', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), '# PDF', 'utf8');

      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      const summary = await getBinSummary(appHome);
      expect(summary.itemCount).toBe(1);
      expect(summary.totalSizeBytes).toBeGreaterThan(0);
    });
  });

  // ─── Startup sweep ────────────────────────────────────────────────────

  describe('performStartupSweep', () => {
    it('runs sweep and stores result for summary', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      // Create an expired item
      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-06-01T10:00:00Z'),
      });

      const result = await performStartupSweep(
        appHome,
        () => new Date('2026-07-31T16:00:00Z'),
      );

      expect(result.deletedCount).toBe(1);
      expect(getLastSweepResult()).toEqual(result);
    });
  });

  describe('formatSweepSummary', () => {
    it('returns null when nothing was deleted', () => {
      expect(formatSweepSummary({ deletedCount: 0, reclaimedBytes: 0 })).toBeNull();
    });

    it('formats a summary line with count and size', () => {
      const summary = formatSweepSummary({ deletedCount: 3, reclaimedBytes: 1024 * 50 });
      expect(summary).toContain('3 expired item(s) swept');
      expect(summary).toContain('reclaimed');
    });
  });

  // ─── No central index ─────────────────────────────────────────────────

  describe('no central index', () => {
    it('bin directory has no index file — items are self-describing', async () => {
      const appHome = await makeAppHome();
      const { recoveryBinPath } = getAppHomePaths(appHome);

      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      // No index.json or similar at the bin root
      const entries = await fs.readdir(recoveryBinPath);
      for (const entry of entries) {
        const stat = await fs.stat(join(recoveryBinPath, entry));
        expect(stat.isDirectory()).toBe(true);
      }
    });
  });

  // ─── item.json schema validation ──────────────────────────────────────

  describe('item.json schema', () => {
    it('rejects item.json with display-name field (spec says no display-name)', async () => {
      const { recoveryItemSchema } = await import('../src/schemas/recovery-bin');
      const result = recoveryItemSchema.safeParse({
        version: 1,
        id: '20260731T161329-coding-skill',
        origin: 'remove',
        kind: 'skill',
        shape: 'file-tree',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        removedAt: '2026-07-31T16:13:29.000Z',
        sizeBytes: 100,
        secretBearing: false,
        'display-name': 'My Skill', // extra field — strict schema should reject
      });
      expect(result.success).toBe(false);
    });

    it('rejects item.json with expiry or policy snapshot fields', async () => {
      const { recoveryItemSchema } = await import('../src/schemas/recovery-bin');
      const result = recoveryItemSchema.safeParse({
        version: 1,
        id: '20260731T161329-coding-skill',
        origin: 'remove',
        kind: 'skill',
        shape: 'file-tree',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        removedAt: '2026-07-31T16:13:29.000Z',
        sizeBytes: 100,
        secretBearing: false,
        expiresAt: '2026-08-30T16:13:29.000Z', // no expiry stored per spec
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── Helpers ──────────────────────────────────────────────────────────

  async function makeHomeWithRetention(retentionDays: number): Promise<string> {
    const appHome = await makeAppHome();
    const { configPath } = getAppHomePaths(appHome);
    const config = await fs.readJson(configPath);
    await fs.writeJson(configPath, {
      ...config,
      recovery: { retentionDays },
    });
    return appHome;
  }

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
});
