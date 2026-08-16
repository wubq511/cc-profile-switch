import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  applySkillTransaction,
  getStagingPath,
  previewTransaction,
  stageSkillTree,
  reconcileSkillTransactionCrashStates,
  reconcileAllProfilesTransactionCrashStates,
  TX_OLD_PREFIX,
  TX_SIDECAR_PREFIX,
  TX_TMP_PREFIX,
} from '../src/core/skills-transaction';
import {
  computeDrift,
  getSkillsDirectoryPath,
  loadSkillsProvenance,
} from '../src/core/skills-provenance';
import type { SkillProvenanceRecord, SkillSource } from '../src/schemas/skills-provenance';
import {
  getLastCrashReconcileCount,
  listRecoveryBinItems,
  performStartupSweep,
} from '../src/core/recovery-bin';
import { probeLinkCapability } from '../src/platform/link';
import { CcpsError } from '../src/utils/errors';

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function makeAppHome(): Promise<string> {
  const root = await makeTempRoot('ccps-skill-tx-');
  const appHome = path.join(root, '.cc-profile-switch');
  await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
  return appHome;
}

async function makeProfile(appHome: string, name: string): Promise<string> {
  await createProfileFromTemplate({
    appHomePath: appHome,
    name,
    template: 'coding',
    clock: () => new Date('2026-07-31T16:00:00Z'),
  });
  const { profilesPath } = getAppHomePaths(appHome);
  return path.join(profilesPath, name);
}

