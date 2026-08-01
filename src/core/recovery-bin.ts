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
  /** Required when collisionResolution is 'restore-as-new-name'. */
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

async function computeDirectorySize(dirPath: string): Promise<number> {
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

export async function performStartupSweep(appHomePath?: string, clock?: Clock): Promise<SweepResult> {
  const result = await sweepExpiredItems(appHomePath, clock);
  lastSweepResult = result;
  return result;
}

export function getLastSweepResult(): SweepResult | null {
  return lastSweepResult;
}

export function formatSweepSummary(result: SweepResult): string | null {
  if (result.deletedCount === 0) return null;
  const sizeStr = formatBytes(result.reclaimedBytes);
  return `Recovery Bin: ${result.deletedCount} expired item(s) swept, ${sizeStr} reclaimed.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    await setDirectoryPermissions0600(itemDir);
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
    await setDirectoryPermissions0600(itemDir);
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

async function setDirectoryPermissions0600(dirPath: string): Promise<void> {
  try {
    await fs.chmod(dirPath, 0o600);
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
  const targetPath = path.join(profileDir, coords.targetRelativePath);
  const resolution = options.collisionResolution ?? 'refuse';

  if (await fs.pathExists(targetPath)) {
    if (resolution === 'refuse') {
      throw new CcpsError('RESTORE_COLLISION', 'A resource already exists at the restore target.', {
        guidance: 'Use restore-as-new-name or delete-and-restore to resolve the collision.',
      });
    }

    if (resolution === 'delete-and-restore') {
      await autoBinExistingPath(targetPath, item.profile, appHomePath, clock);
    } else if (resolution === 'restore-as-new-name') {
      if (!options.newName) {
        throw new CcpsError(
          'RESTORE_NEW_NAME_REQUIRED',
          'A new name is required for restore-as-new-name collision resolution.',
          { guidance: 'Provide a new name for the restored resource.' },
        );
      }
      const newProfileDir = path.join(profilesPath, options.newName);
      const newTargetPath = path.join(newProfileDir, coords.targetRelativePath);
      await fs.ensureDir(path.dirname(newTargetPath));
      const payloadPath = path.join(item.itemDirPath, coords.targetRelativePath);
      await fs.copy(payloadPath, newTargetPath, { overwrite: false, errorOnExist: true });
      return;
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
  _clock: Clock,
): Promise<void> {
  const coords = item.coordinates as FragmentCoordinates;
  const profileDir = path.join(profilesPath, item.profile);
  const targetFilePath = path.join(profileDir, coords.file);
  const resolution = options.collisionResolution ?? 'refuse';

  if (await fs.pathExists(targetFilePath)) {
    const existing = await fs.readJson(targetFilePath);
    const keyValue = getNestedValue(existing, coords.keyPath);

    if (keyValue !== undefined && resolution === 'refuse') {
      throw new CcpsError('RESTORE_COLLISION', 'The fragment key already exists in the target file.', {
        guidance: 'Use delete-and-restore to replace the existing entry.',
      });
    }

    if (keyValue !== undefined && resolution === 'delete-and-restore') {
      await autoBinExistingFragment(targetFilePath, item.profile, coords.keyPath, keyValue, appHomePath, _clock);
    }

    if (keyValue !== undefined && resolution === 'restore-as-new-name') {
      if (!options.newName) {
        throw new CcpsError(
          'RESTORE_NEW_NAME_REQUIRED',
          'A new name is required for restore-as-new-name collision resolution.',
          { guidance: 'Provide a new name for the restored resource.' },
        );
      }
      // For fragments, restore-as-new-name writes to a file under the new profile
      const newProfileDir = path.join(profilesPath, options.newName);
      const newTargetFilePath = path.join(newProfileDir, coords.file);
      let newTarget: Record<string, unknown>;
      if (await fs.pathExists(newTargetFilePath)) {
        newTarget = (await fs.readJson(newTargetFilePath)) as Record<string, unknown>;
      } else {
        newTarget = {};
      }
      setNestedValue(newTarget, coords.keyPath, coords.value);
      await fs.ensureDir(path.dirname(newTargetFilePath));
      await atomicWriteJson(newTargetFilePath, newTarget);
      return;
    }
  }

  let target: Record<string, unknown>;
  if (await fs.pathExists(targetFilePath)) {
    target = (await fs.readJson(targetFilePath)) as Record<string, unknown>;
  } else {
    target = {};
  }

  setNestedValue(target, coords.keyPath, coords.value);
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
    kind: 'skill',
    profile,
    coordinates: { targetRelativePath: relativePath },
    sourcePath: targetPath,
    clock,
  });

  await fs.remove(targetPath);
}

async function autoBinExistingFragment(
  filePath: string,
  profile: string,
  keyPath: string,
  value: unknown,
  appHomePath: string,
  clock: Clock,
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
    kind: 'mcp-server',
    profile,
    coordinates: { file: relativeFilePath, keyPath, value },
    clock,
  });

  const target = (await fs.readJson(filePath)) as Record<string, unknown>;
  deleteNestedValue(target, keyPath);
  await atomicWriteJson(filePath, target);
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
