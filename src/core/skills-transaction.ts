import { createHash, randomBytes } from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';

import { getAppHomePaths } from './app-config';
import { createFileTreeItem } from './recovery-bin';
import {
  computeAuditView,
  computeContentHash,
  getSkillsDirectoryPath,
  loadSkillsProvenance,
  saveSkillsProvenance,
} from './skills-provenance';
import type { AuditView, SkillProvenanceRecord, SkillSource } from '../schemas/skills-provenance';
import { resolveFilesystemPath, resolveInside, validateProfileName } from '../platform/path';
import { atomicWriteJson } from './versioned-json';
import { CcpsError } from '../utils/errors';
import { type Clock } from './types';

export type { Clock } from './types';

// Spec §7.1 "Skill provenance and transactions" (issue #65).
//
// Every Skill tree mutation goes through this atomic transaction contract:
//   stage  — produce the new tree in a staging area OUTSIDE the Profile
//            (same partition as the skills directory, so the apply rename
//            is atomic). Failure is a pure error: the Profile is never touched.
//   preview — hash-based file diff (added/changed/removed) with a local-drift
//             overwrite warning that requires explicit confirmation.
//   apply  — rename swap inside claude-home/skills/ (never in-place):
//            staged → .ccps-tmp-<id>, old → .ccps-old-<id>,
//            .ccps-tmp-<id> → final, delete old, write manifest atomically.
//   rollback — apply-failure restoration only (not a user operation). Three
//              enumerable crash states are reconciled by the startup sweep
//              (reconcileSkillTransactionCrashStates).
//
// A crash between the file swap and the manifest write surfaces as local drift
// and follows exactly the same path as a manual user edit — deliberately.
//
// Link-mode installs are a single atomic symlink creation and do not need the
// rename-swap; this engine is copy-mode only. Link previews still flow through
// previewTransaction to report the link target and source diff.

// ─── Names ───────────────────────────────────────────────────────────────

const STAGING_DIR_NAME = 'staging';
export const TX_TMP_PREFIX = '.ccps-tmp-';
export const TX_OLD_PREFIX = '.ccps-old-';
export const TX_SIDECAR_PREFIX = '.ccps-tx-';

// A transaction sidecar (`.ccps-tx-<id>.json`) is written at the start of
// apply and removed on completion. It records the target skill name so the
// startup sweep can reconcile a crash — the tmp/old dir names carry only the
// transaction id, not the (hyphen-permitting) skill name, so the name cannot
// be parsed back out of the directory name reliably.
const TX_SIDECAR_SCHEMA_VERSION = 1;

const FAULT_ERROR_CODE = 'SKILL_TX_FAULT_INJECTED';

// ─── Staging ─────────────────────────────────────────────────────────────

export function getStagingPath(appHomePath: string): string {
  return resolveInside(appHomePath, STAGING_DIR_NAME);
}

export type StageOptions = {
  appHomePath: string;
  /**
   * Local source tree to copy into staging (copy-mode install/update). The
   * source root becomes the staged skill root.
   */
  localSourcePath?: string;
  /**
   * Already-staged tree (e.g., from the remote acquisition adapter) to copy
   * into the ccps staging area. Copied (not moved) so the caller's staging
   * root stays intact.
   */
  preStagedPath?: string;
};

export type StageResult = {
  /** Absolute path to the staged tree (outside the Profile, same partition as profiles). */
  stagedPath: string;
  stageId: string;
};

/**
 * Produce the new tree in a staging area outside the Profile. Failure is a
 * pure error: the Profile is never touched and the partial staging dir is
 * removed before throwing.
 */
export async function stageSkillTree(options: StageOptions): Promise<StageResult> {
  if (!options.localSourcePath && !options.preStagedPath) {
    throw new CcpsError('SKILL_TX_STAGE_SOURCE_REQUIRED', 'Stage requires a source tree.', {
      guidance: 'Provide localSourcePath or preStagedPath.',
    });
  }

  const stagingRoot = getStagingPath(options.appHomePath);
  await fs.ensureDir(stagingRoot);
  // Best-effort cleanup of stale staging dirs from prior crashed runs. These
  // are outside the Profile and uniquely named, so they never collide; this
  // just keeps the staging area tidy.
  await cleanStaleStagingDirs(stagingRoot).catch(() => {});

  const stageId = randomBytes(6).toString('hex');
  const stagedPath = resolveInside(stagingRoot, `skill-${stageId}`);

  try {
    const source = resolveFilesystemPath(options.localSourcePath ?? options.preStagedPath!);
    await fs.copy(source, stagedPath, { overwrite: false, errorOnExist: true });
  } catch (error) {
    await fs.remove(stagedPath).catch(() => {});
    throw new CcpsError(
      'SKILL_TX_STAGE_FAILED',
      'Failed to stage the Skill tree for the transaction.',
      { guidance: 'Check that the source tree is readable, then retry.', cause: error },
    );
  }

  return { stagedPath, stageId };
}

