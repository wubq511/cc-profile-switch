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
import { binExistingSkillEntry, validateSkillDirectoryName } from './skills-install';
import {
  createRecordForInstall,
  getSkillsDirectoryPath,
  loadSkillsProvenance,
  saveSkillsProvenance,
} from './skills-provenance';
import type { SkillProvenanceRecord, SkillSource } from '../schemas/skills-provenance';
import { resolveInside, validateProfileName } from '../platform/path';
import { type CaptureProcess } from '../platform/process';
import { type Clock } from './types';
import { CcpsError } from '../utils/errors';

export type { Clock } from './types';

// Remote Skill acquisition + install (spec §7.3).
//
// The pinned `skills@1.5.21` adapter stages the source into an isolated
// `<profileRoot>/.ccps-remote-stage-<id>/claude-home/skills/<stagedName>` tree;
// ccps verifies the staged frontmatter identity, then lands the tree through a
// same-partition rename-swap into `claude-home/skills/<name>` with a full
// provenance record. The real `~/.claude` is never touched (CLAUDE_CONFIG_DIR
// points into staging). `buildRemoteInstallPlan` is the pure plan builder, so
// dry-run ≡ real (spec §7.3 / invariant 8).

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
    `acquire  ${plan.classifiedSource.sourceArg}  →  staging`,
    `stage    ${stagedName}/  (frontmatter name: ${identity.name})`,
    `create   ${targetPath}/   (snapshot — Profile-owned)`,
    `record   skills-provenance.json  ← copy · source ${provenanceSource.kind} · sha256 fingerprint`,
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
// Rename-swap the staged tree into the Profile skills dir, then write the
// provenance record. On a caught failure before the swap lands, staging is
// removed and the Profile is untouched. After a successful swap, a manifest
// write failure leaves the Skill installed without a record — reconcile
// backfills an unknown-kind record at next Inspect (spec §7.1), matching the
// local install's behavior.

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

  // Collision handling at apply time. 'replace' bins the old entry first so the
  // rename lands on an empty target (Windows refuses rename onto a non-empty dir).
  if (await fs.pathExists(targetPath)) {
    if (options.collisionResolution !== 'replace') {
      throw new CcpsError(
        'SKILL_INSTALL_COLLISION',
        `A Skill named "${options.name}" already exists.`,
        {
          guidance: 'Choose rename or replace on the confirm step to resolve the collision.',
        },
      );
    }
    await binExistingSkillEntry({
      appHomePath: options.appHomePath,
      profileName: options.profileName,
      profileRootPath: options.profileRootPath,
      name: options.name,
      targetPath,
      clock,
    });
  }

  try {
    // Same-partition rename (staging lives under profileRoot): atomic directory
    // rename into the Profile skills dir.
    await fs.rename(stagedSourcePath, targetPath);
  } catch (error) {
    // Rename failed before landing — clean staging, leave the Profile untouched.
    await fs.remove(options.stagingRoot).catch(() => {});
    if (isNodeError(error) && error.code === 'ENOTEMPTY') {
      throw new CcpsError(
        'SKILL_INSTALL_COLLISION',
        `A Skill named "${options.name}" already exists.`,
        { guidance: 'Resolve the collision on the confirm step.', cause: error },
      );
    }
    throw error;
  }

  try {
    const record = await createRecordForInstall({
      skillDirPath: targetPath,
      mode: 'copy',
      source: options.provenanceSource,
      clock,
    });
    const manifest = await loadSkillsProvenance(options.profileRootPath);
    manifest.skills[options.name] = record;
    await saveSkillsProvenance(options.profileRootPath, manifest);
    return { name: options.name, mode: 'copy', targetPath, record };
  } finally {
    // The swap succeeded; remove the (now mostly empty) staging root. A failure
    // here is non-fatal — the install landed.
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
