import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  checkInstallHealth,
  copySkillToProfile,
  installLocalSkill,
  listLocalSkillSources,
  previewInstall,
  removeLinkedSkill,
  restoreLinkedSkillItem,
  suggestCollisionName,
  validateLocalSkillSource,
  validateSkillDirectoryName,
} from '../src/core/skills-install';
import { loadSkillsProvenance, saveSkillsProvenance, computeDrift } from '../src/core/skills-provenance';
import { reconcileSkillTransactionCrashStates } from '../src/core/skills-transaction';
import { listRecoveryBinItems, restoreRecoveryItem } from '../src/core/recovery-bin';
import { createSkillLink } from '../src/platform/link';
import { type CaptureProcess } from '../src/platform/process';
import { CcpsError } from '../src/utils/errors';

// Probe symlink capability at module load so link tests can skip on platforms
// that refuse symlink creation (rare in CI, but the guard keeps the suite honest).
let canCreateSymlink = false;
{
  const probeDir = fs.mkdtempSync(path.join(tmpdir(), 'ccps-install-symlink-probe-'));
  try {
    fs.mkdirSync(path.join(probeDir, 'target'));
    fs.symlinkSync(path.join(probeDir, 'target'), path.join(probeDir, 'link'), 'dir');
    canCreateSymlink = true;
  } catch {
    canCreateSymlink = false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function makeAppHome(): Promise<string> {
  const root = await makeTempRoot('ccps-skills-install-');
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

const fixedClock = () => new Date('2026-07-31T16:13:29.000Z');

// Git mock helpers for repo-discovery tests (mirror skills-provenance.test.ts).
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

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
  vi.restoreAllMocks();
});

// ─── validateLocalSkillSource ───────────────────────────────────────────

describe('validateLocalSkillSource', () => {
  it('resolves a readable source with SKILL.md and derives a name', async () => {
    const root = await makeTempRoot('ccps-src-');
    const skillDir = await makeSourceSkill(root, 'commit-helper');

    const info = await validateLocalSkillSource(skillDir);

    expect(info.readable).toBe(true);
    expect(info.skillMdPresent).toBe(true);
    expect(info.suggestedName).toBe('commit-helper');
    expect(path.isAbsolute(info.sourcePath)).toBe(true);
  });

  it('marks a source without SKILL.md as invalid', async () => {
    const root = await makeTempRoot('ccps-src-');
    const dir = path.join(root, 'no-skill-md');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'README.md'), 'not a skill', 'utf8');

    const info = await validateLocalSkillSource(dir);

    expect(info.readable).toBe(true);
    expect(info.skillMdPresent).toBe(false);
  });

  it('marks a missing path as not readable', async () => {
    const info = await validateLocalSkillSource(path.join(tmpdir(), 'ccps-does-not-exist-xyz'));
    expect(info.readable).toBe(false);
    expect(info.skillMdPresent).toBe(false);
  });
});

// ─── validateSkillDirectoryName ─────────────────────────────────────────

describe('validateSkillDirectoryName', () => {
  it('accepts typical skill names', () => {
    expect(validateSkillDirectoryName('commit-helper')).toBe('commit-helper');
    expect(validateSkillDirectoryName('code.review')).toBe('code.review');
    expect(validateSkillDirectoryName('tdd_v2')).toBe('tdd_v2');
  });

  it('rejects path separators and traversal', () => {
    expect(() => validateSkillDirectoryName('foo/bar')).toThrow(CcpsError);
    expect(() => validateSkillDirectoryName('foo\\bar')).toThrow(CcpsError);
    expect(() => validateSkillDirectoryName('..')).toThrow(CcpsError);
    expect(() => validateSkillDirectoryName('.')).toThrow(CcpsError);
    expect(() => validateSkillDirectoryName('')).toThrow(CcpsError);
    expect(() => validateSkillDirectoryName(' leading')).toThrow(CcpsError);
  });
});

// ─── suggestCollisionName ───────────────────────────────────────────────

describe('suggestCollisionName', () => {
  it('suggests name-2, then name-3', () => {
    expect(suggestCollisionName('tdd', new Set())).toBe('tdd-2');
    expect(suggestCollisionName('tdd', new Set(['tdd-2']))).toBe('tdd-3');
    expect(suggestCollisionName('tdd', new Set(['tdd-2', 'tdd-3']))).toBe('tdd-4');
  });
});

// ─── previewInstall ─────────────────────────────────────────────────────