async function cleanStaleStagingDirs(stagingRoot: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(stagingRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('skill-')) {
      await fs.remove(path.join(stagingRoot, entry.name)).catch(() => {});
    }
  }
}

// ─── Preview (hash-based diff + local drift) ─────────────────────────────

export type DiffEntry = {
  relPath: string;
  status: 'added' | 'changed' | 'removed';
  oldHash?: string;
  newHash?: string;
};

export type TransactionPreview = {
  name: string;
  mode: 'copy' | 'link';
  diff: DiffEntry[];
  /** True when the live installed tree's hash differs from the recorded hash. */
  hasLocalDrift: boolean;
  recordedHash?: string;
  liveHash?: string;
  stagedHash: string;
  /**
   * True when applying this transaction would overwrite a locally-drifted
   * tree. The caller must require explicit confirmation before applying.
   */
  requiresConfirmation: boolean;
  /** Cached audit state carried from the existing record (spec §7.1). */
  auditView?: AuditView;
  /** Absolute link target (link mode only). */
  linkTargetPath?: string;
};

export type PreviewOptions = {
  profileRootPath: string;
  name: string;
  mode: 'copy' | 'link';
  stagedPath: string;
  /** Link target (link mode only). */
  linkTargetPath?: string;
};

/**
 * Hash-based file diff between the staged tree and the currently-installed
 * tree, plus a local-drift overwrite warning. Local drift (live hash ≠
 * recorded) means someone edited the installed copy since the last apply;
 * overwriting it requires explicit confirmation.
 */
export async function previewTransaction(options: PreviewOptions): Promise<TransactionPreview> {
  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  const livePath = resolveInside(skillsDir, options.name);

  const manifest = await loadSkillsProvenance(options.profileRootPath);
  const record = manifest.skills[options.name];
  const recordedHash = record?.contentHash;

  const liveExists = await fs.pathExists(livePath);
  const liveHash = liveExists ? await computeContentHash(livePath) : undefined;

  // Local drift is only meaningful when both a live tree and a recorded hash
  // exist and they disagree — i.e. the installed copy was edited out of band.
  const hasLocalDrift =
    liveHash !== undefined && recordedHash !== undefined && liveHash !== recordedHash;

  const stagedHash = await computeContentHash(options.stagedPath);
  const diff = await computeTreeDiff(liveExists ? livePath : undefined, options.stagedPath);

  // Overwriting a locally-drifted tree loses the out-of-band edit; the caller
  // must confirm. hasLocalDrift already implies a live tree exists (liveHash
  // is only set when liveExists), so it alone gates confirmation; a fresh
  // install never requires it.
  const requiresConfirmation = hasLocalDrift;

  // Carry the cached audit state from the existing record (spec §7.1 preview).
  const auditView = record ? computeAuditView(record, new Date()) : undefined;

  return {
    name: options.name,
    mode: options.mode,
    diff,
    hasLocalDrift,
    recordedHash,
    liveHash,
    stagedHash,
    requiresConfirmation,
    auditView,
    linkTargetPath: options.mode === 'link' ? options.linkTargetPath : undefined,
  };
}

