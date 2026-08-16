import { randomBytes } from 'node:crypto';
import fs from 'fs-extra';

import {
  acquireSkillIntoStaging,
  buildSkillsAcquisitionPlan,
  classifyRemoteSkillSource,
  verifyStagedSkillIdentity,
  type ClassifiedRemoteSource,
  type SkillsAcquisitionPlan,
  type StagedSkillIdentity,
} from './skills-acquisition';
import { validateSkillDirectoryName } from './skills-install';
import { getSkillsDirectoryPath } from './skills-provenance';
import {
  applySkillTransaction,
  type FaultPoint,
  type ReplaceOldDisposition,
} from './skills-transaction';
import type { SkillProvenanceRecord, SkillSource } from '../schemas/skills-provenance';
import { resolveInside, validateProfileName } from '../platform/path';
import { type CaptureProcess } from '../platform/process';
import { type Clock } from './types';
import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';
import { coreTx, sourceKindLabelCore, type CoreTranslator } from '../utils/i18n';

export type { Clock } from './types';

// Remote Skill acquisition + install (spec §7.3).
//
// The pinned `skills@1.5.21` adapter stages the source into an isolated
// `<profileRoot>/.ccps-remote-stage-<id>/claude-home/skills/<stagedName>` tree;
// ccps verifies the staged frontmatter identity, then lands the tree through
// the §7.1 transaction engine's rename-swap (sidecar + .ccps-tmp/.ccps-old
// residue reconciled by the startup sweep) into `claude-home/skills/<name>`
// with a full provenance record. The real `~/.claude` is never touched
// (CLAUDE_CONFIG_DIR points into staging). `buildRemoteInstallPlan` is the
// pure plan builder, so dry-run ≡ real (spec §7.3 / invariant 8).

export type RemoteInstallPlanOptions = {
  profileRootPath: string;
  rawSource: string;
  /** Optional `--skill <name>` selection for a multi-Skill source. */
  skill?: string;
  /** Final install directory name in claude-home/skills/<name>. When omitted
   * on the acquire path, it is derived from the staged Skill's directory name
   * (which matches its frontmatter name); the wizard has no separate name-input
   * step for remote installs. */
  name?: string;
  extraEnv?: Record<string, string>;
  /** Override the staging id (deterministic tests). */
  stagingId?: string;
};

export type RemoteInstallPlan = {
  classifiedSource: ClassifiedRemoteSource;
  stagingRoot: string;
  acquisition: SkillsAcquisitionPlan;
  /** Target install path; undefined when `name` is omitted (derive post-staging). */
  targetPath?: string;
};

export type RemoteInstallPreview = {
  name: string;
  targetPath: string;
  stagingRoot: string;
  stagedName: string;
  identity: StagedSkillIdentity;
  provenanceSource: SkillSource;
  previewLines: string[];
  collides: boolean;
  existingIsLink: boolean;
  existingNames: string[];
};

export type AcquireAndPreviewOptions = RemoteInstallPlanOptions & {
  appHomePath: string;
  profileName: string;
  captureProcess?: CaptureProcess;
};

export type InstallRemoteSkillOptions = {
  appHomePath: string;
  profileName: string;
  profileRootPath: string;
  name: string;
  /** Staging root produced by acquireAndPreviewRemoteInstall. */
  stagingRoot: string;
  /** Staged dir name (from acquisition) to rename into place. */
  stagedName: string;
  provenanceSource: SkillSource;
  collisionResolution?: 'rename' | 'replace';
  clock?: Clock;
  /**
   * @internal Test-only. Simulates a process crash mid-apply (forwarded to the
   * transaction engine), leaving sidecar residue for crash-reconciliation
   * tests of the install replace path.
   */
  __fault?: FaultPoint;
};

export type InstallRemoteSkillResult = {
  name: string;
  mode: 'copy';
  targetPath: string;
  record: SkillProvenanceRecord;
};

