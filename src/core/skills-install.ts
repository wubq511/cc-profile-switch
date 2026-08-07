import { randomBytes } from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';

import { getAppHomePaths } from './app-config';
import { getProfileTemplatePaths } from './profile-template';
import {
  createFileTreeItem,
  createFragmentItem,
  getRecoveryItem,
} from './recovery-bin';
import {
  applySkillTransaction,
  stageSkillTree,
  type FaultPoint,
  type ReplaceOldDisposition,
} from './skills-transaction';
import {
  createRecordForInstall,
  discoverLocalSkillRepo,
  getSkillsDirectoryPath,
  loadSkillsProvenance,
  saveSkillsProvenance,
} from './skills-provenance';
import type { SkillProvenanceRecord, SkillSource } from '../schemas/skills-provenance';
import {
  isPathInside,
  resolveFilesystemPath,
  resolveInside,
  validateProfileName,
} from '../platform/path';
import {
  createSkillLink,
  deleteSkillLink,
  probeLinkCapability,
  readLinkTarget,
} from '../platform/link';
import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';
import { type CaptureProcess } from '../platform/process';
import { type Clock } from './types';

export type { Clock } from './types';

// ─── Types ──────────────────────────────────────────────────────────────

export type InstallMode = 'copy' | 'link';

export type LocalSkillSourceInfo = {
  /** Resolved absolute path of the source directory. */
  sourcePath: string;
  /** True when the source directory can be read. */
  readable: boolean;
  /** True when a SKILL.md file is present at the source root. */
  skillMdPresent: boolean;
  /** Install directory name suggested from the source basename. */
  suggestedName: string;
};

export type HealthCheckCode =
  | 'source-readable'
  | 'skill-md-present'
  | 'platform-can-link'
  | 'target-not-self-referential';

export type HealthCheck = {
  code: HealthCheckCode;
  ok: boolean;
  message: string;
};

export type CollisionResolution = 'rename' | 'replace';

export type InstallPreview = {
  mode: InstallMode;
  name: string;
  /** Absolute path the install will create: claude-home/skills/<name>. */
  targetPath: string;
  sourcePath: string;
  checks: HealthCheck[];
  /** Human-readable lines describing exactly what lands (confirm-step preview). */
  previewLines: string[];
  canInstall: boolean;
  /** True when <name> already exists in the Profile's skills directory. */
  collides: boolean;
  /** Existing entry is a link (only set when collides). */
  existingIsLink: boolean;
  /** Names already installed (used to compute a rename suggestion in the UI). */
  existingNames: string[];
};

export type InstallOptions = {
  appHomePath: string;
  profileName: string;
  /** Absolute path to the Profile root (profiles/<name>). */
  profileRootPath: string;
  sourcePath: string;
  mode: InstallMode;
  /** Final install directory name (already collision-resolved by the caller). */
  name: string;
  /**
   * Required when <name> already exists. 'replace' bins the existing entry;
   * 'rename' means the caller already chose a fresh name (no collision at
   * apply time, so this option is unused but kept for symmetry).
   */
  collisionResolution?: CollisionResolution;
  clock?: Clock;
  /**
   * Injectable git capture for tests; production omits it and uses the real
   * git CLI via discoverLocalSkillRepo's default. See spec §7.1.
   */
  gitCaptureProcess?: CaptureProcess;
  /**
   * @internal Test-only. Simulates a process crash mid-apply (forwarded to the
   * transaction engine), leaving sidecar residue for crash-reconciliation
   * tests of the install replace path.
   */
  __fault?: FaultPoint;
};

export type InstallResult = {
  name: string;
  mode: InstallMode;
  targetPath: string;
  record: SkillProvenanceRecord;
};

export type RemoveLinkedSkillOptions = {
  appHomePath: string;
  profileName: string;
  profileRootPath: string;
  name: string;
  clock?: Clock;
};

export type RemoveLinkedSkillResult = {
  itemId: string;
  linkTargetPath: string;
};

export type RestoreLinkedSkillOptions = {
  appHomePath: string;
  profileName: string;
  profileRootPath: string;
  itemId: string;
  collisionResolution?: 'refuse' | 'restore-as-new-name' | 'delete-and-restore';
  newName?: string;
  clock?: Clock;
};

