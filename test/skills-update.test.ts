import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths, loadAppConfig, saveAppConfig } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { applySkillTransaction, stageSkillTree } from '../src/core/skills-transaction';
import {
  applySkillUpdate,
  buildSkillUpdatePlan,
  diffSkillVsSource,
  previewSkillUpdate,
} from '../src/core/skills-update';
import {
  computeContentHash,
  computeDrift,
  getSkillsDirectoryPath,
  loadSkillsProvenance,
} from '../src/core/skills-provenance';
import { installLocalSkill } from '../src/core/skills-install';
import {
  listRecoveryBinItems,
  performStartupSweep,
  restoreRecoveryItem,
} from '../src/core/recovery-bin';
import type { SkillProvenanceRecord, SkillSource } from '../src/schemas/skills-provenance';
import type { CaptureProcess } from '../src/platform/process';

// Skill update modes + Diff-vs-source (spec §7.1 update, §12 Diff; ticket #66).
//
// S74 copied-remote update re-acquires the recorded source, shows the diff, and
// applies via the transaction engine; the replaced tree becomes an `origin:
// update` Bin item (fixed 3-day TTL) and undo is the standard Bin restore.
// S75 copied-local pulls --ff-only (dirty aborts), one pull refreshes shared-repo
// skills. S76 linked update pulls with no Bin item (git is the undo).
// S77 Diff-vs-source renders changed / new-at-source / gone-at-source.

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function makeAppHome(): Promise<string> {
  const root = await makeTempRoot('ccps-skill-update-');
  const appHome = path.join(root, '.cc-profile-switch');
  await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
  return appHome;
}

async function makeProfile(appHome: string, name = 'coding'): Promise<string> {
  await createProfileFromTemplate({
    appHomePath: appHome,
    name,
    template: 'coding',
    clock: () => new Date('2026-07-31T16:00:00Z'),
  });
  const { profilesPath } = getAppHomePaths(appHome);
  return path.join(profilesPath, name);
}

const fixedClock = () => new Date('2026-08-01T09:00:00.000Z');
const laterClock = () => new Date('2026-08-01T10:30:00.000Z');

// Probe symlink capability synchronously at module load (link tests).
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

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

function skillsDirOf(profileRoot: string): string {
  return getSkillsDirectoryPath(profileRoot);
}

// ─── Setup helpers ──────────────────────────────────────────────────────

async function makeSkillTree(
  root: string,
  name: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, name);
  await fs.ensureDir(dir);
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A ${name} skill.\n---\n# ${name}\n`,
    'utf8',
  );
  for (const [rel, content] of Object.entries(extra)) {
    await fs.writeFile(path.join(dir, rel), content, 'utf8');
  }
  return dir;
}

async function installCopy(
  appHome: string,
  profileRoot: string,
  profileName: string,
  name: string,
  sourceTree: string,
  source: SkillSource,
  clock: () => Date = fixedClock,
): Promise<SkillProvenanceRecord> {
  const { stagedPath } = await stageSkillTree({ appHomePath: appHome, localSourcePath: sourceTree });
  const result = await applySkillTransaction({
    profileRootPath: profileRoot,
    profileName,
    name,
    mode: 'copy',
    stagedPath,
    source,
    clock,
  });
  return result.record;
}

function remoteSource(url: string, opts: { skillPath?: string; ref?: string } = {}): SkillSource {
  return { kind: 'git-remote', url, ...(opts.skillPath ? { skillPath: opts.skillPath } : {}), ...(opts.ref ? { ref: opts.ref } : {}) };
}

function localSource(sourcePath: string, repoRoot: string, skillPathInRepo: string): SkillSource {
  return {
    kind: 'local',
    path: sourcePath,
    repo: { root: repoRoot, skillPathInRepo, remoteUrl: 'https://example.com/repo.git', ref: 'main' },
  };
}

// ─── Git / remote capture mocks ─────────────────────────────────────────

