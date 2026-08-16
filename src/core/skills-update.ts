import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';

import {
  acquireSkillIntoStaging,
  verifyStagedSkillIdentity,
} from './skills-acquisition';
import {
  canDiffVsSource,
  computeAuditView,
  computeContentHash,
  getSkillsDirectoryPath,
  loadSkillsProvenance,
  saveSkillsProvenance,
} from './skills-provenance';
import {
  applySkillTransaction,
  computeTreeDiff,
  getStagingPath,
  previewTransaction,
  stageSkillTree,
  type TransactionPreview,
} from './skills-transaction';
import { validateSkillDirectoryName } from './skills-install';
import { resolveInside, validateProfileName } from '../platform/path';
import { captureProcess as defaultCaptureProcess, type CaptureProcess } from '../platform/process';
import type { AuditView, DisabledReason, SkillProvenanceRecord, SkillSourceKind } from '../schemas/skills-provenance';
import { CcpsError } from '../utils/errors';
import { type Clock } from './types';

export type { Clock } from './types';

// Skill update modes and Diff-vs-source (spec §7.1 update, §12 Diff).
//
// Three update modes, all routing copied updates through the transaction engine
// (issue #65) and the Recovery Bin (issue #70):
//
//   remote  — a copied Skill whose recorded source is git-remote/url. The exact
//             recorded source is re-acquired through the pinned adapter into
//             staging (never `skills update`), diffed, and applied via the
//             rename-swap transaction. The replaced tree lands in the Bin as an
//             `origin: update` item with the fixed 3-day TTL.
//   local   — a copied Skill whose recorded source is a local directory inside
//             a git repository. One `git pull --ff-only` on the discovered repo
//             refreshes every copy Skill sharing it, then each is hash-diffed
//             and re-copied through the same transaction. A dirty working tree
//             aborts; a repo without an origin/upstream is disabled with reason.
//   linked  — a Linked Skill. The same one-click repo pull makes the new source
//             content live immediately (the link follows the source); no Bin
//             item is created — git itself is the undo mechanism.
//
// Undo of a successful update is the standard Bin restore: the replaced tree is
// a normal file-tree Recovery Item, so restore and the inline delete-and-restore
// path behave exactly like any other removal.
//
// Diff-vs-source (copied Skills) renders the hash-tree comparison: changed /
// new-at-source / gone-at-source. Same-named Skills with different sources are
// compared per Profile against that Skill's own recorded source.

// ─── Update plan (pure classification) ─────────────────────────────────

export type SkillUpdateKind = 'remote' | 'local' | 'linked';

export type SkillUpdatePlan =
  | { kind: 'remote'; sourceUrl: string; skillPath?: string; ref?: string }
  | { kind: 'local'; repoRoot: string; sourcePath: string; remoteUrl: string }
  | { kind: 'linked'; repoRoot: string; linkTargetPath?: string; remoteUrl: string }
  | { kind: 'disabled'; reason: DisabledReason };

/**
 * Pure classification of how a Skill record updates. Carries the concrete source
 * coordinates the update needs, and degrades to a `disabled` plan (never a
 * crash) when a record is corrupt or backfilled: a link without a local repo, a
 * local copy without a path, or a remote record without a URL.
 */
export function buildSkillUpdatePlan(record: SkillProvenanceRecord): SkillUpdatePlan {
  if (record.source.kind === 'unknown') {
    return { kind: 'disabled', reason: 'no-source' };
  }

  if (record.mode === 'link') {
    // A link always targets a local source directory; any other shape is a
    // corrupt or backfilled record — disable with a reason rather than crash.
    if (record.source.kind !== 'local' || !record.source.repo) {
      return { kind: 'disabled', reason: 'no-git-repo' };
    }
    if (!record.source.repo.remoteUrl) {
      return { kind: 'disabled', reason: 'no-remote' };
    }
    return {
      kind: 'linked',
      repoRoot: record.source.repo.root,
      linkTargetPath: record.link?.targetPath,
      remoteUrl: record.source.repo.remoteUrl,
    };
  }

  if (record.source.kind === 'local') {
    if (!record.source.repo) {
      return { kind: 'disabled', reason: 'no-git-repo' };
    }
    if (!record.source.repo.remoteUrl) {
      return { kind: 'disabled', reason: 'no-remote' };
    }
    if (!record.source.path) {
      return { kind: 'disabled', reason: 'no-source' };
    }
    return {
      kind: 'local',
      repoRoot: record.source.repo.root,
      sourcePath: record.source.path,
      remoteUrl: record.source.repo.remoteUrl,
    };
  }

  if (!record.source.url) {
    return { kind: 'disabled', reason: 'no-source' };
  }
  return {
    kind: 'remote',
    sourceUrl: record.source.url,
    skillPath: record.source.skillPath,
    ref: record.source.ref,
  };
}

