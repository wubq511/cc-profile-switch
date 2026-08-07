import fs from 'fs-extra';
import path from 'node:path';

import { getAppHomePaths, loadAppConfig, saveAppConfig, type Clock } from './app-config';
import {
  recoveryItemSchema,
  UPDATE_ORIGIN_TTL_DAYS,
  type RecoveryItem,
  type RecoveryItemOrigin,
  type RecoveryItemKind,
  type FileTreeCoordinates,
  type FragmentCoordinates,
} from '../schemas/recovery-bin';
import type { PluginCoordinates } from '../schemas/plugins';
import { resolveInside, validateProfileName } from '../platform/path';
import { CcpsError } from '../utils/errors';
import { atomicWriteJson } from './versioned-json';

// ─── Public types ───────────────────────────────────────────────────────

export type CreateFileTreeItemOptions = {
  appHomePath?: string;
  origin: RecoveryItemOrigin;
  kind: RecoveryItemKind;
  profile: string;
  coordinates: FileTreeCoordinates;
  /** Absolute path to the source directory/file to copy into the item payload. */
  sourcePath: string;
  secretBearing?: boolean;
  clock?: Clock;
};

export type CreateFragmentItemOptions = {
  appHomePath?: string;
  origin: RecoveryItemOrigin;
  kind: RecoveryItemKind;
  profile: string;
  coordinates: FragmentCoordinates;
  secretBearing?: boolean;
  clock?: Clock;
};

export type CreatePluginItemOptions = {
  appHomePath?: string;
  origin: RecoveryItemOrigin;
  profile: string;
  coordinates: PluginCoordinates;
  clock?: Clock;
};

export type RecoveryBinItem = RecoveryItem & {
  /** Absolute path to the item directory inside recovery-bin/. */
  itemDirPath: string;
};

export type RestoreResult = {
  restoredProfile: string;
  /** The item directory was consumed (removed) on success. */
  consumed: true;
};

export type CollisionResolution = 'refuse' | 'restore-as-new-name' | 'delete-and-restore';

/**
 * Restores a plugin-item by delegated reinstall. Injected so recovery-bin
 * stays free of the claude-plugin delegation service (no circular import).
 */
export type PluginRestoreHandler = (item: RecoveryBinItem) => Promise<void>;

export type RestoreOptions = {
  appHomePath?: string;
  itemId: string;
  collisionResolution?: CollisionResolution;
  /**
   * Required when collisionResolution is 'restore-as-new-name'. Renames the
   * entry within the same profile (last path segment for file-tree items, last
   * keyPath segment for fragments). For kind 'profile' items it is the new
   * profile name instead.
   */
  newName?: string;
  /** Required to restore plugin-shape items; reinstall + re-apply state. */
  pluginRestore?: PluginRestoreHandler;
  clock?: Clock;
};

export type SweepResult = {
  deletedCount: number;
  reclaimedBytes: number;
};

export type RetentionImpact = {
  wouldExpireCount: number;
  wouldExpireIds: string[];
};

export type BinSummary = {
  itemCount: number;
  totalSizeBytes: number;
};

// ─── Item ID generation ─────────────────────────────────────────────────

export function formatItemId(removedAt: Date, profile: string, slug: string): string {
  const ts = compactTimestamp(removedAt);
  return `${ts}-${profile}-${slug}`;
}

function compactTimestamp(date: Date): string {
  const y = date.getUTCFullYear().toString();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const s = pad2(date.getUTCSeconds());
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// ─── Size computation ───────────────────────────────────────────────────

/** du-style recursive size of a directory tree, in bytes. */
export async function computeDirectorySize(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await computeDirectorySize(fullPath);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      total += stat.size;
    }
  }
  return total;
}

// ─── Startup sweep ──────────────────────────────────────────────────────

let lastSweepResult: SweepResult | null = null;
let lastCrashReconcileCount = 0;

export async function performStartupSweep(appHomePath?: string, clock?: Clock): Promise<SweepResult> {
  const result = await sweepExpiredItems(appHomePath, clock);
  lastSweepResult = result;

  // Spec §9.4: the lazy startup sweep also reconciles §7.1 transaction crash
  // states (`.ccps-tmp-*` / `.ccps-old-*` residue). Reconciliation is loaded
  // lazily to avoid a static circular import — skills-transaction imports
  // createFileTreeItem from this module.
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  try {
    const { reconcileAllProfilesTransactionCrashStates } = await import('./skills-transaction');
    const reconcile = await reconcileAllProfilesTransactionCrashStates(resolved);
    lastCrashReconcileCount = reconcile.entries.length;
  } catch {
    // Reconciliation must never break the sweep; it runs best-effort.
    lastCrashReconcileCount = 0;
  }

  return result;
}

