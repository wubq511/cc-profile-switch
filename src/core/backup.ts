import fs from 'fs-extra';
import path from 'node:path';

import { resolveInside, validateProfileName } from '../platform/path';
import { CcpsError } from '../utils/errors';
import { ensureAppHomeStructure, getAppHomePaths, type Clock } from './app-config';
import { computeDirectorySize } from './recovery-bin';

/**
 * Profile Backup service (spec §9.2): the durable store. Backups never expire
 * automatically and restoring never consumes them (§9.3). `backupProfile`
 * (create) lives in ./profile with the other profile-lifecycle operations;
 * this module holds the listing and restore side of the contract.
 */

/**
 * Backup directory names are `<profile>-<yyyymmdd>-<hhmmss>` (see
 * getBackupPath in ./profile). Profile names may themselves contain hyphens,
 * so the profile prefix is the greedy match before the final timestamp.
 */
const BACKUP_ID_PATTERN = /^(?<profile>.+)-(?<timestamp>\d{8}-\d{6})$/;

export type BackupEntry = {
  /** Backup directory name, e.g. "coding-20260516-142530". */
  id: string;
  /** Profile the backup was taken from, parsed from the id. */
  profileName: string;
  /** Absolute path to the backup directory inside backups/. */
  backupPath: string;
  /** Live du-style size of the backup directory, in bytes. */
  sizeBytes: number;
};

export type BackupList = {
  entries: BackupEntry[];
  totalSizeBytes: number;
};

export type RestoreProfileFromBackupOptions = {
  appHomePath?: string;
  /** Backup directory name (see `ccps backup list`), e.g. "coding-20260516-142530". */
  backupId: string;
  /**
   * Restore as a new profile name instead of replacing the recorded profile.
   * An existing profile with that name is a collision and is refused (§9.3).
   */
  newName?: string;
  clock?: Clock;
};

export type RestoreProfileFromBackupResult = {
  restoredProfile: string;
  backupPath: string;
  restoredToPath: string;
  /**
   * Durable auto-backup of the pre-restore profile state (§6.2: restoring
   * auto-backs-up current state first). Null when the target profile did not
   * exist before the restore.
   */
  preRestoreBackupPath: string | null;
};

/**
 * §9.5 Backup listing: per-entry sizes computed du-style at listing time,
 * plus a total. Only directories matching the ccps backup-id shape are
 * listed; unrelated residue in backups/ is ignored.
 */
export async function listBackups(appHomePath?: string): Promise<BackupList> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  const { backupsPath } = getAppHomePaths(resolved);

  if (!(await fs.pathExists(backupsPath))) {
    return { entries: [], totalSizeBytes: 0 };
  }

  const dirents = await fs.readdir(backupsPath, { withFileTypes: true });
  const entries: BackupEntry[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const match = BACKUP_ID_PATTERN.exec(dirent.name);
    if (match?.groups === undefined) continue;
    const backupPath = path.join(backupsPath, dirent.name);
    entries.push({
      id: dirent.name,
      profileName: match.groups.profile,
      backupPath,
      sizeBytes: await computeDirectorySize(backupPath),
    });
  }

  entries.sort((left, right) => left.id.localeCompare(right.id));
  return {
    entries,
    totalSizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  };
}

/**
 * Restore a profile from a durable Backup (§6.2, §9.2, §9.3).
 *
 * - The backup itself is never consumed: content is copied back, the backup
 *   directory stays untouched.
 * - Restoring over an existing profile auto-backs-up its current state first
 *   (a durable Backup is the safety net), then replaces the profile through a
 *   rename swap.
 * - With `newName` the backup lands as a new profile; an existing profile
 *   with that name is refused (§9.3 collision default: refuse).
 *
 * Everything stays inside the app home (profiles/, backups/); the real user
 * Claude directory is never involved.
 */
