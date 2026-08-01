import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  acquireAndPreviewRemoteInstall,
  buildRemoteInstallPlan,
  installRemoteSkill,
} from '../src/core/skills-remote-install';
import { getSkillsDirectoryPath, loadSkillsProvenance } from '../src/core/skills-provenance';
import { listRecoveryBinItems } from '../src/core/recovery-bin';
import { type CaptureProcess } from '../src/platform/process';
import { resolveFilesystemPath } from '../src/platform/path';
import { CcpsError } from '../src/utils/errors';

// Remote Skill install transaction (spec §7.3).
//
// The pinned `skills@1.5.21` adapter stages into an isolated
// `<profileRoot>/.ccps-remote-stage-<id>` tree; ccps verifies the staged
// frontmatter identity, then lands through a same-partition rename-swap with a
// full provenance record. The real `~/.claude` is never touched
// (CLAUDE_CONFIG_DIR points into staging).

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function makeAppHome(): Promise<string> {
  const root = await makeTempRoot('ccps-remote-install-');
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

const fixedClock = () => new Date('2026-07-31T16:13:29.000Z');

// A fake capture that "stages" a Skill by writing its SKILL.md into the
// CLAUDE_CONFIG_DIR the plan injected — mirroring what the real pinned CLI
// would do, but without network. Returns the staged directory name.
function fakeCaptureStaging(skillName: string, description = 'A staged Skill.'): CaptureProcess {
  return async (_command, _args, options) => {
    const claudeHome = options.env.CLAUDE_CONFIG_DIR as string;
    const staged = path.join(claudeHome, 'skills', skillName);
    await fs.ensureDir(staged);
    await fs.writeFile(
      path.join(staged, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: ${description}\n---\n# ${skillName}\n`,
      'utf8',
    );
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
}

function failingCapture(message: string, exitCode = 1): CaptureProcess {
  return async () => ({ exitCode, stdout: '', stderr: message, timedOut: false });
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

// ─── buildRemoteInstallPlan (pure: dry-run ≡ real) ──────────────────────

describe('buildRemoteInstallPlan', () => {
  it('builds a staging root under profileRoot and a target under claude-home/skills', () => {
    const profileRoot = '/profiles/coding';
    const plan = buildRemoteInstallPlan({
      profileRootPath: profileRoot,
      rawSource: 'vercel-labs/skills',
      name: 'find-skills',
      stagingId: 'abc123',
    });

    // Build expectations through the same resolver the src uses: the
    // posix-absolute fake profile root keeps posix separators on every platform.
    expect(plan.stagingRoot).toBe(resolveFilesystemPath(profileRoot, '.ccps-remote-stage-abc123'));
    expect(plan.targetPath).toBe(
      resolveFilesystemPath(profileRoot, 'claude-home', 'skills', 'find-skills'),
    );
    // The acquisition sub-plan is exactly what acquireSkillIntoStaging runs.
    expect(plan.acquisition.command).toBe(process.execPath);
    expect(plan.acquisition.args.slice(1)).toEqual([
      'add',
      'vercel-labs/skills',
      '--global',
      '--agent',
      'claude-code',
      '--copy',
      '--yes',
    ]);
    expect(plan.acquisition.cwd).toBe(plan.stagingRoot);
    // Classified source is git-remote for GitHub shorthand.
    expect(plan.classifiedSource).toEqual({
      kind: 'git-remote',
      sourceArg: 'vercel-labs/skills',
    });
  });

  it('passes --skill through to the acquisition plan', () => {
    const plan = buildRemoteInstallPlan({
      profileRootPath: '/profiles/coding',
      rawSource: 'vercel-labs/skills',
      skill: 'find-skills',
      name: 'find-skills',
      stagingId: 'abc123',
    });
    expect(plan.acquisition.args.slice(1)).toEqual([
      'add',
      'vercel-labs/skills',
      '--skill',
      'find-skills',
      '--global',
      '--agent',
      'claude-code',
      '--copy',
      '--yes',
    ]);
  });

  it('is deterministic with a fixed stagingId (dry-run ≡ real)', () => {
    const opts = {
      profileRootPath: '/profiles/coding',
      rawSource: 'https://github.com/vercel-labs/skills',
      name: 'find-skills',
      stagingId: 'fixed',
    };
    const a = buildRemoteInstallPlan(opts);
    const b = buildRemoteInstallPlan(opts);
    expect(a).toEqual(b);
  });

  it('classifies a tree URL source with ref + skillPath for the provenance record', () => {
    const plan = buildRemoteInstallPlan({
      profileRootPath: '/profiles/coding',
      rawSource: 'https://github.com/vercel-labs/skills/tree/v1.2.0/skills/find-skills',
      name: 'find-skills',
      stagingId: 'abc123',
    });
    expect(plan.classifiedSource).toEqual({
      kind: 'git-remote',
      sourceArg: 'https://github.com/vercel-labs/skills/tree/v1.2.0/skills/find-skills',
      ref: 'v1.2.0',
      skillPath: 'skills/find-skills',
    });
  });

  it('rejects an invalid install name', () => {
    expect(() =>
      buildRemoteInstallPlan({
        profileRootPath: '/profiles/coding',
        rawSource: 'vercel-labs/skills',
        name: '../escape',
        stagingId: 'abc123',
      }),
    ).toThrowError(CcpsError);
  });

  it('rejects an invalid remote source', () => {
    expect(() =>
      buildRemoteInstallPlan({
        profileRootPath: '/profiles/coding',
        rawSource: '',
        name: 'find-skills',
        stagingId: 'abc123',
      }),
    ).toThrowError(CcpsError);
  });
});

// ─── acquireAndPreviewRemoteInstall ─────────────────────────────────────

describe('acquireAndPreviewRemoteInstall', () => {
  it('stages, verifies identity, and builds a confirm-step preview', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const preview = await acquireAndPreviewRemoteInstall({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      rawSource: 'vercel-labs/skills',
      name: 'find-skills',
      stagingId: 'abc123',
      captureProcess: fakeCaptureStaging('find-skills'),
    });

    expect(preview.name).toBe('find-skills');
    expect(preview.stagedName).toBe('find-skills');
    expect(preview.identity).toEqual({
      name: 'find-skills',
      description: 'A staged Skill.',
    });
    expect(preview.provenanceSource).toEqual({
      kind: 'git-remote',
      url: 'vercel-labs/skills',
    });
    expect(preview.targetPath).toBe(
      path.join(profileDir, 'claude-home', 'skills', 'find-skills'),
    );
    expect(preview.collides).toBe(false);
    expect(preview.existingNames).toEqual([]);
    // Preview lines describe the acquire → stage → create → record flow.
    expect(preview.previewLines.some((l) => l.startsWith('acquire'))).toBe(true);
    expect(preview.previewLines.some((l) => l.startsWith('stage'))).toBe(true);
    expect(preview.previewLines.some((l) => l.startsWith('create'))).toBe(true);
    expect(preview.previewLines.some((l) => l.startsWith('record'))).toBe(true);
    // The staging root is kept alive for installRemoteSkill to rename from.
    expect(preview.stagingRoot).toBe(path.join(profileDir, '.ccps-remote-stage-abc123'));
  });

  it('isolates staging: CLAUDE_CONFIG_DIR passed to the adapter points inside staging, never at the real home', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const realHome = path.join(tmpdir(), 'ccps-real-claude-home-never-touched');
    await fs.ensureDir(realHome);
    await fs.writeFile(path.join(realHome, 'sentinel.txt'), 'before', 'utf8');

    let capturedEnv: Record<string, string> | undefined;
    const spyingCapture: CaptureProcess = async (_c, _a, options) => {
      capturedEnv = options.env;
      const claudeHome = options.env.CLAUDE_CONFIG_DIR as string;
      const staged = path.join(claudeHome, 'skills', 'find-skills');
      await fs.ensureDir(staged);
      await fs.writeFile(
        path.join(staged, 'SKILL.md'),
        '---\nname: find-skills\ndescription: x\n---\n',
        'utf8',
      );
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };

    const preview = await acquireAndPreviewRemoteInstall({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      rawSource: 'vercel-labs/skills',
      name: 'find-skills',
      stagingId: 'iso1',
      captureProcess: spyingCapture,
    });

    // The adapter ran with CLAUDE_CONFIG_DIR inside the staging root.
    expect(capturedEnv?.CLAUDE_CONFIG_DIR).toBe(
      path.join(preview.stagingRoot, 'claude-home'),
    );
    expect(capturedEnv?.CLAUDE_CONFIG_DIR).not.toBe(realHome);
    // The real home sentinel is untouched (nothing in the remote flow writes there).
    expect(await fs.readFile(path.join(realHome, 'sentinel.txt'), 'utf8')).toBe('before');
    await fs.remove(realHome);
  });

  it('detects a collision against an already-installed Skill', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const skillsDir = getSkillsDirectoryPath(profileDir);
    await fs.ensureDir(path.join(skillsDir, 'find-skills'));

    const preview = await acquireAndPreviewRemoteInstall({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      rawSource: 'vercel-labs/skills',
      name: 'find-skills',
      stagingId: 'abc123',
      captureProcess: fakeCaptureStaging('find-skills'),
    });

    expect(preview.collides).toBe(true);
    expect(preview.existingNames).toContain('find-skills');
  });

  it('propagates an acquisition failure (offline) without staging a preview', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    await expect(
      acquireAndPreviewRemoteInstall({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        rawSource: 'vercel-labs/skills',
        name: 'find-skills',
        stagingId: 'abc123',
        captureProcess: failingCapture('TypeError: fetch failed'),
      }),
    ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_OFFLINE' });
  });

  it('rejects a staged Skill whose frontmatter name does not match the requested --skill', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    await expect(
      acquireAndPreviewRemoteInstall({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        rawSource: 'vercel-labs/skills',
        skill: 'expected-name',
        name: 'expected-name',
        stagingId: 'abc123',
        // Stages a Skill whose frontmatter name differs from the --skill selection.
        captureProcess: fakeCaptureStaging('staged-dir'),
      }),
    ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_IDENTITY_MISMATCH' });
  });

  // The wizard's onAcquireRemote callback omits `name` — the target install name
  // is derived from the staged Skill's directory name (its frontmatter name).
  it('derives the target name from the staged Skill when `name` is omitted (wizard flow)', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    const preview = await acquireAndPreviewRemoteInstall({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      rawSource: 'vercel-labs/skills',
      // name intentionally omitted — derived from stagedName below
      stagingId: 'abc123',
      captureProcess: fakeCaptureStaging('find-skills'),
    });

    expect(preview.name).toBe('find-skills');
    expect(preview.stagedName).toBe('find-skills');
    expect(preview.targetPath).toBe(
      path.join(profileDir, 'claude-home', 'skills', 'find-skills'),
    );
  });

  it('cleans up the staging root when acquire fails so it is not orphaned', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    await expect(
      acquireAndPreviewRemoteInstall({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        rawSource: 'vercel-labs/skills',
        name: 'find-skills',
        stagingId: 'abc123',
        captureProcess: failingCapture('TypeError: fetch failed'),
      }),
    ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_OFFLINE' });

    // The staging root must not be left behind on an acquire-time failure.
    expect(await fs.pathExists(path.join(profileDir, '.ccps-remote-stage-abc123'))).toBe(false);
  });

  it('cleans up the staging root when identity verification fails', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');

    await expect(
      acquireAndPreviewRemoteInstall({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        rawSource: 'vercel-labs/skills',
        skill: 'expected-name',
        name: 'expected-name',
        stagingId: 'abc123',
        // Stages a Skill whose frontmatter name differs → identity verification throws.
        captureProcess: fakeCaptureStaging('staged-dir'),
      }),
    ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_IDENTITY_MISMATCH' });

    expect(await fs.pathExists(path.join(profileDir, '.ccps-remote-stage-abc123'))).toBe(false);
  });
});

