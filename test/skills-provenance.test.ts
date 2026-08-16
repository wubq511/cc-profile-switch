import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AUDIT_CACHE_TTL_MS,
  backfillUnknownRecord,
  canDiffVsSource,
  canUpdate,
  computeAuditView,
  computeContentHash,
  computeDrift,
  computeLinkHealth,
  createRecordForInstall,
  discoverLocalSkillRepo,
  getSkillsDirectoryPath,
  getSkillsProvenanceManifestPath,
  inspectSkills,
  isAuditStale,
  loadSkillsProvenance,
  reconcileSkillsProvenance,
  saveSkillsProvenance,
  updateAuditCache,
} from '../src/core/skills-provenance';
import type { SkillProvenanceRecord, SkillSource } from '../src/schemas/skills-provenance';
import type { CaptureProcess } from '../src/platform/process';
import { CcpsError } from '../src/utils/errors';

// Golden contentHash for the fixed tree below, computed independently from the
// implementation (node crypto) so the test pins the exact byte format.
// Tree:
//   <skill>/SKILL.md        -> "hello\n"
//   <skill>/sub/a.txt        -> "a\n"
// Algorithm: sort entries by posix rel path, per regular file sha256 of bytes,
// concat `${relPath}\n${hash}\n` per entry, sha256 of the concatenation.
const GOLDEN_TREE_HASH = 'a1d2e95defb967bca734eb9fb481836a1e47da0d4ace75582ece6e5e383eeee3';

const tempRoots: string[] = [];