export async function restoreProfileFromBackup(
  options: RestoreProfileFromBackupOptions,
): Promise<RestoreProfileFromBackupResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { backupsPath, profilesPath } = getAppHomePaths(appHomePath);

  const idMatch = BACKUP_ID_PATTERN.exec(options.backupId);
  if (idMatch?.groups === undefined) {
    throw new CcpsError('BACKUP_INVALID_ID', 'Backup id is not a ccps backup directory name.', {
      guidance: 'List backups with: ccps backup list',
    });
  }

  const backupDir = resolveInside(backupsPath, options.backupId);
  const backupStats = await fs.stat(backupDir).catch(() => null);
  if (backupStats === null || !backupStats.isDirectory()) {
    throw new CcpsError('BACKUP_NOT_FOUND', 'Backup does not exist.', {
      guidance: 'List backups with: ccps backup list',
    });
  }

  const recordedProfile = validateProfileName(idMatch.groups.profile);
  const targetName =
    options.newName !== undefined ? validateProfileName(options.newName) : recordedProfile;
  const targetDir = resolveInside(profilesPath, targetName);

  let preRestoreBackupPath: string | null = null;

  if (await fs.pathExists(targetDir)) {
    if (options.newName !== undefined) {
      throw new CcpsError('RESTORE_COLLISION', 'A profile already exists with the new name.', {
        guidance: 'Choose a different --new-name, or restore over the recorded profile.',
      });
    }

    // §6.2: auto-back-up current state before replacing it. Durable, never
    // auto-expires — this is the safety net for the replace.
    preRestoreBackupPath = await createSafetyBackup(appHomePath, targetName, options.clock);

    await swapReplaceDirectory(backupDir, targetDir, profilesPath);
  } else {
    // Copy, never move: the backup is not consumed (§9.2).
    await fs.copy(backupDir, targetDir, { overwrite: false, errorOnExist: true });
  }

  return {
    restoredProfile: targetName,
    backupPath: backupDir,
    restoredToPath: targetDir,
    preRestoreBackupPath,
  };
}

/**
 * §9.5/S116 permanent deletion of a single durable Backup. There is no safety
 * net and the backup is NOT recoverable afterwards — callers must surface the
 * "permanent and unrecoverable" confirmation copy before invoking this. Only
 * directories matching the ccps backup-id shape are ever touched; unrelated
 * residue in backups/ is ignored, as in listBackups.
 */
export async function permanentlyDeleteBackup(
  backupId: string,
  appHomePath?: string,
): Promise<void> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  const { backupsPath } = getAppHomePaths(resolved);

  const idMatch = BACKUP_ID_PATTERN.exec(backupId);
  if (idMatch?.groups === undefined) {
    throw new CcpsError('BACKUP_INVALID_ID', 'Backup id is not a ccps backup directory name.', {
      guidance: 'List backups with: ccps backup list',
    });
  }

  const backupDir = resolveInside(backupsPath, backupId);
  const stats = await fs.stat(backupDir).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw new CcpsError('BACKUP_NOT_FOUND', 'Backup does not exist.', {
      guidance: 'List backups with: ccps backup list',
    });
  }

  await fs.remove(backupDir);
}

/**
 * Durable auto-backup of the pre-restore state. Uses the same
 * `<profile>-<yyyymmdd>-<hhmmss>` naming as backupProfile (./profile) but
 * resolves same-second collisions with a counter suffix, following the
 * Recovery Bin id convention: a restore run in the same second an earlier
 * backup was taken must never target — and with `errorOnExist` partially copy
 * into — an existing backup directory.
 */
async function createSafetyBackup(
  appHomePath: string,
  profileName: string,
  clock?: Clock,
): Promise<string> {
  const appPaths = await ensureAppHomeStructure(appHomePath);
  const profileRoot = resolveInside(appPaths.profilesPath, validateProfileName(profileName));

  const timestamp = formatBackupTimestamp((clock ?? (() => new Date()))());
  const baseName = `${validateProfileName(profileName)}-${timestamp}`;
  let dirName = baseName;
  let counter = 2;
  while (await fs.pathExists(resolveInside(appPaths.backupsPath, dirName))) {
    dirName = `${baseName}-${counter}`;
    counter++;
  }

  const backupDir = resolveInside(appPaths.backupsPath, dirName);
  await fs.copy(profileRoot, backupDir, { overwrite: false, errorOnExist: true });
  return backupDir;
}

/** UTC timestamp in the backup-id format (`yyyymmdd-hhmmss`), as in ./profile. */
function formatBackupTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Replace targetDir with a copy of sourceDir via rename swap inside the same
 * partition (the §7.1 transaction pattern): stage as .ccps-tmp-*, move the
 * old tree aside as .ccps-old-*, land the new tree, then drop the old one.
 * No in-place rewrite; a crash mid-swap leaves the old tree recoverable next
 * to the profile, and the pre-restore auto-backup is the durable net.
 */
async function swapReplaceDirectory(
  sourceDir: string,
  targetDir: string,
  parentDir: string,
): Promise<void> {
  const base = path.basename(targetDir);
  const tmpDir = resolveInside(parentDir, `.ccps-tmp-restore-${base}`);
  const oldDir = resolveInside(parentDir, `.ccps-old-restore-${base}`);

  // Clear residue from a previously crashed restore before staging.
  await fs.remove(tmpDir);
  await fs.remove(oldDir);

  await fs.copy(sourceDir, tmpDir, { overwrite: false, errorOnExist: true });
  await fs.rename(targetDir, oldDir);
  await fs.rename(tmpDir, targetDir);
  await fs.remove(oldDir);
}