// ─── Pure plan builder ───────────────────────────────────────────────────
// No writes, no network. Dry-run ≡ real: the returned `acquisition` sub-plan
// is exactly what `acquireSkillIntoStaging` runs in acquireAndPreviewRemoteInstall.
// `name` is optional: when omitted, the target name is derived from the staged
// Skill's directory name at acquire time (the wizard has no name-input step).

export function buildRemoteInstallPlan(options: RemoteInstallPlanOptions): RemoteInstallPlan {
  const classifiedSource = classifyRemoteSkillSource(options.rawSource);
  const stagingId = options.stagingId ?? randomBytes(6).toString('hex');
  const stagingRoot = resolveInside(options.profileRootPath, `.ccps-remote-stage-${stagingId}`);
  const acquisition = buildSkillsAcquisitionPlan({
    source: classifiedSource.sourceArg,
    skill: options.skill,
    stagingPath: stagingRoot,
    extraEnv: options.extraEnv,
  });
  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  const targetPath =
    options.name && options.name.trim().length > 0
      ? resolveInside(skillsDir, validateSkillDirectoryName(options.name))
      : undefined;
  return { classifiedSource, stagingRoot, acquisition, targetPath };
}

// ─── Acquire + preview (wizard "staging" phase) ──────────────────────────
// Runs the pinned adapter into staging, verifies frontmatter identity, and
// builds the confirm-step preview. Does NOT install. The staging root is kept
// alive for installRemoteSkill to rename from. On an acquire/verify failure,
// staging is removed here so it is not orphaned (the wizard only cleans up
// stagingRoot after a successful REMOTE_STAGED).

export async function acquireAndPreviewRemoteInstall(
  options: AcquireAndPreviewOptions,
  t?: CoreTranslator,
): Promise<RemoteInstallPreview> {
  const plan = buildRemoteInstallPlan(options);

  let stagedName: string;
  let identity: StagedSkillIdentity;
  try {
    const result = await acquireSkillIntoStaging({
      source: plan.classifiedSource.sourceArg,
      skill: options.skill,
      stagingPath: plan.stagingRoot,
      extraEnv: options.extraEnv,
      captureProcess: options.captureProcess,
    });
    stagedName = result.stagedSkills[0];
    identity = await verifyStagedSkillIdentity({
      stagedSkillsPath: plan.acquisition.stagedSkillsPath,
      stagedName,
      expectedSkill: options.skill,
    });
  } catch (error) {
    // Acquire or identity verification failed before the preview was built —
    // clean staging so it isn't orphaned. A failure here is non-fatal.
    await fs.remove(plan.stagingRoot).catch(() => {});
    throw error;
  }

  // Derive the target install name: a caller-provided name wins; otherwise use
  // the staged Skill's directory name (which matches its frontmatter name).
  // The wizard has no separate name-input step for remote installs.
  const name =
    options.name && options.name.trim().length > 0
      ? validateSkillDirectoryName(options.name)
      : validateSkillDirectoryName(stagedName);

  const provenanceSource = buildProvenanceSource(plan.classifiedSource);
  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  const targetPath = resolveInside(skillsDir, name);
  const existingNames = await listInstalledSkillNames(skillsDir);
  const collides = existingNames.has(name);
  const existingIsLink = collides ? await entryIsLink(targetPath) : false;

  const previewLines = [
    coreTx(t, 'skill.preview.acquire', 'acquire  {source}  →  staging', {
      source: plan.classifiedSource.sourceArg,
    }),
    coreTx(t, 'skill.preview.stage', 'stage    {staged}/  (frontmatter name: {name})', {
      staged: stagedName,
      name: identity.name,
    }),
    coreTx(t, 'skill.preview.create', 'create   {target}/   (snapshot — Profile-owned)', {
      target: targetPath,
    }),
    coreTx(t, 'skill.preview.record.copy', 'record   skills-provenance.json  ← copy · source {source} · sha256 fingerprint', {
      source: sourceKindLabelCore(t, provenanceSource.kind),
    }),
  ];

  return {
    name,
    targetPath,
    stagingRoot: plan.stagingRoot,
    stagedName,
    identity,
    provenanceSource,
    previewLines,
    collides,
    existingIsLink,
    existingNames: [...existingNames].sort(),
  };
}

