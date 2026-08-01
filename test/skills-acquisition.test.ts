import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireSkillIntoStaging,
  buildSkillsAcquisitionPlan,
  isOfflineFailure,
  resolveSkillsCli,
  SKILLS_CLI_PINNED_VERSION,
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
});
