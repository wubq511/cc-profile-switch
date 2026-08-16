import { createHash } from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';

import { areSameFilesystemPath, relativeFilesystemPath, resolveInside } from '../platform/path';
import { captureProcess as defaultCaptureProcess, type CaptureProcess } from '../platform/process';
import {
  auditViewStateSchema,
  skillsProvenanceManifestSchema,
  type AuditView,
  type CapabilityResult,
  type CorruptionSignal,
  type DriftState,
  type LinkHealthState,
  type SkillProvenanceRecord,
  type SkillRepoInfo,
  type SkillSource,
  type SkillsProvenanceManifest,
} from '../schemas/skills-provenance';
import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';
import { loadVersionedJson, saveVersionedJson, type VersionedJsonSpec } from './versioned-json';
import { type Clock } from './types';

export type { Clock } from './types';

// Audit cache TTL: lazy refresh at Inspect with a 24h window (spec §7.1 audit cache).
export const AUDIT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const skillsProvenanceSpec: VersionedJsonSpec<SkillsProvenanceManifest, 1> = {
  fileName: 'skills-provenance.json',
  currentVersion: 1,
  currentSchema: skillsProvenanceManifestSchema,
  migrate: (_raw: unknown, rawVersion: number): SkillsProvenanceManifest => {
    throw new CcpsError(
      'SKILLS_PROVENANCE_INVALID_VERSION',
      `Cannot migrate skills-provenance.json from version ${rawVersion}.`,
      {
        guidance: 'Check the version field in skills-provenance.json.',
      },
    );
  },
  errorPrefix: 'SKILLS_PROVENANCE',
};

export type ReconcileResult = {
  manifest: SkillsProvenanceManifest;
  backfilled: string[];
  corruptionSignals: CorruptionSignal[];
};

export type InspectedSkill = {
  name: string;
  record: SkillProvenanceRecord;
  linkHealth: LinkHealthState | undefined;
  drift: DriftState;
  auditView: AuditView;
  update: CapabilityResult;
  diffVsSource: CapabilityResult;
};

export type InspectResult = {
  manifest: SkillsProvenanceManifest;
  skills: InspectedSkill[];
  backfilled: string[];
  corruptionSignals: CorruptionSignal[];
};

export type CreateRecordForInstallOptions = {
  skillDirPath: string;
  mode: SkillProvenanceRecord['mode'];
  source: SkillSource;
  linkTargetPath?: string;
  clock?: Clock;
};

export type DiscoverLocalSkillRepoOptions = {
  captureProcess?: CaptureProcess;
};

export function getSkillsProvenanceManifestPath(profileRootPath: string): string {
  return resolveInside(profileRootPath, 'skills-provenance.json');
}

export function getSkillsDirectoryPath(profileRootPath: string): string {
  return resolveInside(profileRootPath, 'claude-home', 'skills');
}

export async function loadSkillsProvenance(profileRootPath: string): Promise<SkillsProvenanceManifest> {
  const manifestPath = getSkillsProvenanceManifestPath(profileRootPath);
  try {
    return await loadVersionedJson(skillsProvenanceSpec, manifestPath);
  } catch (error) {
    if (error instanceof CcpsError && error.code === 'SKILLS_PROVENANCE_NOT_FOUND') {
      return { version: 1, skills: {} };
    }
    throw error;
  }
}

export async function saveSkillsProvenance(
  profileRootPath: string,
  manifest: SkillsProvenanceManifest,
): Promise<SkillsProvenanceManifest> {
  const manifestPath = getSkillsProvenanceManifestPath(profileRootPath);
  return saveVersionedJson(skillsProvenanceSpec, manifestPath, manifest);
}

// --- contentHash -------------------------------------------------------------
// Full-tree sha256 (spec §7.1): all regular files sorted by `/`-normalized
// relative path, hashed as (path + per-file sha256) concatenation; symlinks hash
// their target string; permission bits ignored; no exclusion list. The
// normalization to posix separators keeps a copied tree hashing identically
// across Windows/macOS/Linux.
type HashEntry = { relPath: string; entryHash: string };