// Probe symlink capability synchronously at module load, so it.skipIf can read
// it when the describe bodies register their tests (beforeAll runs too late).
let canCreateSymlink = false;
{
  const probeDir = fs.mkdtempSync(path.join(tmpdir(), 'ccps-symlink-probe-'));
  const probeTarget = path.join(probeDir, 'target');
  const probeLink = path.join(probeDir, 'link');
  try {
    fs.mkdirSync(probeTarget);
    fs.symlinkSync(probeTarget, probeLink);
    canCreateSymlink = true;
  } catch {
    canCreateSymlink = false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeSkillTree(skillDir: string): Promise<void> {
  await fs.ensureDir(path.join(skillDir, 'sub'));
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'hello\n', 'utf8');
  await fs.writeFile(path.join(skillDir, 'sub', 'a.txt'), 'a\n', 'utf8');
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function expectCcpsError(thunk: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await thunk();
  } catch (error) {
    expect(error).toBeInstanceOf(CcpsError);
    expect((error as CcpsError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a CcpsError with code ${code}.`);
}

function mockCapture(
  responses: { match: (args: string[]) => boolean; stdout?: string; exitCode?: number }[],
): CaptureProcess {
  return async (_command, args) => {
    for (const response of responses) {
      if (response.match(args)) {
        return {
          exitCode: response.exitCode ?? 0,
          stdout: response.stdout ?? '',
          stderr: '',
          timedOut: false,
        };
      }
    }
    return { exitCode: 1, stdout: '', stderr: 'no mock matched', timedOut: false };
  };
}

const gitArgs = (subcommand: string[]): ((args: string[]) => boolean) => {
  return (args) => subcommand.every((token) => args.includes(token));
};

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------

describe('computeContentHash', () => {
  it('produces the golden hash for a fixed tree', async () => {
    const root = await makeTempRoot('ccps-hash-golden-');
    const skillDir = path.join(root, 'my-skill');
    await writeSkillTree(skillDir);

    const hash = await computeContentHash(skillDir);
    expect(hash).toBe(GOLDEN_TREE_HASH);
  });

  it('is stable across repeated calls', async () => {
    const root = await makeTempRoot('ccps-hash-stable-');
    const skillDir = path.join(root, 'skill');
    await writeSkillTree(skillDir);

    const first = await computeContentHash(skillDir);
    const second = await computeContentHash(skillDir);
    expect(first).toBe(second);
  });

  it('changes when file contents change', async () => {
    const root = await makeTempRoot('ccps-hash-change-');
    const skillDir = path.join(root, 'skill');
    await writeSkillTree(skillDir);

    const before = await computeContentHash(skillDir);
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'changed\n', 'utf8');
    const after = await computeContentHash(skillDir);
    expect(after).not.toBe(before);
  });

  it('sorts entries by normalized posix path regardless of insertion order', async () => {
    const root = await makeTempRoot('ccps-hash-sort-');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await writeSkillTree(a);
    await writeSkillTree(b);

    expect(await computeContentHash(a)).toBe(await computeContentHash(b));
  });

  it('ignores permission bits', async () => {
    const root = await makeTempRoot('ccps-hash-perm-');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await writeSkillTree(a);
    await writeSkillTree(b);
    await fs.chmod(path.join(a, 'SKILL.md'), 0o600);
    await fs.chmod(path.join(b, 'SKILL.md'), 0o644);

    expect(await computeContentHash(a)).toBe(await computeContentHash(b));
  });

  it('hashes a symlink by its target string, not the linked contents', async () => {
    const root = await makeTempRoot('ccps-hash-symlink-');
    const target = path.join(root, 'target');
    await fs.ensureDir(target);
    await fs.writeFile(path.join(target, 'file.txt'), 'linked\n', 'utf8');
    const skillDir = path.join(root, 'skill');
    await fs.ensureDir(skillDir);
    // relative symlink so readlink returns a stable target string cross-platform
    await fs.symlink('../target', path.join(skillDir, 'link'));

    const hash = await computeContentHash(skillDir);
    expect(hash).not.toBe('');

    // Verify the contribution is the hash of the target string, not the file.
    const targetString = await fs.readlink(path.join(skillDir, 'link'));
    const { createHash } = await import('node:crypto');
    const expectedTargetHash = createHash('sha256').update(targetString, 'utf8').digest('hex');
    const finalHash = createHash('sha256')
      .update(`link\n${expectedTargetHash}\n`, 'utf8')
      .digest('hex');
    expect(hash).toBe(finalHash);
  });

  it('throws a CcpsError when the skill directory does not exist', async () => {
    const root = await makeTempRoot('ccps-hash-missing-');
    await expectCcpsError(
      () => computeContentHash(path.join(root, 'nope')),
      'SKILLS_PROVENANCE_HASH_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// manifest load / save
// ---------------------------------------------------------------------------

describe('manifest load and save', () => {
  it('treats a missing manifest as an empty manifest', async () => {
    const root = await makeTempRoot('ccps-manifest-missing-');
    const manifest = await loadSkillsProvenance(root);
    expect(manifest).toEqual({ version: 1, skills: {} });
  });

  it('round-trips a manifest with a record', async () => {
    const root = await makeTempRoot('ccps-manifest-roundtrip-');
    const record: SkillProvenanceRecord = {
      mode: 'copy',
      source: { kind: 'git-remote', url: 'https://example.com/repo.git', skillPath: 'skills/foo' },
      contentHash: 'abc',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sourceCheckedAt: '2026-01-01T00:00:00.000Z',
    };
    await saveSkillsProvenance(root, { version: 1, skills: { foo: record } });

    const loaded = await loadSkillsProvenance(root);
    expect(loaded.skills.foo).toEqual(record);
  });

  it('writes atomically (no .tmp residue left behind)', async () => {
    const root = await makeTempRoot('ccps-manifest-atomic-');
    await saveSkillsProvenance(root, { version: 1, skills: {} });

    const manifestPath = getSkillsProvenanceManifestPath(root);
    const dirEntries = await fs.readdir(root);
    expect(dirEntries).toContain('skills-provenance.json');
    expect(dirEntries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
    expect(await fs.pathExists(manifestPath + '.tmp')).toBe(false);
  });

  it('rejects an invalid record via schema validation', async () => {
    const root = path.join(tmpdir(), 'ccps-manifest-invalid-' + process.pid);
    tempRoots.push(root);
    const bad = {
      version: 1,
      skills: {
        foo: { mode: 'bogus', source: { kind: 'unknown' } },
      },
    } as unknown as Parameters<typeof saveSkillsProvenance>[1];
    await expectCcpsError(() => saveSkillsProvenance(root, bad), 'SKILLS_PROVENANCE_INVALID');
  });

  it('refuses a future manifest version', async () => {
    const root = await makeTempRoot('ccps-manifest-future-');
    const manifestPath = getSkillsProvenanceManifestPath(root);
    await fs.writeFile(manifestPath, JSON.stringify({ version: 99, skills: {} }), 'utf8');
    await expectCcpsError(() => loadSkillsProvenance(root), 'SKILLS_PROVENANCE_FUTURE_VERSION');
  });
});

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

describe('backfillUnknownRecord', () => {
  it('creates an unknown-kind copy record with live hash and directory mtime', async () => {
    const root = await makeTempRoot('ccps-backfill-');
    const skillDir = path.join(root, 'pre-existing');
    await writeSkillTree(skillDir);
    const stat = await fs.stat(skillDir);

    const record = await backfillUnknownRecord(skillDir);

    expect(record.mode).toBe('copy');
    expect(record.source).toEqual({ kind: 'unknown' });
    expect(record.contentHash).toBe(GOLDEN_TREE_HASH);
    expect(record.installedAt).toBe(stat.mtime.toISOString());
    expect(record.updatedAt).toBe(stat.mtime.toISOString());
    expect(record.sourceCheckedAt).toBeUndefined();
    expect(record.link).toBeUndefined();
    expect(record.audit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe('reconcileSkillsProvenance', () => {
  it('backfills unknown records for pre-manifest skill directories', async () => {
    const root = await makeTempRoot('ccps-reconcile-backfill-');
    const skillsDir = getSkillsDirectoryPath(root);
    await fs.ensureDir(path.join(skillsDir, 'alpha'));
    await writeSkillTree(path.join(skillsDir, 'alpha'));

    const result = await reconcileSkillsProvenance(root);

    expect(result.backfilled).toEqual(['alpha']);
    expect(result.corruptionSignals).toEqual([]);
    expect(result.manifest.skills.alpha.source.kind).toBe('unknown');

    // The manifest was persisted.
    const reloaded = await loadSkillsProvenance(root);
    expect(reloaded.skills.alpha).toBeDefined();
  });

  it('is idempotent on a second run (no new backfill, no save needed)', async () => {
    const root = await makeTempRoot('ccps-reconcile-idempotent-');
    const skillsDir = getSkillsDirectoryPath(root);
    await fs.ensureDir(path.join(skillsDir, 'alpha'));
    await writeSkillTree(path.join(skillsDir, 'alpha'));

    await reconcileSkillsProvenance(root);
    const second = await reconcileSkillsProvenance(root);

    expect(second.backfilled).toEqual([]);
    expect(second.corruptionSignals).toEqual([]);
  });

  it('surfaces a corruption signal for a record without a directory', async () => {
    const root = await makeTempRoot('ccps-reconcile-orphan-');
    const skillsDir = getSkillsDirectoryPath(root);
    await fs.ensureDir(path.join(skillsDir, 'real'));
    await writeSkillTree(path.join(skillsDir, 'real'));

    await saveSkillsProvenance(root, {
      version: 1,
      skills: {
        real: {
          mode: 'copy',
          source: { kind: 'git-remote', url: 'https://example.com/r.git' },
          contentHash: 'x',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        ghost: {
          mode: 'copy',
          source: { kind: 'git-remote', url: 'https://example.com/g.git' },
          contentHash: 'y',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    const result = await reconcileSkillsProvenance(root);

    expect(result.backfilled).toEqual([]);
    expect(result.corruptionSignals).toEqual([{ kind: 'orphan-record', skillName: 'ghost' }]);
    expect(result.manifest.skills.ghost).toBeDefined();
  });

  it('treats a missing skills directory as an empty entry set', async () => {
    const root = await makeTempRoot('ccps-reconcile-empty-');
    const result = await reconcileSkillsProvenance(root);
    expect(result.backfilled).toEqual([]);
    expect(result.corruptionSignals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// link health
// ---------------------------------------------------------------------------

describe('computeLinkHealth', () => {
  async function makeLinkRecord(targetPath: string): Promise<SkillProvenanceRecord> {
    return {
      mode: 'link',
      source: { kind: 'local', path: targetPath },
      contentHash: 'irrelevant',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      link: { targetPath },
    };
  }

  it('returns undefined for a copy-mode record', async () => {
    const root = await makeTempRoot('ccps-link-copy-');
    const skillDir = path.join(root, 'copy');
    await writeSkillTree(skillDir);
    const record: SkillProvenanceRecord = {
      mode: 'copy',
      source: { kind: 'git-remote', url: 'https://example.com/r.git' },
      contentHash: 'x',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(await computeLinkHealth(skillDir, record)).toBeUndefined();
  });

  it('reports link-missing when the entry is a regular directory, not a link', async () => {
    const root = await makeTempRoot('ccps-link-missing-dir-');
    const skillDir = path.join(root, 'link');
    await fs.ensureDir(skillDir);
    const record = await makeLinkRecord(path.join(root, 'target'));
    expect(await computeLinkHealth(skillDir, record)).toBe('link-missing');
  });

  it('reports link-missing when the entry does not exist at all', async () => {
    const root = await makeTempRoot('ccps-link-missing-none-');
    const record = await makeLinkRecord(path.join(root, 'target'));
    expect(await computeLinkHealth(path.join(root, 'absent'), record)).toBe('link-missing');
  });

  it.skipIf(!canCreateSymlink)('reports wrong-target when the link points elsewhere', async () => {
    const root = await makeTempRoot('ccps-link-wrong-');
    const intended = path.join(root, 'intended');
    const actual = path.join(root, 'actual');
    const link = path.join(root, 'link');
    await fs.ensureDir(intended);
    await fs.ensureDir(actual);
    await fs.symlink(actual, link);
    const record = await makeLinkRecord(intended);
    expect(await computeLinkHealth(link, record)).toBe('wrong-target');
  });

  it.skipIf(!canCreateSymlink)('reports source-missing when the target no longer exists', async () => {
    const root = await makeTempRoot('ccps-link-source-missing-');
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    await fs.ensureDir(target);
    await fs.symlink(target, link);
    await fs.remove(target);
    const record = await makeLinkRecord(target);
    expect(await computeLinkHealth(link, record)).toBe('source-missing');
  });

  it.skipIf(!canCreateSymlink)('reports ok for a healthy link', async () => {
    const root = await makeTempRoot('ccps-link-ok-');
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    await fs.ensureDir(target);
    await fs.writeFile(path.join(target, 'SKILL.md'), 'ok\n', 'utf8');
    await fs.symlink(target, link);
    const record = await makeLinkRecord(target);
    expect(await computeLinkHealth(link, record)).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// audit cache TTL
// ---------------------------------------------------------------------------

describe('audit cache', () => {
  const fetchedAt = '2026-01-01T00:00:00.000Z';

  function withAudit(audit: { state: string; provider?: string; fetchedAt: string } | undefined): SkillProvenanceRecord {
    const record: SkillProvenanceRecord = {
      mode: 'copy',
      source: { kind: 'git-remote', url: 'https://example.com/r.git' },
      contentHash: 'x',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    if (audit) {
      record.audit = audit;
    }
    return record;
  }

  it('is stale when no audit is present', () => {
    expect(isAuditStale(withAudit(undefined), new Date('2026-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('is fresh within the 24h TTL (23h59m)', () => {
    const fresh = new Date(Date.parse(fetchedAt) + AUDIT_CACHE_TTL_MS - 60_000);
    expect(isAuditStale(withAudit({ state: 'pass', fetchedAt }), fresh)).toBe(false);
  });

  it('is stale past the 24h TTL (24h01m)', () => {
    const stale = new Date(Date.parse(fetchedAt) + AUDIT_CACHE_TTL_MS + 60_000);
    expect(isAuditStale(withAudit({ state: 'pass', fetchedAt }), stale)).toBe(true);
  });

  it('computeAuditView returns not-audited when no audit field exists', () => {
    const view = computeAuditView(withAudit(undefined), new Date(Date.parse(fetchedAt)));
    expect(view).toEqual({ state: 'not audited', stale: true });
  });

  it('computeAuditView returns the stored state when fresh', () => {
    const view = computeAuditView(
      withAudit({ state: 'pass', provider: 'skills.sh', fetchedAt }),
      new Date(Date.parse(fetchedAt) + 60_000),
    );
    expect(view).toEqual({
      state: 'pass',
      provider: 'skills.sh',
      fetchedAt,
      stale: false,
    });
  });

  it('computeAuditView reports cached-stale when past the TTL (keeps old value)', () => {
    const stale = new Date(Date.parse(fetchedAt) + AUDIT_CACHE_TTL_MS + 60_000);
    const view = computeAuditView(
      withAudit({ state: 'pass', provider: 'skills.sh', fetchedAt }),
      stale,
    );
    // Old value retained (provider/fetchedAt) but the view reports cached-stale.
    expect(view).toEqual({
      state: 'cached-stale',
      provider: 'skills.sh',
      fetchedAt,
      stale: true,
    });
  });

  it('updateAuditCache records a fresh fetchedAt and state', () => {
    const record = withAudit({ state: 'pass', fetchedAt });
    const updated = updateAuditCache(record, 'warn', 'skills.sh', new Date('2026-02-01T00:00:00.000Z'));
    expect(updated.audit).toEqual({
      state: 'warn',
      provider: 'skills.sh',
      fetchedAt: '2026-02-01T00:00:00.000Z',
    });
    // Original record is not mutated.
    expect(record.audit?.fetchedAt).toBe(fetchedAt);
  });
});

// ---------------------------------------------------------------------------
// capability gates
// ---------------------------------------------------------------------------

describe('canUpdate and canDiffVsSource', () => {
  function record(source: SkillSource): SkillProvenanceRecord {
    return {
      mode: 'copy',
      source,
      contentHash: 'x',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('disables unknown-kind records with no-source', () => {
    const r = record({ kind: 'unknown' });
    expect(canUpdate(r)).toEqual({ enabled: false, reason: 'no-source' });
    expect(canDiffVsSource(r)).toEqual({ enabled: false, reason: 'no-source' });
  });

  it('disables Update but enables Diff-vs-source for local sources without a repo', () => {
    const r = record({ kind: 'local', path: '/some/path' });
    // Update needs git → disabled; Diff-vs-source compares against the path directly → enabled.
    expect(canUpdate(r)).toEqual({ enabled: false, reason: 'no-git-repo' });
    expect(canDiffVsSource(r)).toEqual({ enabled: true });
  });

  it('enables local sources with a discovered repo and a remote', () => {
    const r = record({
      kind: 'local',
      path: '/some/path',
      repo: {
        root: '/repo',
        skillPathInRepo: 'skills/foo',
        remoteUrl: 'https://example.com/repo.git',
      },
    });
    expect(canUpdate(r)).toEqual({ enabled: true });
    expect(canDiffVsSource(r)).toEqual({ enabled: true });
  });

  it('disables Update with no-remote for a local repo without an origin (no upstream to pull)', () => {
    const r = record({
      kind: 'local',
      path: '/some/path',
      repo: { root: '/repo', skillPathInRepo: 'skills/foo' },
    });
    expect(canUpdate(r)).toEqual({ enabled: false, reason: 'no-remote' });
    // Diff-vs-source compares against the local path directly — still enabled.
    expect(canDiffVsSource(r)).toEqual({ enabled: true });
  });

  it('enables git-remote and url sources', () => {
    expect(canUpdate(record({ kind: 'git-remote', url: 'https://example.com/r.git' }))).toEqual({
      enabled: true,
    });
    expect(canUpdate(record({ kind: 'url', url: 'https://example.com/skill.md' }))).toEqual({
      enabled: true,
    });
  });

  it('disables Diff-vs-source for Linked Skills (Copied-only, spec §6.3) but keeps Update enabled', () => {
    const r: SkillProvenanceRecord = {
      ...record({ kind: 'local', path: '/src', repo: { root: '/repo', skillPathInRepo: 'x', remoteUrl: 'https://example.com/r.git' } }),
      mode: 'link',
      link: { targetPath: '/src' },
    };
    expect(canDiffVsSource(r)).toEqual({ enabled: false, reason: 'link-mode' });
    expect(canUpdate(r)).toEqual({ enabled: true });
  });
});

// ---------------------------------------------------------------------------
// drift
// ---------------------------------------------------------------------------

describe('computeDrift', () => {
  it('reports none when the live hash matches the recorded copy hash', async () => {
    const root = await makeTempRoot('ccps-drift-none-');
    const skillDir = path.join(root, 'skill');
    await writeSkillTree(skillDir);
    const hash = await computeContentHash(skillDir);
    const record: SkillProvenanceRecord = {
      mode: 'copy',
      source: { kind: 'git-remote', url: 'https://example.com/r.git' },
      contentHash: hash,
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(await computeDrift(skillDir, record)).toBe('none');
  });

  it('reports local-drift for a copy whose live hash differs', async () => {
    const root = await makeTempRoot('ccps-drift-local-');
    const skillDir = path.join(root, 'skill');
    await writeSkillTree(skillDir);
    const record: SkillProvenanceRecord = {
      mode: 'copy',
      source: { kind: 'git-remote', url: 'https://example.com/r.git' },
      contentHash: 'stale-recorded-hash',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(await computeDrift(skillDir, record)).toBe('local-drift');
  });

  it.skipIf(!canCreateSymlink)('reports source-updated for a link whose source changed', async () => {
    const root = await makeTempRoot('ccps-drift-source-');
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    await fs.ensureDir(target);
    await fs.writeFile(path.join(target, 'SKILL.md'), 'original\n', 'utf8');
    await fs.symlink(target, link);

    const originalHash = await computeContentHash(link);
    const record: SkillProvenanceRecord = {
      mode: 'link',
      source: { kind: 'local', path: target },
      contentHash: originalHash,
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      link: { targetPath: target },
    };
    expect(await computeDrift(link, record)).toBe('none');

    await fs.writeFile(path.join(target, 'SKILL.md'), 'changed\n', 'utf8');
    expect(await computeDrift(link, record)).toBe('source-updated');
  });
});

// ---------------------------------------------------------------------------
// discoverLocalSkillRepo (git, mocked)
// ---------------------------------------------------------------------------

describe('discoverLocalSkillRepo', () => {
  it('returns undefined when the path is not inside a git repo', async () => {
    const root = await makeTempRoot('ccps-git-norepo-');
    const capture = mockCapture([
      { match: gitArgs(['rev-parse', '--show-toplevel']), exitCode: 1 },
    ]);
    const repo = await discoverLocalSkillRepo(root, { captureProcess: capture });
    expect(repo).toBeUndefined();
  });

  it('discovers root, remote, ref, and skillPathInRepo for a repo with origin', async () => {
    const root = await makeTempRoot('ccps-git-full-');
    const skillPath = path.join(root, 'skills', 'my-skill');
    await fs.ensureDir(skillPath);
    const capture = mockCapture([
      { match: gitArgs(['rev-parse', '--show-toplevel']), stdout: root },
      { match: gitArgs(['remote', 'get-url', 'origin']), stdout: 'https://example.com/repo.git' },
      { match: gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), stdout: 'main' },
    ]);
    const repo = await discoverLocalSkillRepo(skillPath, { captureProcess: capture });
    expect(repo).toEqual({
      root,
      remoteUrl: 'https://example.com/repo.git',
      skillPathInRepo: 'skills/my-skill',
      ref: 'main',
    });
  });

  it('omits remoteUrl when no origin remote is configured', async () => {
    const root = await makeTempRoot('ccps-git-noremote-');
    const capture = mockCapture([
      { match: gitArgs(['rev-parse', '--show-toplevel']), stdout: root },
      { match: gitArgs(['remote', 'get-url', 'origin']), exitCode: 1 },
      { match: gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), stdout: 'main' },
    ]);
    const repo = await discoverLocalSkillRepo(root, { captureProcess: capture });
    expect(repo?.remoteUrl).toBeUndefined();
    expect(repo?.ref).toBe('main');
  });

  it('omits ref when HEAD is detached (abbrev-ref returns HEAD)', async () => {
    const root = await makeTempRoot('ccps-git-detached-');
    const capture = mockCapture([
      { match: gitArgs(['rev-parse', '--show-toplevel']), stdout: root },
      { match: gitArgs(['remote', 'get-url', 'origin']), stdout: 'https://example.com/repo.git' },
      { match: gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), stdout: 'HEAD' },
    ]);
    const repo = await discoverLocalSkillRepo(root, { captureProcess: capture });
    expect(repo?.ref).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createRecordForInstall
// ---------------------------------------------------------------------------

describe('createRecordForInstall', () => {
  it('builds a copy record with live hash and now timestamps', async () => {
    const root = await makeTempRoot('ccps-install-copy-');
    const skillDir = path.join(root, 'skill');
    await writeSkillTree(skillDir);
    const clock = () => new Date('2026-03-01T00:00:00.000Z');

    const record = await createRecordForInstall({
      skillDirPath: skillDir,
      mode: 'copy',
      source: { kind: 'git-remote', url: 'https://example.com/r.git', skillPath: 'skills/skill' },
      clock,
    });

    expect(record.mode).toBe('copy');
    expect(record.contentHash).toBe(GOLDEN_TREE_HASH);
    expect(record.installedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(record.updatedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(record.sourceCheckedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(record.link).toBeUndefined();
  });

  it.skipIf(!canCreateSymlink)('builds a link record carrying the link targetPath', async () => {
    const root = await makeTempRoot('ccps-install-link-');
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    await fs.ensureDir(target);
    await writeSkillTree(target);
    await fs.symlink(target, link);

    const record = await createRecordForInstall({
      skillDirPath: link,
      mode: 'link',
      source: { kind: 'local', path: target, repo: { root, skillPathInRepo: 'target' } },
      linkTargetPath: target,
      clock: () => new Date('2026-03-01T00:00:00.000Z'),
    });

    expect(record.mode).toBe('link');
    expect(record.link).toEqual({ targetPath: target });
    expect(record.contentHash).toBe(GOLDEN_TREE_HASH);
  });
});

// ---------------------------------------------------------------------------
// inspectSkills (end-to-end)
// ---------------------------------------------------------------------------

describe('inspectSkills', () => {
  it('reconciles, computes health, drift, audit views, and capability gates', async () => {
    const root = await makeTempRoot('ccps-inspect-');
    const skillsDir = getSkillsDirectoryPath(root);

    // A pre-manifest skill that should be backfilled.
    await writeSkillTree(path.join(skillsDir, 'pre-manifest'));

    // A skill with a real record whose copy matches.
    const matchedDir = path.join(skillsDir, 'matched');
    await writeSkillTree(matchedDir);
    const matchedHash = await computeContentHash(matchedDir);
    await saveSkillsProvenance(root, {
      version: 1,
      skills: {
        matched: {
          mode: 'copy',
          source: { kind: 'git-remote', url: 'https://example.com/m.git' },
          contentHash: matchedHash,
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          audit: { state: 'pass', provider: 'skills.sh', fetchedAt: '2026-01-01T00:00:00.000Z' },
        },
      },
    });

    const result = await inspectSkills(root, { clock: () => new Date('2026-02-01T00:00:00.000Z') });

    expect(result.backfilled).toEqual(['pre-manifest']);
    expect(result.corruptionSignals).toEqual([]);

    const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]));
    expect(byName['pre-manifest'].record.source.kind).toBe('unknown');
    expect(byName['pre-manifest'].drift).toBe('none');
    expect(byName['pre-manifest'].linkHealth).toBeUndefined();
    expect(byName['pre-manifest'].update).toEqual({ enabled: false, reason: 'no-source' });
    expect(byName['pre-manifest'].auditView).toEqual({ state: 'not audited', stale: true });

    expect(byName.matched.drift).toBe('none');
    // audit past 24h TTL → cached-stale
    expect(byName.matched.auditView.state).toBe('cached-stale');
    expect(byName.matched.auditView.stale).toBe(true);
    expect(byName.matched.update).toEqual({ enabled: true });
  });
});
