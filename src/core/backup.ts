import fs from 'fs-extra';
import path from 'node:path';

import { resolveInside, validateProfileName } from '../platform/path';
import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';
import { ensureAppHomeStructure, getAppHomePaths, type Clock } from './app-config';
import { computeDirectorySize } from './recovery-bin';
import { repairProfileIdentity } from './profile-identity';

/**
 * Profile Backup service (spec §9.2): the durable store. Backups never expire
 * automatically and restoring never consumes them (§9.3). This module also
 * owns the shared Backup ID protocol (issue #107): the same allocate/parse
 * rules serve create, list, restore, and delete, for both normal backups
 * (./profile) and pre-restore safety backups.
 */

/**
 * Backup directory names are `<profile>-<yyyymmdd>-<hhmmss>`, with an
 * optional `-<counter>` same-second suffix (e.g. `...-100000-2`). Profile
 * names may themselves contain hyphens and timestamp-like segments, so the
 * profile prefix is the greedy match before the final timestamp, and the
 * counter must come strictly after a complete timestamp — a hyphenated
 * profile name never parses as a counter.
 */
const BACKUP_ID_PATTERN = /^(?<profile>.+)-(?<timestamp>\d{8}-\d{6})(?:-(?<counter>\d+))?$/;

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

// ─── Backup ID protocol (issue #107) ────────────────────────────────────

export type ParsedBackupId = {
  profileName: string;
  timestamp: string;
  /** Same-second counter suffix, or null for the plain timestamp id. */
  counter: number | null;
};

/**
 * Parse a backup id into its profile name, timestamp, and optional same-second
 * counter. The one shared rule behind list, restore, and delete; the allocator
 * below only ever emits ids this parser accepts, so any id a backup operation
 * returned round-trips through every other operation. Traversal (path
 * separators, `..`) never matches the strict pattern and is rejected before
 * resolveInside can be misled.
 */
export function parseBackupId(backupId: string): ParsedBackupId {
  const parsed = tryParseBackupId(backupId);
  if (parsed === null) {
    throw backupIdInvalid();
  }
  return parsed;
}

/** Non-throwing variant used by listing, where unmatched names are skipped. */
function tryParseBackupId(backupId: string): ParsedBackupId | null {
  // Traversal and separator payloads never name a backup directory; reject
  // them here so the protocol cannot be talked past resolveInside.
  if (backupId.includes('/') || backupId.includes('\\') || backupId.includes('\0')) {
    return null;
  }
  const match = BACKUP_ID_PATTERN.exec(backupId);
  if (match?.groups === undefined) {
    return null;
  }
  return {
    profileName: match.groups.profile ?? '',
    timestamp: match.groups.timestamp ?? '',
    counter: match.groups.counter === undefined ? null : Number(match.groups.counter),
  };
}

function backupIdInvalid(): CcpsError {
  return new CcpsError('BACKUP_INVALID_ID', 'Backup id is not a ccps backup directory name.', {
    guidance: 'List backups with: ccps backup list',
  });
}

/**
 * The id a backup allocator would emit for this profile/timestamp/counter —
 * used by tests to predict same-second suffixes and by the allocator itself.
 */
export function formatBackupId(profileName: string, timestamp: string, counter?: number): string {
  const base = `${profileName}-${timestamp}`;
  return counter === undefined ? base : `${base}-${counter}`;
}