// ─── Preview ────────────────────────────────────────────────────────────

export type PreviewSkillUpdateOptions = {
  appHomePath: string;
  profileRootPath: string;
  profileName: string;
  name: string;
  captureProcess?: CaptureProcess;
  clock?: Clock;
};

export type SkillUpdatePreview = {
  name: string;
  mode: 'copy' | 'link';
  kind: SkillUpdateKind;
  /** Repo pulled for local/linked modes. */
  pulled: boolean;
  repoRoot?: string;
  remoteUrl?: string;
  /** Link mode only: the recorded link target (spec §7.1 preview contract). */
  linkTargetPath?: string;
  /** Cached audit state from the existing record (spec §7.1 preview contract). */
  auditView?: AuditView;
  /** Copy mode only: the hash-based file diff preview. */
  transaction?: TransactionPreview;
  /** Copy mode only: the staged tree to pass to applySkillUpdate. */
  stagedPath?: string;
  /** Local mode only: other copied Skills in this Profile sharing the same repo. */
  shared: string[];
  /**
   * Copy mode only: the staged source is byte-identical to the installed tree
   * (and no local drift) — applying would change nothing.
   */
  noop?: boolean;
};

/**
 * Prepare a Skill update without touching the Profile. Copy modes stage the new
 * tree outside the Profile and compute the diff preview; local/linked modes
 * perform the repo pull (the source diff is only knowable after it). The staged
 * tree is kept alive for applySkillUpdate.
 */
export async function previewSkillUpdate(options: PreviewSkillUpdateOptions): Promise<SkillUpdatePreview> {
  validateProfileName(options.profileName);
  validateSkillDirectoryName(options.name);
  const record = await loadRecordForSkill(options.profileRootPath, options.name);
  const plan = buildSkillUpdatePlan(record);
  if (plan.kind === 'disabled') {
    throw updateDisabledError(plan.reason, options.name);
  }

  if (plan.kind === 'remote') {
    return previewRemoteUpdate(options, plan);
  }
  if (plan.kind === 'local') {
    return previewLocalUpdate(options, plan);
  }
  return previewLinkedUpdate(options, record, plan);
}

async function previewRemoteUpdate(
  options: PreviewSkillUpdateOptions,
  plan: Extract<SkillUpdatePlan, { kind: 'remote' }>,
): Promise<SkillUpdatePreview> {
  const acquired = await acquireRecordedRemoteSource({
    appHomePath: options.appHomePath,
    sourceUrl: plan.sourceUrl,
    skillPath: plan.skillPath,
    captureProcess: options.captureProcess,
  });
  try {
    const { stagedPath } = await stageSkillTree({
      appHomePath: options.appHomePath,
      preStagedPath: acquired.stagedSkillPath,
    });
    const transaction = await previewTransaction({
      profileRootPath: options.profileRootPath,
      name: options.name,
      mode: 'copy',
      stagedPath,
    });
    return {
      name: options.name,
      mode: 'copy',
      kind: 'remote',
      pulled: false,
      transaction,
      stagedPath,
      shared: [],
      noop: transaction.diff.length === 0 && !transaction.hasLocalDrift,
    };
  } finally {
    await fs.remove(acquired.stagingRoot).catch(() => {});
  }
}