describe('previewInstall', () => {
  it('previews a Copy install with health checks and no collision', async () => {
    const root = await makeTempRoot('ccps-preview-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'fresh-skill');

    const preview = await previewInstall({
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'copy',
      name: 'fresh-skill',
    });

    expect(preview.mode).toBe('copy');
    expect(preview.name).toBe('fresh-skill');
    expect(preview.collides).toBe(false);
    expect(preview.canInstall).toBe(true);
    expect(preview.previewLines.some((l) => l.includes('create'))).toBe(true);
    expect(preview.previewLines.some((l) => l.includes('skills-provenance.json'))).toBe(true);
    expect(preview.checks.map((c) => c.code)).toContain('source-readable');
    expect(preview.checks.map((c) => c.code)).toContain('skill-md-present');
    // Copy mode does not run the platform-can-link check.
    expect(preview.checks.some((c) => c.code === 'platform-can-link')).toBe(false);
  });

  it('detects a collision and reports existingIsLink', async () => {
    const root = await makeTempRoot('ccps-preview-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'collide');

    // Install a copy first so the name collides on the second preview.
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'copy',
      name: 'collide',
      clock: fixedClock,
    });

    const preview = await previewInstall({
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'copy',
      name: 'collide',
    });

    expect(preview.collides).toBe(true);
    expect(preview.existingIsLink).toBe(false);
    expect(preview.existingNames).toContain('collide');
  });
});

// ─── installLocalSkill (Copy) ───────────────────────────────────────────

describe('installLocalSkill — Copy', () => {
  it('installs a snapshot and writes a copy-mode provenance record', async () => {
    const root = await makeTempRoot('ccps-install-copy-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'commit-helper', '# Helper\n');

    const result = await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'copy',
      name: 'commit-helper',
      clock: fixedClock,
    });

    expect(result.mode).toBe('copy');
    const installed = path.join(profileDir, 'claude-home', 'skills', 'commit-helper', 'SKILL.md');
    expect(await fs.pathExists(installed)).toBe(true);
    expect(await fs.readFile(installed, 'utf8')).toContain('# Helper');

    // Source must remain readable and unchanged (snapshot, not move).
    expect(await fs.pathExists(path.join(source, 'SKILL.md'))).toBe(true);

    const manifest = await loadSkillsProvenance(profileDir);
    const record = manifest.skills['commit-helper'];
    expect(record).toBeDefined();
    expect(record.mode).toBe('copy');
    expect(record.source.kind).toBe('local');
    expect(record.source.path).toBe(source);
    expect(record.contentHash.length).toBe(64);
    expect(record.link).toBeUndefined();
  });

  it('rejects a name with path separators (traversal safety)', async () => {
    const root = await makeTempRoot('ccps-install-copy-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'evil');

    await expect(
      installLocalSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        sourcePath: source,
        mode: 'copy',
        name: '../escape',
        clock: fixedClock,
      }),
    ).rejects.toThrow(CcpsError);
  });

  it('refuses to overwrite an existing skill without a resolution', async () => {
    const root = await makeTempRoot('ccps-install-copy-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'tdd');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'copy',
      name: 'tdd',
      clock: fixedClock,
    });

    await expect(
      installLocalSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        sourcePath: source,
        mode: 'copy',
        name: 'tdd',
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_INSTALL_COLLISION' });
  });

  it('replace resolution bins the existing copy and installs the new one', async () => {
    const root = await makeTempRoot('ccps-install-copy-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const sourceA = await makeSourceSkill(root, 'old-skill', '# OLD\n');
    const sourceB = path.join(root, 'new-skill');
    await fs.ensureDir(sourceB);
    await fs.writeFile(path.join(sourceB, 'SKILL.md'), '---\nname: new-skill\n---\n# NEW\n', 'utf8');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceA,
      mode: 'copy',
      name: 'shared',
      clock: fixedClock,
    });

    const result = await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceB,
      mode: 'copy',
      name: 'shared',
      collisionResolution: 'replace',
      clock: fixedClock,
    });

    expect(result.mode).toBe('copy');
    // New content is live.
    const installed = path.join(profileDir, 'claude-home', 'skills', 'shared', 'SKILL.md');
    expect(await fs.readFile(installed, 'utf8')).toContain('# NEW');

    // Old copy landed in the Recovery Bin as a file-tree item.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems.length).toBe(1);
    expect(binItems[0].kind).toBe('skill');
    expect(binItems[0].shape).toBe('file-tree');
  });
});

// ─── installLocalSkill (Link) ───────────────────────────────────────────