/** UTC timestamp in the backup-id format (`yyyymmdd-hhmmss`). */
export function formatBackupTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Unique target directory for a new backup (issue #107): start from the
 * `<profile>-<yyyymmdd>-<hhmmss>` id, then retry with `-2`, `-3`, … counters
 * while any same-second sibling exists. Only directories a parser-identical
 * backup occupies claim the id — unrelated residue is not treated as a
 * collision. The allocator never returns a path whose id already exists, so
 * a concurrent allocator cannot be handed a target that would overwrite or
 * mix into another writer's backup; the caller must create the directory with
 * exclusive semantics (errorOnExist) so losing a race surfaces as an error
 * instead of clobbering the winner.
 */
export async function allocateBackupDirPath(
  backupsPath: string,
  profileName: string,
  clock: Clock,
): Promise<string> {
  const safeName = validateProfileName(profileName);
  const timestamp = formatBackupTimestamp(clock());
  const baseId = formatBackupId(safeName, timestamp);

  let id = baseId;
  let counter = 2;
  while (await backupIdTaken(backupsPath, id)) {
    id = formatBackupId(safeName, timestamp, counter);
    counter++;
  }
  return resolveInside(backupsPath, id);
}

/**
 * Publish a staged backup under the allocated id, retrying the ALLOCATION
 * (never the copy) when a concurrent writer claimed the id between
 * allocation and publish (issue #107: a publish collision only changes the
 * id — it must not overwrite or mix into another writer's backup). The
 * materialize callback must land the payload EXCLUSIVELY: a directory-level
 * fs.copy with errorOnExist silently MERGES into an existing directory
 * (fs-extra only errors per pre-existing FILE), so create the target
 * directory with an exclusive mkdir first — losing the race surfaces as
 * EEXIST and is retried under the next counter id.
 */
export async function publishBackupWithCollisionRetry(
  stagingDir: string,
  initialTarget: string,
  backupsPath: string,
  profileName: string,
  clock: Clock,
  materialize: (target: string) => Promise<void>,
): Promise<string> {
  const parsed = parseBackupId(path.basename(initialTarget));
  let target = initialTarget;
  let counter = 2;

  for (;;) {
    try {
      await materialize(target);
      return target;
    } catch (error) {
      const code = isNodeError(error) ? error.code : undefined;
      const collision =
        code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR' || code === 'ENOTDIR';
      if (!collision) throw error;
      const timestamp = formatBackupTimestamp(clock());
      target = resolveInside(
        backupsPath,
        formatBackupId(validateProfileName(parsed.profileName), timestamp, counter),
      );
      counter++;
    }
  }
}

async function backupIdTaken(backupsPath: string, id: string): Promise<boolean> {
  const candidate = resolveInside(backupsPath, id);
  const stats = await fs.stat(candidate).catch(() => null);
  // Any existing directory at the allocated id path — including a crashed
  // writer's half copy that matches the id shape — claims the id; the loop
  // moves to the next counter instead of risking a clobber.
  return stats !== null && stats.isDirectory();
}

/**
 * Stage a backup under an id the listing will not recognize (issue #107): the
 * staging directory lives inside backups/ but carries the `.ccps-tmp-*`
 * transaction prefix shared with the §7.1 crash-reconcile sweep, so an
 * interrupted copy is reclaimed (or provably preserved) instead of surfacing
 * as a half-written Backup. Callers copy the payload in with exclusive
 * semantics, then rename to the allocated final id — the rename is the
 * publish point that makes the backup listable.
 */
export async function createBackupStagingDir(backupsPath: string): Promise<string> {
  const stagingDir = resolveInside(
    backupsPath,
    `.ccps-tmp-backup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.ensureDir(stagingDir);
  return stagingDir;
}

/**
 * The staged backup is complete: publish it by renaming the staging directory
 * to the final allocated id. After this commit point the backup is listable.
 */
export async function publishBackupFromStaging(
  stagingDir: string,
  finalDir: string,
): Promise<void> {
  await fs.rename(stagingDir, finalDir);
}

/** Drop an abandoned staging directory (copy failed before publish). */
export async function discardBackupStagingDir(stagingDir: string): Promise<void> {
  await fs.remove(stagingDir);
}

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
    const parsed = tryParseBackupId(dirent.name);
    if (parsed === null) continue;
    const backupPath = path.join(backupsPath, dirent.name);
    entries.push({
      id: dirent.name,
      profileName: parsed.profileName,
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

  const recorded = parseBackupId(options.backupId);

  const backupDir = resolveInside(backupsPath, options.backupId);
  const backupStats = await fs.stat(backupDir).catch(() => null);
  if (backupStats === null || !backupStats.isDirectory()) {
    throw new CcpsError('BACKUP_NOT_FOUND', 'Backup does not exist.', {
      guidance: 'List backups with: ccps backup list',
    });
  }

  const recordedProfile = validateProfileName(recorded.profileName);
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

    await swapReplaceDirectory(backupDir, targetDir, profilesPath, targetName);
  } else {
    // Copy, never move: the backup is not consumed (§9.2). The new-name
    // publish below is the commit point: staging keeps a mid-copy failure
    // from occupying the target name.
    const stagingDir = await createBackupStagingDir(profilesPath);
    try {
      await fs.copy(backupDir, stagingDir, { overwrite: false, errorOnExist: true });
      await repairProfileIdentity({ stagingPath: stagingDir, finalPath: targetDir, profileName: targetName });
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      await discardBackupStagingDir(stagingDir).catch(() => {});
      throw error;
    }
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

  parseBackupId(backupId);

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
 * Durable auto-backup of the pre-restore state. Uses the same shared Backup
 * ID protocol as every other backup (issue #107): the
 * `<profile>-<yyyymmdd>-<hhmmss>` id, same-second counter retries, and
 * staging-before-publish so an interrupted copy never surfaces as (or claims)
 * a listable backup.
 */
async function createSafetyBackup(
  appHomePath: string,
  profileName: string,
  clock?: Clock,
): Promise<string> {
  const appPaths = await ensureAppHomeStructure(appHomePath);
  const profileRoot = resolveInside(appPaths.profilesPath, validateProfileName(profileName));

  const backupDir = await allocateBackupDirPath(
    appPaths.backupsPath,
    profileName,
    clock ?? (() => new Date()),
  );

  const stagingDir = await createBackupStagingDir(appPaths.backupsPath);
  try {
    await fs.copy(profileRoot, stagingDir, { overwrite: false, errorOnExist: true });
    await publishBackupWithCollisionRetry(
      stagingDir,
      backupDir,
      appPaths.backupsPath,
      profileName,
      clock ?? (() => new Date()),
      await exclusiveLanding(stagingDir),
    );
  } catch (error) {
    await discardBackupStagingDir(stagingDir).catch(() => {});
    throw error;
  }
  return backupDir;
}

/**
 * The exclusive landing the collision retry relies on: create the target
 * directory exclusively, then copy the staged payload in. fs-extra's
 * errorOnExist only rejects pre-existing FILES (a directory-level copy
 * silently merges into an existing target), so the exclusive mkdir is the
 * guard that turns a lost publish race into a retriable EEXIST.
 */
async function exclusiveLanding(stagingDir: string): Promise<(target: string) => Promise<void>> {
  return async (target: string) => {
    await fs.ensureDir(stagingDir);
    await fs.mkdir(target); // exclusive: throws EEXIST when the target exists
    await fs.copy(stagingDir, target, { overwrite: false, errorOnExist: true });
    await fs.remove(stagingDir);
  };
}

/**
 * Replace targetDir with a copy of sourceDir via rename swap inside the same
 * partition (the §7.1 transaction pattern): stage as .ccps-tmp-*, move the
 * old tree aside as .ccps-old-*, land the new tree, then drop the old one.
 * The staged copy gets the profile-identity repair (issue #108) before it
 * publishes, so a restore that replaces a profile lands bound to the same
 * target name it publishes under. No in-place rewrite; a crash mid-swap
 * leaves the old tree recoverable next to the profile, and the pre-restore
 * auto-backup is the durable net.
 */
async function swapReplaceDirectory(
  sourceDir: string,
  targetDir: string,
  parentDir: string,
  targetProfileName: string,
): Promise<void> {
  const base = path.basename(targetDir);
  const tmpDir = resolveInside(parentDir, `.ccps-tmp-restore-${base}`);
  const oldDir = resolveInside(parentDir, `.ccps-old-restore-${base}`);

  // Clear residue from a previously crashed restore before staging.
  await fs.remove(tmpDir);
  await fs.remove(oldDir);

  await fs.copy(sourceDir, tmpDir, { overwrite: false, errorOnExist: true });
  await repairProfileIdentity({ stagingPath: tmpDir, finalPath: targetDir, profileName: targetProfileName });
  await fs.rename(targetDir, oldDir);
  await fs.rename(tmpDir, targetDir);
  await fs.remove(oldDir);
}