async function previewLocalUpdate(
  options: PreviewSkillUpdateOptions,
  plan: Extract<SkillUpdatePlan, { kind: 'local' }>,
): Promise<SkillUpdatePreview> {
  if (!(await fs.pathExists(plan.sourcePath))) {
    throw new CcpsError(
      'SKILL_UPDATE_SOURCE_MISSING',
      `The source tree for "${options.name}" no longer exists at ${plan.sourcePath}.`,
      {
        guidance:
          '1. Restore the recorded local source path.\n2. Or reinstall the Skill from a remote source.\n3. Retry the update.',
      },
    );
  }
  await assertRepoClean(plan.repoRoot, options.captureProcess);
  await assertRepoHasUpstream(plan.repoRoot, options.name, options.captureProcess);
  await pullRepo(plan.repoRoot, options.captureProcess);

  const { stagedPath } = await stageSkillTree({
    appHomePath: options.appHomePath,
    localSourcePath: plan.sourcePath,
  });
  const transaction = await previewTransaction({
    profileRootPath: options.profileRootPath,
    name: options.name,
    mode: 'copy',
    stagedPath,
  });
  const shared = await listSharedRepoSkills(options.profileRootPath, plan.repoRoot, options.name);
  return {
    name: options.name,
    mode: 'copy',
    kind: 'local',
    pulled: true,
    repoRoot: plan.repoRoot,
    remoteUrl: plan.remoteUrl,
    transaction,
    stagedPath,
    shared,
    noop: transaction.diff.length === 0 && !transaction.hasLocalDrift,
  };
}

async function previewLinkedUpdate(
  options: PreviewSkillUpdateOptions,
  record: SkillProvenanceRecord,
  plan: Extract<SkillUpdatePlan, { kind: 'linked' }>,
): Promise<SkillUpdatePreview> {
  await assertRepoClean(plan.repoRoot, options.captureProcess);
  await assertRepoHasUpstream(plan.repoRoot, options.name, options.captureProcess);
  await pullRepo(plan.repoRoot, options.captureProcess);
  return {
    name: options.name,
    mode: 'link',
    kind: 'linked',
    pulled: true,
    repoRoot: plan.repoRoot,
    remoteUrl: plan.remoteUrl,
    linkTargetPath: plan.linkTargetPath,
    // Cached audit state, carried from the existing record (spec §7.1 preview).
    auditView: computeAuditView(record, (options.clock ?? (() => new Date()))()),
    shared: [],
  };
}

// ─── Apply ──────────────────────────────────────────────────────────────

export type ApplySkillUpdateOptions = {
  appHomePath: string;
  profileRootPath: string;
  profileName: string;
  name: string;
  /** Copy mode only: the staged tree from previewSkillUpdate. */
  stagedPath?: string;
  /**
   * Required when the preview reported a locally-drifted installed tree that the
   * update would overwrite. The caller must surface the overwrite and get
   * explicit confirmation (spec §7.1 preview).
   */
  confirmDriftOverwrite?: boolean;
  captureProcess?: CaptureProcess;
  clock?: Clock;
};

export type AppliedSkill = {
  name: string;
  /** Nothing changed at the source and the installed copy matches the record. */
  noop: boolean;
  /** The on-disk tree changed as a result of this update. */
  replaced: boolean;
  /** Recovery Item id of the replaced tree (`origin: update`), when one was binned. */
  binItemId?: string;
  /**
   * True when this shared-repo Skill was skipped because its installed copy has
   * local drift that would need explicit confirmation the caller did not give.
   * The primary Skill still applied; the caller can re-run with confirmation.
   */
  skippedDrift?: boolean;
};

export type ApplySkillUpdateResult = {
  name: string;
  mode: 'copy' | 'link';
  applied: AppliedSkill[];
  record: SkillProvenanceRecord;
};

/**
 * Apply a previously previewed update. Copied modes run the staged tree through
 * the rename-swap transaction with `origin: update` binning; local mode also
 * re-copies every other copied Skill in the Profile sharing the pulled repo.
 * Linked mode re-records the (now-live) source content — no Bin item, no
 * transaction: git itself is the undo.
 */
