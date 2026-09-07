import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import {
  allocateBackupDirPath,
  createBackupStagingDir,
  listBackups,
  parseBackupId,
  permanentlyDeleteBackup,
  publishBackupWithCollisionRetry,
  restoreProfileFromBackup,
} from '../src/core/backup';
import { validateProfile } from '../src/core/validator';
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

      // The strict protocol rejects the traversal-shaped id outright; the
      // traversal can never reach resolveInside.
      await expect(
        restoreProfileFromBackup({
          appHomePath: appHome,
          backupId: '../escape-20260801-100000',
          clock: restoreClock,
        }),
      ).rejects.toMatchObject({ code: 'BACKUP_INVALID_ID' });
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

      // The strict protocol rejects the traversal-shaped id outright; the
      // traversal can never reach resolveInside.
      await expect(
        permanentlyDeleteBackup('../escape-20260801-100000', appHome),
      ).rejects.toMatchObject({ code: 'BACKUP_INVALID_ID' });
    });
  });

  // ─── Backup ID protocol — same-second ids, #107 ───────────────────────

  describe('Backup ID protocol (#107)', () => {
    it('lists, restores, and deletes a same-second suffixed backup id end to end', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'alpha');
      const { backupsPath } = getAppHomePaths(appHome);
      await backupProfile({ appHomePath: appHome, name: 'alpha', clock: backupClock });

      // Second backup in the SAME second through the shared protocol: the
      // allocator produces a suffixed id and staging→atomic-rename publish
      // lands it as a first-class backup. (The normal `ccps backup` create
      // path is wired in ./profile; this exercises the protocol directly.)
      const secondTarget = await allocateBackupDirPath(backupsPath, 'alpha', backupClock);
      expect(path.basename(secondTarget)).toBe('alpha-20260801-100000-2');
      const secondStaging = await createBackupStagingDir(backupsPath);
      await fs.copy(
        join(getAppHomePaths(appHome).profilesPath, 'alpha'),
        secondStaging,
        { overwrite: false, errorOnExist: true },
      );
      const published = await publishBackupWithCollisionRetry(
        secondStaging,
        secondTarget,
        backupsPath,
        'alpha',
        backupClock,
      );
      expect(published).toBe(secondTarget);
      expect(await fs.pathExists(secondStaging)).toBe(false);

      const list = await listBackups(appHome);
      expect(list.entries.map((entry) => entry.id)).toEqual([
        'alpha-20260801-100000',
        'alpha-20260801-100000-2',
      ]);
      expect(list.entries[1].sizeBytes).toBeGreaterThan(0);
      expect(list.totalSizeBytes).toBe(
        list.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      );

      // The suffixed backup restores the content it captured (restoring into
      // a fresh name proves its own snapshot, not a mix with the first).
      const secondBackupClaudeMd = await fs.readFile(
        join(backupsPath, 'alpha-20260801-100000-2', 'claude-home', 'CLAUDE.md'),
        'utf8',
      );
      const restored = await restoreProfileFromBackup({
        appHomePath: appHome,
        backupId: 'alpha-20260801-100000-2',
        newName: 'from-second',
        clock: restoreClock,
      });
      expect(restored.restoredProfile).toBe('from-second');
      await expect(
        fs.readFile(
          join(restored.restoredToPath, 'claude-home', 'CLAUDE.md'),
          'utf8',
        ),
      ).resolves.toBe(secondBackupClaudeMd);

      // Delete removes exactly the selected suffixed item.
      await permanentlyDeleteBackup('alpha-20260801-100000-2', appHome);
      const afterDelete = await listBackups(appHome);
      expect(afterDelete.entries.map((entry) => entry.id)).toEqual(['alpha-20260801-100000']);
    });

    it('parses hyphenated profile names and timestamp-like segments without mistaking them for counters', () => {
      expect(parseBackupId('my-profile-20260801-100000')).toEqual({
        profileName: 'my-profile',
        timestamp: '20260801-100000',
        counter: null,
      });
      expect(parseBackupId('my-profile-20260801-100000-7')).toEqual({
        profileName: 'my-profile',
        timestamp: '20260801-100000',
        counter: 7,
      });
      // A profile whose own name ends in a timestamp-like segment: the final
      // timestamp is the anchor, the earlier segment belongs to the profile.
      expect(parseBackupId('release-20260801-999999-20260801-100000-3')).toEqual({
        profileName: 'release-20260801-999999',
        timestamp: '20260801-100000',
        counter: 3,
      });
    });

    it('rejects traversal and malformed ids in the shared parser', () => {
      expect(() => parseBackupId('../escape-20260801-100000')).toThrowError();
      expect(() => parseBackupId('coding-20260801')).toThrowError();
      expect(() => parseBackupId('coding')).toThrowError();
      expect(() => parseBackupId('coding-20260801-100000-')).toThrowError();
      expect(() => parseBackupId('coding-20260801-100000-2-3')).toThrowError();
    });

    it('two normal backups in the same second produce distinct listable ids (#107 AC: normal + safety unified)', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'alpha');
      await backupProfile({ appHomePath: appHome, name: 'alpha', clock: backupClock });
      // Second normal backup in the SAME second: backupProfile now uses the
      // shared protocol, so the suffix is allocated instead of colliding.
      await backupProfile({ appHomePath: appHome, name: 'alpha', clock: backupClock });

      const list = await listBackups(appHome);
      expect(list.entries.map((entry) => entry.id)).toEqual([
        'alpha-20260801-100000',
        'alpha-20260801-100000-2',
      ]);

      // Both entries are first-class: restorable through the shared protocol.
      const restored = await restoreProfileFromBackup({
        appHomePath: appHome,
        backupId: 'alpha-20260801-100000-2',
        newName: 'from-second-normal',
        clock: restoreClock,
      });
      expect(restored.restoredProfile).toBe('from-second-normal');

      // And deletion removes exactly the selected suffixed item.
      await permanentlyDeleteBackup('alpha-20260801-100000-2', appHome);
      expect((await listBackups(appHome)).entries.map((entry) => entry.id)).toEqual([
        'alpha-20260801-100000',
      ]);
    });

    it('reports the RESOLVED publish id when a concurrent writer forces a collision (review P1-1)', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'alpha');
      const { backupsPath } = getAppHomePaths(appHome);

      // Pre-claim the base id the way a concurrent winner would, then make
      // the allocator hand out the same (now occupied) id anyway by racing
      // the two calls: one of them loses and must publish under -2.
      const [first, second] = await Promise.all([
        backupProfile({ appHomePath: appHome, name: 'alpha', clock: backupClock }),
        backupProfile({ appHomePath: appHome, name: 'alpha', clock: backupClock }),
      ]);

      // Each result's backupPath is a real, distinct directory that holds
      // that caller's OWN payload — never the winner's content.
      expect(first.backupPath).not.toBe(second.backupPath);
      for (const result of [first, second]) {
        expect(await fs.pathExists(join(result.backupPath, 'claude-home', 'CLAUDE.md'))).toBe(
          true,
        );
      }
      const ids = (await listBackups(appHome)).entries.map((entry) => ({
        id: entry.id,
        backupPath: entry.backupPath,
      }));
      for (const result of [first, second]) {
        const match = ids.find((entry) => entry.backupPath === result.backupPath);
        expect(match).toBeDefined();
      }

      // A stray FILE squatting on an id also forces a retry; the reported
      // path must be the real directory, not the file. Which id the second
      // racer published under depends on the race outcome, so the file is
      // placed on the currently-lowest listed id, and the third backup must
      // land on the id the ALLOCATOR itself resolves past the squat (the
      // production truth), never on the squatting file's path.
      const secondListed = (await listBackups(appHome)).entries;
      const squatId = secondListed[0]!.id;
      await permanentlyDeleteBackup(squatId, appHome);
      const squattingFile = join(backupsPath, squatId);
      await fs.writeFile(squattingFile, 'not a backup', 'utf8');
      const third = await backupProfile({ appHomePath: appHome, name: 'alpha', clock: backupClock });
      expect(third.backupPath).not.toBe(squattingFile);
      expect(await fs.pathExists(squattingFile)).toBe(true);
      // The reported id is a real directory holding its own payload, and it
      // is listable — the allocator (called again afterwards) skips PAST it,
      // proving the reported id is claimed by this backup on disk.
      expect(await fs.pathExists(join(third.backupPath, 'claude-home', 'CLAUDE.md'))).toBe(true);
      const nextFree = await allocateBackupDirPath(backupsPath, 'alpha', backupClock);
      const thirdId = path.basename(third.backupPath);
      expect(nextFree).not.toBe(third.backupPath);
      const thirdParsed = parseBackupId(thirdId);
      expect(parseBackupId(path.basename(nextFree)).counter).toBe(
        (thirdParsed.counter ?? 1) + 1,
      );
      const list = await listBackups(appHome);
      expect(list.entries.map((entry) => entry.id)).toContain(thirdId);
    });

    it('allocates unique same-second targets and stages-publishes without mixing writers', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'alpha');
      const { backupsPath } = getAppHomePaths(appHome);

      // Two allocator rounds in the same second each get a fresh id; the
      // first publish then claims its id on disk and the next allocator
      // moves past it — no allocation ever targets existing content.
      const firstTarget = await allocateBackupDirPath(backupsPath, 'alpha', backupClock);
      expect(path.basename(firstTarget)).toBe('alpha-20260801-100000');

      const staging = await createBackupStagingDir(backupsPath);
      await fs.writeFile(join(staging, 'payload.txt'), 'first', 'utf8');
      const published = await publishBackupWithCollisionRetry(
        staging,
        firstTarget,
        backupsPath,
        'alpha',
        backupClock,
      );
      expect(published).toBe(firstTarget);
      expect(await fs.pathExists(firstTarget)).toBe(true);

      const secondTarget = await allocateBackupDirPath(backupsPath, 'alpha', backupClock);
      expect(path.basename(secondTarget)).toBe('alpha-20260801-100000-2');
      expect(secondTarget).not.toBe(firstTarget);

      // The published backup is immediately first-class: listed, parseable,
      // deletable through the shared protocol.
      const list = await listBackups(appHome);
      expect(list.entries.map((entry) => entry.id)).toEqual(['alpha-20260801-100000']);
      await permanentlyDeleteBackup('alpha-20260801-100000', appHome);
      expect((await listBackups(appHome)).entries).toEqual([]);
    });

    it('concurrent same-second allocations never share a target', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'alpha');
      const { backupsPath } = getAppHomePaths(appHome);

      // Two writers allocate in the same second, then both stage and publish
      // through the real protocol. The atomic rename is the arbiter: the id
      // that lands first wins, the loser's rename fails and retries under the
      // next counter id — no overwrite, no mix.
      const [left, right] = await Promise.all([
        allocateBackupDirPath(backupsPath, 'alpha', backupClock),
        allocateBackupDirPath(backupsPath, 'alpha', backupClock),
      ]);

      const stageFor = async (marker: string): Promise<string> => {
        const staging = await createBackupStagingDir(backupsPath);
        await fs.writeFile(join(staging, 'marker.txt'), marker, 'utf8');
        return staging;
      };
      const publish = async (staging: string, target: string): Promise<string> =>
        publishBackupWithCollisionRetry(staging, target, backupsPath, 'alpha', backupClock);

      const leftStaging = await stageFor('left');
      const rightStaging = await stageFor('right');
      const [leftFinal, rightFinal] = await Promise.all([
        publish(leftStaging, left),
        publish(rightStaging, right),
      ]);

      // Each result reports the id its own payload actually occupies.
      expect(await fs.readFile(join(leftFinal, 'marker.txt'), 'utf8')).toBe('left');
      expect(await fs.readFile(join(rightFinal, 'marker.txt'), 'utf8')).toBe('right');
      expect(leftFinal).not.toBe(rightFinal);
      const ids = (await listBackups(appHome)).entries.map((entry) => entry.id).sort();
      expect(ids).toEqual(['alpha-20260801-100000', 'alpha-20260801-100000-2']);
    });

    it('staging directories are not listed as backups and carry the reconciled tmp prefix', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const { backupsPath } = getAppHomePaths(appHome);
      await createBackupStagingDir(backupsPath);

      const list = await listBackups(appHome);
      expect(list.entries).toEqual([]);
    });

    it('restore-as-new-name applies the identity repair — new name, auto memory, rule, excludes, and clean Validate', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'alpha');
      // User customization that must survive the restore.
      const alphaSettingsPath = join(
        getAppHomePaths(appHome).profilesPath,
        'alpha',
        'claude-home',
        'settings.json',
      );
      const alphaSettings = await fs.readJson(alphaSettingsPath);
      await fs.writeJson(alphaSettingsPath, {
        ...alphaSettings,
        customUserKey: { keep: true },
      });

      await backupProfile({ appHomePath: appHome, name: 'alpha', clock: backupClock });

      const result = await restoreProfileFromBackup({
        appHomePath: appHome,
        backupId: 'alpha-20260801-100000',
        newName: 'beta',
        clock: restoreClock,
      });

      expect(result.restoredProfile).toBe('beta');
      const betaRoot = join(getAppHomePaths(appHome).profilesPath, 'beta');
      expect(await fs.pathExists(join(betaRoot, 'profile.json'))).toBe(true);

      const betaProfileJson = await fs.readJson(join(betaRoot, 'profile.json'));
      expect(betaProfileJson.name).toBe('beta');

      const betaSettings = await fs.readJson(join(betaRoot, 'claude-home', 'settings.json'));
      expect(betaSettings.autoMemoryDirectory).toBe(join(betaRoot, 'claude-home', 'memory', 'auto'));
      expect(betaSettings.customUserKey).toEqual({ keep: true });

      await expect(
        fs.readFile(join(betaRoot, 'claude-home', 'memory', 'auto', 'MEMORY.md'), 'utf8'),
      ).resolves.toContain('# beta Auto Memory');

      await expect(
        fs.readFile(join(betaRoot, 'claude-home', 'rules', 'ccps-profile.md'), 'utf8'),
      ).resolves.toContain('ccps-managed-profile-boundary:start:v2');

      const launchValidation = await validateProfile({ appHomePath: appHome, name: 'beta' });
      expect(launchValidation.findings.map((finding) => finding.code)).not.toContain(
        'PROFILE_MEMORY_DIRECTORY_MISMATCH',
      );
    });

    it('a pre-publish failure occupies neither the target name nor the listing', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'alpha');
      await backupProfile({ appHomePath: appHome, name: 'alpha', clock: backupClock });

      // Corrupt the backup so the identity repair refuses it: profile.json gone.
      const { backupsPath } = getAppHomePaths(appHome);
      await fs.remove(join(backupsPath, 'alpha-20260801-100000', 'profile.json'));

      await expect(
        restoreProfileFromBackup({
          appHomePath: appHome,
          backupId: 'alpha-20260801-100000',
          newName: 'beta',
          clock: restoreClock,
        }),
      ).rejects.toMatchObject({ code: 'PROFILE_IDENTITY_REPAIR_FAILED' });

      // No beta profile, no staging residue in profiles/.
      const { profilesPath } = getAppHomePaths(appHome);
      expect(await fs.pathExists(join(profilesPath, 'beta'))).toBe(false);
      const residue = (await fs.readdir(profilesPath)).filter((name) => name.startsWith('.ccps-'));
      expect(residue).toEqual([]);
    });
  });
});
