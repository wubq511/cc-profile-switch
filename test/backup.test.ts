import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { listBackups, permanentlyDeleteBackup, restoreProfileFromBackup } from '../src/core/backup';
import { backupProfile } from '../src/core/profile';
import { createProfileFromTemplate } from '../src/core/profile-template';

describe('Profile Backup service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-backup-'));
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

  const backupClock = () => new Date('2026-08-01T10:00:00Z');
  const restoreClock = () => new Date('2026-08-02T11:30:00Z');

  // ─── listBackups ──────────────────────────────────────────────────────

  describe('listBackups', () => {
    it('returns an empty list when the backups directory does not exist', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ccps-backup-'));
      tempRoots.push(root);
      const appHome = join(root, '.cc-profile-switch');

      const list = await listBackups(appHome);

      expect(list.entries).toEqual([]);
      expect(list.totalSizeBytes).toBe(0);
    });

    it('lists backups with parsed profile names and live sizes plus a total', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');

      await backupProfile({ appHomePath: appHome, name: 'coding', clock: backupClock });
      await backupProfile({ appHomePath: appHome, name: 'study', clock: backupClock });

      const list = await listBackups(appHome);

      expect(list.entries.map((entry) => entry.id)).toEqual([
        'coding-20260801-100000',
        'study-20260801-100000',
      ]);
      expect(list.entries[0].profileName).toBe('coding');
      expect(list.entries[0].sizeBytes).toBeGreaterThan(0);
      expect(list.entries[1].sizeBytes).toBeGreaterThan(0);
      expect(list.totalSizeBytes).toBe(
        list.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      );
    });

    it('parses hyphenated profile names from backup ids', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'my-profile');
      await backupProfile({ appHomePath: appHome, name: 'my-profile', clock: backupClock });

      const list = await listBackups(appHome);

      expect(list.entries).toHaveLength(1);
      expect(list.entries[0].id).toBe('my-profile-20260801-100000');
      expect(list.entries[0].profileName).toBe('my-profile');
    });

    it('ignores directories that are not ccps backups', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await backupProfile({ appHomePath: appHome, name: 'coding', clock: backupClock });

      const { backupsPath } = getAppHomePaths(appHome);
      await fs.ensureDir(join(backupsPath, 'not-a-backup'));
      await fs.ensureDir(join(backupsPath, '.ccps-tmp-scratch'));

      const list = await listBackups(appHome);

      expect(list.entries.map((entry) => entry.id)).toEqual(['coding-20260801-100000']);
    });
  });

  // ─── restoreProfileFromBackup ─────────────────────────────────────────

  describe('restoreProfileFromBackup', () => {
    it('restores into a missing profile without an auto-backup and keeps the backup', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const { backupPath } = await backupProfile({
        appHomePath: appHome,
        name: 'coding',
        clock: backupClock,
      });
      const backupClaudeMd = await fs.readFile(
        join(backupPath, 'claude-home', 'CLAUDE.md'),
        'utf8',
      );

      // Simulate a profile that no longer exists (e.g. removed earlier).
      await fs.remove(profileDir);

      const result = await restoreProfileFromBackup({
        appHomePath: appHome,
        backupId: 'coding-20260801-100000',
        clock: restoreClock,
      });

      expect(result.restoredProfile).toBe('coding');
      expect(result.preRestoreBackupPath).toBeNull();
      expect(await fs.pathExists(profileDir)).toBe(true);
      await expect(fs.readFile(join(profileDir, 'claude-home', 'CLAUDE.md'), 'utf8')).resolves.toBe(
        backupClaudeMd,
      );

      // The backup is never consumed.
      expect(await fs.pathExists(backupPath)).toBe(true);
    });

    it('auto-backs-up current state first when restoring over an existing profile', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const { backupPath } = await backupProfile({
        appHomePath: appHome,
        name: 'coding',
        clock: backupClock,
      });
      const backupClaudeMd = await fs.readFile(
        join(backupPath, 'claude-home', 'CLAUDE.md'),
        'utf8',
      );

      // Mutate the live profile after the backup was taken.
      const claudeMdPath = join(profileDir, 'claude-home', 'CLAUDE.md');
      await fs.writeFile(claudeMdPath, 'MUTATED STATE', 'utf8');
      await fs.writeFile(join(profileDir, 'mutated-marker.txt'), 'x', 'utf8');

      const result = await restoreProfileFromBackup({
        appHomePath: appHome,
        backupId: 'coding-20260801-100000',
        clock: restoreClock,
      });

      // §6.2: the pre-restore state was auto-backed-up first (durable).
      expect(result.preRestoreBackupPath).not.toBeNull();
      const preRestoreBackupPath = result.preRestoreBackupPath as string;
      await expect(
        fs.readFile(join(preRestoreBackupPath, 'claude-home', 'CLAUDE.md'), 'utf8'),
      ).resolves.toBe('MUTATED STATE');
      await expect(fs.pathExists(join(preRestoreBackupPath, 'mutated-marker.txt'))).resolves.toBe(
        true,
      );

      // The profile now holds the backup content again.
      await expect(fs.readFile(claudeMdPath, 'utf8')).resolves.toBe(backupClaudeMd);
      await expect(fs.pathExists(join(profileDir, 'mutated-marker.txt'))).resolves.toBe(false);

      // §9.2/§9.3: the source backup was never consumed.
      expect(await fs.pathExists(backupPath)).toBe(true);
      await expect(fs.readFile(join(backupPath, 'claude-home', 'CLAUDE.md'), 'utf8')).resolves.toBe(
        backupClaudeMd,
      );

      // No swap residue survives inside profiles/.
      const { profilesPath } = getAppHomePaths(appHome);
      const profileEntries = await fs.readdir(profilesPath);
      expect(profileEntries.filter((name) => name.startsWith('.ccps-'))).toEqual([]);
    });

    it('can restore the same backup twice — restoring never consumes it', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await backupProfile({ appHomePath: appHome, name: 'coding', clock: backupClock });

      const first = await restoreProfileFromBackup({
        appHomePath: appHome,
        backupId: 'coding-20260801-100000',
        newName: 'coding-one',
        clock: restoreClock,
      });
      const second = await restoreProfileFromBackup({
        appHomePath: appHome,
        backupId: 'coding-20260801-100000',
        newName: 'coding-two',
        clock: restoreClock,
      });

      const { profilesPath } = getAppHomePaths(appHome);
      expect(first.restoredProfile).toBe('coding-one');
      expect(second.restoredProfile).toBe('coding-two');
      expect(await fs.pathExists(join(profilesPath, 'coding-one', 'profile.json'))).toBe(true);
      expect(await fs.pathExists(join(profilesPath, 'coding-two', 'profile.json'))).toBe(true);
      expect(await fs.pathExists(join(profilesPath, 'coding', 'profile.json'))).toBe(true);
    });

    it('refuses restore-as-new-name when the new name already exists', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const focusDir = await makeProfile(appHome, 'focus');
      await backupProfile({ appHomePath: appHome, name: 'coding', clock: backupClock });
      const focusClaudeMd = await fs.readFile(join(focusDir, 'claude-home', 'CLAUDE.md'), 'utf8');

      await expect(
        restoreProfileFromBackup({
          appHomePath: appHome,
          backupId: 'coding-20260801-100000',
          newName: 'focus',
          clock: restoreClock,
        }),
      ).rejects.toMatchObject({ code: 'RESTORE_COLLISION' });

      // Nothing changed: the colliding profile is intact and no auto-backup ran.
      await expect(fs.readFile(join(focusDir, 'claude-home', 'CLAUDE.md'), 'utf8')).resolves.toBe(
        focusClaudeMd,
      );
      const list = await listBackups(appHome);
      expect(list.entries).toHaveLength(1);
    });

    it('auto-backs-up to a suffixed directory when the second collides, never touching the source backup', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      const { backupPath } = await backupProfile({
        appHomePath: appHome,
        name: 'coding',
        clock: backupClock,
      });

      // Mutate the live profile, then restore with the SAME clock second the
      // source backup was taken — the naive auto-backup name would collide.
      await fs.writeFile(join(profileDir, 'mutated-marker.txt'), 'x', 'utf8');

      const result = await restoreProfileFromBackup({
        appHomePath: appHome,
        backupId: 'coding-20260801-100000',
        clock: backupClock,
      });

      expect(result.preRestoreBackupPath).not.toBeNull();
      const preRestoreBackupPath = result.preRestoreBackupPath as string;
      expect(preRestoreBackupPath).not.toBe(backupPath);
      expect(path.basename(preRestoreBackupPath)).toBe('coding-20260801-100000-2');
      await expect(fs.pathExists(join(preRestoreBackupPath, 'mutated-marker.txt'))).resolves.toBe(
        true,
      );

      // The source backup stayed byte-clean: no pollution from the replace.
      await expect(fs.pathExists(join(backupPath, 'mutated-marker.txt'))).resolves.toBe(false);
    });

    it('rejects an unknown backup id', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        restoreProfileFromBackup({
          appHomePath: appHome,
          backupId: 'coding-20990101-000000',
          clock: restoreClock,
        }),
      ).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    });

    it('rejects a malformed backup id', async () => {
      const appHome = await makeAppHome();

      await expect(
        restoreProfileFromBackup({
          appHomePath: appHome,
          backupId: 'not-a-backup-id',
          clock: restoreClock,
        }),
      ).rejects.toMatchObject({ code: 'BACKUP_INVALID_ID' });
    });

    it('blocks backup ids that escape the backups directory', async () => {
      const appHome = await makeAppHome();

      await expect(
        restoreProfileFromBackup({
          appHomePath: appHome,
          backupId: '../escape-20260801-100000',
          clock: restoreClock,
        }),
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_BASE' });
    });
  });

  // ─── permanentlyDeleteBackup ──────────────────────────────────────────

  describe('permanentlyDeleteBackup', () => {
    it('removes the backup directory permanently and unrecoverably', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const { backupPath } = await backupProfile({
        appHomePath: appHome,
        name: 'coding',
        clock: backupClock,
      });

      await permanentlyDeleteBackup('coding-20260801-100000', appHome);

      expect(await fs.pathExists(backupPath)).toBe(false);
      expect((await listBackups(appHome)).entries).toHaveLength(0);
    });

    it('rejects a malformed backup id', async () => {
      const appHome = await makeAppHome();

      await expect(permanentlyDeleteBackup('not-a-backup-id', appHome)).rejects.toMatchObject({
        code: 'BACKUP_INVALID_ID',
      });
    });

    it('rejects a missing backup', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        permanentlyDeleteBackup('coding-20990101-000000', appHome),
      ).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' });
    });

    it('blocks backup ids that escape the backups directory', async () => {
      const appHome = await makeAppHome();

      await expect(
        permanentlyDeleteBackup('../escape-20260801-100000', appHome),
      ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_BASE' });
    });
  });
});