type GitMockResponse = {
  match: (args: string[]) => boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

function mockGit(
  responses: GitMockResponse[],
  opts: { onCall?: (args: string[]) => void } = {},
): CaptureProcess {
  return async (_command, args) => {
    opts.onCall?.(args);
    for (const response of responses) {
      if (response.match(args)) {
        return {
          exitCode: response.exitCode ?? 0,
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
          timedOut: false,
        };
      }
    }
    return { exitCode: 1, stdout: '', stderr: 'no git mock matched', timedOut: false };
  };
}

const gitArgs = (subcommand: string[]): ((args: string[]) => boolean) => {
  return (args) => subcommand.every((token) => args.includes(token));
};

function cleanRepo(responses: GitMockResponse[] = []): GitMockResponse[] {
  return [
    { match: gitArgs(['status', '--porcelain']), stdout: '' },
    {
      match: gitArgs(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
      stdout: 'refs/remotes/origin/main',
    },
    { match: gitArgs(['pull']), stdout: 'Already up to date.' },
    ...responses,
  ];
}

/**
 * Fake pinned-adapter capture: stages the given files under the CLAUDE_CONFIG_DIR
 * the plan injected — mirroring what the real skills CLI does, without network.
 * Records every invocation's args for assertions.
 */
function fakeRemoteCapture(
  skillName: string,
  files: Record<string, string>,
  calls: string[][] = [],
): CaptureProcess {
  return async (_command, args, options) => {
    calls.push(args);
    const stagedRoot = path.join(options.env.CLAUDE_CONFIG_DIR as string, 'skills', skillName);
    await fs.ensureDir(stagedRoot);
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(stagedRoot, rel);
      await fs.ensureDir(path.dirname(target));
      await fs.writeFile(target, content, 'utf8');
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
}

/** The staging area may exist with its `remote-*`/`skill-*` subdirs removed. */
async function expectNoStagingResidue(appHome: string): Promise<void> {
  const staging = path.join(appHome, 'staging');
  if (!(await fs.pathExists(staging))) return;
  const entries = await fs.readdir(staging);
  expect(entries.filter((e) => e.startsWith('remote-') || e.startsWith('skill-'))).toEqual([]);
}

function skillMd(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: A ${name} skill.\n---\n${body}`;
}

// ─── buildSkillUpdatePlan ───────────────────────────────────────────────

describe('buildSkillUpdatePlan', () => {
  function record(source: SkillSource, mode: 'copy' | 'link' = 'copy', link?: string): SkillProvenanceRecord {
    return {
      mode,
      source,
      contentHash: 'x',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...(link ? { link: { targetPath: link } } : {}),
    };
  }

  it('classifies a git-remote copy as remote with the recorded URL coordinates', () => {
    const plan = buildSkillUpdatePlan(
      record({ kind: 'git-remote', url: 'owner/repo', skillPath: 'skills/find', ref: 'main' }),
    );
    expect(plan).toEqual({
      kind: 'remote',
      sourceUrl: 'owner/repo',
      skillPath: 'skills/find',
      ref: 'main',
    });
  });

  it('classifies a local copy with a repo as local', () => {
    const plan = buildSkillUpdatePlan(
      record({
        kind: 'local',
        path: '/src',
        repo: { root: '/repo', skillPathInRepo: 'x', remoteUrl: 'https://example.com/r.git' },
      }),
    );
    expect(plan).toEqual({
      kind: 'local',
      repoRoot: '/repo',
      sourcePath: '/src',
      remoteUrl: 'https://example.com/r.git',
    });
  });

  it('classifies a link as linked (repo pull, live content)', () => {
    const plan = buildSkillUpdatePlan(
      record(
        {
          kind: 'local',
          path: '/src',
          repo: { root: '/repo', skillPathInRepo: 'x', remoteUrl: 'https://example.com/r.git' },
        },
        'link',
        '/src',
      ),
    );
    expect(plan).toEqual({
      kind: 'linked',
      repoRoot: '/repo',
      linkTargetPath: '/src',
      remoteUrl: 'https://example.com/r.git',
    });
  });

  it('reports disabled plans for unknown / repo-less / remote-less records', () => {
    expect(buildSkillUpdatePlan(record({ kind: 'unknown' }))).toEqual({
      kind: 'disabled',
      reason: 'no-source',
    });
    expect(buildSkillUpdatePlan(record({ kind: 'local', path: '/src' }))).toEqual({
      kind: 'disabled',
      reason: 'no-git-repo',
    });
    expect(
      buildSkillUpdatePlan(
        record({ kind: 'local', path: '/src', repo: { root: '/repo', skillPathInRepo: 'x' } }),
      ),
    ).toEqual({ kind: 'disabled', reason: 'no-remote' });
  });
});

// ─── Copied-remote update (S74) ─────────────────────────────────────────

describe('copied-remote update', () => {
  it('re-acquires the exact recorded source, shows the file diff, and applies via the transaction engine', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-remote-upd-');

    // Install a copied-remote Skill from content A.
    const sourceTree = await makeSkillTree(root, 'find-skills');
    const source = remoteSource('vercel-labs/skills', { skillPath: 'skills/find-skills', ref: 'main' });
    await installCopy(appHome, profileDir, 'coding', 'find-skills', sourceTree, source);

    // The upstream source now has new content (fake adapter stages content B).
    const calls: string[][] = [];
    const capture = fakeRemoteCapture(
      'find-skills',
      { 'SKILL.md': skillMd('find-skills', '# NEW REMOTE CONTENT\n'), 'notes/added.txt': 'new\n' },
      calls,
    );

    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      captureProcess: capture,
    });

    expect(preview.kind).toBe('remote');
    expect(preview.mode).toBe('copy');
    expect(preview.noop).toBe(false);
    // The diff preview is hash-based: SKILL.md changed, notes/added.txt new-at-source.
    const byPath = new Map(preview.transaction!.diff.map((d) => [d.relPath, d.status]));
    expect(byPath.get('SKILL.md')).toBe('changed');
    expect(byPath.get('notes/added.txt')).toBe('added');
    expect(preview.stagedPath).toBeDefined();

    // The adapter re-acquired the RECORDED source (never `skills update`).
    const addArgs = calls.find((args) => args.includes('add'))!;
    expect(addArgs[1]).toBe('add');
    expect(addArgs).toContain('vercel-labs/skills');
    expect(addArgs).toContain('--skill');
    expect(addArgs).toContain('find-skills');
    expect(calls.every((args) => args[1] !== 'update')).toBe(true);

    const applied = await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      stagedPath: preview.stagedPath,
      clock: laterClock,
    });

    expect(applied.applied[0].noop).toBe(false);
    expect(applied.applied[0].replaced).toBe(true);
    // New content is live.
    const live = path.join(skillsDirOf(profileDir), 'find-skills', 'SKILL.md');
    expect(await fs.readFile(live, 'utf8')).toContain('# NEW REMOTE CONTENT');
    expect(await fs.pathExists(path.join(skillsDirOf(profileDir), 'find-skills', 'notes', 'added.txt'))).toBe(true);
    // Record refreshed (updatedAt) and hash matches the live tree.
    expect(applied.record.updatedAt).toBe(laterClock().toISOString());
    expect(applied.record.installedAt).toBe('2026-08-01T09:00:00.000Z');
    expect(applied.record.contentHash).toBe(await computeContentHash(path.join(skillsDirOf(profileDir), 'find-skills')));

    // The replaced tree landed in the Bin as origin: update.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems).toHaveLength(1);
    expect(binItems[0].origin).toBe('update');
    expect(binItems[0].kind).toBe('skill');
    expect(binItems[0].id).toBe(applied.applied[0].binItemId);
    // The bin copy holds the OLD content (undo material).
    const oldPayload = path.join(binItems[0].itemDirPath, 'claude-home', 'skills', 'find-skills', 'SKILL.md');
    expect(await fs.readFile(oldPayload, 'utf8')).toContain('# find-skills');
    // No transaction residue.
    expect(await fs.readdir(skillsDirOf(profileDir))).toEqual(['find-skills']);
  });

  it('undo of a successful update is the standard Bin restore; delete-and-restore preserves redo', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-remote-undo-');

    const sourceTree = await makeSkillTree(root, 'find-skills');
    await installCopy(
      appHome,
      profileDir,
      'coding',
      'find-skills',
      sourceTree,
      remoteSource('vercel-labs/skills'),
    );
    const capture = fakeRemoteCapture('find-skills', {
      'SKILL.md': skillMd('find-skills', '# NEW\n'),
    });
    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      captureProcess: capture,
    });
    const applied = await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      stagedPath: preview.stagedPath,
      clock: laterClock,
    });

    // Refuse-first: the live (new) tree collides with the restore target.
    await expect(
      restoreRecoveryItem({ appHomePath: appHome, itemId: applied.applied[0].binItemId! }),
    ).rejects.toMatchObject({ code: 'RESTORE_COLLISION' });

    // Inline delete-and-restore: the conflicting (new) tree becomes its own
    // Bin item (redo preserved), then the old content is restored.
    await restoreRecoveryItem({
      appHomePath: appHome,
      itemId: applied.applied[0].binItemId!,
      collisionResolution: 'delete-and-restore',
    });

    const live = path.join(skillsDirOf(profileDir), 'find-skills', 'SKILL.md');
    expect(await fs.readFile(live, 'utf8')).toContain('# find-skills');
    // The new tree is redo-able from a fresh remove-origin item.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems).toHaveLength(1);
    expect(binItems[0].origin).toBe('remove');
  });

  it('update items expire on the fixed 3-day TTL regardless of the global retention setting', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-remote-ttl-');

    // Raise the global retention to 90 days to prove the update TTL is fixed.
    const config = await loadAppConfig(appHome);
    await saveAppConfig(appHome, { ...config, recovery: { retentionDays: 90 } }, { clock: fixedClock });

    const sourceTree = await makeSkillTree(root, 'find-skills');
    await installCopy(appHome, profileDir, 'coding', 'find-skills', sourceTree, remoteSource('vercel-labs/skills'));
    const capture = fakeRemoteCapture('find-skills', { 'SKILL.md': skillMd('find-skills', '# NEW\n') });
    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      captureProcess: capture,
    });
    await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      stagedPath: preview.stagedPath,
      clock: fixedClock,
    });

    // removedAt = fixedClock (2026-08-01T09:00). Within the 3-day TTL at +2 days.
    const early = await performStartupSweep(appHome, () => new Date('2026-08-03T09:00:01.000Z'));
    expect(early.deletedCount).toBe(0);
    expect((await listRecoveryBinItems(appHome)).length).toBe(1);

    // Past the fixed 3-day TTL at +4 days — swept even with retentionDays = 90.
    const late = await performStartupSweep(appHome, () => new Date('2026-08-05T09:00:01.000Z'));
    expect(late.deletedCount).toBe(1);
    expect((await listRecoveryBinItems(appHome)).length).toBe(0);
  });

  it('is a no-op when the re-acquired source is identical to the installed tree (no Bin item)', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-remote-noop-');

    const sourceTree = await makeSkillTree(root, 'find-skills');
    await installCopy(appHome, profileDir, 'coding', 'find-skills', sourceTree, remoteSource('vercel-labs/skills'));
    // Re-acquire identical content.
    const capture = fakeRemoteCapture('find-skills', {
      'SKILL.md': skillMd('find-skills', '# find-skills\n'),
    });
    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      captureProcess: capture,
    });
    expect(preview.noop).toBe(true);
    expect(preview.transaction!.diff).toEqual([]);

    const applied = await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      stagedPath: preview.stagedPath,
      clock: laterClock,
    });
    expect(applied.applied[0].noop).toBe(true);
    expect((await listRecoveryBinItems(appHome)).length).toBe(0);
  });

  it('requires confirmation before overwriting a locally-drifted installed copy', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-remote-drift-');

    const sourceTree = await makeSkillTree(root, 'find-skills');
    await installCopy(appHome, profileDir, 'coding', 'find-skills', sourceTree, remoteSource('vercel-labs/skills'));
    // Out-of-band edit of the installed copy → local drift.
    await fs.writeFile(
      path.join(skillsDirOf(profileDir), 'find-skills', 'SKILL.md'),
      '---\nname: find-skills\n---\n# EDITED BY HAND\n',
      'utf8',
    );

    const capture = fakeRemoteCapture('find-skills', { 'SKILL.md': skillMd('find-skills', '# NEW\n') });
    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      captureProcess: capture,
    });
    expect(preview.transaction!.hasLocalDrift).toBe(true);
    expect(preview.transaction!.requiresConfirmation).toBe(true);

    await expect(
      applySkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'find-skills',
        stagedPath: preview.stagedPath,
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPDATE_DRIFT_CONFIRM_REQUIRED' });

    const applied = await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'find-skills',
      stagedPath: preview.stagedPath,
      confirmDriftOverwrite: true,
      clock: laterClock,
    });
    expect(applied.applied[0].noop).toBe(false);
    // The drifted edit was binned (origin update) so it is not lost.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems).toHaveLength(1);
    expect(binItems[0].origin).toBe('update');
  });

  it('propagates an offline re-acquisition failure without touching the Profile', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-remote-offline-');

    const sourceTree = await makeSkillTree(root, 'find-skills');
    await installCopy(appHome, profileDir, 'coding', 'find-skills', sourceTree, remoteSource('vercel-labs/skills'));

    const offlineCapture: CaptureProcess = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'TypeError: fetch failed',
      timedOut: false,
    });
    await expect(
      previewSkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'find-skills',
        captureProcess: offlineCapture,
      }),
    ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_OFFLINE' });

    // The Profile is untouched and no staging residue remains.
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'find-skills', 'SKILL.md'), 'utf8')).toContain('# find-skills');
    await expectNoStagingResidue(appHome);
  });
});

// ─── Copied-local update (S75) ──────────────────────────────────────────

describe('copied-local update', () => {
  it('dirty repo (tracked changes) aborts before any pull', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-local-dirty-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'commit-helper');
    await installCopy(
      appHome,
      profileDir,
      'coding',
      'commit-helper',
      sourceTree,
      localSource(sourceTree, repoRoot, 'commit-helper'),
    );

    const calls: string[][] = [];
    const git = mockGit(
      [{ match: gitArgs(['status', '--porcelain']), stdout: ' M SKILL.md\n' }],
      { onCall: (args) => calls.push(args) },
    );

    await expect(
      previewSkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'commit-helper',
        captureProcess: git,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPDATE_DIRTY_REPO' });

    // No pull was attempted.
    expect(calls.some((args) => args.includes('pull'))).toBe(false);
  });

  it('untracked files do not block the update (only tracked modifications are dirty)', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-local-untracked-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'commit-helper');
    await installCopy(
      appHome,
      profileDir,
      'coding',
      'commit-helper',
      sourceTree,
      localSource(sourceTree, repoRoot, 'commit-helper'),
    );

    const git = mockGit(cleanRepo());
    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'commit-helper',
      captureProcess: git,
    });
    expect(preview.kind).toBe('local');
    expect(preview.pulled).toBe(true);
  });

  it('pulls with --ff-only once and refreshes every copied Skill sharing the repo', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-local-shared-');
    const repoRoot = path.join(root, 'repo');

    // Two copied Skills from the same repo.
    const sourceA = await makeSkillTree(repoRoot, 'commit-helper');
    const sourceB = await makeSkillTree(repoRoot, 'code-review');
    await installCopy(appHome, profileDir, 'coding', 'commit-helper', sourceA, localSource(sourceA, repoRoot, 'commit-helper'));
    await installCopy(appHome, profileDir, 'coding', 'code-review', sourceB, localSource(sourceB, repoRoot, 'code-review'));

    // Upstream advanced: the source trees now carry new content (a real pull
    // would have brought this in; the mock just exits 0).
    await fs.writeFile(path.join(sourceA, 'SKILL.md'), skillMd('commit-helper', '# A V2\n'), 'utf8');
    await fs.writeFile(path.join(sourceB, 'SKILL.md'), skillMd('code-review', '# B V2\n'), 'utf8');

    const pulls: string[][] = [];
    const git = mockGit(cleanRepo(), { onCall: (args) => (args.includes('pull') ? pulls.push(args) : undefined) });

    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'commit-helper',
      captureProcess: git,
    });

    // The preview stages the pulled source and reports the shared repo sibling.
    expect(preview.kind).toBe('local');
    expect(preview.shared).toEqual(['code-review']);
    expect(preview.transaction!.diff.some((d) => d.relPath === 'SKILL.md' && d.status === 'changed')).toBe(true);
    // One pull per repo — not one per Skill.
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toContain('--ff-only');

    const applied = await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'commit-helper',
      stagedPath: preview.stagedPath,
      clock: laterClock,
    });

    // Both Skills were refreshed together.
    expect(applied.applied.map((a) => a.name).sort()).toEqual(['code-review', 'commit-helper']);
    expect(applied.applied.every((a) => a.noop === false)).toBe(true);
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'commit-helper', 'SKILL.md'), 'utf8')).toContain('# A V2');
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'code-review', 'SKILL.md'), 'utf8')).toContain('# B V2');

    // One Bin item per replaced tree, each origin: update.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems).toHaveLength(2);
    expect(binItems.every((item) => item.origin === 'update')).toBe(true);
    expect(binItems.every((item) => item.kind === 'skill')).toBe(true);
    // Still exactly one pull total — apply does not pull again.
    expect(pulls).toHaveLength(1);
  });

  it('disables with reason when the recorded repo has no remote/upstream', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-local-noremote-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'commit-helper');
    await installCopy(
      appHome,
      profileDir,
      'coding',
      'commit-helper',
      sourceTree,
      { kind: 'local', path: sourceTree, repo: { root: repoRoot, skillPathInRepo: 'commit-helper' } },
    );

    await expect(
      previewSkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'commit-helper',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPDATE_DISABLED' });
    expect(buildSkillUpdatePlan((await loadSkillsProvenance(profileDir)).skills['commit-helper'])).toEqual({
      kind: 'disabled',
      reason: 'no-remote',
    });
  });

  it('disables with reason when the repo has an origin but the current branch tracks no upstream', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-local-noupstream-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'commit-helper');
    await installCopy(
      appHome,
      profileDir,
      'coding',
      'commit-helper',
      sourceTree,
      localSource(sourceTree, repoRoot, 'commit-helper'),
    );

    // status clean; `git pull --ff-only` would fail — but the upstream probe
    // catches it first so the failure is a stated reason, not a pull error.
    const git = mockGit([
      { match: gitArgs(['status', '--porcelain']), stdout: '' },
      {
        match: gitArgs(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
        exitCode: 1,
        stderr: "fatal: no upstream configured for branch 'main'",
      },
    ]);

    await expect(
      previewSkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'commit-helper',
        captureProcess: git,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPDATE_DISABLED' });
  });

  it('skips (not aborts) a shared-repo Skill whose installed copy has local drift when unconfirmed', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-local-shareddrift-');
    const repoRoot = path.join(root, 'repo');

    const sourceA = await makeSkillTree(repoRoot, 'commit-helper');
    const sourceB = await makeSkillTree(repoRoot, 'code-review');
    await installCopy(appHome, profileDir, 'coding', 'commit-helper', sourceA, localSource(sourceA, repoRoot, 'commit-helper'));
    await installCopy(appHome, profileDir, 'coding', 'code-review', sourceB, localSource(sourceB, repoRoot, 'code-review'));

    // Both sources advanced upstream.
    await fs.writeFile(path.join(sourceA, 'SKILL.md'), skillMd('commit-helper', '# A V2\n'), 'utf8');
    await fs.writeFile(path.join(sourceB, 'SKILL.md'), skillMd('code-review', '# B V2\n'), 'utf8');
    // The shared skill's INSTALLED copy was edited out of band → local drift.
    await fs.writeFile(
      path.join(skillsDirOf(profileDir), 'code-review', 'SKILL.md'),
      '---\nname: code-review\n---\n# EDITED BY HAND\n',
      'utf8',
    );

    const git = mockGit(cleanRepo());
    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'commit-helper',
      captureProcess: git,
    });
    expect(preview.shared).toEqual(['code-review']);

    const applied = await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'commit-helper',
      stagedPath: preview.stagedPath,
      clock: laterClock,
    });

    // The primary applied; the drifted shared Skill was skipped without aborting
    // the batch, and its out-of-band edit is untouched.
    const primary = applied.applied.find((a) => a.name === 'commit-helper')!;
    const shared = applied.applied.find((a) => a.name === 'code-review')!;
    expect(primary.replaced).toBe(true);
    expect(shared.skippedDrift).toBe(true);
    expect(shared.replaced).toBe(false);
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'commit-helper', 'SKILL.md'), 'utf8')).toContain('# A V2');
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'code-review', 'SKILL.md'), 'utf8')).toContain('# EDITED BY HAND');
    // Only the primary produced an origin: update Bin item.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems).toHaveLength(1);
    expect(binItems[0].origin).toBe('update');
  });

  it('aborts on a failed pull with the git detail surfaced', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-local-pullfail-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'commit-helper');
    await installCopy(
      appHome,
      profileDir,
      'coding',
      'commit-helper',
      sourceTree,
      localSource(sourceTree, repoRoot, 'commit-helper'),
    );

    const git = mockGit([
      { match: gitArgs(['status', '--porcelain']), stdout: '' },
      {
        match: gitArgs(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
        stdout: 'refs/remotes/origin/main',
      },
      { match: gitArgs(['pull']), exitCode: 1, stderr: 'Not possible to fast-forward, aborting.' },
    ]);

    await expect(
      previewSkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'commit-helper',
        captureProcess: git,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPDATE_PULL_FAILED' });
  });

  it('fails cleanly when the recorded local source path no longer exists', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-local-missing-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'commit-helper');
    await installCopy(
      appHome,
      profileDir,
      'coding',
      'commit-helper',
      sourceTree,
      localSource(sourceTree, repoRoot, 'commit-helper'),
    );
    await fs.remove(sourceTree);

    const git = mockGit(cleanRepo());
    await expect(
      previewSkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'commit-helper',
        captureProcess: git,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPDATE_SOURCE_MISSING' });
  });
});

// ─── Linked update (S76) ────────────────────────────────────────────────

describe('linked update', () => {
  it.skipIf(!canCreateSymlink)('pulls the source repo, content goes live with no Bin item, and the source-updated marker clears', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-linked-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'live-skill');

    // Install as a linked Skill (repo discovery mocked at install time).
    const gitForInstall = mockGit([
      { match: gitArgs(['rev-parse', '--show-toplevel']), stdout: repoRoot },
      { match: gitArgs(['remote', 'get-url', 'origin']), stdout: 'https://example.com/repo.git' },
      { match: gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), stdout: 'main' },
    ]);
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceTree,
      mode: 'link',
      name: 'live-skill',
      gitCaptureProcess: gitForInstall,
      clock: fixedClock,
    });

    const linkPath = path.join(skillsDirOf(profileDir), 'live-skill');
    expect(await fs.lstat(linkPath)).toHaveProperty('isSymbolicLink');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

    // The source changes upstream → live content diverges from the recorded hash.
    await fs.writeFile(path.join(sourceTree, 'SKILL.md'), skillMd('live-skill', '# SOURCE V2\n'), 'utf8');
    const before = (await loadSkillsProvenance(profileDir)).skills['live-skill'];
    expect(await computeDrift(linkPath, before)).toBe('source-updated');

    // Update = one-click repo pull; content is live immediately.
    const pulls: string[][] = [];
    const gitForUpdate = mockGit(cleanRepo(), {
      onCall: (args) => (args.includes('pull') ? pulls.push(args) : undefined),
    });
    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'live-skill',
      captureProcess: gitForUpdate,
    });
    expect(preview.kind).toBe('linked');
    expect(preview.pulled).toBe(true);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toContain('--ff-only');

    const applied = await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'live-skill',
      clock: laterClock,
    });
    expect(applied.mode).toBe('link');
    expect(applied.applied[0].replaced).toBe(true);

    // Content is live through the link.
    expect(await fs.readFile(path.join(linkPath, 'SKILL.md'), 'utf8')).toContain('# SOURCE V2');
    // The record now fingerprints the pulled content — the source-updated marker clears.
    const after = (await loadSkillsProvenance(profileDir)).skills['live-skill'];
    expect(after.contentHash).toBe(applied.record.contentHash);
    expect(await computeDrift(linkPath, after)).toBe('none');
    // No Bin item: git is the undo.
    expect((await listRecoveryBinItems(appHome)).length).toBe(0);
  });

  it.skipIf(!canCreateSymlink)('is a no-op when the pulled source is unchanged', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-linked-noop-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'live-skill');

    const gitForInstall = mockGit([
      { match: gitArgs(['rev-parse', '--show-toplevel']), stdout: repoRoot },
      { match: gitArgs(['remote', 'get-url', 'origin']), stdout: 'https://example.com/repo.git' },
      { match: gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), stdout: 'main' },
    ]);
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceTree,
      mode: 'link',
      name: 'live-skill',
      gitCaptureProcess: gitForInstall,
      clock: fixedClock,
    });

    const preview = await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'live-skill',
      captureProcess: mockGit(cleanRepo()),
    });
    const applied = await applySkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'live-skill',
      clock: laterClock,
    });
    expect(preview.pulled).toBe(true);
    expect(applied.applied[0].noop).toBe(true);
    expect(applied.applied[0].replaced).toBe(false);
    expect((await listRecoveryBinItems(appHome)).length).toBe(0);
  });

  it.skipIf(!canCreateSymlink)('fails cleanly when the link source is missing', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-linked-broken-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'live-skill');

    const gitForInstall = mockGit([
      { match: gitArgs(['rev-parse', '--show-toplevel']), stdout: repoRoot },
      { match: gitArgs(['remote', 'get-url', 'origin']), stdout: 'https://example.com/repo.git' },
      { match: gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), stdout: 'main' },
    ]);
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceTree,
      mode: 'link',
      name: 'live-skill',
      gitCaptureProcess: gitForInstall,
      clock: fixedClock,
    });
    await fs.remove(sourceTree);

    await previewSkillUpdate({
      appHomePath: appHome,
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'live-skill',
      captureProcess: mockGit(cleanRepo()),
    });
    await expect(
      applySkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'live-skill',
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPDATE_LINK_BROKEN' });
  });
});

// ─── Diff vs source (S77) ───────────────────────────────────────────────

describe('diffSkillVsSource', () => {
  it('renders changed / new-at-source / gone-at-source against the local source', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-diff-local-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'shared', {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
    });
    await installCopy(appHome, profileDir, 'coding', 'shared', sourceTree, localSource(sourceTree, repoRoot, 'shared'));

    // Source changed: SKILL.md edited; a.txt removed at source; c.txt added at source.
    await fs.writeFile(path.join(sourceTree, 'SKILL.md'), skillMd('shared', '# SOURCE NEW\n'), 'utf8');
    await fs.remove(path.join(sourceTree, 'a.txt'));
    await fs.writeFile(path.join(sourceTree, 'c.txt'), 'c\n', 'utf8');

    const diff = await diffSkillVsSource({ appHomePath: appHome, profileRootPath: profileDir, name: 'shared' });

    const byPath = new Map(diff.entries.map((e) => [e.relPath, e.verdict]));
    expect(byPath.get('SKILL.md')).toBe('changed');
    expect(byPath.get('a.txt')).toBe('gone-at-source');
    expect(byPath.get('c.txt')).toBe('new-at-source');
    expect(diff.changedCount).toBe(1);
    expect(diff.goneAtSourceCount).toBe(1);
    expect(diff.newAtSourceCount).toBe(1);
    expect(diff.sourceMissing).toBe(false);
    expect(diff.sourceDescription).toBe(sourceTree);
  });

  it('compares same-named Skills with different sources each against its own source', async () => {
    const appHome = await makeAppHome();
    const profileA = await makeProfile(appHome, 'coding');
    const profileB = await makeProfile(appHome, 'study');
    const root = await makeTempRoot('ccps-diff-ownsource-');
    const repoA = path.join(root, 'repo-a');
    const repoB = path.join(root, 'repo-b');
    const sourceA = await makeSkillTree(repoA, 'shared', { 'only-a.txt': 'a\n' });
    const sourceB = await makeSkillTree(repoB, 'shared', { 'only-b.txt': 'b\n' });

    await installCopy(appHome, profileA, 'coding', 'shared', sourceA, localSource(sourceA, repoA, 'shared'));
    await installCopy(appHome, profileB, 'study', 'shared', sourceB, localSource(sourceB, repoB, 'shared'));

    // Each source advances independently.
    await fs.writeFile(path.join(sourceA, 'only-a.txt'), 'a2\n', 'utf8');
    await fs.writeFile(path.join(sourceB, 'only-b.txt'), 'b2\n', 'utf8');

    const diffA = await diffSkillVsSource({ appHomePath: appHome, profileRootPath: profileA, name: 'shared' });
    const diffB = await diffSkillVsSource({ appHomePath: appHome, profileRootPath: profileB, name: 'shared' });

    expect(diffA.entries.find((e) => e.relPath === 'only-a.txt')?.verdict).toBe('changed');
    expect(diffA.entries.find((e) => e.relPath === 'only-b.txt')).toBeUndefined();
    expect(diffB.entries.find((e) => e.relPath === 'only-b.txt')?.verdict).toBe('changed');
    expect(diffB.entries.find((e) => e.relPath === 'only-a.txt')).toBeUndefined();
    // No cross-Profile cross-talk: each diff reflects only its own source.
    expect(diffA.sourceDescription).toBe(sourceA);
    expect(diffB.sourceDescription).toBe(sourceB);
  });

  it('reports sourceMissing when the recorded local source is gone', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-diff-missing-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'shared');
    await installCopy(appHome, profileDir, 'coding', 'shared', sourceTree, localSource(sourceTree, repoRoot, 'shared'));
    await fs.remove(sourceTree);

    const diff = await diffSkillVsSource({ appHomePath: appHome, profileRootPath: profileDir, name: 'shared' });
    expect(diff.sourceMissing).toBe(true);
    expect(diff.entries).toEqual([]);
  });

  it('re-acquires a remote source for comparison and cleans up staging', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-diff-remote-');
    const sourceTree = await makeSkillTree(root, 'find-skills');
    await installCopy(appHome, profileDir, 'coding', 'find-skills', sourceTree, remoteSource('vercel-labs/skills', { skillPath: 'skills/find-skills' }));

    const calls: string[][] = [];
    const capture = fakeRemoteCapture(
      'find-skills',
      { 'SKILL.md': skillMd('find-skills', '# REMOTE NEW\n'), 'new.txt': 'n\n' },
      calls,
    );

    const diff = await diffSkillVsSource({
      appHomePath: appHome,
      profileRootPath: profileDir,
      name: 'find-skills',
      captureProcess: capture,
    });

    const byPath = new Map(diff.entries.map((e) => [e.relPath, e.verdict]));
    expect(byPath.get('SKILL.md')).toBe('changed');
    expect(byPath.get('new.txt')).toBe('new-at-source');
    // The recorded source URL was re-acquired (never `skills update`).
    const addArgs = calls.find((args) => args.includes('add'))!;
    expect(addArgs[1]).toBe('add');
    expect(addArgs).toContain('vercel-labs/skills');
    expect(addArgs).toContain('--skill');
    expect(addArgs).toContain('find-skills');
    // No staging residue after the diff.
    await expectNoStagingResidue(appHome);
  });

  it.skipIf(!canCreateSymlink)('disables diff-vs-source for a Linked Skill (Copied-only)', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-diff-linked-');
    const repoRoot = path.join(root, 'repo');
    const sourceTree = await makeSkillTree(repoRoot, 'live-skill');
    const gitForInstall = mockGit([
      { match: gitArgs(['rev-parse', '--show-toplevel']), stdout: repoRoot },
      { match: gitArgs(['remote', 'get-url', 'origin']), stdout: 'https://example.com/repo.git' },
      { match: gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), stdout: 'main' },
    ]);
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceTree,
      mode: 'link',
      name: 'live-skill',
      gitCaptureProcess: gitForInstall,
      clock: fixedClock,
    });

    const record = (await loadSkillsProvenance(profileDir)).skills['live-skill'];
    expect(record.mode).toBe('link');
    await expect(
      diffSkillVsSource({ appHomePath: appHome, profileRootPath: profileDir, name: 'live-skill' }),
    ).rejects.toMatchObject({ code: 'SKILL_DIFF_DISABLED' });
  });

  it('disables diff-vs-source for unknown-kind (backfilled) records', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-diff-unknown-');
    const sourceTree = await makeSkillTree(root, 'legacy');
    await installCopy(appHome, profileDir, 'coding', 'legacy', sourceTree, { kind: 'unknown' });

    await expect(
      diffSkillVsSource({ appHomePath: appHome, profileRootPath: profileDir, name: 'legacy' }),
    ).rejects.toMatchObject({ code: 'SKILL_DIFF_DISABLED' });
  });
});

// ─── Shared guards ──────────────────────────────────────────────────────

describe('update guards', () => {
  it('rejects a missing staged tree on apply', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);
    const root = await makeTempRoot('ccps-guard-stage-');
    const sourceTree = await makeSkillTree(root, 'find-skills');
    await installCopy(appHome, profileDir, 'coding', 'find-skills', sourceTree, remoteSource('vercel-labs/skills'));

    await expect(
      applySkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'find-skills',
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_UPDATE_STAGED_REQUIRED' });
  });

  it('refuses to update a Skill that is not installed', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome);

    await expect(
      previewSkillUpdate({
        appHomePath: appHome,
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
  });
});