export async function computeContentHash(skillDirPath: string): Promise<string> {
  const entries: HashEntry[] = [];
  await collectHashEntries(skillDirPath, '', entries);

  entries.sort((left, right) =>
    left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0,
  );

  const concat = entries.map((entry) => `${entry.relPath}\n${entry.entryHash}\n`).join('');
  return sha256Hex(concat);
}

async function collectHashEntries(
  dirFsPath: string,
  relPosixPath: string,
  entries: HashEntry[],
): Promise<void> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.readdir(dirFsPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CcpsError(
        'SKILLS_PROVENANCE_HASH_FAILED',
        'The Skill directory to hash does not exist.',
        { guidance: 'Check that the Skill is installed before computing its hash.', cause: error },
      );
    }
    throw error;
  }

  for (const dirent of dirents) {
    const childFsPath = path.join(dirFsPath, dirent.name);
    const childRel = relPosixPath ? `${relPosixPath}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      await collectHashEntries(childFsPath, childRel, entries);
    } else if (dirent.isSymbolicLink()) {
      let target: string;
      try {
        target = await fs.readlink(childFsPath);
      } catch (error) {
        throw new CcpsError(
          'SKILLS_PROVENANCE_HASH_FAILED',
          `Could not read symlink target at ${childRel}.`,
          { cause: error },
        );
      }
      entries.push({ relPath: childRel, entryHash: sha256Hex(target) });
    } else if (dirent.isFile()) {
      const fileHash = await sha256FileHex(childFsPath);
      entries.push({ relPath: childRel, entryHash: fileHash });
    }
    // Other entry kinds (block/char/fifo/socket) are ignored — they have no
    // stable content representation and are not part of a Skill tree.
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

async function sha256FileHex(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

// --- backfill ---------------------------------------------------------------

export async function backfillUnknownRecord(skillDirPath: string): Promise<SkillProvenanceRecord> {
  const contentHash = await computeContentHash(skillDirPath);
  const stat = await fs.stat(skillDirPath);
  const installedAt = stat.mtime.toISOString();

  return {
    mode: 'copy',
    source: { kind: 'unknown' },
    contentHash,
    installedAt,
    updatedAt: installedAt,
  };
}

// --- reconcile --------------------------------------------------------------

export async function reconcileSkillsProvenance(
  profileRootPath: string,
): Promise<ReconcileResult> {
  const manifest = await loadSkillsProvenance(profileRootPath);
  const skillsDir = getSkillsDirectoryPath(profileRootPath);

  const directoryEntries = await listSkillDirectoryEntries(skillsDir);
  const recordNames = Object.keys(manifest.skills);
  const directoryNameSet = new Set(directoryEntries);

  const corruptionSignals: CorruptionSignal[] = recordNames
    .filter((name) => !directoryNameSet.has(name))
    .map((name) => ({ kind: 'orphan-record' as const, skillName: name }));

  const backfilled: string[] = [];
  for (const entry of directoryEntries) {
    if (manifest.skills[entry]) {
      continue;
    }
    const skillDirPath = resolveInside(skillsDir, entry);
    manifest.skills[entry] = await backfillUnknownRecord(skillDirPath);
    backfilled.push(entry);
  }

  if (backfilled.length > 0) {
    await saveSkillsProvenance(profileRootPath, manifest);
  }

  return { manifest, backfilled, corruptionSignals };
}

async function listSkillDirectoryEntries(skillsDir: string): Promise<string[]> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const entries: string[] = [];
  for (const dirent of dirents) {
    const fullPath = path.join(skillsDir, dirent.name);
    // A Skill entry is a directory or a symlink resolving to a directory.
    // Broken symlinks and non-directory junk are skipped (not backfilled).
    let stat: fs.Stats;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      entries.push(dirent.name);
    }
  }
  return entries.sort((left, right) => left.localeCompare(right));
}

// --- link health (computed live, never stored) ------------------------------

export async function computeLinkHealth(
  skillDirPath: string,
  record: SkillProvenanceRecord,
): Promise<LinkHealthState | undefined> {
  if (record.mode !== 'link' || !record.link) {
    return undefined;
  }

  const targetPath = record.link.targetPath;
  let lstat: fs.Stats;
  try {
    lstat = await fs.lstat(skillDirPath);
  } catch {
    return 'link-missing';
  }

  if (!lstat.isSymbolicLink()) {
    return 'link-missing';
  }

  let actualTarget: string;
  try {
    actualTarget = await fs.readlink(skillDirPath);
  } catch {
    return 'link-missing';
  }

  if (!areSameFilesystemPath(actualTarget, targetPath)) {
    return 'wrong-target';
  }

  if (!(await fs.pathExists(targetPath))) {
    return 'source-missing';
  }

  return 'ok';
}

// --- drift (derived from contentHash) --------------------------------------

export async function computeDrift(
  skillDirPath: string,
  record: SkillProvenanceRecord,
): Promise<DriftState> {
  const liveHash = await computeContentHash(skillDirPath);
  if (liveHash === record.contentHash) {
    return 'none';
  }
  return record.mode === 'copy' ? 'local-drift' : 'source-updated';
}

// --- audit cache (24h TTL, never blocks) ------------------------------------

export function isAuditStale(record: SkillProvenanceRecord, now: Date): boolean {
  if (!record.audit || !record.audit.fetchedAt) {
    return true;
  }
  const fetchedAt = Date.parse(record.audit.fetchedAt);
  if (Number.isNaN(fetchedAt)) {
    return true;
  }
  return now.getTime() - fetchedAt > AUDIT_CACHE_TTL_MS;
}

export function computeAuditView(record: SkillProvenanceRecord, now: Date): AuditView {
  if (!record.audit || !record.audit.fetchedAt) {
    return { state: 'not audited', stale: true };
  }

  const stale = isAuditStale(record, now);
  if (stale) {
    // "refresh failure keeps old value marked cached-stale" — the stored value
    // is retained, but the view reports cached-stale until a refresh succeeds.
    return {
      state: 'cached-stale',
      provider: record.audit.provider,
      fetchedAt: record.audit.fetchedAt,
      stale: true,
    };
  }

  const parsed = auditViewStateSchema.safeParse(record.audit.state);
  return {
    state: parsed.success ? parsed.data : 'unavailable',
    provider: record.audit.provider,
    fetchedAt: record.audit.fetchedAt,
    stale: false,
  };
}

export function updateAuditCache(
  record: SkillProvenanceRecord,
  newState: string,
  provider: string | undefined,
  now: Date,
): SkillProvenanceRecord {
  return {
    ...record,
    audit: { state: newState, provider, fetchedAt: now.toISOString() },
  };
}

// --- capability gates (Update / Diff-vs-source) -----------------------------

export function canUpdate(record: SkillProvenanceRecord): CapabilityResult {
  if (record.source.kind === 'unknown') {
    return { enabled: false, reason: 'no-source' };
  }
  if (record.source.kind === 'local') {
    if (!record.source.repo) {
      return { enabled: false, reason: 'no-git-repo' };
    }
    // A repo without an origin/upstream cannot be pulled — Update is disabled
    // with a stated reason (spec §7.1 "missing remote/upstream disables with reason").
    if (!record.source.repo.remoteUrl) {
      return { enabled: false, reason: 'no-remote' };
    }
  }
  return { enabled: true };
}

export function canDiffVsSource(record: SkillProvenanceRecord): CapabilityResult {
  if (record.source.kind === 'unknown') {
    return { enabled: false, reason: 'no-source' };
  }
  // Diff-vs-source is Copied-only (spec §6.3): a Linked Skill's profile tree IS
  // the source (through the link), so the comparison is always empty.
  if (record.mode === 'link') {
    return { enabled: false, reason: 'link-mode' };
  }
  // Diff-vs-source compares the profile tree against the recorded source path/URL
  // directly — it does not need git, so a local source without an enclosing repo
  // can still be diffed. Only Update needs git (re-pull / re-acquire).
  return { enabled: true };
}

// --- git discovery for local sources ----------------------------------------

export async function discoverLocalSkillRepo(
  localPath: string,
  options: DiscoverLocalSkillRepoOptions = {},
): Promise<SkillRepoInfo | undefined> {
  const run = options.captureProcess ?? defaultCaptureProcess;
  const env = process.env;

  const toplevel = await runGit(run, localPath, ['rev-parse', '--show-toplevel'], env);
  if (toplevel === undefined) {
    return undefined;
  }
  const root = toplevel;

  const skillPathInRepo = toPosix(relativeFilesystemPath(root, localPath));
  if (skillPathInRepo.startsWith('..') || path.posix.isAbsolute(skillPathInRepo)) {
    // localPath was not actually inside the reported repo root.
    return undefined;
  }

  const remoteUrl = await runGit(run, root, ['remote', 'get-url', 'origin'], env);

  const abbrevRef = await runGit(run, root, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
  const ref = abbrevRef && abbrevRef !== 'HEAD' ? abbrevRef : undefined;

  const repo: SkillRepoInfo = { root, skillPathInRepo };
  if (remoteUrl) {
    repo.remoteUrl = remoteUrl;
  }
  if (ref) {
    repo.ref = ref;
  }
  return repo;
}

async function runGit(
  run: CaptureProcess,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  let result;
  try {
    result = await run('git', ['-C', cwd, ...args], { cwd, shell: false, env });
  } catch {
    return undefined;
  }
  if (result.exitCode !== 0) {
    return undefined;
  }
  const stdout = result.stdout.trim();
  return stdout.length > 0 ? stdout : undefined;
}

// --- install-time record construction (for the transaction layer) -----------

export async function createRecordForInstall(
  options: CreateRecordForInstallOptions,
): Promise<SkillProvenanceRecord> {
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const contentHash = await computeContentHash(options.skillDirPath);

  const record: SkillProvenanceRecord = {
    mode: options.mode,
    source: options.source,
    contentHash,
    installedAt: now,
    updatedAt: now,
    sourceCheckedAt: now,
  };

  if (options.mode === 'link' && options.linkTargetPath) {
    record.link = { targetPath: options.linkTargetPath };
  }

  return record;
}

// --- inspect (top-level entry) ----------------------------------------------
// Note: inspect reconciles first, which may WRITE the manifest (backfilling
// newly discovered pre-manifest Skills). This side effect is spec-sanctioned
// (§7.1: "Backfill ... at first Inspect/list").

export async function inspectSkills(
  profileRootPath: string,
  options: { clock?: Clock } = {},
): Promise<InspectResult> {
  const now = (options.clock ?? (() => new Date()))();
  const reconcile = await reconcileSkillsProvenance(profileRootPath);
  const skillsDir = getSkillsDirectoryPath(profileRootPath);

  const skills: InspectedSkill[] = await Promise.all(
    Object.entries(reconcile.manifest.skills)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([name, record]) => {
        const skillDirPath = resolveInside(skillsDir, name);
        const [linkHealth, drift] = await Promise.all([
          computeLinkHealth(skillDirPath, record),
          computeDrift(skillDirPath, record),
        ]);
        return {
          name,
          record,
          linkHealth,
          drift,
          auditView: computeAuditView(record, now),
          update: canUpdate(record),
          diffVsSource: canDiffVsSource(record),
        } satisfies InspectedSkill;
      }),
  );

  return {
    manifest: reconcile.manifest,
    skills,
    backfilled: reconcile.backfilled,
    corruptionSignals: reconcile.corruptionSignals,
  };
}

// --- helpers ----------------------------------------------------------------

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}