export function getLastSweepResult(): SweepResult | null {
  return lastSweepResult;
}

export function getLastCrashReconcileCount(): number {
  return lastCrashReconcileCount;
}

export function formatSweepSummary(result: SweepResult): string | null {
  if (result.deletedCount === 0) return null;
  const sizeStr = formatBytes(result.reclaimedBytes);
  return `Recovery Bin: ${result.deletedCount} expired item(s) swept, ${sizeStr} reclaimed.`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Startup sweep orchestration (spec §9.4) ────────────────────────────

/**
 * Pending-summary marker: written when a sweep deleted something, consumed
 * (read once, then removed) at the next startup so the one-line summary
 * prints exactly once — the §9.4 "next launch prints one line" contract.
 * Lives at the app-home root next to config.json/state.json; the Recovery
 * Bin itself stays free of non-item files (items are self-describing). This
 * is a one-shot notification, not a cleanup log (§9.4: no persistent log).
 */
const PENDING_SWEEP_SUMMARY_FILE_NAME = 'pending-sweep-summary.json';

function getPendingSweepSummaryPath(appHomePath: string): string {
  return resolveInside(appHomePath, PENDING_SWEEP_SUMMARY_FILE_NAME);
}

async function consumePendingSweepSummary(appHomePath: string): Promise<SweepResult | null> {
  const markerPath = getPendingSweepSummaryPath(appHomePath);
  try {
    if (!(await fs.pathExists(markerPath))) return null;
    const raw: unknown = await fs.readJson(markerPath).catch(() => undefined);
    // One-shot marker: always consumed, even when corrupt, so a bad file
    // never lingers or repeats.
    await fs.remove(markerPath).catch(() => {});
    if (
      raw === null ||
      typeof raw !== 'object' ||
      typeof (raw as SweepResult).deletedCount !== 'number' ||
      typeof (raw as SweepResult).reclaimedBytes !== 'number'
    ) {
      return null;
    }
    const result = raw as SweepResult;
    return { deletedCount: result.deletedCount, reclaimedBytes: result.reclaimedBytes };
  } catch {
    // The marker is best-effort; I/O failure never blocks startup.
    return null;
  }
}

async function recordPendingSweepSummary(
  result: SweepResult,
  appHomePath: string,
): Promise<void> {
  if (result.deletedCount === 0) return;
  const markerPath = getPendingSweepSummaryPath(appHomePath);
  await fs.ensureDir(path.dirname(markerPath));
  await atomicWriteJson(markerPath, result);
}

export type StartupSweepReport = {
  /**
   * One-line summary of the PREVIOUS sweep's deletions, ready to print. Null
   * when the previous sweep deleted nothing or no sweep has run yet. The
   * marker is consumed by this call, so the line prints exactly once.
   */
  pendingSummary: string | null;
  /**
   * This invocation's sweep result. Null when the sweep could not run
   * (uninitialized app home, corrupt config, I/O failure) — the caller must
   * treat the sweep as best-effort and continue.
   */
  sweepResult: SweepResult | null;
};

/**
 * §9.4 lazy startup sweep driver, run once per ccps invocation (any command).
 * Consumes and formats the previous sweep's pending summary line, then sweeps
 * expired items and reconciles §7.1 transaction crash states (via
 * performStartupSweep), recording a new pending summary when this sweep
 * deleted something. Fully failure-isolated: sweep problems never throw.
 */
export async function runStartupSweep(
  appHomePath?: string,
  clock?: Clock,
): Promise<StartupSweepReport> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;

  const pending = await consumePendingSweepSummary(resolved);
  const pendingSummary = pending === null ? null : formatSweepSummary(pending);

  try {
    const sweepResult = await performStartupSweep(resolved, clock);
    const last = getLastSweepResult() ?? sweepResult;
    if (last.deletedCount > 0) {
      await recordPendingSweepSummary(last, resolved);
    }
    return { pendingSummary, sweepResult: last };
  } catch {
    return { pendingSummary, sweepResult: null };
  }
}

// ─── Core operations ────────────────────────────────────────────────────

