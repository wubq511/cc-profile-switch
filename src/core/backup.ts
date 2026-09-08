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
 * mix into another writer's backup.
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

async function backupIdTaken(backupsPath: string, id: string): Promise<boolean> {
  const candidate = resolveInside(backupsPath, id);
  const stats = await fs.stat(candidate).catch(() => null);
  // Any existing entry at the allocated id path — including a crashed
  // writer's half copy or a stray file squatting on the id — claims it; the
  // loop moves to the next counter instead of risking a clobber.
  return stats !== null;
}

/**
 * Retry bound for the publish loop: collisions are expected only while other
 * same-second writers publish (a handful of retries); exhausting the bound
 * means something is systematically wrong (e.g. backups/ corrupted into a
 * non-directory), which must surface as an error rather than hang the CLI.
 */
const PUBLISH_COLLISION_RETRY_LIMIT = 64;

/**
 * Publish a staged backup under the allocated id (issue #107). The publish is
 * an ATOMIC rename of the staging directory onto the target: staging lives in
 * the same parent directory, so the rename is same-partition atomic — either
 * the complete payload is at the final, listable id, or nothing is. A
 * concurrent writer claiming the id between allocation and publish makes the
 * rename fail (EEXIST/ENOTEMPTY/…); the retry only changes the id, never
 * overwrites or mixes into the other writer's backup. The RESOLVED target —
 * the path the payload actually occupies — is returned and MUST be used as
 * the published backup path by the caller.
 */
export async function publishBackupWithCollisionRetry(
  stagingDir: string,
  initialTarget: string,
  backupsPath: string,
  profileName: string,
  clock: Clock,
): Promise<string> {
  const parsed = parseBackupId(path.basename(initialTarget));
  let target = initialTarget;
  let attempts = 0;

  for (;;) {
    try {
      await fs.rename(stagingDir, target);
      return target;
    } catch (error) {
      attempts++;
      const code = isNodeError(error) ? error.code : undefined;
      const collision =
        code === 'EEXIST' ||
        code === 'ENOTEMPTY' ||
        code === 'EISDIR' ||
        code === 'ENOTDIR' ||
        code === 'EPERM' ||
        code === 'EACCES';
      if (!collision) throw error;
      if (attempts >= PUBLISH_COLLISION_RETRY_LIMIT) {
        throw new CcpsError(
          'BACKUP_PUBLISH_COLLISION',
          `Backup publish kept colliding with existing entries after ${String(attempts)} attempts.`,
          {
            guidance:
              'Inspect the backups directory for corruption, then retry; nothing was overwritten.',
            cause: error,
          },
        );
      }
      const timestamp = formatBackupTimestamp(clock());
      target = resolveInside(
        backupsPath,
        formatBackupId(validateProfileName(parsed.profileName), timestamp, counterFor(attempts)),
      );
    }
  }
}

function counterFor(attemptNumber: number): number {
  // attempts=1 → counter 2, attempts=2 → 3, …
  return attemptNumber + 1;
}

/**
 * Stage a backup under an id the listing will not recognize (issue #107): the
 * staging directory lives inside backups/ (or profiles/, for restore copies)
 * and carries the `.ccps-tmp-backup-` prefix, which no listing or ID parser
 * accepts — an interrupted first copy therefore can never surface as, or
 * claim, a Backup id. The publish step renames the staging directory onto the
 * final id atomically; nothing else ever writes at the final id. Residue from
 * a crash before publish keeps the unrecognized prefix (it holds only an
 * incomplete copy and is replaced by the next staging run for the same id —
 * new staging names are unique); it is not part of any Backup.
 */
export async function createBackupStagingDir(backupsPath: string): Promise<string> {
  const stagingDir = resolveInside(
    backupsPath,
    `.ccps-tmp-backup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.ensureDir(stagingDir);
  return stagingDir;
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
 * atomic-rename publish so an interrupted copy never surfaces as (or claims)
 * a listable backup. The returned path is the RESOLVED publish target — the
 * directory that actually holds the payload.
 */
async function createSafetyBackup(
  appHomePath: string,
  profileName: string,
  clock?: Clock,
): Promise<string> {
  const appPaths = await ensureAppHomeStructure(appHomePath);
  const profileRoot = resolveInside(appPaths.profilesPath, validateProfileName(profileName));
  const now = clock ?? (() => new Date());

  const allocatedDir = await allocateBackupDirPath(appPaths.backupsPath, profileName, now);

  const stagingDir = await createBackupStagingDir(appPaths.backupsPath);
  try {
    await fs.copy(profileRoot, stagingDir, { overwrite: false, errorOnExist: true });
    return await publishBackupWithCollisionRetry(
      stagingDir,
      allocatedDir,
      appPaths.backupsPath,
      profileName,
      now,
    );
  } catch (error) {
    await discardBackupStagingDir(stagingDir).catch(() => {});
    throw error;
  }
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
  try {
    await repairProfileIdentity({ stagingPath: tmpDir, finalPath: targetDir, profileName: targetProfileName });
    await fs.rename(targetDir, oldDir);
    await fs.rename(tmpDir, targetDir);
  } catch (error) {
    // Nothing published yet — clear our staging so no half-repaired copy
    // lingers next to the live profile.
    await fs.remove(tmpDir).catch(() => {});
    throw error;
  }
  await fs.remove(oldDir);
}