// ─── Source validation ──────────────────────────────────────────────────

export async function validateLocalSkillSource(
  rawSourcePath: string,
): Promise<LocalSkillSourceInfo> {
  const sourcePath = resolveFilesystemPath(rawSourcePath);
  const suggestedName = sanitizeSkillName(path.basename(sourcePath));

  let readable = false;
  let stat: fs.Stats | undefined;
  try {
    stat = await fs.stat(sourcePath);
    readable = stat.isDirectory();
  } catch {
    readable = false;
  }

  let skillMdPresent = false;
  if (readable) {
    try {
      const skillMdStat = await fs.stat(path.join(sourcePath, 'SKILL.md'));
      skillMdPresent = skillMdStat.isFile();
    } catch {
      skillMdPresent = false;
    }
  }

  return { sourcePath, readable, skillMdPresent, suggestedName };
}

// ─── Local source catalog (install wizard step 1, spec §7.2) ────────────

/**
 * A local Skill source discovered on disk, ready to pick in the install
 * wizard. `LocalSkillSourceInfo` carries the validity marks (spec §7.2 step 1:
 * "invalid sources (no SKILL.md) are marked at this step").
 */
export type CatalogedLocalSkillSource = LocalSkillSourceInfo & {
  /** Profile whose skills directory holds this source (display label). */
  originProfile: string;
};

/**
 * Catalog the local Skill sources the wizard can offer for picking (spec §7.2
 * step 1). The discovery layer (§7.4) catalogs remote sources only, so the
 * honest local catalog is the Skills already installed in the *other*
 * Profiles under this app home — real on-disk directories a Copy install can
 * snapshot (the "equip another Profile" semantic). The real user ~/.claude is
 * never scanned. The target Profile's own Skills are excluded (reinstalling a
 * Skill onto itself is pointless), and entries are validated so sources
 * without a SKILL.md arrive pre-marked. Listing is best-effort: an unreadable
 * Profile or skills directory is skipped, not fatal.
 */
export async function listLocalSkillSources(options: {
  appHomePath: string;
  /** Install target Profile — its own Skills are excluded from the list. */
  excludeProfileName?: string;
}): Promise<CatalogedLocalSkillSource[]> {
  const { profilesPath } = getAppHomePaths(options.appHomePath);
  let profileDirs: fs.Dirent[];
  try {
    profileDirs = await fs.readdir(profilesPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }

  const sources: CatalogedLocalSkillSource[] = [];
  for (const profileDir of profileDirs) {
    if (!profileDir.isDirectory() || profileDir.name === options.excludeProfileName) {
      continue;
    }
    const skillsDir = resolveInside(
      path.join(profilesPath, profileDir.name),
      'claude-home',
      'skills',
    );
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip transaction residue (.ccps-tmp-*/.ccps-old-*/.ccps-tx-*.json).
      if (entry.name.startsWith('.ccps-')) continue;
      const info = await validateLocalSkillSource(path.join(skillsDir, entry.name)).catch(
        () => undefined,
      );
      if (info) sources.push({ ...info, originProfile: profileDir.name });
    }
  }

  sources.sort(
    (a, b) =>
      a.originProfile.localeCompare(b.originProfile) ||
      a.suggestedName.localeCompare(b.suggestedName),
  );
  return sources;
}

// ─── Skill directory name validation ────────────────────────────────────

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateSkillDirectoryName(name: string): string {
  if (name.length === 0 || name !== name.trim()) {
    throw invalidSkillName();
  }
  if (name === '.' || name === '..') {
    throw invalidSkillName();
  }
  if (/[\\/]/.test(name)) {
    throw invalidSkillName();
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw invalidSkillName();
  }
  return name;
}

function invalidSkillName(): CcpsError {
  return new CcpsError('INVALID_SKILL_NAME', 'Skill name is not safe.', {
    guidance:
      'Use letters, numbers, dot, hyphen, or underscore. Avoid path separators and reserved names.',
  });
}

function sanitizeSkillName(name: string): string {
  // Trim and strip path separators so a basename like "foo/" becomes "foo".
  const trimmed = name.replace(/[\\/]+$/g, '').trim();
  const base = trimmed.length > 0 ? path.basename(trimmed) : 'skill';
  return SKILL_NAME_PATTERN.test(base) ? base : 'skill';
}