export async function createFileTreeItem(options: CreateFileTreeItemOptions): Promise<RecoveryBinItem> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { recoveryBinPath } = getAppHomePaths(appHomePath);
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const profileName = validateProfileName(options.profile);

  const slug = deriveSlug(options.coordinates.targetRelativePath);
  const baseId = formatItemId(now, profileName, slug);
  const itemId = await resolveIdCollision(recoveryBinPath, baseId);
  const itemDir = resolveInside(recoveryBinPath, itemId);

  await fs.ensureDir(itemDir);
  await fs.copy(
    options.sourcePath,
    resolveInside(itemDir, options.coordinates.targetRelativePath),
    { overwrite: false, errorOnExist: true },
  );

  // Compute size once at removal time, BEFORE writing item.json
  // so sizeBytes reflects only the payload, not the metadata.
  const sizeBytes = await computeDirectorySize(itemDir);

  const item: RecoveryItem = {
    version: 1,
    id: itemId,
    origin: options.origin,
    kind: options.kind,
    shape: 'file-tree',
    profile: profileName,
    coordinates: options.coordinates,
    removedAt: now.toISOString(),
    sizeBytes,
    secretBearing: options.secretBearing ?? false,
  };

  await writeItemJson(itemDir, item);

  if (item.secretBearing) {
    await setDirectoryPermissions0700(itemDir);
  }

  return { ...item, itemDirPath: itemDir };
}

export async function createFragmentItem(options: CreateFragmentItemOptions): Promise<RecoveryBinItem> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { recoveryBinPath } = getAppHomePaths(appHomePath);
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const profileName = validateProfileName(options.profile);

  const slug = deriveSlug(`${options.coordinates.file}-${options.coordinates.keyPath}`);
  const baseId = formatItemId(now, profileName, slug);
  const itemId = await resolveIdCollision(recoveryBinPath, baseId);
  const itemDir = resolveInside(recoveryBinPath, itemId);

  await fs.ensureDir(itemDir);

  const item: RecoveryItem = {
    version: 1,
    id: itemId,
    origin: options.origin,
    kind: options.kind,
    shape: 'fragment',
    profile: profileName,
    coordinates: options.coordinates,
    removedAt: now.toISOString(),
    sizeBytes: 0,
    secretBearing: options.secretBearing ?? false,
  };

  await writeItemJson(itemDir, item);

  if (item.secretBearing) {
    await setDirectoryPermissions0700(itemDir);
  }

  return { ...item, itemDirPath: itemDir };
}

export async function createPluginItem(options: CreatePluginItemOptions): Promise<RecoveryBinItem> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { recoveryBinPath } = getAppHomePaths(appHomePath);
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const profileName = validateProfileName(options.profile);

  const slug = deriveSlug(`${options.coordinates.plugin}@${options.coordinates.marketplace}`);
  const baseId = formatItemId(now, profileName, slug);
  const itemId = await resolveIdCollision(recoveryBinPath, baseId);
  const itemDir = resolveInside(recoveryBinPath, itemId);

  await fs.ensureDir(itemDir);

  const item: RecoveryItem = {
    version: 1,
    id: itemId,
    origin: options.origin,
    kind: 'plugin',
    shape: 'plugin',
    profile: profileName,
    coordinates: options.coordinates,
    removedAt: now.toISOString(),
    sizeBytes: 0,
    secretBearing: false,
  };

  await writeItemJson(itemDir, item);

  return { ...item, itemDirPath: itemDir };
}

export async function listRecoveryBinItems(appHomePath?: string): Promise<RecoveryBinItem[]> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  const { recoveryBinPath } = getAppHomePaths(resolved);

  if (!(await fs.pathExists(recoveryBinPath))) {
    return [];
  }

  const entries = await fs.readdir(recoveryBinPath, { withFileTypes: true });
  const items: RecoveryBinItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const itemDir = path.join(recoveryBinPath, entry.name);
    const itemJsonPath = path.join(itemDir, 'item.json');

    if (!(await fs.pathExists(itemJsonPath))) continue;

    try {
      const raw = await fs.readJson(itemJsonPath);
      const parsed = recoveryItemSchema.safeParse(raw);
      if (!parsed.success) continue;
      items.push({ ...parsed.data, itemDirPath: itemDir });
    } catch {
      continue;
    }
  }

  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getRecoveryItem(itemId: string, appHomePath?: string): Promise<RecoveryBinItem> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  const { recoveryBinPath } = getAppHomePaths(resolved);
  const itemDir = resolveInside(recoveryBinPath, itemId);
  const itemJsonPath = path.join(itemDir, 'item.json');

  if (!(await fs.pathExists(itemJsonPath))) {
    throw new CcpsError('RECOVERY_ITEM_NOT_FOUND', 'Recovery item does not exist.', {
      guidance: 'The item may have been restored or permanently deleted.',
    });
  }

  const raw = await fs.readJson(itemJsonPath);
  const parsed = recoveryItemSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CcpsError('RECOVERY_ITEM_INVALID', 'Recovery item metadata is corrupt.', {
      guidance: 'Manually inspect the item directory or permanently delete it.',
      cause: parsed.error,
    });
  }

  return { ...parsed.data, itemDirPath: itemDir };
}