describe.skipIf(!canCreateSymlink)('installLocalSkill — Link', () => {
  it('creates a link and records link-mode provenance with the source fingerprint', async () => {
    const root = await makeTempRoot('ccps-install-link-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'live-skill', '# LIVE\n');

    const result = await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'link',
      name: 'live-skill',
      clock: fixedClock,
    });

    expect(result.mode).toBe('link');
    const linkPath = path.join(profileDir, 'claude-home', 'skills', 'live-skill');
    const lstat = await fs.lstat(linkPath);
    expect(lstat.isSymbolicLink()).toBe(true);

    // The link resolves to the source.
    const target = await fs.readlink(linkPath);
    expect(path.resolve(target)).toBe(path.resolve(source));

    const manifest = await loadSkillsProvenance(profileDir);
    const record = manifest.skills['live-skill'];
    expect(record.mode).toBe('link');
    expect(record.link?.targetPath).toBe(path.resolve(source));
    expect(record.source.kind).toBe('local');
  });

  it('rejects a relative link target (absolute-path safety)', async () => {
    const root = await makeTempRoot('ccps-install-link-');
    const linkPath = path.join(root, 'link');
    // createSkillLink is the defense-in-depth absolute guard; the service
    // resolves source paths to absolute before calling it, but the guard
    // itself must refuse a relative target outright.
    await expect(
      createSkillLink({ targetPath: 'relative/target', linkPath }),
    ).rejects.toMatchObject({ code: 'LINK_TARGET_NOT_ABSOLUTE' });
  });

  it('flags a self-referential target (inside claude-home) as a health failure', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    // Target inside the profile's claude-home.
    const innerSource = path.join(profileDir, 'claude-home', 'inner-skill');
    await fs.ensureDir(innerSource);
    await fs.writeFile(path.join(innerSource, 'SKILL.md'), '---\nname: inner\n---\n# inner\n', 'utf8');

    const checks = await checkInstallHealth({
      profileRootPath: profileDir,
      sourcePath: innerSource,
      mode: 'link',
    });
    const selfRef = checks.find((c) => c.code === 'target-not-self-referential');
    expect(selfRef?.ok).toBe(false);
  });

  it('records the enclosing git repo in provenance when the source is inside one', async () => {
    const root = await makeTempRoot('ccps-install-gitrepo-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'commit-helper', '# Helper\n');

    const gitCapture = mockCapture([
      { match: gitArgs(['rev-parse', '--show-toplevel']), stdout: root },
      { match: gitArgs(['remote', 'get-url', 'origin']), stdout: 'https://example.com/repo.git' },
      { match: gitArgs(['rev-parse', '--abbrev-ref', 'HEAD']), stdout: 'main' },
    ]);

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'copy',
      name: 'commit-helper',
      clock: fixedClock,
      gitCaptureProcess: gitCapture,
    });

    const manifest = await loadSkillsProvenance(profileDir);
    const record = manifest.skills['commit-helper'];
    expect(record.source.repo).toEqual({
      root,
      remoteUrl: 'https://example.com/repo.git',
      skillPathInRepo: 'commit-helper',
      ref: 'main',
    });
  });

  it('omits repo when the source is not inside a git repo', async () => {
    const root = await makeTempRoot('ccps-install-nogit-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'commit-helper', '# Helper\n');

    const gitCapture = mockCapture([
      { match: gitArgs(['rev-parse', '--show-toplevel']), exitCode: 1 },
    ]);

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'copy',
      name: 'commit-helper',
      clock: fixedClock,
      gitCaptureProcess: gitCapture,
    });

    const manifest = await loadSkillsProvenance(profileDir);
    const record = manifest.skills['commit-helper'];
    expect(record.source.repo).toBeUndefined();
  });
});

// ─── Link-incapable platform (mocked) ───────────────────────────────────