// ─── Collision helpers ──────────────────────────────────────────────────

export function suggestCollisionName(name: string, existingNames: ReadonlySet<string>): string {
  let n = 2;
  while (existingNames.has(`${name}-${n}`)) n++;
  return `${name}-${n}`;
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

async function existingEntryIsLink(targetPath: string): Promise<boolean> {
  try {
    const lstat = await fs.lstat(targetPath);
    return lstat.isSymbolicLink();
  } catch {
    return false;
  }
}

// ─── Health checks ──────────────────────────────────────────────────────

export async function checkInstallHealth(options: {
  profileRootPath: string;
  sourcePath: string;
  mode: InstallMode;
}): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  const sourceInfo = await validateLocalSkillSource(options.sourcePath);

  checks.push({
    code: 'source-readable',
    ok: sourceInfo.readable,
    message: sourceInfo.readable
      ? 'source readable'
      : 'source not readable — not a directory or missing',
  });

  checks.push({
    code: 'skill-md-present',
    ok: sourceInfo.skillMdPresent,
    message: sourceInfo.skillMdPresent ? 'SKILL.md present' : 'no SKILL.md in source — not a Skill',
  });

  if (options.mode === 'link') {
    const probe = probeLinkCapability();
    checks.push({
      code: 'platform-can-link',
      ok: probe.canCreate,
      message: probe.canCreate
        ? `platform can create ${probe.kind}s`
        : `platform cannot create links — ${probe.reason ?? 'unknown reason'}`,
    });

    // Self-reference guard: the link target must not live inside this Profile's
    // claude-home (would create a cycle and corrupt discovery).
    const claudeHome = resolveInside(options.profileRootPath, 'claude-home');
    const insideClaudeHome = isPathInside(claudeHome, sourceInfo.sourcePath);
    checks.push({
      code: 'target-not-self-referential',
      ok: !insideClaudeHome,
      message: insideClaudeHome
        ? 'link target is inside this Profile — self-reference refused'
        : 'link target is outside the Profile (live source)',
    });
  }

  return checks;
}

// ─── Preview ────────────────────────────────────────────────────────────

export async function previewInstall(options: {
  profileRootPath: string;
  sourcePath: string;
  mode: InstallMode;
  name: string;
}): Promise<InstallPreview> {
  validateSkillDirectoryName(options.name);

  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  const targetPath = resolveInside(skillsDir, options.name);
  const checks = await checkInstallHealth({
    profileRootPath: options.profileRootPath,
    sourcePath: options.sourcePath,
    mode: options.mode,
  });

  const existingNames = await listInstalledSkillNames(skillsDir);
  const collides = existingNames.has(options.name);
  const existingIsLink = collides ? await existingEntryIsLink(targetPath) : false;

  const sourceInfo = await validateLocalSkillSource(options.sourcePath);
  const provenanceLine =
    options.mode === 'copy'
      ? `record  skills-provenance.json  ← copy · source ${sourceInfo.sourcePath} · sha256 fingerprint`
      : `record  skills-provenance.json  ← link · live source ${sourceInfo.sourcePath} · health checked`;

  const previewLines =
    options.mode === 'copy'
      ? [
          `create  ${targetPath}/   (snapshot — Profile-owned)`,
          provenanceLine,
        ]
      : [
          `link    ${targetPath}  →  ${sourceInfo.sourcePath}`,
          provenanceLine,
        ];

  const canInstall = checks.every((c) => c.ok);

  return {
    mode: options.mode,
    name: options.name,
    targetPath,
    sourcePath: sourceInfo.sourcePath,
    checks,
    previewLines,
    canInstall,
    collides,
    existingIsLink,
    existingNames: [...existingNames].sort(),
  };
}

// ─── Install ────────────────────────────────────────────────────────────