export async function applySkillUpdate(options: ApplySkillUpdateOptions): Promise<ApplySkillUpdateResult> {
  validateProfileName(options.profileName);
  validateSkillDirectoryName(options.name);
  const record = await loadRecordForSkill(options.profileRootPath, options.name);
  const plan = buildSkillUpdatePlan(record);
  if (plan.kind === 'disabled') {
    throw updateDisabledError(plan.reason, options.name);
  }

  if (plan.kind === 'linked') {
    return applyLinkedUpdate(options, record);
  }

  if (!options.stagedPath) {
    throw new CcpsError(
      'SKILL_UPDATE_STAGED_REQUIRED',
      `Updating "${options.name}" requires the staged tree from previewSkillUpdate.`,
      {
        guidance: '1. Run previewSkillUpdate first.\n2. Pass its stagedPath to applySkillUpdate.',
      },
    );
  }

  const applied: AppliedSkill[] = [];
  applied.push(await applyCopiedSkill(options, record, options.stagedPath));

  // Local mode: one pull refreshed the shared repo — re-copy every other copied
  // Skill in this Profile that draws from it (spec §7.1 "one pull refreshes all
  // Skills sharing the repo"). A shared Skill with local drift is skipped, not
  // fatal: its overwrite was never previewed/confirmed, and the primary already
  // applied — a mid-batch throw would leave a partial update.
  if (plan.kind === 'local') {
    const shared = await listSharedRepoSkills(options.profileRootPath, plan.repoRoot, options.name);
    for (const sharedName of shared) {
      const sharedRecord = (await loadSkillsProvenance(options.profileRootPath)).skills[sharedName];
      if (!sharedRecord || sharedRecord.mode !== 'copy' || sharedRecord.source.kind !== 'local') {
        continue;
      }
      const sharedSourcePath = sharedRecord.source.path;
      if (!sharedSourcePath || !(await fs.pathExists(sharedSourcePath))) {
        continue;
      }
      const { stagedPath } = await stageSkillTree({
        appHomePath: options.appHomePath,
        localSourcePath: sharedSourcePath,
      });
      try {
        applied.push(
          await applyCopiedSkill(
            { ...options, name: sharedName },
            sharedRecord,
            stagedPath,
          ),
        );
      } catch (error) {
        if (isDriftConfirmError(error)) {
          applied.push({ name: sharedName, noop: false, replaced: false, skippedDrift: true });
          continue;
        }
        throw error;
      }
    }
  }

  const finalRecord = (await loadSkillsProvenance(options.profileRootPath)).skills[options.name];
  return { name: options.name, mode: 'copy', applied, record: finalRecord };
}

async function applyCopiedSkill(
  options: ApplySkillUpdateOptions,
  record: SkillProvenanceRecord,
  stagedPath: string,
): Promise<AppliedSkill> {
  // No-op when the staged source matches the recorded tree AND the installed
  // copy matches the record — applying would change nothing (no Bin item for a
  // content-identical update).
  const installedPath = resolveInside(getSkillsDirectoryPath(options.profileRootPath), options.name);
  const stagedHash = await computeContentHash(stagedPath);
  const liveExists = await fs.pathExists(installedPath);
  const liveHash = liveExists ? await computeContentHash(installedPath) : undefined;
  if (stagedHash === record.contentHash && liveHash === record.contentHash) {
    return { name: options.name, noop: true, replaced: false };
  }

  // Overwriting a locally-drifted copy loses the out-of-band edit; the caller
  // must have confirmed (spec §7.1 preview requires explicit confirmation).
  const hasDrift =
    liveHash !== undefined && record.contentHash !== undefined && liveHash !== record.contentHash;
  if (hasDrift && options.confirmDriftOverwrite !== true) {
    throw new CcpsError(
      'SKILL_UPDATE_DRIFT_CONFIRM_REQUIRED',
      `Updating "${options.name}" would overwrite local edits made to the installed copy.`,
      {
        guidance: 'Confirm the overwrite to proceed, or undo the local edits and retry.',
      },
    );
  }

  const result = await applySkillTransaction({
    profileRootPath: options.profileRootPath,
    profileName: options.profileName,
    name: options.name,
    mode: 'copy',
    stagedPath,
    source: record.source,
    replaceOld: {
      kind: 'bin',
      origin: 'update',
      appHomePath: options.appHomePath,
      profileName: options.profileName,
    },
    existingRecord: record,
    clock: options.clock,
  });
  return { name: options.name, noop: false, replaced: result.replaced, binItemId: result.binItemId };
}