describe('installLocalSkill — link-incapable platform', () => {
  afterEach(() => {
    vi.doUnmock('../src/platform/link');
    vi.resetModules();
  });

  it('previews the link-incapable blocker and refuses to install', async () => {
    vi.doMock('../src/platform/link', () => ({
      probeLinkCapability: () => ({
        canCreate: false,
        kind: 'junction' as const,
        reason: 'mocked: platform cannot create links',
      }),
      createSkillLink: async () => {
        throw new Error('should not be called');
      },
      deleteSkillLink: async () => {},
      readLinkTarget: async () => undefined,
      getPlatformLinkKind: () => 'junction' as const,
      _resetLinkProbeCacheForTests: () => {},
    }));
    vi.resetModules();
    const mocked = await import('../src/core/skills-install');

    const root = await makeTempRoot('ccps-install-nolink-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'want-link');

    const preview = await mocked.previewInstall({
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'link',
      name: 'want-link',
    });
    expect(preview.canInstall).toBe(false);
    expect(preview.checks.find((c) => c.code === 'platform-can-link')?.ok).toBe(false);

    await expect(
      mocked.installLocalSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        sourcePath: source,
        mode: 'link',
        name: 'want-link',
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_INSTALL_HEALTH' });

    // Nothing was written.
    expect(await fs.pathExists(path.join(profileDir, 'claude-home', 'skills', 'want-link'))).toBe(false);
  });
});

// ─── Linked Skill removal + restore ─────────────────────────────────────

describe.skipIf(!canCreateSymlink)('removeLinkedSkill + restoreLinkedSkillItem', () => {
  it('removes only the link (source untouched) and lands a fragment Bin item', async () => {
    const root = await makeTempRoot('ccps-remove-link-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'linked-skill', '# LINKED\n');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'link',
      name: 'linked-skill',
      clock: fixedClock,
    });

    const result = await removeLinkedSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      name: 'linked-skill',
      clock: fixedClock,
    });

    expect(result.linkTargetPath).toBe(path.resolve(source));

    // Invariant 7: source tree untouched.
    expect(await fs.pathExists(path.join(source, 'SKILL.md'))).toBe(true);
    expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toContain('# LINKED');

    // The link is gone.
    expect(await fs.pathExists(path.join(profileDir, 'claude-home', 'skills', 'linked-skill'))).toBe(false);

    // The Bin holds a fragment with link coordinates + provenance.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems.length).toBe(1);
    expect(binItems[0].kind).toBe('skill');
    expect(binItems[0].shape).toBe('fragment');

    // The manifest no longer carries the record.
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['linked-skill']).toBeUndefined();
  });

  it('restore re-creates the link and re-applies the provenance record', async () => {
    const root = await makeTempRoot('ccps-restore-link-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'restore-skill', '# RESTORE\n');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'link',
      name: 'restore-skill',
      clock: fixedClock,
    });

    const removed = await removeLinkedSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      name: 'restore-skill',
      clock: fixedClock,
    });

    const binItems = await listRecoveryBinItems(appHome);
    const restore = await restoreLinkedSkillItem({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      itemId: binItems[0].id,
      clock: fixedClock,
    });

    expect(restore.consumed).toBe(true);
    expect(restore.restoredName).toBe('restore-skill');

    // The link is back, pointing at the same source.
    const linkPath = path.join(profileDir, 'claude-home', 'skills', 'restore-skill');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(await fs.readlink(linkPath))).toBe(path.resolve(removed.linkTargetPath));

    // The provenance record is back.
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['restore-skill'].mode).toBe('link');

    // The Bin item was consumed.
    expect((await listRecoveryBinItems(appHome)).length).toBe(0);
  });

  it('refuses to remove a Copied Skill through the link-only path', async () => {
    const root = await makeTempRoot('ccps-remove-link-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'copied-skill');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'copy',
      name: 'copied-skill',
      clock: fixedClock,
    });

    await expect(
      removeLinkedSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        name: 'copied-skill',
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_LINKED' });
  });
});

// ─── Generic restore guard ──────────────────────────────────────────────

describe.skipIf(!canCreateSymlink)('recovery-bin generic restore guard', () => {
  it('refuses to restore a linked-skill fragment through the generic path', async () => {
    const root = await makeTempRoot('ccps-guard-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'guard-skill');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: source,
      mode: 'link',
      name: 'guard-skill',
      clock: fixedClock,
    });

    await removeLinkedSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      name: 'guard-skill',
      clock: fixedClock,
    });

    const binItems = await listRecoveryBinItems(appHome);
    await expect(
      restoreRecoveryItem({ appHomePath: appHome, itemId: binItems[0].id }),
    ).rejects.toMatchObject({ code: 'RECOVERY_ITEM_RESTORE_ROUTE' });
  });
});

// ─── copySkillToProfile (spec §11.1 fan-out) ────────────────────────────

