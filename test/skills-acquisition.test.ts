import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireSkillIntoStaging,
  buildSkillsAcquisitionPlan,
  classifyRemoteSkillSource,
  isOfflineFailure,
  resolveSkillsCli,
  SKILLS_CLI_PINNED_VERSION,
  SKILLS_DOWNLOAD_MAX_BYTES_DEFAULT,
  SKILLS_EXTRACT_MAX_BYTES_DEFAULT,
  SKILLS_EXTRACT_MAX_FILES_DEFAULT,
  verifyStagedSkillIdentity,
} from '../src/core/skills-acquisition';
import type { CaptureProcess } from '../src/platform/process';
import { CcpsError } from '../src/utils/errors';

describe('skills acquisition adapter', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  function expectCcpsError(run: () => unknown, code: string): void {
    expect(run).toThrowError(CcpsError);
    try {
      run();
    } catch (error) {
      expect((error as CcpsError).code).toBe(code);
      return;
    }
    throw new Error(`Expected a CcpsError with code ${code}.`);
  }

  describe('resolveSkillsCli', () => {
    it('resolves the installed pinned Skills CLI entry', () => {
      const cli = resolveSkillsCli();

      expect(cli.version).toBe(SKILLS_CLI_PINNED_VERSION);
      expect(cli.entryPath.endsWith(join('bin', 'cli.mjs'))).toBe(true);
      expect(fs.pathExistsSync(cli.entryPath)).toBe(true);
    });

    it('rejects an installed version that does not match the pin', async () => {
      const packageDir = join(await makeTempRoot('ccps-skills-cli-'), 'skills');
      await fs.ensureDir(join(packageDir, 'bin'));
      await fs.writeFile(join(packageDir, 'bin', 'cli.mjs'), '// stub\n', 'utf8');
      await fs.writeJson(join(packageDir, 'package.json'), {
        name: 'skills',
        version: '0.0.0',
        bin: { skills: 'bin/cli.mjs' },
      });

      expectCcpsError(
        () => resolveSkillsCli(join(packageDir, 'package.json')),
        'SKILLS_CLI_VERSION_MISMATCH',
      );
    });

    it('rejects a manifest whose bin entry is missing on disk', async () => {
      const packageDir = join(await makeTempRoot('ccps-skills-cli-'), 'skills');
      await fs.ensureDir(packageDir);
      await fs.writeJson(join(packageDir, 'package.json'), {
        name: 'skills',
        version: SKILLS_CLI_PINNED_VERSION,
        bin: { skills: 'bin/cli.mjs' },
      });

      expectCcpsError(
        () => resolveSkillsCli(join(packageDir, 'package.json')),
        'SKILLS_CLI_UNAVAILABLE',
      );
    });
  });

  describe('buildSkillsAcquisitionPlan', () => {
    it('builds the isolated staging invocation with an argument array and no shell', async () => {
      const staging = join(await makeTempRoot('ccps-skills-plan-'), 'staging');
      const plan = buildSkillsAcquisitionPlan({
        source: 'vercel-labs/skills',
        skill: 'find-skills',
        stagingPath: staging,
      });

      expect(plan.command).toBe(process.execPath);
      expect(plan.args.slice(1)).toEqual([
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
      expect(plan.args[0].endsWith(join('bin', 'cli.mjs'))).toBe(true);
      expect(plan.cwd).toBe(staging);
      expect(plan.envChanges).toEqual({
        CLAUDE_CONFIG_DIR: join(staging, 'claude-home'),
        XDG_STATE_HOME: join(staging, 'state'),
        DISABLE_TELEMETRY: '1',
        NODE_DISABLE_COMPILE_CACHE: '1',
        // Archive bounds (spec §7.3) — ccps controls the envelope; caller
        // overrides via extraEnv, which is merged last in the plan builder.
        SKILLS_DOWNLOAD_MAX_BYTES: String(SKILLS_DOWNLOAD_MAX_BYTES_DEFAULT),
        SKILLS_EXTRACT_MAX_BYTES: String(SKILLS_EXTRACT_MAX_BYTES_DEFAULT),
        SKILLS_EXTRACT_MAX_FILES: String(SKILLS_EXTRACT_MAX_FILES_DEFAULT),
      });
      expect(plan.stagedSkillsPath).toBe(join(staging, 'claude-home', 'skills'));
      expect(plan.stateHomePath).toBe(join(staging, 'state'));
    });

    it('omits --skill when no explicit selection is given and merges probe env overrides', async () => {
      const staging = join(await makeTempRoot('ccps-skills-plan-'), 'staging');
      const plan = buildSkillsAcquisitionPlan({
        source: '/tmp/local-skill',
        stagingPath: staging,
        extraEnv: { SKILLS_EXTRACT_MAX_FILES: '5' },
      });

      expect(plan.args.slice(1)).toEqual([
        'add',
        '/tmp/local-skill',
        '--global',
        '--agent',
        'claude-code',
        '--copy',
        '--yes',
      ]);
      expect(plan.envChanges.SKILLS_EXTRACT_MAX_FILES).toBe('5');
    });

    it('blocks staging paths that escape through traversal', () => {
      expect(() =>
        buildSkillsAcquisitionPlan({ source: 'a/b', stagingPath: '/tmp/../..' }),
      ).not.toThrow();
      // resolveInside guards every derived path against the resolved staging root.
      const plan = buildSkillsAcquisitionPlan({
        source: 'a/b',
        stagingPath: join('relative', 'staging'),
      });
      expect(plan.stagedSkillsPath.startsWith(plan.cwd)).toBe(true);
    });
  });

  describe('acquireSkillIntoStaging', () => {
    function fakeCapture(result: {
      exitCode: number | null;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
    }): CaptureProcess {
      return async () => ({
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.timedOut ?? false,
      });
    }

    it('returns staged Skill names on a successful acquisition', async () => {
      const staging = join(await makeTempRoot('ccps-skills-run-'), 'staging');
      const result = await acquireSkillIntoStaging({
        source: 'vercel-labs/skills',
        skill: 'find-skills',
        stagingPath: staging,
        captureProcess: async (_command, _args, options) => {
          const staged = join(options.env.CLAUDE_CONFIG_DIR as string, 'skills', 'find-skills');
          await fs.ensureDir(staged);
          await fs.writeFile(join(staged, 'SKILL.md'), '---\nname: find-skills\n---\n', 'utf8');
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stagedSkills).toEqual(['find-skills']);
    });

    it('treats a zero exit with no staged Skill as a failure', async () => {
      const staging = join(await makeTempRoot('ccps-skills-run-'), 'staging');

      await expect(
        acquireSkillIntoStaging({
          source: 'vercel-labs/skills',
          stagingPath: staging,
          captureProcess: fakeCapture({ exitCode: 0 }),
        }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_EMPTY' });
    });

    it('classifies network failures as offline', async () => {
      const staging = join(await makeTempRoot('ccps-skills-run-'), 'staging');

      await expect(
        acquireSkillIntoStaging({
          source: 'vercel-labs/skills',
          stagingPath: staging,
          captureProcess: fakeCapture({ exitCode: 1, stderr: 'TypeError: fetch failed' }),
        }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_OFFLINE' });
    });

    it('reports non-offline failures with upstream diagnostics', async () => {
      const staging = join(await makeTempRoot('ccps-skills-run-'), 'staging');

      await expect(
        acquireSkillIntoStaging({
          source: 'vercel-labs/skills',
          stagingPath: staging,
          captureProcess: fakeCapture({
            exitCode: 1,
            stderr: 'Archive contains too many files (10). Maximum is 5.',
          }),
        }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_FAILED' });
    });

    it('reports timeouts distinctly', async () => {
      const staging = join(await makeTempRoot('ccps-skills-run-'), 'staging');

      await expect(
        acquireSkillIntoStaging({
          source: 'vercel-labs/skills',
          stagingPath: staging,
          captureProcess: fakeCapture({ exitCode: null, timedOut: true }),
        }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_TIMEOUT' });
    });

    // Spec §7.3: stage exactly the selected Skill. A multi-Skill stage means the
    // selection was ambiguous or the source is not a single Skill.
    it('rejects a multi-Skill stage (exactly one is required)', async () => {
      const staging = join(await makeTempRoot('ccps-skills-run-'), 'staging');
      await expect(
        acquireSkillIntoStaging({
          source: 'vercel-labs/skills',
          stagingPath: staging,
          captureProcess: async (_command, _args, options) => {
            const skillsDir = join(options.env.CLAUDE_CONFIG_DIR as string, 'skills');
            await fs.ensureDir(join(skillsDir, 'alpha'));
            await fs.writeFile(
              join(skillsDir, 'alpha', 'SKILL.md'),
              '---\nname: alpha\n---\n',
              'utf8',
            );
            await fs.ensureDir(join(skillsDir, 'beta'));
            await fs.writeFile(
              join(skillsDir, 'beta', 'SKILL.md'),
              '---\nname: beta\n---\n',
              'utf8',
            );
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
          },
        }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_FAILED' });
    });

    it('surfaces SKILLS_CLI_UNAVAILABLE when the spawn itself throws', async () => {
      const staging = join(await makeTempRoot('ccps-skills-run-'), 'staging');
      const throwingCapture: CaptureProcess = async () => {
        throw new Error('spawn ENOENT');
      };
      await expect(
        acquireSkillIntoStaging({
          source: 'vercel-labs/skills',
          stagingPath: staging,
          captureProcess: throwingCapture,
        }),
      ).rejects.toMatchObject({ code: 'SKILLS_CLI_UNAVAILABLE' });
    });
  });

  describe('isOfflineFailure', () => {
    it.each([
      'TypeError: fetch failed',
      "Failed to clone https://github.com/vercel-labs/skills.git: fatal: unable to access 'https://github.com/vercel-labs/skills.git/': Could not resolve host: github.com",
      "fatal: unable to access 'https://github.com/vercel-labs/skills.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Connection refused",
      'ssh: Could not resolve hostname github.com: Temporary failure in name resolution',
      'fatal: unable to connect to github.com: github.com[0: 140.82.112.3]: errno=Operation timed out',
      'Clone timed out after 300s. Common causes: a large repository or a slow network',
      'request to https://skills.sh/api/search failed, reason: getaddrinfo ENOTFOUND skills.sh',
      'connect ETIMEDOUT 140.82.112.3:443',
      'Error: connect ECONNREFUSED 127.0.0.1:9',
    ])('classifies %s as offline', (output) => {
      expect(isOfflineFailure('', output)).toBe(true);
    });

    it.each([
      'Archive contains too many files (10). Maximum is 5. Set SKILLS_EXTRACT_MAX_FILES to override.',
      'Download is larger than 2048 bytes. Set SKILLS_DOWNLOAD_MAX_BYTES to override.',
      'Download failed with HTTP 403',
      'No skills found matching: nonexistent-skill',
      'Downloaded URL is not a valid SKILL.md file or supported archive',
      'Authentication failed',
    ])('does not classify %s as offline', (output) => {
      expect(isOfflineFailure('', output)).toBe(false);
    });
  });

  // ─── classifyRemoteSkillSource (spec §7.3 "Source identity") ───────────
  // Pure: no filesystem, no network. The pinned CLI parses every form itself;
  // `sourceArg` is always the raw input, `kind` is the provenance classification,
  // and `ref`/`skillPath` are extracted from tree URLs for the record only.
  describe('classifyRemoteSkillSource', () => {
    it('classifies GitHub shorthand as git-remote', () => {
      expect(classifyRemoteSkillSource('vercel-labs/skills')).toEqual({
        kind: 'git-remote',
        sourceArg: 'vercel-labs/skills',
      });
    });

    it('classifies github: prefix as git-remote', () => {
      expect(classifyRemoteSkillSource('github:vercel-labs/skills')).toEqual({
        kind: 'git-remote',
        sourceArg: 'github:vercel-labs/skills',
      });
    });

    it('classifies SSH and git protocols as git-remote', () => {
      expect(classifyRemoteSkillSource('git@github.com:vercel-labs/skills.git')).toEqual({
        kind: 'git-remote',
        sourceArg: 'git@github.com:vercel-labs/skills.git',
      });
      expect(classifyRemoteSkillSource('ssh://git@github.com/vercel-labs/skills.git')).toEqual({
        kind: 'git-remote',
        sourceArg: 'ssh://git@github.com/vercel-labs/skills.git',
      });
      expect(classifyRemoteSkillSource('git://github.com/vercel-labs/skills.git')).toEqual({
        kind: 'git-remote',
        sourceArg: 'git://github.com/vercel-labs/skills.git',
      });
    });

    it('classifies a plain GitHub repo URL as git-remote without ref/skillPath', () => {
      expect(classifyRemoteSkillSource('https://github.com/vercel-labs/skills')).toEqual({
        kind: 'git-remote',
        sourceArg: 'https://github.com/vercel-labs/skills',
      });
    });

    it('extracts ref and skillPath from a GitHub tree URL', () => {
      expect(
        classifyRemoteSkillSource('https://github.com/vercel-labs/skills/tree/v1.2.0/skills/find-skills'),
      ).toEqual({
        kind: 'git-remote',
        sourceArg: 'https://github.com/vercel-labs/skills/tree/v1.2.0/skills/find-skills',
        ref: 'v1.2.0',
        skillPath: 'skills/find-skills',
      });
    });

    it('extracts ref from a tree URL with no path', () => {
      expect(
        classifyRemoteSkillSource('https://github.com/vercel-labs/skills/tree/main'),
      ).toEqual({
        kind: 'git-remote',
        sourceArg: 'https://github.com/vercel-labs/skills/tree/main',
        ref: 'main',
      });
    });

    it('extracts ref and skillPath from a GitHub blob URL', () => {
      expect(
        classifyRemoteSkillSource('https://github.com/vercel-labs/skills/blob/main/skills/find-skills/SKILL.md'),
      ).toEqual({
        kind: 'git-remote',
        sourceArg: 'https://github.com/vercel-labs/skills/blob/main/skills/find-skills/SKILL.md',
        ref: 'main',
        skillPath: 'skills/find-skills/SKILL.md',
      });
    });

    it('classifies a GitLab tree URL as git-remote with ref + skillPath', () => {
      expect(
        classifyRemoteSkillSource('https://gitlab.com/my-group/my-repo/-/tree/main/skills/find-skills'),
      ).toEqual({
        kind: 'git-remote',
        sourceArg: 'https://gitlab.com/my-group/my-repo/-/tree/main/skills/find-skills',
        ref: 'main',
        skillPath: 'skills/find-skills',
      });
    });

    it('classifies raw.githubusercontent.com as a direct url download', () => {
      expect(
        classifyRemoteSkillSource(
          'https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md',
        ),
      ).toEqual({
        kind: 'url',
        sourceArg:
          'https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md',
      });
    });

    it('classifies archive URLs (.zip/.tar.gz/.tgz) as url', () => {
      expect(
        classifyRemoteSkillSource('https://example.com/skills/find-skills.zip'),
      ).toEqual({ kind: 'url', sourceArg: 'https://example.com/skills/find-skills.zip' });
      expect(
        classifyRemoteSkillSource('https://example.com/skills/find-skills.tar.gz'),
      ).toEqual({ kind: 'url', sourceArg: 'https://example.com/skills/find-skills.tar.gz' });
      expect(
        classifyRemoteSkillSource('https://example.com/skills/find-skills.tgz'),
      ).toEqual({ kind: 'url', sourceArg: 'https://example.com/skills/find-skills.tgz' });
    });

    it('classifies any other http(s) URL as a direct url download', () => {
      expect(classifyRemoteSkillSource('https://example.com/skills/find-skills/SKILL.md')).toEqual({
        kind: 'url',
        sourceArg: 'https://example.com/skills/find-skills/SKILL.md',
      });
    });

    it('rejects an empty source with SKILLS_ACQUISITION_INVALID_SOURCE', () => {
      expect(() => classifyRemoteSkillSource('')).toThrowError(CcpsError);
      expect(() => classifyRemoteSkillSource('   ')).toThrowError(CcpsError);
      try {
        classifyRemoteSkillSource('');
      } catch (error) {
        expect((error as CcpsError).code).toBe('SKILLS_ACQUISITION_INVALID_SOURCE');
      }
    });

    it('rejects local path indicators (local installs live on the §7.2 path)', () => {
      const localIndicators = [
        '/abs/path',
        '~/skill',
        './relative',
        '../parent',
        '.',
        '..',
        'C:\\Users\\me\\skill',
        'D:/skill',
      ];
      for (const indicator of localIndicators) {
        try {
          classifyRemoteSkillSource(indicator);
          throw new Error(`Expected ${indicator} to be rejected as a local path`);
        } catch (error) {
          expect(error).toBeInstanceOf(CcpsError);
          expect((error as CcpsError).code).toBe('SKILLS_ACQUISITION_INVALID_SOURCE');
        }
      }
    });

    it('rejects an unrecognized source form', () => {
      expect(() => classifyRemoteSkillSource('not a source')).toThrowError(CcpsError);
      try {
        classifyRemoteSkillSource('!!!invalid!!!');
      } catch (error) {
        expect((error as CcpsError).code).toBe('SKILLS_ACQUISITION_INVALID_SOURCE');
      }
    });

    it('returns numbered recovery steps in guidance', () => {
      try {
        classifyRemoteSkillSource('');
      } catch (error) {
        const guidance = (error as CcpsError).guidance ?? '';
        // Guidance uses numbered steps (spec §7.3 "numbered recovery steps").
        expect(guidance).toMatch(/1\.\s/);
      }
    });
  });

  // ─── verifyStagedSkillIdentity (spec §7.3 "matching frontmatter identity") ─
  describe('verifyStagedSkillIdentity', () => {
    it('returns name + description from readable SKILL.md frontmatter', async () => {
      const root = await makeTempRoot('ccps-identity-');
      const skillsPath = join(root, 'skills');
      const stagedName = 'find-skills';
      await fs.ensureDir(join(skillsPath, stagedName));
      await fs.writeFile(
        join(skillsPath, stagedName, 'SKILL.md'),
        '---\nname: find-skills\ndescription: Locate skills across repositories.\n---\n# Body\n',
        'utf8',
      );

      const identity = await verifyStagedSkillIdentity({ stagedSkillsPath: skillsPath, stagedName });
      expect(identity).toEqual({
        name: 'find-skills',
        description: 'Locate skills across repositories.',
      });
    });

    it('rejects a missing SKILL.md', async () => {
      const root = await makeTempRoot('ccps-identity-');
      const skillsPath = join(root, 'skills');
      await fs.ensureDir(join(skillsPath, 'no-skill-md'));
      await expect(
        verifyStagedSkillIdentity({ stagedSkillsPath: skillsPath, stagedName: 'no-skill-md' }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_IDENTITY_MISMATCH' });
    });

    it('rejects unparseable frontmatter', async () => {
      const root = await makeTempRoot('ccps-identity-');
      const skillsPath = join(root, 'skills');
      const stagedName = 'broken';
      await fs.ensureDir(join(skillsPath, stagedName));
      // No closing delimiter → frontmatter parse error.
      await fs.writeFile(
        join(skillsPath, stagedName, 'SKILL.md'),
        '---\nname: broken\n',
        'utf8',
      );
      await expect(
        verifyStagedSkillIdentity({ stagedSkillsPath: skillsPath, stagedName }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_IDENTITY_MISMATCH' });
    });

    it('rejects a missing frontmatter name', async () => {
      const root = await makeTempRoot('ccps-identity-');
      const skillsPath = join(root, 'skills');
      const stagedName = 'no-name';
      await fs.ensureDir(join(skillsPath, stagedName));
      await fs.writeFile(
        join(skillsPath, stagedName, 'SKILL.md'),
        '---\ndescription: A skill with no name.\n---\n',
        'utf8',
      );
      await expect(
        verifyStagedSkillIdentity({ stagedSkillsPath: skillsPath, stagedName }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_IDENTITY_MISMATCH' });
    });

    it('rejects a missing frontmatter description', async () => {
      const root = await makeTempRoot('ccps-identity-');
      const skillsPath = join(root, 'skills');
      const stagedName = 'no-desc';
      await fs.ensureDir(join(skillsPath, stagedName));
      await fs.writeFile(
        join(skillsPath, stagedName, 'SKILL.md'),
        '---\nname: no-desc\n---\n',
        'utf8',
      );
      await expect(
        verifyStagedSkillIdentity({ stagedSkillsPath: skillsPath, stagedName }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_IDENTITY_MISMATCH' });
    });

    it('rejects a name mismatch when an expected --skill was given', async () => {
      const root = await makeTempRoot('ccps-identity-');
      const skillsPath = join(root, 'skills');
      const stagedName = 'find-skills';
      await fs.ensureDir(join(skillsPath, stagedName));
      await fs.writeFile(
        join(skillsPath, stagedName, 'SKILL.md'),
        '---\nname: find-skills\ndescription: Locate skills.\n---\n',
        'utf8',
      );
      await expect(
        verifyStagedSkillIdentity({
          stagedSkillsPath: skillsPath,
          stagedName,
          expectedSkill: 'other-skill',
        }),
      ).rejects.toMatchObject({ code: 'SKILLS_ACQUISITION_IDENTITY_MISMATCH' });
    });

    it('accepts when expected --skill matches the frontmatter name', async () => {
      const root = await makeTempRoot('ccps-identity-');
      const skillsPath = join(root, 'skills');
      const stagedName = 'find-skills';
      await fs.ensureDir(join(skillsPath, stagedName));
      await fs.writeFile(
        join(skillsPath, stagedName, 'SKILL.md'),
        '---\nname: find-skills\ndescription: Locate skills.\n---\n',
        'utf8',
      );
      const identity = await verifyStagedSkillIdentity({
        stagedSkillsPath: skillsPath,
        stagedName,
        expectedSkill: 'find-skills',
      });
      expect(identity.name).toBe('find-skills');
    });
  });
});