export async function restoreRecoveryItem(options: RestoreOptions): Promise<RestoreResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const item = await getRecoveryItem(options.itemId, appHomePath);
  const { profilesPath } = getAppHomePaths(appHomePath);
  const clock = options.clock ?? (() => new Date());

  if (item.shape === 'file-tree') {
    await restoreFileTreeItem(item, profilesPath, appHomePath, options, clock);
  } else if (item.shape === 'plugin') {
    await restorePluginItem(item, options.pluginRestore);
  } else {
    // Linked Skill removals land as kind='skill' fragments carrying link
    // coordinates + provenance (spec §7.2/§9). Restoring them re-creates a
    // link, not a JSON value, so they route through the dedicated skills
    // restore path — refuse here to avoid writing a fragment value into a
    // directory and corrupting the Profile.
    if (item.kind === 'skill') {
      throw new CcpsError(
        'RECOVERY_ITEM_RESTORE_ROUTE',
        'This Recovery Item is a Linked Skill fragment and must be restored through the Skills restore path.',
        {
          guidance: 'Use restoreLinkedSkillItem from the Skills module to re-create the link.',
        },
      );
    }
    await restoreFragmentItem(item, profilesPath, appHomePath, options, clock);
  }

  await fs.remove(item.itemDirPath);

  return { restoredProfile: item.profile, consumed: true };
}

export async function permanentlyDeleteItem(itemId: string, appHomePath?: string): Promise<void> {
  const item = await getRecoveryItem(itemId, appHomePath);
  await fs.remove(item.itemDirPath);
}

export async function emptyRecoveryBin(appHomePath?: string): Promise<void> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  const { recoveryBinPath } = getAppHomePaths(resolved);

  if (!(await fs.pathExists(recoveryBinPath))) return;

  const entries = await fs.readdir(recoveryBinPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fs.remove(path.join(recoveryBinPath, entry.name));
    }
  }
}

export async function sweepExpiredItems(appHomePath?: string, clock?: Clock): Promise<SweepResult> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  const config = await loadAppConfig(resolved);
  const now = (clock ?? (() => new Date()))();
  const retentionDays = config.recovery.retentionDays;

  const items = await listRecoveryBinItems(resolved);

  let deletedCount = 0;
  let reclaimedBytes = 0;

  for (const item of items) {
    if (isExpired(item, retentionDays, now)) {
      reclaimedBytes += item.sizeBytes;
      await fs.remove(item.itemDirPath);
      deletedCount++;
    }
  }

  return { deletedCount, reclaimedBytes };
}

export async function computeRetentionImpact(
  retentionDays: number | null,
  appHomePath?: string,
  clock?: Clock,
): Promise<RetentionImpact> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  const now = (clock ?? (() => new Date()))();
  const items = await listRecoveryBinItems(resolved);

  const wouldExpireIds = items
    .filter((item) => isExpired(item, retentionDays, now))
    .map((item) => item.id);

  return { wouldExpireCount: wouldExpireIds.length, wouldExpireIds };
}

export async function changeRetentionSetting(
  retentionDays: number | null,
  appHomePath?: string,
  clock?: Clock,
): Promise<RetentionImpact> {
  const resolved = appHomePath ?? getAppHomePaths().appHomePath;
  const impact = await computeRetentionImpact(retentionDays, resolved, clock);

  const config = await loadAppConfig(resolved);
  await saveAppConfig(
    resolved,
    { ...config, recovery: { retentionDays: retentionDays as 7 | 30 | 90 | null } },
    { clock },
  );

  return impact;
}