async function applyLinkedUpdate(
  options: ApplySkillUpdateOptions,
  record: SkillProvenanceRecord,
): Promise<ApplySkillUpdateResult> {
  const linkTarget = record.link?.targetPath;
  if (!linkTarget || !(await fs.pathExists(linkTarget))) {
    throw new CcpsError(
      'SKILL_UPDATE_LINK_BROKEN',
      `The Linked Skill "${options.name}" source is missing at ${linkTarget ?? 'unknown'}.`,
      {
        guidance:
          '1. Restore or relocate the link source.\n2. Re-create the link if needed.\n3. Retry the update.',
      },
    );
  }

  const clock = options.clock ?? (() => new Date());
  // Hash follows the link, so this is the live source content (spec §7.1).
  const installedPath = resolveInside(getSkillsDirectoryPath(options.profileRootPath), options.name);
  const liveHash = await computeContentHash(installedPath);
  const noop = liveHash === record.contentHash;

  const updatedRecord: SkillProvenanceRecord = {
    ...record,
    contentHash: liveHash,
    updatedAt: clock().toISOString(),
    sourceCheckedAt: clock().toISOString(),
  };
  const manifest = await loadSkillsProvenance(options.profileRootPath);
  manifest.skills[options.name] = updatedRecord;
  await saveSkillsProvenance(options.profileRootPath, manifest);

  // No Bin item: git is the undo mechanism for linked updates (spec §7.1).
  return {
    name: options.name,
    mode: 'link',
    applied: [{ name: options.name, noop, replaced: !noop }],
    record: updatedRecord,
  };
}

// ─── Diff vs source ─────────────────────────────────────────────────────

export type SkillSourceDiffEntry = {
  relPath: string;
  verdict: 'changed' | 'new-at-source' | 'gone-at-source';
  profileHash?: string;
  sourceHash?: string;
};

export type SkillVsSourceDiff = {
  name: string;
  mode: 'copy' | 'link';
  sourceKind: SkillSourceKind;
  sourceDescription: string;
  entries: SkillSourceDiffEntry[];
  changedCount: number;
  newAtSourceCount: number;
  goneAtSourceCount: number;
  /** True when a local recorded source path no longer exists. */
  sourceMissing: boolean;
};

export type DiffSkillVsSourceOptions = {
  appHomePath: string;
  profileRootPath: string;
  name: string;
  captureProcess?: CaptureProcess;
};

/**
 * Hash-tree diff of the installed Skill against its own recorded source
 * (spec §12): `changed` / `new-at-source` / `gone-at-source`. A local source is
 * compared in place; a remote source is re-acquired through the pinned adapter
 * into staging (never written into the Profile) and cleaned up afterwards.
 * Same-named Skills with different sources each compare against their own record
 * because this API reads the Profile's own manifest.
 */
export async function diffSkillVsSource(options: DiffSkillVsSourceOptions): Promise<SkillVsSourceDiff> {
  validateSkillDirectoryName(options.name);
  const record = await loadRecordForSkill(options.profileRootPath, options.name);
  const capability = canDiffVsSource(record);
  if (!capability.enabled) {
    throw diffDisabledError(capability.reason ?? 'no-source', options.name);
  }

  let sourceTreePath: string;
  let cleanupRoot: string | undefined;

  if (record.source.kind === 'local' && record.source.path) {
    sourceTreePath = record.source.path;
    if (!(await fs.pathExists(sourceTreePath))) {
      return {
        name: options.name,
        mode: record.mode,
        sourceKind: 'local',
        sourceDescription: sourceTreePath,
        entries: [],
        changedCount: 0,
        newAtSourceCount: 0,
        goneAtSourceCount: 0,
        sourceMissing: true,
      };
    }
  } else {
    if (!record.source.url) {
      throw new CcpsError(
        'SKILL_DIFF_DISABLED',
        `Skill "${options.name}" has a remote source with no recorded URL; it cannot be diffed.`,
        {
          guidance:
            'Reinstall the Skill from a real remote source to enable diff-vs-source.',
        },
      );
    }
    const acquired = await acquireRecordedRemoteSource({
      appHomePath: options.appHomePath,
      sourceUrl: record.source.url,
      skillPath: record.source.skillPath,
      captureProcess: options.captureProcess,
    });
    sourceTreePath = acquired.stagedSkillPath;
    cleanupRoot = acquired.stagingRoot;
  }

  try {
    const profilePath = resolveInside(getSkillsDirectoryPath(options.profileRootPath), options.name);
    const raw = await computeTreeDiff(profilePath, sourceTreePath);
    const entries: SkillSourceDiffEntry[] = raw.map((entry) => ({
      relPath: entry.relPath,
      verdict:
        entry.status === 'added'
          ? 'new-at-source'
          : entry.status === 'removed'
            ? 'gone-at-source'
            : 'changed',
      profileHash:
        entry.status === 'removed' || entry.status === 'changed' ? entry.oldHash : undefined,
      sourceHash: entry.status === 'added' || entry.status === 'changed' ? entry.newHash : undefined,
    }));

    return {
      name: options.name,
      mode: record.mode,
      sourceKind: record.source.kind,
      sourceDescription:
        record.source.kind === 'local' ? record.source.path! : record.source.url!,
      entries,
      changedCount: entries.filter((e) => e.verdict === 'changed').length,
      newAtSourceCount: entries.filter((e) => e.verdict === 'new-at-source').length,
      goneAtSourceCount: entries.filter((e) => e.verdict === 'gone-at-source').length,
      sourceMissing: false,
    };
  } finally {
    if (cleanupRoot) {
      await fs.remove(cleanupRoot).catch(() => {});
    }
  }
}