export async function installLocalSkill(options: InstallOptions): Promise<InstallResult> {
  validateSkillDirectoryName(options.name);
  validateProfileName(options.profileName);

  const clock = options.clock ?? (() => new Date());
  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  const targetPath = resolveInside(skillsDir, options.name);

  // Re-run health at apply time (source may have changed since preview).
  const checks = await checkInstallHealth({
    profileRootPath: options.profileRootPath,
    sourcePath: options.sourcePath,
    mode: options.mode,
  });
  const failed = checks.find((c) => !c.ok);
  if (failed) {
    throw new CcpsError(
      'SKILL_INSTALL_HEALTH',
      `Pre-install health check failed: ${failed.message}.`,
      { guidance: 'Resolve the blocker shown on the confirm step, then retry.' },
    );
  }

  // Collision handling at apply time: refuse unless the caller chose replace.
  // The replace itself is the transaction engine's rename-swap below (spec
  // §7.1) — crash-safe, with sidecar residue the startup sweep reconciles.
  if ((await fs.pathExists(targetPath)) && options.collisionResolution !== 'replace') {
    // 'rename' resolution means the caller already picked a non-colliding
    // name; reaching here means the name still collides — refuse.
    throw new CcpsError(
      'SKILL_INSTALL_COLLISION',
      `A Skill named "${options.name}" already exists.`,
      {
        guidance: 'Choose rename or replace on the confirm step to resolve the collision.',
      },
    );
  }

  // Replaced entries are always binned (spec §7.2: the old copy goes to the
  // Recovery Bin). The disposition is passed unconditionally so that even a
  // fresh install racing a late-appearing entry bins it instead of deleting.
  const replaceOld: ReplaceOldDisposition = {
    kind: 'bin',
    origin: 'remove',
    appHomePath: options.appHomePath,
    profileName: options.profileName,
  };
  const source = await buildSkillSource(options);

  if (options.mode === 'copy') {
    // Stage outside the Profile (same partition), then rename-swap apply.
    const { stagedPath } = await stageSkillTree({
      appHomePath: options.appHomePath,
      localSourcePath: options.sourcePath,
    });
    try {
      const result = await applySkillTransaction({
        profileRootPath: options.profileRootPath,
        profileName: options.profileName,
        name: options.name,
        mode: 'copy',
        stagedPath,
        source,
        replaceOld,
        clock,
        __fault: options.__fault,
      });
      return { name: options.name, mode: options.mode, targetPath, record: result.record };
    } finally {
      // A pre-swap failure leaves the staged tree behind; reap it (a no-op
      // once the swap consumed it). Stale staging is also swept on next stage.
      await fs.remove(stagedPath).catch(() => {});
    }
  }

  // Link mode: the swap is one atomic symlink creation; the old entry still
  // renames to .ccps-old inside the transaction, so replace is crash-safe.
  const result = await applySkillTransaction({
    profileRootPath: options.profileRootPath,
    profileName: options.profileName,
    name: options.name,
    mode: 'link',
    linkTargetPath: resolveFilesystemPath(options.sourcePath),
    source,
    replaceOld,
    clock,
    __fault: options.__fault,
  });
  return { name: options.name, mode: options.mode, targetPath, record: result.record };
}

async function buildSkillSource(options: InstallOptions): Promise<SkillSource> {
  const source: SkillSource = {
    kind: 'local',
    path: resolveFilesystemPath(options.sourcePath),
  };
  // Spec §7.1: local installs discover the enclosing git repository at
  // install time and record repo { root, remoteUrl, skillPathInRepo, ref }.
  // When none is found the field is omitted and Update is disabled with
  // reason 'no-git-repo' (checked in skills-provenance.ts).
  const repo = await discoverLocalSkillRepo(source.path, {
    captureProcess: options.gitCaptureProcess,
  });
  if (repo) {
    source.repo = repo;
  }
  return source;
}