export async function getBinSummary(appHomePath?: string): Promise<BinSummary> {
  const items = await listRecoveryBinItems(appHomePath);
  return {
    itemCount: items.length,
    totalSizeBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}

export type RecoveryBinListEntry = {
  item: RecoveryBinItem;
  /** Live du-style size of the whole item directory (payload + item.json). */
  sizeBytes: number;
};

export type RecoveryBinList = {
  entries: RecoveryBinListEntry[];
  totalSizeBytes: number;
};

/**
 * §9.5 Bin listing: per-entry sizes inline plus a total. Sizes are computed
 * du-style at listing time so fragment/plugin items (recorded as 0 payload
 * bytes) still report the space they actually occupy; the removal-time
 * recording is the fallback when the live walk fails.
 */
export async function listRecoveryBinWithSizes(appHomePath?: string): Promise<RecoveryBinList> {
  const items = await listRecoveryBinItems(appHomePath);
  const entries: RecoveryBinListEntry[] = [];

  for (const item of items) {
    let sizeBytes = item.sizeBytes;
    try {
      sizeBytes = await computeDirectorySize(item.itemDirPath);
    } catch {
      // Fall back to the removal-time recording when live du fails.
    }
    entries.push({ item, sizeBytes });
  }

  return {
    entries,
    totalSizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────

function isExpired(item: RecoveryItem, retentionDays: number | null, now: Date): boolean {
  if (retentionDays === null) return false;

  const effectiveDays = item.origin === 'update' ? UPDATE_ORIGIN_TTL_DAYS : retentionDays;
  const removedAt = new Date(item.removedAt);
  const expiryMs = effectiveDays * 24 * 60 * 60 * 1000;
  return now.getTime() - removedAt.getTime() > expiryMs;
}

function deriveSlug(relativePath: string): string {
  const segments = relativePath.split(/[/\\]+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? 'item';
  return last.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
}

async function resolveIdCollision(recoveryBinPath: string, baseId: string): Promise<string> {
  if (!(await fs.pathExists(path.join(recoveryBinPath, baseId)))) {
    return baseId;
  }

  let counter = 2;
  while (await fs.pathExists(path.join(recoveryBinPath, `${baseId}-${counter}`))) {
    counter++;
  }
  return `${baseId}-${counter}`;
}

async function writeItemJson(itemDir: string, item: RecoveryItem): Promise<void> {
  const itemJsonPath = path.join(itemDir, 'item.json');
  await atomicWriteJson(itemJsonPath, item);
}

async function setDirectoryPermissions0700(dirPath: string): Promise<void> {
  try {
    // 0700 (rwx------) on a directory: owner can traverse/read/write while
    // other users cannot. 0600 would omit execute, which prevents even the
    // owner from accessing files inside (list/get/restore/delete all fail).
    await fs.chmod(dirPath, 0o700);
  } catch {
    // Windows may not support chmod; silently ignore
  }
}

async function restoreFileTreeItem(
  item: RecoveryBinItem,
  profilesPath: string,
  appHomePath: string,
  options: RestoreOptions,
  clock: Clock,
): Promise<void> {
  const coords = item.coordinates as FileTreeCoordinates;
  const profileDir = path.join(profilesPath, item.profile);
  const resolution = options.collisionResolution ?? 'refuse';
  const isProfileItem = item.kind === 'profile';

  // Profile-kind payloads are whole profile trees recorded at
  // `profiles/<name>`; the restore target is the profile directory itself,
  // not a path inside it.
  const baseTargetPath = isProfileItem
    ? path.join(profilesPath, item.profile)
    : path.join(profileDir, coords.targetRelativePath);

  // restore-as-new-name targets a renamed location regardless of whether the
  // original still exists: the caller asked for the new name explicitly.
  let targetPath = baseTargetPath;

  if (resolution === 'restore-as-new-name') {
    const newName = requireNewName(options);

    if (isProfileItem) {
      // A whole-profile payload restores into a brand-new profile directory
      // (spec §9.3 S13: recreate `coding`, restore as `coding-2`, both exist).
      const newProfileDir = path.join(profilesPath, validateProfileName(newName));
      if (await fs.pathExists(newProfileDir)) {
        throw collisionError('A profile already exists with the new name.');
      }
      await fs.ensureDir(newProfileDir);
      const payloadPath = path.join(item.itemDirPath, coords.targetRelativePath);
      await fs.copy(payloadPath, newProfileDir, { overwrite: false, errorOnExist: true });
      return;
    }

    // Resource-level rename: same profile, new name for the last path segment
    // (spec §9.3: fragment/entry collisions resolve at entry level).
    const newRelativePath = renameLastPathSegment(
      coords.targetRelativePath,
      assertSafeNewName(newName),
    );
    targetPath = path.join(profileDir, newRelativePath);
    if (await fs.pathExists(targetPath)) {
      throw collisionError('A resource already exists at the renamed restore target.');
    }
  }

  if (await fs.pathExists(targetPath)) {
    if (resolution === 'refuse') {
      throw collisionError('A resource already exists at the restore target.');
    }
    // delete-and-restore: the conflicting entry becomes its own Recovery Item
    // (spec §9.3 S14: a conflicting Profile becomes its own Bin item).
    if (isProfileItem) {
      await autoBinProfile(targetPath, item.profile, coords, appHomePath, clock);
    } else {
      await autoBinExistingPath(targetPath, item.profile, appHomePath, clock, item.kind);
    }
  }

  await fs.ensureDir(path.dirname(targetPath));
  const payloadPath = path.join(item.itemDirPath, coords.targetRelativePath);
  await fs.copy(payloadPath, targetPath, { overwrite: false, errorOnExist: true });
}

async function restoreFragmentItem(
  item: RecoveryBinItem,
  profilesPath: string,
  appHomePath: string,
  options: RestoreOptions,
  clock: Clock,
): Promise<void> {
  const coords = item.coordinates as FragmentCoordinates;
  const profileDir = path.join(profilesPath, item.profile);
  const targetFilePath = path.join(profileDir, coords.file);
  const resolution = options.collisionResolution ?? 'refuse';

  let target: Record<string, unknown>;
  if (await fs.pathExists(targetFilePath)) {
    target = (await fs.readJson(targetFilePath)) as Record<string, unknown>;
  } else {
    target = {};
  }

  // restore-as-new-name writes to a renamed key in the same file, regardless of
  // whether the original key still exists — the caller asked for the new name.
  const targetKey =
    resolution === 'restore-as-new-name'
      ? renameLastKeySegment(coords.keyPath, requireFragmentNewName(options))
      : coords.keyPath;

  const existingValue = getNestedValue(target, targetKey);
  if (existingValue !== undefined) {
    if (resolution === 'refuse') {
      throw collisionError('The fragment key already exists in the target file.');
    }
    if (resolution === 'restore-as-new-name') {
      throw collisionError('A fragment already exists at the renamed target key.');
    }
    // delete-and-restore: the conflicting entry becomes its own Recovery Item.
    await autoBinExistingFragment(
      targetFilePath,
      item.profile,
      targetKey,
      existingValue,
      appHomePath,
      clock,
      item.kind,
    );
  }

  setNestedValue(target, targetKey, coords.value);
  await atomicWriteJson(targetFilePath, target);
}

async function restorePluginItem(
  item: RecoveryBinItem,
  pluginRestore: PluginRestoreHandler | undefined,
): Promise<void> {
  if (!pluginRestore) {
    throw new CcpsError(
      'PLUGIN_RESTORE_UNAVAILABLE',
      'No plugin restore handler is wired for this Recovery Item.',
      {
        guidance: 'Restore a plugin item through the CLI or Workbench surface that provides it.',
      },
    );
  }

  await pluginRestore(item);
}

async function autoBinExistingPath(
  targetPath: string,
  profile: string,
  appHomePath: string,
  clock: Clock,
  kind: RecoveryItemKind,
): Promise<void> {
  const profilesPath = getAppHomePaths(appHomePath).profilesPath;
  const profileDir = path.join(profilesPath, profile);
  const relativePath = path.relative(profileDir, targetPath);

  // Block traversal: relativePath must not escape the profile directory
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new CcpsError('PATH_OUTSIDE_BASE', 'Auto-bin target escapes the profile directory.', {
      guidance: 'The conflicting path must be inside the profile directory.',
    });
  }

  await createFileTreeItem({
    appHomePath,
    origin: 'remove',
    kind,
    profile,
    coordinates: { targetRelativePath: relativePath },
    sourcePath: targetPath,
    clock,
  });

  await fs.remove(targetPath);
}

async function autoBinProfile(
  profileRoot: string,
  profile: string,
  coords: FileTreeCoordinates,
  appHomePath: string,
  clock: Clock,
): Promise<void> {
  // A conflicting Profile is binned with the same coordinates the original
  // removal used, so it round-trips exactly like any other profile item.
  await createFileTreeItem({
    appHomePath,
    origin: 'remove',
    kind: 'profile',
    profile,
    coordinates: { targetRelativePath: coords.targetRelativePath },
    sourcePath: profileRoot,
    clock,
  });

  await fs.remove(profileRoot);
}

async function autoBinExistingFragment(
  filePath: string,
  profile: string,
  keyPath: string,
  value: unknown,
  appHomePath: string,
  clock: Clock,
  kind: RecoveryItemKind,
): Promise<void> {
  const profilesPath = getAppHomePaths(appHomePath).profilesPath;
  const profileDir = path.join(profilesPath, profile);
  const relativeFilePath = path.relative(profileDir, filePath);

  // Block traversal: relativeFilePath must not escape the profile directory
  if (relativeFilePath.startsWith('..') || path.isAbsolute(relativeFilePath)) {
    throw new CcpsError('PATH_OUTSIDE_BASE', 'Auto-bin target escapes the profile directory.', {
      guidance: 'The conflicting file must be inside the profile directory.',
    });
  }

  await createFragmentItem({
    appHomePath,
    origin: 'remove',
    kind,
    profile,
    coordinates: { file: relativeFilePath, keyPath, value },
    clock,
  });

  const target = (await fs.readJson(filePath)) as Record<string, unknown>;
  deleteNestedValue(target, keyPath);
  await atomicWriteJson(filePath, target);
}

// ─── Collision helpers ─────────────────────────────────────────────────

function requireNewName(options: RestoreOptions): string {
  if (!options.newName) {
    throw new CcpsError(
      'RESTORE_NEW_NAME_REQUIRED',
      'A new name is required for restore-as-new-name collision resolution.',
      { guidance: 'Provide a new name for the restored resource.' },
    );
  }
  return options.newName;
}

function requireFragmentNewName(options: RestoreOptions): string {
  const newName = requireNewName(options);
  assertSafeNewName(newName);
  // Fragment key paths use dots as separators, so a dotted new name would
  // silently create a nested key instead of a renamed one.
  if (newName.includes('.')) {
    throw new CcpsError('RESTORE_INVALID_NEW_NAME', 'The new name must not contain dots.', {
      guidance: 'The fragment key path uses dots as separators; pick a plain name.',
    });
  }
  return newName;
}

function assertSafeNewName(newName: string): string {
  if (!newName || newName !== newName.trim()) {
    throw invalidNewName();
  }
  if (newName === '.' || newName === '..') {
    throw invalidNewName();
  }
  // Block any platform separator or NUL so the renamed target stays inside the
  // profile directory even if the caller's name came from untrusted input.
  if (newName.includes('/') || newName.includes('\\') || newName.includes('\0')) {
    throw invalidNewName();
  }
  return newName;
}

function invalidNewName(): CcpsError {
  return new CcpsError('RESTORE_INVALID_NEW_NAME', 'The new name is not safe.', {
    guidance: 'Use a plain name with no path separators.',
  });
}

function collisionError(message: string): CcpsError {
  return new CcpsError('RESTORE_COLLISION', message, {
    guidance: 'Use restore-as-new-name or delete-and-restore to resolve the collision.',
  });
}

function renameLastPathSegment(relativePath: string, newName: string): string {
  const sepIdx = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'));
  if (sepIdx === -1) return newName;
  return `${relativePath.slice(0, sepIdx + 1)}${newName}`;
}

function renameLastKeySegment(keyPath: string, newName: string): string {
  const sepIdx = keyPath.lastIndexOf('.');
  if (sepIdx === -1) return newName;
  return `${keyPath.slice(0, sepIdx + 1)}${newName}`;
}

// ─── Nested value helpers ───────────────────────────────────────────────

function getNestedValue(obj: unknown, keyPath: string): unknown {
  const keys = keyPath.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = current[keys[i]];
    if (next === null || next === undefined || typeof next !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function deleteNestedValue(obj: Record<string, unknown>, keyPath: string): void {
  const keys = keyPath.split('.');
  let current: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return;
    }
    current = (current as Record<string, unknown>)[keys[i]];
  }
  if (current !== null && current !== undefined && typeof current === 'object') {
    delete (current as Record<string, unknown>)[keys[keys.length - 1]];
  }
}