// ─── Apply (wizard "installing" phase) ────────────────────────────────────
// Land the staged tree through the §7.1 transaction engine's rename-swap
// (sidecar + .ccps-tmp/.ccps-old residue, reconciled by the startup sweep),
// which also writes the provenance record atomically. A crash between the
// file swap and the manifest write surfaces as local drift — exactly the
// same path as a manual user edit (spec §7.1, deliberately).

export async function installRemoteSkill(
  options: InstallRemoteSkillOptions,
): Promise<InstallRemoteSkillResult> {
  validateProfileName(options.profileName);
  validateSkillDirectoryName(options.name);

  const clock = options.clock ?? (() => new Date());
  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  const targetPath = resolveInside(skillsDir, options.name);
  const stagedSourcePath = resolveInside(
    options.stagingRoot,
    'claude-home',
    'skills',
    options.stagedName,
  );

  // Collision handling at apply time: refuse unless the caller chose replace.
  // The refusal runs before any staging cleanup so the wizard can retry with a
  // rename/replace resolution without re-acquiring the staged tree.
  if ((await fs.pathExists(targetPath)) && options.collisionResolution !== 'replace') {
    throw new CcpsError(
      'SKILL_INSTALL_COLLISION',
      `A Skill named "${options.name}" already exists.`,
      {
        guidance: 'Choose rename or replace on the confirm step to resolve the collision.',
      },
    );
  }

  // Replaced entries are always binned (spec §7.2 auto-Bin). The disposition is
  // passed unconditionally so that even a fresh install racing a late-appearing
  // entry bins it instead of deleting.
  const replaceOld: ReplaceOldDisposition = {
    kind: 'bin',
    origin: 'remove',
    appHomePath: options.appHomePath,
    profileName: options.profileName,
  };

  try {
    // The acquisition staging lives under the Profile root, so the staged tree
    // is already same-partition and the engine renames it directly (no extra
    // copy). The engine consumes it via the rename swap.
    const result = await applySkillTransaction({
      profileRootPath: options.profileRootPath,
      profileName: options.profileName,
      name: options.name,
      mode: 'copy',
      stagedPath: stagedSourcePath,
      source: options.provenanceSource,
      replaceOld,
      clock,
      __fault: options.__fault,
    });
    return { name: options.name, mode: 'copy', targetPath, record: result.record };
  } finally {
    // The swap consumed the staged Skill tree; remove the (now mostly empty)
    // staging root. On a pre-swap failure this also reaps the untouched staged
    // tree. A failure here is non-fatal.
    await fs.remove(options.stagingRoot).catch(() => {});
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildProvenanceSource(classified: ClassifiedRemoteSource): SkillSource {
  if (classified.kind === 'git-remote') {
    const source: SkillSource = { kind: 'git-remote', url: classified.sourceArg };
    if (classified.ref) source.ref = classified.ref;
    if (classified.skillPath) source.skillPath = classified.skillPath;
    return source;
  }
  return { kind: 'url', url: classified.sourceArg };
}

async function listInstalledSkillNames(skillsDir: string): Promise<Set<string>> {
  const names = new Set<string>();
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return names;
    throw error;
  }
  for (const dirent of dirents) {
    names.add(dirent.name);
  }
  return names;
}

async function entryIsLink(targetPath: string): Promise<boolean> {
  try {
    const lstat = await fs.lstat(targetPath);
    return lstat.isSymbolicLink();
  } catch {
    return false;
  }
}