// Bin an existing Skill entry (link or copy) as a Recovery Bin item and remove
// it from the Profile, so the caller can land a new entry on an empty target.
// Used by the bulk-remove flow for Copied Skills; the install replace paths
// instead bin inside the §7.1 transaction engine (crash-safe swap with sidecar
// reconciliation). The caller writes the new provenance record after the swap.
export async function binExistingSkillEntry(options: {
  appHomePath: string;
  profileName: string;
  profileRootPath: string;
  name: string;
  targetPath: string;
  clock: Clock;
}): Promise<void> {
  const { appHomePath, profileName, profileRootPath, name, targetPath, clock } = options;
  const isLink = await existingEntryIsLink(targetPath);
  const { profilesPath } = getAppHomePaths(appHomePath);
  const profileDir = path.join(profilesPath, profileName);
  const relativeTarget = path.relative(profileDir, targetPath);
  if (!isPathInside(profileDir, targetPath)) {
    throw new CcpsError('PATH_OUTSIDE_BASE', 'Collision target escapes the Profile directory.', {
      guidance: 'The conflicting path must be inside the Profile directory.',
    });
  }

  if (isLink) {
    // Linked existing → bin as a fragment (link coords + provenance), delete link only.
    const linkTargetPath = (await readLinkTarget(targetPath)) ?? '';
    const manifest = await loadSkillsProvenance(profileRootPath);
    const existingRecord = manifest.skills[name];
    await createFragmentItem({
      appHomePath,
      origin: 'remove',
      kind: 'skill',
      profile: profileName,
      coordinates: {
        file: 'claude-home/skills',
        keyPath: name,
        value: {
          mode: 'link',
          linkTargetPath,
          provenance: existingRecord,
        },
      },
      clock,
    });
    await deleteSkillLink(targetPath);
  } else {
    // Copied existing → bin as a file-tree, remove the directory.
    await createFileTreeItem({
      appHomePath,
      origin: 'remove',
      kind: 'skill',
      profile: profileName,
      coordinates: { targetRelativePath: relativeTarget },
      sourcePath: targetPath,
      clock,
    });
    await fs.remove(targetPath);
  }

  // Drop the old provenance record; the caller writes the new one after the swap.
  const manifest = await loadSkillsProvenance(profileRootPath);
  delete manifest.skills[name];
  await saveSkillsProvenance(profileRootPath, manifest);
}

// ─── Cross-Profile Skill copy (spec §11.1 fan-out) ──────────────────────
// Copies an installed Skill from one Profile into another as a Profile-owned
// snapshot, carrying over the source's provenance identity so Update and
// Diff-vs-source keep working in the target exactly as at the source. A linked
// source lands in the target as a real directory (fs.copy dereferences the
// symlink) — the "equip a new Profile" semantic.

export type CopySkillToProfileOptions = {
  appHomePath: string;
  fromProfile: string;
  toProfile: string;
  skillName: string;
  /** Optional rename in the target; defaults to the source name. */
  targetName?: string;
  clock?: Clock;
};

export type CopySkillToProfileResult = {
  /** Absolute path of the new entry in the target: claude-home/skills/<name>. */
  targetPath: string;
  record: SkillProvenanceRecord;
};