async function computeTreeDiff(
  oldPath: string | undefined,
  newPath: string,
): Promise<DiffEntry[]> {
  const oldFiles = oldPath ? await collectFileHashes(oldPath) : new Map<string, string>();
  const newFiles = await collectFileHashes(newPath);

  const entries: DiffEntry[] = [];
  const allPaths = new Set<string>([...oldFiles.keys(), ...newFiles.keys()]);
  for (const relPath of allPaths) {
    const oldHash = oldFiles.get(relPath);
    const newHash = newFiles.get(relPath);
    if (oldHash === undefined && newHash !== undefined) {
      entries.push({ relPath, status: 'added', newHash });
    } else if (oldHash !== undefined && newHash === undefined) {
      entries.push({ relPath, status: 'removed', oldHash });
    } else if (oldHash !== undefined && newHash !== undefined && oldHash !== newHash) {
      entries.push({ relPath, status: 'changed', oldHash, newHash });
    }
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return entries;
}

async function collectFileHashes(rootPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await walkFiles(rootPath, '', map);
  return map;
}

async function walkFiles(
  dirFsPath: string,
  relPosixPath: string,
  map: Map<string, string>,
): Promise<void> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.readdir(dirFsPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const dirent of dirents) {
    const childFsPath = path.join(dirFsPath, dirent.name);
    const childRel = relPosixPath ? `${relPosixPath}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      await walkFiles(childFsPath, childRel, map);
    } else if (dirent.isSymbolicLink()) {
      const target = await fs.readlink(childFsPath);
      map.set(childRel, sha256Hex(target));
    } else if (dirent.isFile()) {
      map.set(childRel, await sha256FileHex(childFsPath));
    }
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

async function sha256FileHex(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

// ─── Apply (rename-swap transaction) ─────────────────────────────────────

export type ReplaceOldDisposition =
  | { kind: 'delete' }
  | {
      kind: 'bin';
      origin: 'remove' | 'update';
      appHomePath: string;
      profileName: string;
    };

/**
 * Test-only fault injection. The apply throws a sentinel CcpsError after
 * completing the named phase, leaving on-disk residue for crash-reconciliation
 * tests. A real process crash is equivalent: the same residue is reconciled by
 * the startup sweep.
 */
export type FaultPoint =
  | 'after-rename-tmp'
  | 'after-rename-old'
  | 'after-rename-new'
  | 'before-manifest';

export type ApplyOptions = {
  profileRootPath: string;
  profileName: string;
  name: string;
  /** Apply is copy-mode only; link installs use their own atomic symlink path. */
  mode: 'copy';
  stagedPath: string;
  source: SkillSource;
  /**
   * How to handle an existing tree at <name>. Default: delete outright. When
   * binning, the old tree is copied to the Recovery Bin (with the given
   * origin) before being deleted — `update` origin carries the fixed 3-day
   * TTL (spec §7.1/§9.2).
   */
  replaceOld?: ReplaceOldDisposition;
  /** Existing record (update path) — preserves installedAt and the audit cache. */
  existingRecord?: SkillProvenanceRecord;
  clock?: Clock;
  /**
   * @internal Test-only. Throws a sentinel CcpsError after the named phase,
   * simulating a process crash: residue is left for the startup sweep.
   */
  __fault?: FaultPoint;
  /**
   * @internal Test-only. Throws a plain Error after the named phase, simulating
   * a real (non-crash) failure: apply rolls back to pre-operation state.
   */
  __failAt?: FaultPoint;
};

export type ApplyResult = {
  name: string;
  targetPath: string;
  record: SkillProvenanceRecord;
  /** True when an existing tree was replaced. */
  replaced: boolean;
};

type ApplyPhase =
  | 'init'
  | 'tmp-staged'
  | 'old-moved'
  | 'new-live'
  | 'old-disposed'
  | 'manifest-written';

/**
 * Apply the staged tree by rename swap inside claude-home/skills/:
 * staged → .ccps-tmp-<id>, old → .ccps-old-<id>, .ccps-tmp-<id> → final,
 * delete old, then write the manifest atomically. Never in-place; verified
 * same-partition so every rename is atomic.
 */
export async function applySkillTransaction(options: ApplyOptions): Promise<ApplyResult> {
  validateProfileName(options.profileName);
  const clock = options.clock ?? (() => new Date());
  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  await fs.ensureDir(skillsDir);
  const targetPath = resolveInside(skillsDir, options.name);

  // Same-partition guarantee: the staged tree must live on the same filesystem
  // as the skills directory so the staged → .ccps-tmp rename is atomic.
  await assertSamePartition(options.stagedPath, skillsDir);

  const txId = randomBytes(6).toString('hex');
  const tmpPath = resolveInside(skillsDir, `${TX_TMP_PREFIX}${txId}`);
  const oldPath = resolveInside(skillsDir, `${TX_OLD_PREFIX}${txId}`);
  const sidecarPath = resolveInside(skillsDir, `${TX_SIDECAR_PREFIX}${txId}.json`);

  // Sidecar first: a crash any time after this point is reconcilable.
  await atomicWriteJson(sidecarPath, {
    version: TX_SIDECAR_SCHEMA_VERSION,
    id: txId,
    name: options.name,
    createdAt: clock().toISOString(),
  });

  let phase: ApplyPhase = 'init';
  let oldExists = false;
  try {
    // 1. staged → .ccps-tmp-<id> (atomic same-partition rename).
    await renameOrCrossPartitionError(options.stagedPath, tmpPath);
    phase = 'tmp-staged';
    maybeInjectFault(options, 'after-rename-tmp');

    // 2. old <name> → .ccps-old-<id> (if present).
    oldExists = await fs.pathExists(targetPath);
    if (oldExists) {
      await fs.rename(targetPath, oldPath);
    }
    phase = 'old-moved';
    maybeInjectFault(options, 'after-rename-old');

    // 3. .ccps-tmp-<id> → <name> (final). New tree is now live.
    await fs.rename(tmpPath, targetPath);
    phase = 'new-live';
    maybeInjectFault(options, 'after-rename-new');

    // 4. Dispose of the old tree (delete, or bin-then-delete).
    if (oldExists) {
      await disposeOldTree(oldPath, options.replaceOld ?? { kind: 'delete' }, options.name, clock);
    }
    phase = 'old-disposed';
    maybeInjectFault(options, 'before-manifest');

    // 5. Build and write the provenance record atomically (temp + rename).
    const record = await buildApplyRecord(options, targetPath, clock);
    const manifest = await loadSkillsProvenance(options.profileRootPath);
    manifest.skills[options.name] = record;
    await saveSkillsProvenance(options.profileRootPath, manifest);
    phase = 'manifest-written';

    // Success: the transaction is complete — drop the sidecar.
    await fs.remove(sidecarPath).catch(() => {});

    return { name: options.name, targetPath, record, replaced: oldExists };
  } catch (error) {
    if (isInjectedFault(error)) {
      // Simulated crash: leave the sidecar + residue for the startup sweep.
      throw error;
    }
    // Real failure: roll back to pre-operation state with no residue. Once the
    // new tree is live (new-live onward) the old tree may already be gone, so
    // rollback degrades to cleaning tmp/old residue and letting local drift
    // surface — identical to a crash at that phase, reconciled by the sweep.
    await rollbackTransaction(sidecarPath, tmpPath, oldPath, targetPath, phase).catch(() => {});
    throw error;
  }
}

async function renameOrCrossPartitionError(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EXDEV') {
      throw new CcpsError(
        'SKILL_TX_CROSS_PARTITION',
        'The staged tree and the skills directory are on different filesystems.',
        {
          guidance:
            'Move the ccps app home onto the same filesystem as the Profile skills directory so the rename swap is atomic.',
          cause: error,
        },
      );
    }
    throw error;
  }
}

async function assertSamePartition(leftPath: string, rightPath: string): Promise<void> {
  try {
    const [leftStat, rightStat] = await Promise.all([fs.stat(leftPath), fs.stat(rightPath)]);
    if (leftStat.dev !== rightStat.dev) {
      throw new CcpsError(
        'SKILL_TX_CROSS_PARTITION',
        'The staged tree and the skills directory are on different filesystems.',
        {
          guidance:
            'Move the ccps app home onto the same filesystem as the Profile skills directory so the rename swap is atomic.',
        },
      );
    }
  } catch (error) {
    if (error instanceof CcpsError) throw error;
    // stat failure is not itself a cross-partition error — let the rename surface it.
  }
}

async function disposeOldTree(
  oldPath: string,
  disposition: ReplaceOldDisposition,
  skillName: string,
  clock: Clock,
): Promise<void> {
  if (disposition.kind === 'delete') {
    await fs.remove(oldPath);
    return;
  }
  // Bin the old tree (copy to Recovery Bin), then delete the live copy. The
  // bin copy is taken from .ccps-old-<id>, so the recorded targetRelativePath
  // is the original skill location, not the transient .ccps-old name.
  await createFileTreeItem({
    appHomePath: disposition.appHomePath,
    origin: disposition.origin,
    kind: 'skill',
    profile: disposition.profileName,
    coordinates: { targetRelativePath: path.join('claude-home', 'skills', skillName) },
    sourcePath: oldPath,
    clock,
  });
  await fs.remove(oldPath);
}

async function buildApplyRecord(
  options: ApplyOptions,
  targetPath: string,
  clock: Clock,
): Promise<SkillProvenanceRecord> {
  const now = clock().toISOString();
  const contentHash = await computeContentHash(targetPath);
  const installedAt = options.existingRecord?.installedAt ?? now;

  const record: SkillProvenanceRecord = {
    mode: options.mode,
    source: options.source,
    contentHash,
    installedAt,
    updatedAt: now,
    sourceCheckedAt: now,
  };
  // applySkillTransaction is copy-mode only; link installs use their own
  // atomic symlink path and never reach here. The audit cache is preserved
  // across an update (spec §7.1 audit cache).
  if (options.existingRecord?.audit) {
    record.audit = options.existingRecord.audit;
  }
  return record;
}

async function rollbackTransaction(
  sidecarPath: string,
  tmpPath: string,
  oldPath: string,
  targetPath: string,
  phase: ApplyPhase,
): Promise<void> {
  // Criterion #6: any failure rolls back to pre-operation state with no
  // half-applied residue. Rollback is fully achievable up to and including
  // the swap (new-live) — the old tree is still at .ccps-old-<id> and can be
  // restored. Once the old tree has been disposed (old-disposed onward) it is
  // gone, so rollback degrades to cleaning residue; the live new tree stays
  // and the unwritten manifest surfaces as local drift (criterion #5), which
  // is the same path a hard crash takes at that phase.
  if (phase === 'tmp-staged') {
    await fs.remove(tmpPath).catch(() => {});
  } else if (phase === 'old-moved') {
    // targetPath was renamed away; restore it from .ccps-old, drop tmp.
    await fs.rename(oldPath, targetPath).catch(() => {});
    await fs.remove(tmpPath).catch(() => {});
  } else if (phase === 'new-live') {
    // The new tree is live at targetPath; the old tree is still at .ccps-old.
    // Restore pre-operation state: move new back to tmp, old back to target.
    const oldStillHeld = await fs.pathExists(oldPath);
    if (oldStillHeld) {
      await fs.rename(targetPath, tmpPath).catch(() => {});
      await fs.rename(oldPath, targetPath).catch(() => {});
      await fs.remove(tmpPath).catch(() => {});
    } else {
      // Fresh install (no old tree): pre-operation was "no <name>".
      await fs.remove(targetPath).catch(() => {});
    }
  } else {
    // old-disposed / before-manifest: old tree is gone, new tree is the
    // intended result. Clean any tmp residue; drift surfaces from the stale
    // manifest. (A real crash here is reconciled by the startup sweep.)
    await fs.remove(tmpPath).catch(() => {});
  }
  await fs.remove(sidecarPath).catch(() => {});
}

function crashFault(point: FaultPoint): CcpsError {
  return new CcpsError(FAULT_ERROR_CODE, `Fault injected at ${point} (test-only).`, {
    guidance: 'This is a simulated crash for reconciliation tests.',
  });
}

function rollbackFault(point: FaultPoint): Error {
  return new Error(`Real failure injected at ${point} (test-only).`);
}

function isInjectedFault(error: unknown): boolean {
  return error instanceof CcpsError && error.code === FAULT_ERROR_CODE;
}

/**
 * Test-only fault injection at a phase boundary. `__fault` simulates a process
 * crash (leaves residue for the startup sweep); `__failAt` simulates a real
 * failure (triggers rollback). A real crash is indistinguishable from `__fault`
 * because both leave the same on-disk residue and skip the catch-block rollback.
 */
function maybeInjectFault(options: ApplyOptions, point: FaultPoint): void {
  if (options.__fault === point) throw crashFault(point);
  if (options.__failAt === point) throw rollbackFault(point);
}

// ─── Crash-state reconciliation (startup sweep) ──────────────────────────

export type CrashReconcileAction =
  | 'deleted-tmp'
  | 'deleted-old'
  | 'renamed-old-back'
  | 'deleted-stale-sidecar';

export type CrashReconcileEntry = { id: string; name: string; action: CrashReconcileAction };

export type CrashReconcileResult = {
  entries: CrashReconcileEntry[];
};

/**
 * Reconcile the three enumerable crash states (spec §7.1) for one Profile by
 * scanning claude-home/skills/ for transaction sidecars:
 *
 *   - tmp residue only              → delete tmp
 *   - old + final both present      → delete old (apply had succeeded)
 *   - old present without final     → rename old back to final (rollback)
 *
 * A crash between the file swap and the manifest write leaves no tmp/old
 * residue (only a stale sidecar); the sweep drops the sidecar and the
 * mismatch surfaces as local drift via computeDrift.
 */
export async function reconcileSkillTransactionCrashStates(
  profileRootPath: string,
): Promise<CrashReconcileResult> {
  const skillsDir = getSkillsDirectoryPath(profileRootPath);
  const sidecars = await listSidecars(skillsDir);
  const entries: CrashReconcileEntry[] = [];

  for (const sidecar of sidecars) {
    const entry = await reconcileOne(skillsDir, sidecar);
    if (entry) entries.push(entry);
  }

  return { entries };
}

async function reconcileOne(
  skillsDir: string,
  sidecar: { id: string; name: string },
): Promise<CrashReconcileEntry | null> {
  if (!isValidSkillName(sidecar.name)) {
    // A corrupt or hostile sidecar name is left for manual inspection.
    return null;
  }

  const tmpPath = resolveInside(skillsDir, `${TX_TMP_PREFIX}${sidecar.id}`);
  const oldPath = resolveInside(skillsDir, `${TX_OLD_PREFIX}${sidecar.id}`);
  const sidecarPath = resolveInside(skillsDir, `${TX_SIDECAR_PREFIX}${sidecar.id}.json`);
  const finalPath = resolveInside(skillsDir, sidecar.name);

  const [tmpExists, oldExists, finalExists] = await Promise.all([
    fs.pathExists(tmpPath),
    fs.pathExists(oldPath),
    fs.pathExists(finalPath),
  ]);

  let action: CrashReconcileAction;
  if (oldExists && finalExists) {
    // Apply had succeeded (swap done); old not yet deleted.
    await fs.remove(oldPath).catch(() => {});
    if (tmpExists) await fs.remove(tmpPath).catch(() => {});
    action = 'deleted-old';
  } else if (oldExists && !finalExists) {
    // Crash during the swap: old was moved, new not yet renamed to final.
    await fs.rename(oldPath, finalPath).catch(() => {});
    if (tmpExists) await fs.remove(tmpPath).catch(() => {});
    action = 'renamed-old-back';
  } else if (tmpExists) {
    // tmp residue only (staged→tmp crashed before old moved, or a fresh
    // install crashed before the swap).
    await fs.remove(tmpPath).catch(() => {});
    action = 'deleted-tmp';
  } else {
    // No tmp, no old — stale sidecar (e.g. manifest-write crash left no
    // residue). The live tree's hash divergence surfaces as local drift.
    action = 'deleted-stale-sidecar';
  }

  await fs.remove(sidecarPath).catch(() => {});
  return { id: sidecar.id, name: sidecar.name, action };
}

async function listSidecars(
  skillsDir: string,
): Promise<Array<{ id: string; name: string }>> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }

  const sidecars: Array<{ id: string; name: string }> = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.startsWith(TX_SIDECAR_PREFIX) || !dirent.name.endsWith('.json')) continue;
    const sidecarPath = path.join(skillsDir, dirent.name);
    try {
      const raw = await fs.readJson(sidecarPath);
      if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as { id?: unknown }).id === 'string' &&
        typeof (raw as { name?: unknown }).name === 'string'
      ) {
        sidecars.push({
          id: (raw as { id: string }).id,
          name: (raw as { name: string }).name,
        });
      }
    } catch {
      // Unreadable sidecar — skip (leave for manual inspection).
    }
  }
  return sidecars;
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isValidSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name === name.trim() &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name) &&
    SKILL_NAME_RE.test(name)
  );
}

/**
 * Reconcile transaction crash states for every Profile under the app home.
 * Called by the startup sweep (spec §9.4).
 */
export async function reconcileAllProfilesTransactionCrashStates(
  appHomePath: string,
): Promise<CrashReconcileResult> {
  const { profilesPath } = getAppHomePaths(appHomePath);
  const allEntries: CrashReconcileEntry[] = [];

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.readdir(profilesPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { entries: [] };
    throw error;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const profileRoot = path.join(profilesPath, dirent.name);
    const result = await reconcileSkillTransactionCrashStates(profileRoot).catch(() => ({
      entries: [],
    }));
    allEntries.push(...result.entries);
  }

  return { entries: allEntries };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