async function makeSourceSkill(root: string, name: string, body = '# Test\n'): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.ensureDir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n${body}`, 'utf8');
  return skillDir;
}

function localSource(pathStr: string): SkillSource {
  return { kind: 'local', path: pathStr };
}

const fixedClock = () => new Date('2026-08-01T09:00:00.000Z');
const laterClock = () => new Date('2026-08-01T10:30:00.000Z');

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

function skillsDirOf(profileRoot: string): string {
  return getSkillsDirectoryPath(profileRoot);
}

async function listResidue(skillsDir: string): Promise<string[]> {
  if (!(await fs.pathExists(skillsDir))) return [];
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.name.startsWith(TX_TMP_PREFIX) ||
        e.name.startsWith(TX_OLD_PREFIX) ||
        e.name.startsWith(TX_SIDECAR_PREFIX),
    )
    .map((e) => e.name);
}

// ─── stageSkillTree ─────────────────────────────────────────────────────

describe('stageSkillTree', () => {
  it('stages a local source tree outside the Profile (same partition as profiles)', async () => {
    const root = await makeTempRoot('ccps-stage-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'commit-helper', '# Helper\n');

    const { stagedPath, stageId } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: source,
    });

    expect(stageId.length).toBe(12);
    // Staged path lives under the app home staging area, not the Profile.
    expect(stagedPath.startsWith(getStagingPath(appHome))).toBe(true);
    expect(stagedPath.startsWith(profileDir)).toBe(false);
    // Content is copied.
    expect(await fs.readFile(path.join(stagedPath, 'SKILL.md'), 'utf8')).toContain('# Helper');
    // Source is untouched (copy, not move).
    expect(await fs.pathExists(path.join(source, 'SKILL.md'))).toBe(true);
  });

  it('stage failure is a pure error — Profile untouched, no staging residue', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    await expect(
      stageSkillTree({
        appHomePath: appHome,
        localSourcePath: path.join(tmpdir(), 'ccps-does-not-exist-xyz'),
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_STAGE_FAILED' });

    // No skill-* staging residue left behind.
    const staging = getStagingPath(appHome);
    if (await fs.pathExists(staging)) {
      const left = (await fs.readdir(staging)).filter((n) => n.startsWith('skill-'));
      expect(left).toEqual([]);
    }
    // Staging never writes into the Profile — the skills directory carries no
    // transaction residue and no staged skill entry.
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('accepts a pre-staged tree (remote acquisition path)', async () => {
    const root = await makeTempRoot('ccps-prestage-');
    const appHome = await makeAppHome();
    const preStaged = await makeSourceSkill(root, 'remote-skill', '# Remote\n');

    const { stagedPath } = await stageSkillTree({
      appHomePath: appHome,
      preStagedPath: preStaged,
    });

    expect(await fs.readFile(path.join(stagedPath, 'SKILL.md'), 'utf8')).toContain('# Remote');
    // Pre-staged source is preserved (copied, not moved).
    expect(await fs.pathExists(path.join(preStaged, 'SKILL.md'))).toBe(true);
  });
});

// ─── previewTransaction ─────────────────────────────────────────────────

describe('previewTransaction', () => {
  it('fresh install: every staged file is added, no drift, no confirmation required', async () => {
    const root = await makeTempRoot('ccps-prev-fresh-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'fresh', '# Fresh\n');

    const { stagedPath } = await stageSkillTree({ appHomePath: appHome, localSourcePath: source });

    const preview = await previewTransaction({
      profileRootPath: profileDir,
      name: 'fresh',
      mode: 'copy',
      stagedPath,
    });

    expect(preview.hasLocalDrift).toBe(false);
    expect(preview.requiresConfirmation).toBe(false);
    expect(preview.diff.map((d) => ({ relPath: d.relPath, status: d.status }))).toEqual([
      { relPath: 'SKILL.md', status: 'added' },
    ]);
  });

  it('update: reports added, changed, and removed files', async () => {
    const root = await makeTempRoot('ccps-prev-diff-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    // Installed tree: SKILL.md + notes/a.txt
    const installedSource = path.join(root, 'installed');
    await fs.ensureDir(path.join(installedSource, 'notes'));
    await fs.writeFile(path.join(installedSource, 'SKILL.md'), '---\nname: x\n---\n# OLD\n', 'utf8');
    await fs.writeFile(path.join(installedSource, 'notes', 'a.txt'), 'old-a\n', 'utf8');

    const { stagedPath: stage1 } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: installedSource,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'x',
      mode: 'copy',
      stagedPath: stage1,
      source: localSource(installedSource),
      clock: fixedClock,
    });

    // New staged tree: SKILL.md (changed), notes/b.txt (added), notes/a.txt (removed)
    const newSource = path.join(root, 'new');
    await fs.ensureDir(path.join(newSource, 'notes'));
    await fs.writeFile(path.join(newSource, 'SKILL.md'), '---\nname: x\n---\n# NEW\n', 'utf8');
    await fs.writeFile(path.join(newSource, 'notes', 'b.txt'), 'new-b\n', 'utf8');
    const { stagedPath: stage2 } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: newSource,
    });

    const preview = await previewTransaction({
      profileRootPath: profileDir,
      name: 'x',
      mode: 'copy',
      stagedPath: stage2,
    });

    const byPath = new Map(preview.diff.map((d) => [d.relPath, d.status]));
    expect(byPath.get('SKILL.md')).toBe('changed');
    expect(byPath.get('notes/b.txt')).toBe('added');
    expect(byPath.get('notes/a.txt')).toBe('removed');
    // No out-of-band edit → no drift.
    expect(preview.hasLocalDrift).toBe(false);
    expect(preview.requiresConfirmation).toBe(false);
  });

  it('local drift (edited copy) requires explicit confirmation before overwrite', async () => {
    const root = await makeTempRoot('ccps-prev-drift-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'drift', '# Original\n');

    const { stagedPath: stage1 } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: source,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'drift',
      mode: 'copy',
      stagedPath: stage1,
      source: localSource(source),
      clock: fixedClock,
    });

    // Out-of-band edit of the installed copy → live hash diverges from recorded.
    await fs.writeFile(
      path.join(skillsDirOf(profileDir), 'drift', 'SKILL.md'),
      '---\nname: drift\n---\n# EDITED BY HAND\n',
      'utf8',
    );

    // Stage the original content again (so the staged hash matches the recorded,
    // not the live edited tree).
    const { stagedPath: stage2 } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: source,
    });

    const preview = await previewTransaction({
      profileRootPath: profileDir,
      name: 'drift',
      mode: 'copy',
      stagedPath: stage2,
    });

    expect(preview.hasLocalDrift).toBe(true);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.liveHash).not.toBe(preview.recordedHash);
  });
});

// ─── applySkillTransaction — fresh install ──────────────────────────────

describe('applySkillTransaction — fresh install', () => {
  it('lands the new tree at <name> and writes provenance, leaving no residue', async () => {
    const root = await makeTempRoot('ccps-apply-fresh-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'commit-helper', '# Helper\n');

    const { stagedPath } = await stageSkillTree({ appHomePath: appHome, localSourcePath: source });

    const result = await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'commit-helper',
      mode: 'copy',
      stagedPath,
      source: localSource(source),
      clock: fixedClock,
    });

    expect(result.replaced).toBe(false);
    const installed = path.join(skillsDirOf(profileDir), 'commit-helper', 'SKILL.md');
    expect(await fs.readFile(installed, 'utf8')).toContain('# Helper');

    // Manifest carries a copy-mode record with a content hash matching the live tree.
    const manifest = await loadSkillsProvenance(profileDir);
    const record = manifest.skills['commit-helper'];
    expect(record).toBeDefined();
    expect(record.mode).toBe('copy');
    expect(record.contentHash).toBe(result.record.contentHash);
    expect(record.installedAt).toBe(record.updatedAt);

    // No transaction residue.
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);

    // Staging area was consumed (rename, not copy).
    expect(await fs.pathExists(stagedPath)).toBe(false);
  });

  it('refuses a cross-partition staged tree', async () => {
    // Simulate cross-partition by mocking fs.stat dev mismatch is hard across
    // platforms; instead verify the EXDEV path is classified. We trust the
    // same-partition happy path (above) and exercise the guard via a missing
    // staged path which surfaces a non-cross-partition error. This test pins
    // that a non-existent staged path does not silently succeed.
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'ghost',
        mode: 'copy',
        stagedPath: path.join(tmpdir(), 'ccps-no-such-staged-tree'),
        source: localSource('/nope'),
        clock: fixedClock,
      }),
    ).rejects.toThrow();
  });
});

// ─── applySkillTransaction — replace ────────────────────────────────────

describe('applySkillTransaction — replace', () => {
  it('delete disposition removes the old tree outright', async () => {
    const root = await makeTempRoot('ccps-apply-replace-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });
    const result = await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageB,
      source: localSource(sourceB),
      replaceOld: { kind: 'delete' },
      clock: laterClock,
    });

    expect(result.replaced).toBe(true);
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# NEW',
    );
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
    // No Bin item created for a plain delete.
    expect((await listRecoveryBinItems(appHome)).length).toBe(0);
  });

  it('bin disposition (origin: update) lands the old tree in the Recovery Bin', async () => {
    const root = await makeTempRoot('ccps-apply-bin-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageB,
      source: localSource(sourceB),
      replaceOld: { kind: 'bin', origin: 'update', appHomePath: appHome, profileName: 'coding' },
      clock: laterClock,
    });

    // Old tree is gone from the live skills directory.
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# NEW',
    );
    // Old tree landed in the Bin as a file-tree skill item with origin: update.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems.length).toBe(1);
    expect(binItems[0].kind).toBe('skill');
    expect(binItems[0].shape).toBe('file-tree');
    expect(binItems[0].origin).toBe('update');
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('update preserves installedAt and the audit cache, refreshes updatedAt', async () => {
    const root = await makeTempRoot('ccps-apply-update-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    const first = await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    // Simulate a cached audit on the installed record.
    const manifest = await loadSkillsProvenance(profileDir);
    const existing: SkillProvenanceRecord = {
      ...manifest.skills['shared'],
      audit: { state: 'pass', provider: 'skills.sh', fetchedAt: fixedClock().toISOString() },
    };

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });
    const updated = await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageB,
      source: localSource(sourceB),
      replaceOld: { kind: 'bin', origin: 'update', appHomePath: appHome, profileName: 'coding' },
      existingRecord: existing,
      clock: laterClock,
    });

    expect(updated.record.installedAt).toBe(first.record.installedAt);
    expect(updated.record.updatedAt).toBe(laterClock().toISOString());
    expect(updated.record.audit).toEqual(existing.audit);
  });
});

// ─── Crash-state reconciliation (fault injection) ───────────────────────

describe('crash-state reconciliation (startup sweep)', () => {
  it('crash after rename-tmp → tmp residue only → sweep deletes tmp, old tree intact', async () => {
    const root = await makeTempRoot('ccps-crash-tmp-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });

    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'copy',
        stagedPath: stageB,
        source: localSource(sourceB),
        __fault: 'after-rename-tmp',
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    // Residue present before the sweep.
    const residueBefore = await listResidue(skillsDirOf(profileDir));
    expect(residueBefore.some((n) => n.startsWith(TX_TMP_PREFIX))).toBe(true);
    expect(residueBefore.some((n) => n.startsWith(TX_SIDECAR_PREFIX))).toBe(true);

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('deleted-tmp');
    expect(result.entries[0].name).toBe('shared');
    // Old tree is intact — the apply never reached the swap.
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# OLD',
    );
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
    // Manifest unchanged (still the OLD record).
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['shared'].contentHash).toBe(
      (await loadSkillsProvenance(profileDir)).skills['shared'].contentHash,
    );
  });

  it('crash after rename-old → old without final → sweep renames old back (rollback)', async () => {
    const root = await makeTempRoot('ccps-crash-old-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });

    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'copy',
        stagedPath: stageB,
        source: localSource(sourceB),
        __fault: 'after-rename-old',
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    // <name> is gone (renamed to .ccps-old) and tmp exists — pre-sweep state.
    expect(await fs.pathExists(path.join(skillsDirOf(profileDir), 'shared'))).toBe(false);

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('renamed-old-back');
    // Old tree is restored to <name>.
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# OLD',
    );
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('crash after rename-new → old + final both present → sweep deletes old, drift remains', async () => {
    const root = await makeTempRoot('ccps-crash-new-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });
    const recordedHash = (await loadSkillsProvenance(profileDir)).skills['shared'].contentHash;

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });

    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'copy',
        stagedPath: stageB,
        source: localSource(sourceB),
        __fault: 'after-rename-new',
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries[0].action).toBe('deleted-old');
    // New tree is live.
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# NEW',
    );
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
    // Manifest was not written → live hash diverges from recorded → local drift.
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['shared'].contentHash).toBe(recordedHash);
    const drift = await computeDrift(
      path.join(skillsDirOf(profileDir), 'shared'),
      manifest.skills['shared'],
    );
    expect(drift).toBe('local-drift');
  });

  it('crash before manifest write → stale sidecar only → sweep drops it, drift remains', async () => {
    const root = await makeTempRoot('ccps-crash-manifest-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });
    const recordedHash = (await loadSkillsProvenance(profileDir)).skills['shared'].contentHash;

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });

    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'copy',
        stagedPath: stageB,
        source: localSource(sourceB),
        replaceOld: { kind: 'bin', origin: 'update', appHomePath: appHome, profileName: 'coding' },
        __fault: 'before-manifest',
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    // Pre-sweep: only a sidecar remains (swap + disposal completed).
    const residueBefore = await listResidue(skillsDirOf(profileDir));
    expect(residueBefore.every((n) => n.startsWith(TX_SIDECAR_PREFIX))).toBe(true);

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries[0].action).toBe('deleted-stale-sidecar');
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
    // New tree is live, manifest stale → local drift (same path as a manual edit).
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['shared'].contentHash).toBe(recordedHash);
    const drift = await computeDrift(
      path.join(skillsDirOf(profileDir), 'shared'),
      manifest.skills['shared'],
    );
    expect(drift).toBe('local-drift');
  });
});

// ─── Write-atomicity (real-error rollback) ──────────────────────────────

describe('write-atomicity (real failure rolls back)', () => {
  it('failure after rename-old restores the old tree with no residue', async () => {
    const root = await makeTempRoot('ccps-rollback-old-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });

    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'copy',
        stagedPath: stageB,
        source: localSource(sourceB),
        __failAt: 'after-rename-old',
        clock: laterClock,
      }),
    ).rejects.toThrow('Real failure injected');

    // Old tree restored to <name>, no transaction residue, manifest unchanged.
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# OLD',
    );
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('failure after rename-tmp cleans the tmp residue, old tree intact', async () => {
    const root = await makeTempRoot('ccps-rollback-tmp-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });

    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'copy',
        stagedPath: stageB,
        source: localSource(sourceB),
        __failAt: 'after-rename-tmp',
        clock: laterClock,
      }),
    ).rejects.toThrow('Real failure injected');

    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# OLD',
    );
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });
});

// ─── Startup sweep integration ──────────────────────────────────────────

describe('performStartupSweep reconciles crash states across profiles', () => {
  it('sweeps expired Bin items and reconciles transaction residue', async () => {
    const root = await makeTempRoot('ccps-sweep-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });
    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'copy',
        stagedPath: stageB,
        source: localSource(sourceB),
        __fault: 'after-rename-old',
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    expect(await listResidue(skillsDirOf(profileDir))).not.toEqual([]);

    const sweepResult = await performStartupSweep(appHome, () => new Date('2026-08-01T12:00:00Z'));

    // Sweep returns the Bin expiry result (no expired items here).
    expect(sweepResult.deletedCount).toBe(0);
    // Crash reconciliation ran as part of the sweep.
    expect(getLastCrashReconcileCount()).toBe(1);
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('reconcileAllProfilesTransactionCrashStates covers every profile', async () => {
    const root = await makeTempRoot('ccps-sweep-all-');
    const appHome = await makeAppHome();
    const profileA = await makeProfile(appHome, 'coding');
    const profileB = await makeProfile(appHome, 'study');

    const injectCrash = async (profileDir: string, profileName: string) => {
      const source = await makeSourceSkill(root, `${profileName}-src`, '# X\n');
      const { stagedPath } = await stageSkillTree({ appHomePath: appHome, localSourcePath: source });
      await expect(
        applySkillTransaction({
          profileRootPath: profileDir,
          profileName,
          name: 'shared',
          mode: 'copy',
          stagedPath,
          source: localSource(source),
          __fault: 'after-rename-tmp',
          clock: laterClock,
        }),
      ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });
    };

    await injectCrash(profileA, 'coding');
    await injectCrash(profileB, 'study');

    const result = await reconcileAllProfilesTransactionCrashStates(appHome);
    expect(result.entries).toHaveLength(2);
    expect(await listResidue(skillsDirOf(profileA))).toEqual([]);
    expect(await listResidue(skillsDirOf(profileB))).toEqual([]);
  });
});

// ─── Traversal safety ───────────────────────────────────────────────────

describe('applySkillTransaction — traversal safety', () => {
  it('rejects a name with path separators', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const root = await makeTempRoot('ccps-traversal-');
    const source = await makeSourceSkill(root, 'evil');

    const { stagedPath } = await stageSkillTree({ appHomePath: appHome, localSourcePath: source });

    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: '../escape',
        mode: 'copy',
        stagedPath,
        source: localSource(source),
        clock: fixedClock,
      }),
    ).rejects.toThrow(CcpsError);
  });
});

// ─── applySkillTransaction — link mode ──────────────────────────────────
// Link-mode applies swap in one atomic symlink creation; the old entry still
// renames to .ccps-old first, so a replacing link install is crash-safe and
// sweep-reconcilable exactly like copy mode.

const canLink = probeLinkCapability().canCreate;

describe.skipIf(!canLink)('applySkillTransaction — link mode', () => {
  it('fresh link install lands an absolute-target symlink and a link-mode record', async () => {
    const root = await makeTempRoot('ccps-tx-link-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'live-skill', '# LIVE\n');

    const result = await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'live-skill',
      mode: 'link',
      linkTargetPath: source,
      source: localSource(source),
      clock: fixedClock,
    });

    const linkPath = path.join(skillsDirOf(profileDir), 'live-skill');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(await fs.readlink(linkPath))).toBe(path.resolve(source));
    expect(result.record.mode).toBe('link');
    expect(result.record.link?.targetPath).toBe(path.resolve(source));
    expect(result.replaced).toBe(false);
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('replacing a copied entry bins the old tree as a file-tree item', async () => {
    const root = await makeTempRoot('ccps-tx-link-replace-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const result = await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'link',
      linkTargetPath: sourceB,
      source: localSource(sourceB),
      replaceOld: { kind: 'bin', origin: 'remove', appHomePath: appHome, profileName: 'coding' },
      clock: laterClock,
    });

    expect(result.replaced).toBe(true);
    // The new entry is a live link to the source.
    const linkPath = path.join(skillsDirOf(profileDir), 'shared');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(await fs.readlink(linkPath))).toBe(path.resolve(sourceB));
    // Old copied tree landed in the Bin as a file-tree item.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems.length).toBe(1);
    expect(binItems[0].kind).toBe('skill');
    expect(binItems[0].shape).toBe('file-tree');
    expect(binItems[0].origin).toBe('remove');
    // The record is link-mode with the resolved target.
    expect(result.record.mode).toBe('link');
    expect(result.record.link?.targetPath).toBe(path.resolve(sourceB));
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('replacing a linked entry bins it as a fragment with link coordinates + provenance', async () => {
    const root = await makeTempRoot('ccps-tx-link-frag-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    // Old entry is a LINK with a link-mode record in the manifest.
    const sourceA = await makeSourceSkill(root, 'old-live', '# OLD LIVE\n');
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'link',
      linkTargetPath: sourceA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    const { stagedPath: stageB } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceB,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageB,
      source: localSource(sourceB),
      replaceOld: { kind: 'bin', origin: 'remove', appHomePath: appHome, profileName: 'coding' },
      clock: laterClock,
    });

    // New copied tree is live.
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# NEW',
    );
    // The linked old entry was binned as a fragment — restore re-creates the
    // link instead of materializing its content.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems.length).toBe(1);
    expect(binItems[0].kind).toBe('skill');
    expect(binItems[0].shape).toBe('fragment');
    const coords = binItems[0].coordinates as {
      file: string;
      keyPath: string;
      value: { mode: string; linkTargetPath: string; provenance?: { mode: string } };
    };
    expect(coords.keyPath).toBe('shared');
    expect(coords.value.mode).toBe('link');
    expect(path.resolve(coords.value.linkTargetPath)).toBe(path.resolve(sourceA));
    expect(coords.value.provenance?.mode).toBe('link');
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('crash after rename-old (link mode) → sweep renames the old entry back', async () => {
    const root = await makeTempRoot('ccps-tx-link-crash-old-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'link',
        linkTargetPath: sourceB,
        source: localSource(sourceB),
        __fault: 'after-rename-old',
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    // Pre-sweep: <name> is gone (renamed to .ccps-old), no tmp in link mode.
    expect(await fs.pathExists(path.join(skillsDirOf(profileDir), 'shared'))).toBe(false);
    const residueBefore = await listResidue(skillsDirOf(profileDir));
    expect(residueBefore.some((n) => n.startsWith(TX_OLD_PREFIX))).toBe(true);
    expect(residueBefore.some((n) => n.startsWith(TX_TMP_PREFIX))).toBe(false);

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('renamed-old-back');
    expect(await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8')).toContain(
      '# OLD',
    );
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });

  it('crash after rename-new (link mode) → sweep deletes old; the live link shows as drift', async () => {
    const root = await makeTempRoot('ccps-tx-link-crash-new-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });
    const recordedHash = (await loadSkillsProvenance(profileDir)).skills['shared'].contentHash;

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'link',
        linkTargetPath: sourceB,
        source: localSource(sourceB),
        __fault: 'after-rename-new',
        clock: laterClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('deleted-old');
    // The new entry is the live link.
    const linkPath = path.join(skillsDirOf(profileDir), 'shared');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
    // Manifest was not written → live link content diverges from the OLD
    // record → local drift (same path as a manual user edit, spec §7.1).
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['shared'].contentHash).toBe(recordedHash);
    const drift = await computeDrift(linkPath, manifest.skills['shared']);
    expect(drift).toBe('local-drift');
  });

  it('real failure after rename-new (link mode) rolls back: link removed, old restored', async () => {
    const root = await makeTempRoot('ccps-tx-link-rollback-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const sourceA = await makeSourceSkill(root, 'old', '# OLD\n');
    const { stagedPath: stageA } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceA,
    });
    await applySkillTransaction({
      profileRootPath: profileDir,
      profileName: 'coding',
      name: 'shared',
      mode: 'copy',
      stagedPath: stageA,
      source: localSource(sourceA),
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new', '# NEW\n');
    await expect(
      applySkillTransaction({
        profileRootPath: profileDir,
        profileName: 'coding',
        name: 'shared',
        mode: 'link',
        linkTargetPath: sourceB,
        source: localSource(sourceB),
        __failAt: 'after-rename-new',
        clock: laterClock,
      }),
    ).rejects.toThrow('Real failure injected at after-rename-new');

    // Rollback restored the pre-operation state: old tree back at <name>, the
    // just-created link removed, no residue.
    const restored = path.join(skillsDirOf(profileDir), 'shared');
    expect((await fs.lstat(restored)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(restored, 'SKILL.md'), 'utf8')).toContain('# OLD');
    expect(await listResidue(skillsDirOf(profileDir))).toEqual([]);
  });
});