export async function copySkillToProfile(
  options: CopySkillToProfileOptions,
): Promise<CopySkillToProfileResult> {
  validateSkillDirectoryName(options.skillName);
  const clock = options.clock ?? (() => new Date());
  const targetName = options.targetName ?? options.skillName;
  if (options.targetName) validateSkillDirectoryName(options.targetName);

  // getProfileTemplatePaths validates both profile names.
  const sourceRoot = getProfileTemplatePaths(options.appHomePath, options.fromProfile).profileRootPath;
  const targetRoot = getProfileTemplatePaths(options.appHomePath, options.toProfile);
  if (!(await fs.pathExists(targetRoot.profileRootPath))) {
    throw new CcpsError(
      'PROFILE_NOT_FOUND',
      'Target profile does not exist.',
      { guidance: `Create the target profile first: ccps create ${options.toProfile}` },
    );
  }

  // Load the source record and verify the physical tree exists.
  const manifest = await loadSkillsProvenance(sourceRoot);
  const record = manifest.skills[options.skillName];
  const sourceDir = resolveInside(getSkillsDirectoryPath(sourceRoot), options.skillName);
  if (!record || !(await fs.pathExists(sourceDir))) {
    throw new CcpsError(
      'SKILL_NOT_FOUND',
      `Skill "${options.skillName}" does not exist in profile "${options.fromProfile}".`,
      { guidance: 'List skills first to see what is available.' },
    );
  }

  const targetDir = resolveInside(getSkillsDirectoryPath(targetRoot.profileRootPath), targetName);
  if (await fs.pathExists(targetDir)) {
    throw new CcpsError(
      'SKILL_INSTALL_COLLISION',
      `A Skill named "${targetName}" already exists in the target profile.`,
      { guidance: 'Choose a different target profile or remove the existing Skill there first.' },
    );
  }

  // Snapshot the tree — dereference so a linked source lands as a real
  // directory in the target (the "equip a new Profile" semantic). Stage under
  // the target Profile root (same filesystem as the target, so the rename is
  // atomic) then rename into place, so a mid-copy failure never leaves a
  // partial `skills/<name>` tree. (copySkillToProfile refuses collisions up
  // front, so it needs no replace swap and stays outside the §7.1 engine.)
  const stageId = randomBytes(6).toString('hex');
  const stagePath = resolveInside(targetRoot.profileRootPath, `.ccps-skill-copy-${stageId}`);
  try {
    await fs.ensureDir(getSkillsDirectoryPath(targetRoot.profileRootPath));
    await fs.copy(sourceDir, stagePath, { overwrite: false, errorOnExist: true, dereference: true });
    await fs.rename(stagePath, targetDir);
  } catch (error) {
    await fs.remove(stagePath).catch(() => {});
    if (isNodeError(error) && error.code === 'ENOTEMPTY') {
      throw new CcpsError(
        'SKILL_INSTALL_COLLISION',
        `A Skill named "${targetName}" already exists in the target profile.`,
        { guidance: 'Choose a different target profile or remove the existing Skill there first.' },
      );
    }
    throw error;
  }
  const newRecord = await createRecordForInstall({
    skillDirPath: targetDir,
    mode: 'copy',
    source: record.source,
    clock,
  });

  const targetManifest = await loadSkillsProvenance(targetRoot.profileRootPath);
  targetManifest.skills[targetName] = newRecord;
  await saveSkillsProvenance(targetRoot.profileRootPath, targetManifest);

  return { targetPath: targetDir, record: newRecord };
}

// ─── Linked Skill removal + restore ─────────────────────────────────────
// Removing a Linked Skill deletes ONLY the link (source untouched — invariant
// 7). Its Bin fragment stores link coordinates plus the provenance record, and
// restore re-creates the link. Copied Skill removal goes through the existing
// file-tree Bin path and is not handled here.

export async function removeLinkedSkill(
  options: RemoveLinkedSkillOptions,
): Promise<RemoveLinkedSkillResult> {
  validateProfileName(options.profileName);
  validateSkillDirectoryName(options.name);

  const clock = options.clock ?? (() => new Date());
  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  const linkPath = resolveInside(skillsDir, options.name);

  const isLink = await existingEntryIsLink(linkPath);
  if (!isLink) {
    throw new CcpsError(
      'SKILL_NOT_LINKED',
      `"${options.name}" is not a Linked Skill.`,
      {
        guidance: 'Only Linked Skills can be removed through the link-only path. Use the Copied Skill removal path for snapshots.',
      },
    );
  }

  const linkTargetPath = (await readLinkTarget(linkPath)) ?? '';
  const manifest = await loadSkillsProvenance(options.profileRootPath);
  const record = manifest.skills[options.name];

  const item = await createFragmentItem({
    appHomePath: options.appHomePath,
    origin: 'remove',
    kind: 'skill',
    profile: options.profileName,
    coordinates: {
      file: 'claude-home/skills',
      keyPath: options.name,
      value: {
        mode: 'link',
        linkTargetPath,
        provenance: record,
      },
    },
    clock,
  });

  // Delete only the link — never the source.
  await deleteSkillLink(linkPath);

  delete manifest.skills[options.name];
  await saveSkillsProvenance(options.profileRootPath, manifest);

  return { itemId: item.id, linkTargetPath };
}