describe('copySkillToProfile', () => {
  it('copies a copied Skill as a snapshot carrying the local source identity', async () => {
    const root = await makeTempRoot('ccps-skill-copy-');
    const appHome = await makeAppHome();
    const sourceDir = await makeProfile(appHome, 'coding');
    const targetDir = await makeProfile(appHome, 'study');
    const source = await makeSourceSkill(root, 'commit-helper', '# Helper\n');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: sourceDir,
      sourcePath: source,
      mode: 'copy',
      name: 'commit-helper',
      clock: fixedClock,
    });

    const result = await copySkillToProfile({
      appHomePath: appHome,
      fromProfile: 'coding',
      toProfile: 'study',
      skillName: 'commit-helper',
      clock: fixedClock,
    });

    const landed = path.join(targetDir, 'claude-home', 'skills', 'commit-helper', 'SKILL.md');
    expect(await fs.pathExists(landed)).toBe(true);
    expect(await fs.readFile(landed, 'utf8')).toContain('# Helper');

    const manifest = await loadSkillsProvenance(targetDir);
    const record = manifest.skills['commit-helper'];
    expect(record).toBeDefined();
    expect(record.mode).toBe('copy');
    // Source identity carried over — local source path preserved.
    expect(record.source.kind).toBe('local');
    expect(record.source.path).toBe(source);
    expect(record.contentHash.length).toBe(64);
    expect(result.targetPath).toBe(path.join(targetDir, 'claude-home', 'skills', 'commit-helper'));

    // Source profile untouched.
    const sourceManifest = await loadSkillsProvenance(sourceDir);
    expect(sourceManifest.skills['commit-helper']).toBeDefined();
  });

  it('carries a git-remote source identity so updates keep working in the target', async () => {
    const root = await makeTempRoot('ccps-skill-copy-remote-');
    const appHome = await makeAppHome();
    const sourceDir = await makeProfile(appHome, 'coding');
    const targetDir = await makeProfile(appHome, 'study');
    const source = await makeSourceSkill(root, 'remote-skill');

    // Install as a plain copy, then rewrite the record's source to model a
    // remote-sourced Skill (as the remote install path would record it).
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: sourceDir,
      sourcePath: source,
      mode: 'copy',
      name: 'remote-skill',
      clock: fixedClock,
    });
    const manifest = await loadSkillsProvenance(sourceDir);
    manifest.skills['remote-skill'].source = {
      kind: 'git-remote',
      url: 'https://github.com/acme/remote-skill.git',
      ref: 'main',
    };
    await saveSkillsProvenance(sourceDir, manifest);

    await copySkillToProfile({
      appHomePath: appHome,
      fromProfile: 'coding',
      toProfile: 'study',
      skillName: 'remote-skill',
      clock: fixedClock,
    });

    const record = (await loadSkillsProvenance(targetDir)).skills['remote-skill'];
    expect(record.source.kind).toBe('git-remote');
    expect(record.source.url).toBe('https://github.com/acme/remote-skill.git');
    expect(record.source.ref).toBe('main');
  });

  it('snapshots a linked Skill into a real directory in the target', async () => {
    const root = await makeTempRoot('ccps-skill-copy-link-');
    const appHome = await makeAppHome();
    const sourceDir = await makeProfile(appHome, 'coding');
    const targetDir = await makeProfile(appHome, 'study');
    const source = await makeSourceSkill(root, 'linked-skill');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: sourceDir,
      sourcePath: source,
      mode: 'link',
      name: 'linked-skill',
      clock: fixedClock,
    });

    await copySkillToProfile({
      appHomePath: appHome,
      fromProfile: 'coding',
      toProfile: 'study',
      skillName: 'linked-skill',
      clock: fixedClock,
    });

    const landedDir = path.join(targetDir, 'claude-home', 'skills', 'linked-skill');
    const stats = await fs.lstat(landedDir);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(await fs.pathExists(path.join(landedDir, 'SKILL.md'))).toBe(true);
    const record = (await loadSkillsProvenance(targetDir)).skills['linked-skill'];
    expect(record.mode).toBe('copy');
    // The source link must not be touched.
    expect(await fs.pathExists(source)).toBe(true);
  });

  it('keeps an unknown backfilled source identity (update stays disabled)', async () => {
    const root = await makeTempRoot('ccps-skill-copy-unknown-');
    const appHome = await makeAppHome();
    const sourceDir = await makeProfile(appHome, 'coding');
    const targetDir = await makeProfile(appHome, 'study');
    const source = await makeSourceSkill(root, 'legacy-skill');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: sourceDir,
      sourcePath: source,
      mode: 'copy',
      name: 'legacy-skill',
      clock: fixedClock,
    });
    const manifest = await loadSkillsProvenance(sourceDir);
    manifest.skills['legacy-skill'].source = { kind: 'unknown' };
    await saveSkillsProvenance(sourceDir, manifest);

    await copySkillToProfile({
      appHomePath: appHome,
      fromProfile: 'coding',
      toProfile: 'study',
      skillName: 'legacy-skill',
      clock: fixedClock,
    });

    const record = (await loadSkillsProvenance(targetDir)).skills['legacy-skill'];
    expect(record.source.kind).toBe('unknown');
  });

  it('refuses when a same-named Skill already exists in the target', async () => {
    const root = await makeTempRoot('ccps-skill-copy-collision-');
    const appHome = await makeAppHome();
    const sourceDir = await makeProfile(appHome, 'coding');
    const targetDir = await makeProfile(appHome, 'study');
    const source = await makeSourceSkill(root, 'shared-skill');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: sourceDir,
      sourcePath: source,
      mode: 'copy',
      name: 'shared-skill',
      clock: fixedClock,
    });
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'study',
      profileRootPath: targetDir,
      sourcePath: source,
      mode: 'copy',
      name: 'shared-skill',
      clock: fixedClock,
    });

    await expect(
      copySkillToProfile({
        appHomePath: appHome,
        fromProfile: 'coding',
        toProfile: 'study',
        skillName: 'shared-skill',
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_INSTALL_COLLISION' });

    // Target entry untouched.
    const record = (await loadSkillsProvenance(targetDir)).skills['shared-skill'];
    expect(record).toBeDefined();
    expect(await fs.readFile(path.join(targetDir, 'claude-home', 'skills', 'shared-skill', 'SKILL.md'), 'utf8')).toContain('name: shared-skill');
  });

  it('rejects a Skill that is not installed in the source profile', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await makeProfile(appHome, 'study');

    await expect(
      copySkillToProfile({
        appHomePath: appHome,
        fromProfile: 'coding',
        toProfile: 'study',
        skillName: 'not-there',
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
  });

  it('rejects when the target profile does not exist', async () => {
    const root = await makeTempRoot('ccps-skill-copy-noprof-');
    const appHome = await makeAppHome();
    const sourceDir = await makeProfile(appHome, 'coding');
    const source = await makeSourceSkill(root, 'orphan-skill');

    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: sourceDir,
      sourcePath: source,
      mode: 'copy',
      name: 'orphan-skill',
      clock: fixedClock,
    });

    await expect(
      copySkillToProfile({
        appHomePath: appHome,
        fromProfile: 'coding',
        toProfile: 'missing',
        skillName: 'orphan-skill',
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });
});

// ─── installLocalSkill replace — crash reconciliation (spec §7.1, #65) ────
// The install replace path runs through the transaction engine's rename-swap,
// so a crash leaves sidecar + .ccps-tmp/.ccps-old residue that the startup
// sweep reconciles. Fault injection mirrors skills-transaction.test.ts.

async function listTxResidue(skillsDir: string): Promise<string[]> {
  if (!(await fs.pathExists(skillsDir))) return [];
  return (await fs.readdir(skillsDir)).filter((n) => n.startsWith('.ccps-'));
}

describe('installLocalSkill — replace crash reconciliation (copy)', () => {
  async function installOld(appHome: string, profileDir: string, root: string): Promise<void> {
    const sourceA = await makeSourceSkill(root, 'old-skill', '# OLD\n');
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceA,
      mode: 'copy',
      name: 'shared',
      clock: fixedClock,
    });
  }

  function skillsDirOf(profileDir: string): string {
    return path.join(profileDir, 'claude-home', 'skills');
  }

  it('crash after rename-old → sweep renames the old tree back, no Bin item', async () => {
    const root = await makeTempRoot('ccps-install-crash-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    await installOld(appHome, profileDir, root);
    const sourceB = await makeSourceSkill(root, 'new-skill', '# NEW\n');

    await expect(
      installLocalSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        sourcePath: sourceB,
        mode: 'copy',
        name: 'shared',
        collisionResolution: 'replace',
        clock: fixedClock,
        __fault: 'after-rename-old',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    // <name> is gone (renamed to .ccps-old), sidecar present — pre-sweep state.
    expect(await fs.pathExists(path.join(skillsDirOf(profileDir), 'shared'))).toBe(false);
    expect((await listTxResidue(skillsDirOf(profileDir))).length).toBeGreaterThan(0);

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('renamed-old-back');
    // Old tree is restored; nothing was binned; no residue remains.
    expect(
      await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8'),
    ).toContain('# OLD');
    expect(await listTxResidue(skillsDirOf(profileDir))).toEqual([]);
    expect((await listRecoveryBinItems(appHome)).length).toBe(0);
  });

  it('crash after rename-new → sweep deletes old; new tree live; stale manifest drifts', async () => {
    const root = await makeTempRoot('ccps-install-crash-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    await installOld(appHome, profileDir, root);
    const recordedHash = (await loadSkillsProvenance(profileDir)).skills['shared'].contentHash;
    const sourceB = await makeSourceSkill(root, 'new-skill', '# NEW\n');

    await expect(
      installLocalSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        sourcePath: sourceB,
        mode: 'copy',
        name: 'shared',
        collisionResolution: 'replace',
        clock: fixedClock,
        __fault: 'after-rename-new',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('deleted-old');
    // New tree is live; the swap had succeeded.
    expect(
      await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8'),
    ).toContain('# NEW');
    expect(await listTxResidue(skillsDirOf(profileDir))).toEqual([]);
    // Manifest was not written → live hash diverges from the OLD record →
    // local drift, exactly the manual-edit path (spec §7.1, deliberately).
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['shared'].contentHash).toBe(recordedHash);
    const drift = await computeDrift(
      path.join(skillsDirOf(profileDir), 'shared'),
      manifest.skills['shared'],
    );
    expect(drift).toBe('local-drift');
  });

  it('crash before manifest write → stale sidecar only → sweep drops it, drift remains', async () => {
    const root = await makeTempRoot('ccps-install-crash-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    await installOld(appHome, profileDir, root);
    const recordedHash = (await loadSkillsProvenance(profileDir)).skills['shared'].contentHash;
    const sourceB = await makeSourceSkill(root, 'new-skill', '# NEW\n');

    await expect(
      installLocalSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        sourcePath: sourceB,
        mode: 'copy',
        name: 'shared',
        collisionResolution: 'replace',
        clock: fixedClock,
        __fault: 'before-manifest',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    // No tmp/old residue — the swap and the bin disposal completed.
    expect(
      (await listTxResidue(skillsDirOf(profileDir))).every((n) => n.startsWith('.ccps-tx-')),
    ).toBe(true);

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('deleted-stale-sidecar');
    expect(
      await fs.readFile(path.join(skillsDirOf(profileDir), 'shared', 'SKILL.md'), 'utf8'),
    ).toContain('# NEW');
    expect(await listTxResidue(skillsDirOf(profileDir))).toEqual([]);
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['shared'].contentHash).toBe(recordedHash);
    const drift = await computeDrift(
      path.join(skillsDirOf(profileDir), 'shared'),
      manifest.skills['shared'],
    );
    expect(drift).toBe('local-drift');
  });
});

describe.skipIf(!canCreateSymlink)('installLocalSkill — replace crash reconciliation (link)', () => {
  it('crash after rename-new → sweep deletes old; the live link shows as drift', async () => {
    const root = await makeTempRoot('ccps-install-link-crash-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const skillsDir = path.join(profileDir, 'claude-home', 'skills');

    const sourceA = await makeSourceSkill(root, 'old-skill', '# OLD\n');
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceA,
      mode: 'copy',
      name: 'shared',
      clock: fixedClock,
    });
    const recordedHash = (await loadSkillsProvenance(profileDir)).skills['shared'].contentHash;

    const sourceB = await makeSourceSkill(root, 'new-live', '# NEW\n');
    await expect(
      installLocalSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        sourcePath: sourceB,
        mode: 'link',
        name: 'shared',
        collisionResolution: 'replace',
        clock: fixedClock,
        __fault: 'after-rename-new',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_TX_FAULT_INJECTED' });

    const result = await reconcileSkillTransactionCrashStates(profileDir);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('deleted-old');
    // The new entry is the live link; the old copy is gone.
    const linkPath = path.join(skillsDir, 'shared');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await listTxResidue(skillsDir)).toEqual([]);
    // Manifest stale → drift on the link content (manual-edit path).
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['shared'].contentHash).toBe(recordedHash);
    const drift = await computeDrift(linkPath, manifest.skills['shared']);
    expect(drift).toBe('local-drift');
  });

  it('replacing a copied entry lands the link and bins the old copy (file-tree)', async () => {
    const root = await makeTempRoot('ccps-install-link-replace-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const skillsDir = path.join(profileDir, 'claude-home', 'skills');

    const sourceA = await makeSourceSkill(root, 'old-skill', '# OLD\n');
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceA,
      mode: 'copy',
      name: 'shared',
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new-live', '# NEW\n');
    const result = await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceB,
      mode: 'link',
      name: 'shared',
      collisionResolution: 'replace',
      clock: fixedClock,
    });

    expect(result.mode).toBe('link');
    const linkPath = path.join(skillsDir, 'shared');
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(path.resolve(await fs.readlink(linkPath))).toBe(path.resolve(sourceB));
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems.length).toBe(1);
    expect(binItems[0].shape).toBe('file-tree');
    expect(binItems[0].origin).toBe('remove');
    // The manifest carries the link-mode record with the resolved target.
    const manifest = await loadSkillsProvenance(profileDir);
    expect(manifest.skills['shared'].mode).toBe('link');
    expect(manifest.skills['shared'].link?.targetPath).toBe(path.resolve(sourceB));
  });

  it('replacing a linked entry bins it as a fragment with link coordinates + provenance', async () => {
    const root = await makeTempRoot('ccps-install-link-frag-');
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const skillsDir = path.join(profileDir, 'claude-home', 'skills');

    const sourceA = await makeSourceSkill(root, 'old-live', '# OLD LIVE\n');
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceA,
      mode: 'link',
      name: 'shared',
      clock: fixedClock,
    });

    const sourceB = await makeSourceSkill(root, 'new-skill', '# NEW\n');
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      sourcePath: sourceB,
      mode: 'copy',
      name: 'shared',
      collisionResolution: 'replace',
      clock: fixedClock,
    });

    expect(
      await fs.readFile(path.join(skillsDir, 'shared', 'SKILL.md'), 'utf8'),
    ).toContain('# NEW');
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems.length).toBe(1);
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
  });
});