// ─── Git helpers ────────────────────────────────────────────────────────

/**
 * Dirty-repo check (spec §7.1): aborts the update when the source repo has
 * uncommitted *tracked* changes. Untracked files (`??` porcelain lines) do not
 * block a fast-forward pull and are not treated as dirty.
 */
async function assertRepoClean(repoRoot: string, captureProcess?: CaptureProcess): Promise<void> {
  const run = captureProcess ?? defaultCaptureProcess;
  const result = await run('git', ['-C', repoRoot, 'status', '--porcelain'], {
    cwd: repoRoot,
    shell: false,
    env: process.env,
  });
  if (result.exitCode !== 0) {
    // Could not determine cleanliness — let the pull (the operation that matters)
    // surface the real git problem rather than guessing.
    return;
  }
  const dirty = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .some((line) => !line.startsWith('?? '));
  if (dirty) {
    throw new CcpsError(
      'SKILL_UPDATE_DIRTY_REPO',
      `The source repo ${repoRoot} has uncommitted changes; the update aborted.`,
      {
        guidance:
          '1. Commit or stash the local changes in the source repo.\n2. Retry the update.',
      },
    );
  }
}

/**
 * Missing-upstream check (spec §7.1 "missing remote/upstream disables with
 * reason"). A repo can have an origin yet the current branch track no upstream;
 * `git pull` would then fail mid-update. Detect it before pulling so the user
 * gets a stated reason instead of a pull failure.
 */
async function assertRepoHasUpstream(
  repoRoot: string,
  skillName: string,
  captureProcess?: CaptureProcess,
): Promise<void> {
  const run = captureProcess ?? defaultCaptureProcess;
  const result = await run(
    'git',
    ['-C', repoRoot, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd: repoRoot, shell: false, env: process.env },
  );
  if (result.exitCode !== 0) {
    throw new CcpsError(
      'SKILL_UPDATE_DISABLED',
      `Skill "${skillName}" is copied from a git repository whose current branch has no upstream; it cannot be pulled.`,
      {
        guidance:
          '1. Set an upstream for the current branch (git push -u origin <branch>).\n2. Or set the remote tracking branch, then retry the update.',
      },
    );
  }
}

/** One `git pull --ff-only` per repo (spec §7.1). */
async function pullRepo(repoRoot: string, captureProcess?: CaptureProcess): Promise<void> {
  const run = captureProcess ?? defaultCaptureProcess;
  const result = await run('git', ['-C', repoRoot, 'pull', '--ff-only'], {
    cwd: repoRoot,
    shell: false,
    env: process.env,
  });
  if (result.exitCode !== 0) {
    const detail = [result.stdout, result.stderr]
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0)
      .join(' | ')
      .slice(0, 400);
    throw new CcpsError(
      'SKILL_UPDATE_PULL_FAILED',
      `git pull --ff-only failed in ${repoRoot}.`,
      {
        guidance: `1. Resolve the repository state (a non-fast-forward needs local handling).\n2. Retry the update.\n${detail}`,
      },
    );
  }
}