export async function restoreLinkedSkillItem(
  options: RestoreLinkedSkillOptions,
): Promise<{ restoredName: string; consumed: true }> {
  validateProfileName(options.profileName);

  const clock = options.clock ?? (() => new Date());
  const item = await getRecoveryItem(options.itemId, options.appHomePath);

  if (item.kind !== 'skill' || item.shape !== 'fragment') {
    throw new CcpsError(
      'RECOVERY_ITEM_NOT_LINKED_SKILL',
      'This Recovery Item is not a Linked Skill fragment.',
      { guidance: 'Use the generic restore path for other Recovery Items.' },
    );
  }

  // Fragment coordinates shape: { file, keyPath, value: { mode, linkTargetPath, provenance } }
  const coords = item.coordinates as {
    file: string;
    keyPath: string;
    value: { mode: string; linkTargetPath: string; provenance?: SkillProvenanceRecord };
  };

  if (coords.value?.mode !== 'link' || typeof coords.value.linkTargetPath !== 'string') {
    throw new CcpsError(
      'RECOVERY_ITEM_NOT_LINKED_SKILL',
      'The Linked Skill fragment is missing link coordinates.',
      { guidance: 'The item may be corrupt; manually inspect the item directory.' },
    );
  }

  const originalName = coords.keyPath;
  const resolution = options.collisionResolution ?? 'refuse';
  let restoreName = originalName;

  const skillsDir = getSkillsDirectoryPath(options.profileRootPath);
  const linkPath = resolveInside(skillsDir, originalName);

  if (await fs.pathExists(linkPath)) {
    if (resolution === 'refuse') {
      throw new CcpsError('RESTORE_COLLISION', 'A Skill entry already exists at the restore target.', {
        guidance: 'Use restore-as-new-name or delete-and-restore to resolve the collision.',
      });
    }
    if (resolution === 'restore-as-new-name') {
      if (!options.newName) {
        throw new CcpsError(
          'RESTORE_NEW_NAME_REQUIRED',
          'A new name is required for restore-as-new-name.',
          { guidance: 'Provide a new name for the restored Linked Skill.' },
        );
      }
      restoreName = validateSkillDirectoryName(options.newName);
    } else if (resolution === 'delete-and-restore') {
      // Bin the conflicting entry (copy or link) generically, then restore.
      const conflictingPath = linkPath;
      const { profilesPath } = getAppHomePaths(options.appHomePath);
      const profileDir = path.join(profilesPath, options.profileName);
      const relativeTarget = path.relative(profileDir, conflictingPath);
      if (!isPathInside(profileDir, conflictingPath)) {
        throw new CcpsError('PATH_OUTSIDE_BASE', 'Collision target escapes the Profile directory.', {
          guidance: 'The conflicting path must be inside the Profile directory.',
        });
      }
      if (await existingEntryIsLink(conflictingPath)) {
        const conflictingTarget = (await readLinkTarget(conflictingPath)) ?? '';
        const manifest = await loadSkillsProvenance(options.profileRootPath);
        const conflictingRecord = manifest.skills[originalName];
        await createFragmentItem({
          appHomePath: options.appHomePath,
          origin: 'remove',
          kind: 'skill',
          profile: options.profileName,
          coordinates: {
            file: 'claude-home/skills',
            keyPath: originalName,
            value: { mode: 'link', linkTargetPath: conflictingTarget, provenance: conflictingRecord },
          },
          clock,
        });
        await deleteSkillLink(conflictingPath);
        delete manifest.skills[originalName];
        await saveSkillsProvenance(options.profileRootPath, manifest);
      } else {
        await createFileTreeItem({
          appHomePath: options.appHomePath,
          origin: 'remove',
          kind: 'skill',
          profile: options.profileName,
          coordinates: { targetRelativePath: relativeTarget },
          sourcePath: conflictingPath,
          clock,
        });
        await fs.remove(conflictingPath);
        const manifest = await loadSkillsProvenance(options.profileRootPath);
        delete manifest.skills[originalName];
        await saveSkillsProvenance(options.profileRootPath, manifest);
      }
    }
  }

  const restoreLinkPath = resolveInside(skillsDir, restoreName);
  await createSkillLink({
    targetPath: resolveFilesystemPath(coords.value.linkTargetPath),
    linkPath: restoreLinkPath,
  });

  // Re-apply the provenance record.
  if (coords.value.provenance) {
    const manifest = await loadSkillsProvenance(options.profileRootPath);
    manifest.skills[restoreName] = coords.value.provenance;
    await saveSkillsProvenance(options.profileRootPath, manifest);
  }

  // Consume the Bin item.
  await fs.remove(item.itemDirPath);

  return { restoredName: restoreName, consumed: true };
}