// ─── listLocalSkillSources (install wizard step-1 catalog, spec §7.2) ─────

describe('listLocalSkillSources', () => {
  it('catalogs Skills from other Profiles, excluding the install target', async () => {
    const root = await makeTempRoot('ccps-local-sources-');
    const appHome = await makeAppHome();
    const codingDir = await makeProfile(appHome, 'coding');
    const notesDir = await makeProfile(appHome, 'notes');

    // Install a Skill into each Profile.
    const sourceA = await makeSourceSkill(root, 'grilling', '# GRILL\n');
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'notes',
      profileRootPath: notesDir,
      sourcePath: sourceA,
      mode: 'copy',
      name: 'grilling',
      clock: fixedClock,
    });
    const sourceB = await makeSourceSkill(root, 'tdd', '# TDD\n');
    await installLocalSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: codingDir,
      sourcePath: sourceB,
      mode: 'copy',
      name: 'tdd',
      clock: fixedClock,
    });

    const sources = await listLocalSkillSources({
      appHomePath: appHome,
      excludeProfileName: 'coding',
    });

    // Only the notes Profile's Skill is offered — never the target's own.
    expect(sources.length).toBe(1);
    expect(sources[0].suggestedName).toBe('grilling');
    expect(sources[0].originProfile).toBe('notes');
    expect(sources[0].readable).toBe(true);
    expect(sources[0].skillMdPresent).toBe(true);
    expect(sources[0].sourcePath).toBe(
      path.join(notesDir, 'claude-home', 'skills', 'grilling'),
    );
  });

  it('marks sources without a SKILL.md and skips transaction residue', async () => {
    const root = await makeTempRoot('ccps-local-sources-');
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const notesDir = await makeProfile(appHome, 'notes');
    const skillsDir = path.join(notesDir, 'claude-home', 'skills');

    // A broken source (no SKILL.md) — must arrive pre-marked, not hidden.
    await fs.ensureDir(path.join(skillsDir, 'scratch'));
    // Transaction residue must never appear as a source.
    await fs.ensureDir(path.join(skillsDir, '.ccps-old-deadbeef'));
    await fs.writeFile(path.join(skillsDir, '.ccps-tx-deadbeef.json'), '{}', 'utf8');
    void root;

    const sources = await listLocalSkillSources({
      appHomePath: appHome,
      excludeProfileName: 'coding',
    });

    expect(sources.length).toBe(1);
    expect(sources[0].suggestedName).toBe('scratch');
    expect(sources[0].skillMdPresent).toBe(false);
  });

  it('returns an empty list when no other Profile has Skills', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');

    const sources = await listLocalSkillSources({
      appHomePath: appHome,
      excludeProfileName: 'coding',
    });
    expect(sources).toEqual([]);
  });
});