// ─── Remote re-acquisition ──────────────────────────────────────────────

/**
 * Re-acquire the exact recorded source through the pinned adapter into a
 * throwaway staging root under the app-home staging area. The recorded URL is
 * the source identity (never `skills update`); the recorded `skillPath` supplies
 * the `--skill` selection hint for tree-URL sources. The staging root is removed
 * by the caller (preview/diff), which also removes it on failure.
 */
async function acquireRecordedRemoteSource(options: {
  appHomePath: string;
  sourceUrl: string;
  skillPath?: string;
  captureProcess?: CaptureProcess;
}): Promise<{ stagedSkillPath: string; stagedName: string; stagingRoot: string }> {
  const id = randomBytes(6).toString('hex');
  const stagingRoot = resolveInside(getStagingPath(options.appHomePath), `remote-${id}`);
  const skill =
    options.skillPath && options.skillPath.trim().length > 0
      ? path.posix.basename(options.skillPath.replace(/\\/g, '/'))
      : undefined;

  try {
    const result = await acquireSkillIntoStaging({
      source: options.sourceUrl,
      skill,
      stagingPath: stagingRoot,
      captureProcess: options.captureProcess,
    });
    const stagedName = result.stagedSkills[0];
    await verifyStagedSkillIdentity({
      stagedSkillsPath: result.plan.stagedSkillsPath,
      stagedName,
    });
    return {
      stagedSkillPath: path.join(result.plan.stagedSkillsPath, stagedName),
      stagedName,
      stagingRoot,
    };
  } catch (error) {
    await fs.remove(stagingRoot).catch(() => {});
    throw error;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function loadRecordForSkill(
  profileRootPath: string,
  name: string,
): Promise<SkillProvenanceRecord> {
  const manifest = await loadSkillsProvenance(profileRootPath);
  const record = manifest.skills[name];
  if (!record) {
    throw new CcpsError(
      'SKILL_NOT_FOUND',
      `Skill "${name}" is not installed in this Profile.`,
      {
        guidance: 'Install the Skill before updating or diffing it.',
      },
    );
  }
  return record;
}

async function listSharedRepoSkills(
  profileRootPath: string,
  repoRoot: string,
  excludeName: string,
): Promise<string[]> {
  const manifest = await loadSkillsProvenance(profileRootPath);
  return Object.entries(manifest.skills)
    .filter(
      ([name, record]) =>
        name !== excludeName &&
        record.mode === 'copy' &&
        record.source.kind === 'local' &&
        record.source.repo?.root === repoRoot,
    )
    .map(([name]) => name)
    .sort();
}

function isDriftConfirmError(error: unknown): boolean {
  return error instanceof CcpsError && error.code === 'SKILL_UPDATE_DRIFT_CONFIRM_REQUIRED';
}

function updateDisabledError(reason: DisabledReason, name: string): CcpsError {
  const messages: Record<DisabledReason, string> = {
    'no-source': `Skill "${name}" has no recorded source and cannot be updated.`,
    'no-git-repo': `Skill "${name}" is copied from a local directory outside a git repository; there is nothing to pull.`,
    'no-remote': `Skill "${name}" is copied from a local git repository without a remote or upstream to pull from.`,
    'link-mode': `Skill "${name}" is a Linked Skill and cannot be updated through the copied path.`,
  };
  return new CcpsError('SKILL_UPDATE_DISABLED', messages[reason], {
    guidance:
      'Reinstall the Skill from a remote or git-backed source to enable updates, or update it manually.',
  });
}

function diffDisabledError(reason: DisabledReason, name: string): CcpsError {
  const messages: Record<DisabledReason, string> = {
    'no-source': `Skill "${name}" has no recorded source and cannot be diffed against one.`,
    'no-git-repo': `Skill "${name}" has no recorded git repository to diff against.`,
    'no-remote': `Skill "${name}" has no remote source to diff against.`,
    'link-mode': `Skill "${name}" is a Linked Skill — its Profile tree is the live source, so diff-vs-source is a no-op.`,
  };
  return new CcpsError('SKILL_DIFF_DISABLED', messages[reason], {
    guidance: 'Diff-vs-source applies to Copied Skills with a recorded source.',
  });
}