// ─── installRemoteSkill ─────────────────────────────────────────────────

describe('installRemoteSkill', () => {
  async function stageAndPreview(
    appHome: string,
    profileDir: string,
    opts: { name?: string; skillName?: string; source?: string } = {},
  ) {
    const name = opts.name ?? 'find-skills';
    const skillName = opts.skillName ?? name;
    const preview = await acquireAndPreviewRemoteInstall({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      rawSource: opts.source ?? 'vercel-labs/skills',
      name,
      stagingId: 'abc123',
      captureProcess: fakeCaptureStaging(skillName),
    });
    return preview;
  }

  it('rename-swaps the staged tree into the Profile skills dir and writes a copy provenance record', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const preview = await stageAndPreview(appHome, profileDir);

    const result = await installRemoteSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      name: preview.name,
      stagingRoot: preview.stagingRoot,
      stagedName: preview.stagedName,
      provenanceSource: preview.provenanceSource,
      clock: fixedClock,
    });

    expect(result.mode).toBe('copy');
    expect(result.name).toBe('find-skills');
    // The tree landed in the Profile skills dir.
    const installed = path.join(profileDir, 'claude-home', 'skills', 'find-skills', 'SKILL.md');
    expect(await fs.pathExists(installed)).toBe(true);
    expect(await fs.readFile(installed, 'utf8')).toContain('name: find-skills');

    // The staging root is removed after a successful swap.
    expect(await fs.pathExists(preview.stagingRoot)).toBe(false);

    // Provenance record: copy mode, git-remote source, content hash present.
    const manifest = await loadSkillsProvenance(profileDir);
    const record = manifest.skills['find-skills'];
    expect(record).toBeDefined();
    expect(record.mode).toBe('copy');
    expect(record.source.kind).toBe('git-remote');
    expect(record.source.url).toBe('vercel-labs/skills');
    expect(record.contentHash.length).toBe(64);
    expect(record.link).toBeUndefined();
  });

  it('records ref + skillPath for a tree-URL source', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const preview = await stageAndPreview(appHome, profileDir, {
      source: 'https://github.com/vercel-labs/skills/tree/v1.2.0/skills/find-skills',
    });

    await installRemoteSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      name: preview.name,
      stagingRoot: preview.stagingRoot,
      stagedName: preview.stagedName,
      provenanceSource: preview.provenanceSource,
      clock: fixedClock,
    });

    const manifest = await loadSkillsProvenance(profileDir);
    const record = manifest.skills['find-skills'];
    expect(record.source.kind).toBe('git-remote');
    expect(record.source.url).toBe(
      'https://github.com/vercel-labs/skills/tree/v1.2.0/skills/find-skills',
    );
    expect(record.source.ref).toBe('v1.2.0');
    expect(record.source.skillPath).toBe('skills/find-skills');
  });

  it('records a url source for a direct SKILL.md download', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const preview = await stageAndPreview(appHome, profileDir, {
      source: 'https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md',
    });

    await installRemoteSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      name: preview.name,
      stagingRoot: preview.stagingRoot,
      stagedName: preview.stagedName,
      provenanceSource: preview.provenanceSource,
      clock: fixedClock,
    });

    const manifest = await loadSkillsProvenance(profileDir);
    const record = manifest.skills['find-skills'];
    expect(record.source.kind).toBe('url');
    expect(record.source.ref).toBeUndefined();
    expect(record.source.skillPath).toBeUndefined();
  });

  it('refuses to install over an existing Skill without a resolution', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const skillsDir = getSkillsDirectoryPath(profileDir);
    // Pre-populate the target so the rename swap collides.
    await fs.ensureDir(path.join(skillsDir, 'find-skills'));
    await fs.writeFile(
      path.join(skillsDir, 'find-skills', 'SKILL.md'),
      '---\nname: find-skills\ndescription: old\n---\n',
      'utf8',
    );

    const preview = await stageAndPreview(appHome, profileDir);

    await expect(
      installRemoteSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        name: preview.name,
        stagingRoot: preview.stagingRoot,
        stagedName: preview.stagedName,
        provenanceSource: preview.provenanceSource,
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_INSTALL_COLLISION' });
  });

  it('replace resolution bins the existing copy and lands the new tree', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const skillsDir = getSkillsDirectoryPath(profileDir);
    // Install an existing copy first.
    const existing = path.join(skillsDir, 'find-skills');
    await fs.ensureDir(existing);
    await fs.writeFile(
      path.join(existing, 'SKILL.md'),
      '---\nname: find-skills\ndescription: OLD\n---\n# old\n',
      'utf8',
    );

    const preview = await stageAndPreview(appHome, profileDir);

    const result = await installRemoteSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      name: preview.name,
      stagingRoot: preview.stagingRoot,
      stagedName: preview.stagedName,
      provenanceSource: preview.provenanceSource,
      collisionResolution: 'replace',
      clock: fixedClock,
    });

    expect(result.name).toBe('find-skills');
    // The new tree replaced the old one.
    const installed = path.join(existing, 'SKILL.md');
    expect(await fs.readFile(installed, 'utf8')).toContain('A staged Skill.');
    // The old copy was binned as a Recovery Bin item.
    const binItems = await listRecoveryBinItems(appHome);
    expect(binItems.some((item) => item.kind === 'skill')).toBe(true);
  });

  it('refuses to install over an existing Skill without a resolution and leaves the target untouched', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    const skillsDir = getSkillsDirectoryPath(profileDir);
    // Pre-populate target AND do NOT pass a collision resolution, so the code
    // throws SKILL_INSTALL_COLLISION before the rename.
    await fs.ensureDir(path.join(skillsDir, 'find-skills'));

    const preview = await stageAndPreview(appHome, profileDir);

    await expect(
      installRemoteSkill({
        appHomePath: appHome,
        profileName: 'coding',
        profileRootPath: profileDir,
        name: preview.name,
        stagingRoot: preview.stagingRoot,
        stagedName: preview.stagedName,
        provenanceSource: preview.provenanceSource,
        clock: fixedClock,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_INSTALL_COLLISION' });

    // The collision path throws before the rename, so the Profile skills dir is
    // untouched (no partial install). The staging root is left in place for the
    // wizard's abandon-cleanup effect to reap (the user may retry with a rename
    // or replace, which reuses the staged tree without re-acquiring).
    expect(await fs.pathExists(path.join(skillsDir, 'find-skills'))).toBe(true);
  });

  it('never writes outside the Profile root (real-home invariance)', async () => {
    const appHome = await makeAppHome();
    const profileDir = await makeProfile(appHome, 'coding');
    // Snapshot the temp root tree *outside* the profile dir; nothing should
    // appear there from a remote install.
    const outsideRoot = path.dirname(profileDir); // …/profiles
    const snapshotBefore = await listTree(outsideRoot);

    const preview = await stageAndPreview(appHome, profileDir);
    await installRemoteSkill({
      appHomePath: appHome,
      profileName: 'coding',
      profileRootPath: profileDir,
      name: preview.name,
      stagingRoot: preview.stagingRoot,
      stagedName: preview.stagedName,
      provenanceSource: preview.provenanceSource,
      clock: fixedClock,
    });

    // No staging root is left dangling under the profile root after success.
    const entries = await fs.readdir(profileDir);
    expect(entries.some((e) => e.startsWith('.ccps-remote-stage-'))).toBe(false);

    // The only new entry under outsideRoot beyond the profile dir itself is none;
    // the staging root lived *inside* profileDir and was removed.
    const snapshotAfter = await listTree(outsideRoot);
    // The profile dir's own contents changed (a Skill landed), but no sibling
    // directories were created outside it.
    const siblingsBefore = new Set(snapshotBefore.filter((p) => !p.startsWith(profileDir)));
    const siblingsAfter = snapshotAfter.filter((p) => !p.startsWith(profileDir));
    expect(siblingsAfter.sort()).toEqual([...siblingsBefore].sort());
  });
});

// Recursively list every path under `root` (used for the invariance snapshot).
async function listTree(root: string): Promise<string[]> {
  if (!(await fs.pathExists(root))) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    let stat: fs.Stats;
    try {
      stat = await fs.lstat(cur);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = await fs.readdir(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(cur, e));
    }
  }
  return out;
}
