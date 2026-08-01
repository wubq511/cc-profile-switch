import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  checkInstallHealth,
  installLocalSkill,
  previewInstall,
  removeLinkedSkill,
  restoreLinkedSkillItem,
  suggestCollisionName,
  validateLocalSkillSource,
  validateSkillDirectoryName,
} from '../src/core/skills-install';
import { loadSkillsProvenance } from '../src/core/skills-provenance';
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
