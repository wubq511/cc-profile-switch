import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import {
  createFileTreeItem,
  createFragmentItem,
  createPluginItem,
  listRecoveryBinItems,
  listRecoveryBinWithSizes,
  getRecoveryItem,
  restoreRecoveryItem,
  permanentlyDeleteItem,
  emptyRecoveryBin,
  sweepExpiredItems,
  computeRetentionImpact,
  changeRetentionSetting,
  getBinSummary,
  performStartupSweep,
  runStartupSweep,
  getLastSweepResult,
  formatSweepSummary,
  formatItemId,
  computeItemExpiresAt,
  getRecoveryItemDisplayName,
} from '../src/core/recovery-bin';
import { createProfileFromTemplate } from '../src/core/profile-template';

describe('Recovery Bin service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    // Restore permissions on recovery-bin items (0700 dirs can't be deleted by fs.remove)
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

  // ─── Presentation helpers (§9.5) ──────────────────────────────────────

  describe('computeItemExpiresAt', () => {
    it('computes removedAt + configured retention for remove-origin items', async () => {
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

      const expiresAt = computeItemExpiresAt(item, 30);
      expect(expiresAt).toEqual(new Date('2026-08-30T16:13:29.000Z'));
    });

    it('applies the fixed 3-day TTL for update-origin items', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'update',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: fixedClock,
      });

      const expiresAt = computeItemExpiresAt(item, 30);
      expect(expiresAt).toEqual(new Date('2026-08-03T16:13:29.000Z'));
    });

    it('returns null when retention is null (Never)', async () => {
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

      expect(computeItemExpiresAt(item, null)).toBeNull();
    });
  });

  describe('getRecoveryItemDisplayName', () => {
    it('uses the profile name for whole-profile payloads', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'profile',
        profile: 'coding',
        coordinates: { targetRelativePath: 'profiles/coding' },
        sourcePath: profileDir,
        clock: fixedClock,
      });

      expect(getRecoveryItemDisplayName(item)).toBe('coding');
    });

    it('uses the last path segment for file-tree entries', async () => {
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

      expect(getRecoveryItemDisplayName(item)).toBe('pdf');
    });

    it('uses the last keyPath segment for fragments', async () => {
      const appHome = await makeAppHome();

      const item = await createFragmentItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'mcp-server',
        profile: 'coding',
        coordinates: {
          file: 'claude-home/.claude.json',
          keyPath: 'mcpServers.myServer',
          value: {},
        },
        clock: fixedClock,
      });

      expect(getRecoveryItemDisplayName(item)).toBe('myServer');
    });

    it('uses <plugin>@<marketplace> for plugin items', async () => {
      const appHome = await makeAppHome();

      const item = await createPluginItem({
        appHomePath: appHome,
        origin: 'remove',
        profile: 'coding',
        coordinates: {
          plugin: 'pretty-ts-errors',
          marketplace: 'ccps-marketplace',
        },
        clock: fixedClock,
      });

      expect(getRecoveryItemDisplayName(item)).toBe('pretty-ts-errors@ccps-marketplace');
    });
  });

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

    it('sets directory permissions to 0700 when secretBearing is true', async () => {
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
        expect(mode).toBe(0o700);
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

    it('resolves collision with restore-as-new-name at entry level', async () => {
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

      // The original still exists (collision); restore as a renamed skill
      // within the same profile (§9.3 entry-level rename).
      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        collisionResolution: 'restore-as-new-name',
        newName: 'pdf-2',
      });

      expect(result.consumed).toBe(true);
      expect(result.restoredProfile).toBe('coding');

      // Both the conflicting original and the renamed restore exist.
      expect(await fs.pathExists(join(skillDir, 'SKILL.md'))).toBe(true);
      const renamedPath = join(profileDir, 'claude-home', 'skills', 'pdf-2', 'SKILL.md');
      expect(await fs.pathExists(renamedPath)).toBe(true);
    });

    it('restore-as-new-name refuses a renamed target that also collides', async () => {
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

      // `pdf-2` already exists, so the rename target itself collides.
      await fs.ensureDir(join(profileDir, 'claude-home', 'skills', 'pdf-2'));
      await fs.writeFile(
        join(profileDir, 'claude-home', 'skills', 'pdf-2', 'SKILL.md'),
        '# PDF 2',
        'utf8',
      );

      await expect(
        restoreRecoveryItem({
          appHomePath: appHome,
          itemId: item.id,
          collisionResolution: 'restore-as-new-name',
          newName: 'pdf-2',
        }),
      ).rejects.toMatchObject({ code: 'RESTORE_COLLISION' });
    });

    it('restore-as-new-name requires a new name', async () => {
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

      await expect(
        restoreRecoveryItem({
          appHomePath: appHome,
          itemId: item.id,
          collisionResolution: 'restore-as-new-name',
        }),
      ).rejects.toMatchObject({ code: 'RESTORE_NEW_NAME_REQUIRED' });
    });

    it('restore-as-new-name rejects a name that escapes the profile', async () => {
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

      await expect(
        restoreRecoveryItem({
          appHomePath: appHome,
          itemId: item.id,
          collisionResolution: 'restore-as-new-name',
          newName: '../escape',
        }),
      ).rejects.toMatchObject({ code: 'RESTORE_INVALID_NEW_NAME' });
    });

    it('resolves a file-tree collision for an auto-memory entry at entry level', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const autoDir = join(profileDir, 'claude-home', 'memory', 'auto');
      await fs.ensureDir(autoDir);
      await fs.writeFile(join(autoDir, 'topics.md'), '# Refactoring', 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'auto-memory',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/memory/auto/topics.md' },
        sourcePath: join(autoDir, 'topics.md'),
        clock: fixedClock,
      });

      // The original entry still exists (collision); restore under a new name.
      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        collisionResolution: 'restore-as-new-name',
        newName: 'topics-2.md',
      });

      expect(result.consumed).toBe(true);
      expect(await fs.pathExists(join(autoDir, 'topics.md'))).toBe(true);
      const renamed = await fs.readFile(join(autoDir, 'topics-2.md'), 'utf8');
      expect(renamed).toBe('# Refactoring');
    });

    it('delete-and-restore bins the conflicting entry as its own same-kind item', async () => {
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

      // The conflicting version should be in the bin as a new same-kind item
      const binItems = await listRecoveryBinItems(appHome);
      expect(binItems.length).toBeGreaterThanOrEqual(1);
      const conflicting = binItems.find((i) => i.id !== item.id);
      expect(conflicting?.kind).toBe('skill');
      const conflictingContent = await fs.readFile(
        join(conflicting!.itemDirPath, 'claude-home', 'skills', 'pdf', 'SKILL.md'),
        'utf8',
      );
      expect(conflictingContent).toBe('# PDF Conflict');
    });

    it('restores a profile-kind item as a new profile name', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      // Simulate an entry inside the profile so the payload tree is non-trivial.
      await fs.writeFile(join(profileDir, 'profile.json'), '{"profileName":"coding"}', 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'profile',
        profile: 'coding',
        coordinates: { targetRelativePath: 'profiles/coding' },
        sourcePath: profileDir,
        clock: fixedClock,
      });

      // The real removal deletes the profile (that is why the item exists).
      await fs.remove(profileDir);

      // Recreate `coding` (S13), then restore the item as `coding-2`.
      await makeProfile(appHome, 'coding');

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        collisionResolution: 'restore-as-new-name',
        newName: 'coding-2',
        clock: fixedClock,
      });

      expect(result.consumed).toBe(true);
      const { profilesPath } = getAppHomePaths(appHome);
      // Both the recreated original and the new-name restore exist.
      expect(await fs.pathExists(join(profilesPath, 'coding'))).toBe(true);
      expect(await fs.pathExists(join(profilesPath, 'coding-2', 'profile.json'))).toBe(true);
    });

    it('restores a profile-kind item back in place (S12)', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await fs.writeFile(join(profileDir, 'profile.json'), '{"profileName":"coding"}', 'utf8');

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'profile',
        profile: 'coding',
        coordinates: { targetRelativePath: 'profiles/coding' },
        sourcePath: profileDir,
        clock: fixedClock,
      });

      // The removal deleted the profile (that is why the item exists).
      await fs.remove(profileDir);

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        clock: fixedClock,
      });

      expect(result.consumed).toBe(true);
      const { profilesPath } = getAppHomePaths(appHome);
      // The profile tree is back at its own directory, not a nested path.
      expect(await fs.pathExists(join(profilesPath, 'coding', 'profile.json'))).toBe(true);
      expect(await fs.pathExists(join(profilesPath, 'coding', 'profiles'))).toBe(false);
    });

    it('profile delete-and-restore bins the conflicting Profile then restores (S14)', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await fs.writeFile(
        join(profileDir, 'profile.json'),
        '{"profileName":"coding","content":"original"}',
        'utf8',
      );

      const item = await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'profile',
        profile: 'coding',
        coordinates: { targetRelativePath: 'profiles/coding' },
        sourcePath: profileDir,
        clock: fixedClock,
      });

      await fs.remove(profileDir);

      // Recreate `coding` with different content (S14 conflict).
      await makeProfile(appHome, 'coding');
      await fs.writeFile(
        join(profileDir, 'profile.json'),
        '{"profileName":"coding","content":"conflict"}',
        'utf8',
      );

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        collisionResolution: 'delete-and-restore',
        clock: fixedClock,
      });

      expect(result.consumed).toBe(true);

      // The original (bin) content is restored at the profile root.
      const { profilesPath } = getAppHomePaths(appHome);
      const restored = await fs.readJson(join(profilesPath, 'coding', 'profile.json'));
      expect((restored as Record<string, unknown>).content).toBe('original');
      // No nested profiles/ garbage directory.
      expect(await fs.pathExists(join(profilesPath, 'coding', 'profiles'))).toBe(false);

      // The conflicting Profile became its own profile-kind Bin item.
      const binItems = await listRecoveryBinItems(appHome);
      const conflicting = binItems.find((i) => i.id !== item.id);
      expect(conflicting?.kind).toBe('profile');
      const conflictingJson = await fs.readJson(
        join(conflicting!.itemDirPath, 'profiles', 'coding', 'profile.json'),
      );
      expect((conflictingJson as Record<string, unknown>).content).toBe('conflict');
    });

    it('resolves a fragment collision with restore-as-new-name at entry level', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const settingsPath = join(profileDir, 'claude-home', 'settings.json');

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

      // Re-add the conflicting key so restore collides.
      const settings = (await fs.readJson(settingsPath)) as Record<string, unknown>;
      settings.mcpServers = { myServer: { command: 'other' } };
      await fs.writeJson(settingsPath, settings);

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        collisionResolution: 'restore-as-new-name',
        newName: 'myServer2',
        clock: fixedClock,
      });

      expect(result.consumed).toBe(true);
      const restored = (await fs.readJson(settingsPath)) as Record<string, unknown>;
      const servers = restored.mcpServers as Record<string, unknown>;
      // Both the conflicting original and the renamed restore exist.
      expect(servers.myServer).toEqual({ command: 'other' });
      expect(servers.myServer2).toEqual({ command: 'node', args: ['server.js'] });
    });

    it('fragment delete-and-restore bins the conflicting entry then restores', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const settingsPath = join(profileDir, 'claude-home', 'settings.json');

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

      const settings = (await fs.readJson(settingsPath)) as Record<string, unknown>;
      settings.mcpServers = { myServer: { command: 'conflict' } };
      await fs.writeJson(settingsPath, settings);

      const result = await restoreRecoveryItem({
        appHomePath: appHome,
        itemId: item.id,
        collisionResolution: 'delete-and-restore',
        clock: fixedClock,
      });

      expect(result.consumed).toBe(true);
      const restored = (await fs.readJson(settingsPath)) as Record<string, unknown>;
      expect((restored.mcpServers as Record<string, unknown>).myServer).toEqual({
        command: 'node',
        args: ['server.js'],
      });

      // The conflicting entry became its own fragment item.
      const binItems = await listRecoveryBinItems(appHome);
      const conflicting = binItems.find((i) => i.id !== item.id);
      expect(conflicting?.kind).toBe('mcp-server');
      const coords = conflicting!.coordinates as { file: string; keyPath: string; value: unknown };
      expect(coords.keyPath).toBe('mcpServers.myServer');
      expect(coords.value).toEqual({ command: 'conflict' });
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

      const result = await sweepExpiredItems(appHome, () => new Date('2026-07-31T16:00:00Z'));

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

      const result = await sweepExpiredItems(appHome, () => new Date('2026-07-31T16:00:00Z'));

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

      const result = await performStartupSweep(appHome, () => new Date('2026-07-31T16:00:00Z'));

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

  // ─── Startup sweep orchestration (§9.4) ───────────────────────────────

  describe('runStartupSweep', () => {
    it('sweeps expired items and reports the summary only on the next run', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const skillDir = join(profileDir, 'claude-home', 'skills', 'pdf');
      await fs.ensureDir(skillDir);
      await fs.writeFile(join(skillDir, 'SKILL.md'), 'x'.repeat(2048), 'utf8');

      // Removed 2026-06-01; swept 2026-07-31 — past the default 30-day retention.
      await createFileTreeItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'skill',
        profile: 'coding',
        coordinates: { targetRelativePath: 'claude-home/skills/pdf' },
        sourcePath: skillDir,
        clock: () => new Date('2026-06-01T10:00:00Z'),
      });
      const now = () => new Date('2026-07-31T16:00:00Z');

      // First run: the sweep deletes the expired item; nothing to report yet.
      const first = await runStartupSweep(appHome, now);
      expect(first.pendingSummary).toBeNull();
      expect(first.sweepResult).not.toBeNull();
      expect(first.sweepResult?.deletedCount).toBe(1);
      expect(first.sweepResult?.reclaimedBytes).toBeGreaterThan(0);
      expect(await listRecoveryBinItems(appHome)).toHaveLength(0);

      // Next run (the "next launch"): the one-line summary surfaces once.
      const second = await runStartupSweep(appHome, now);
      expect(second.pendingSummary).toContain('1 expired item(s) swept');
      expect(second.pendingSummary).toContain('reclaimed');
      expect(second.sweepResult?.deletedCount).toBe(0);

      // Third run: the marker was consumed — the line never repeats.
      const third = await runStartupSweep(appHome, now);
      expect(third.pendingSummary).toBeNull();
    });

    it('records no pending summary when a sweep deletes nothing', async () => {
      const appHome = await makeAppHome();
      const now = () => new Date('2026-07-31T16:00:00Z');

      const first = await runStartupSweep(appHome, now);
      expect(first.sweepResult?.deletedCount).toBe(0);

      const second = await runStartupSweep(appHome, now);
      expect(second.pendingSummary).toBeNull();
    });

    it('is failure-isolated on an uninitialized app home and creates nothing', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ccps-recovery-bin-'));
      tempRoots.push(root);
      const appHome = join(root, '.cc-profile-switch');

      const report = await runStartupSweep(appHome);

      expect(report).toEqual({ pendingSummary: null, sweepResult: null });
      expect(await fs.pathExists(appHome)).toBe(false);
    });

    it('ignores and clears a corrupt pending-summary marker', async () => {
      const appHome = await makeAppHome();
      const markerPath = join(appHome, 'pending-sweep-summary.json');
      await fs.writeFile(markerPath, '{ not json', 'utf8');

      const report = await runStartupSweep(appHome, () => new Date('2026-07-31T16:00:00Z'));

      expect(report.pendingSummary).toBeNull();
      expect(report.sweepResult?.deletedCount).toBe(0);
      expect(await fs.pathExists(markerPath)).toBe(false);
    });
  });

  // ─── Bin listing with sizes (§9.5) ────────────────────────────────────

  describe('listRecoveryBinWithSizes', () => {
    it('returns per-entry live sizes and a total', async () => {
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
      await createFragmentItem({
        appHomePath: appHome,
        origin: 'remove',
        kind: 'mcp-server',
        profile: 'coding',
        coordinates: { file: 'claude-home/.claude.json', keyPath: 'mcpServers.x', value: {} },
        clock: fixedClock,
      });

      const list = await listRecoveryBinWithSizes(appHome);

      expect(list.entries).toHaveLength(2);
      const treeEntry = list.entries.find((entry) => entry.item.id === item.id);
      const fragmentEntry = list.entries.find((entry) => entry.item.kind === 'mcp-server');
      // The file-tree entry reports at least its payload size live.
      expect(treeEntry?.sizeBytes).toBeGreaterThanOrEqual(1000);
      // The fragment entry records 0 payload bytes but its item directory
      // still occupies space — the live du reports it.
      expect(fragmentEntry?.item.sizeBytes).toBe(0);
      expect(fragmentEntry?.sizeBytes).toBeGreaterThan(0);
      expect(list.totalSizeBytes).toBe(
        list.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      );
    });

    it('returns zeros for an empty bin', async () => {
      const appHome = await makeAppHome();

      const list = await listRecoveryBinWithSizes(appHome);

      expect(list.entries).toEqual([]);
      expect(list.totalSizeBytes).toBe(0);
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
