import { createRequire } from 'node:module';
import fs from 'fs-extra';

import { captureProcess as defaultCaptureProcess, type CaptureProcess } from '../platform/process';
import { resolveFilesystemPath, resolveInside } from '../platform/path';
import { CcpsError } from '../utils/errors';

export const SKILLS_CLI_PINNED_VERSION = '1.5.21';
export const SKILLS_ACQUISITION_TIMEOUT_MS = 10 * 60 * 1000;

export type SkillsAcquisitionOptions = {
  source: string;
  skill?: string;
  stagingPath: string;
  extraEnv?: Record<string, string>;
};

export type SkillsAcquisitionPlan = {
  command: string;
  args: string[];
  cwd: string;
  envChanges: Record<string, string>;
  stagedSkillsPath: string;
  stateHomePath: string;
};

export type SkillsAcquisitionResult = {
  plan: SkillsAcquisitionPlan;
  exitCode: number | null;
  stagedSkills: string[];
};

export type ResolvedSkillsCli = {
  packagePath: string;
  entryPath: string;
  version: string;
};

const OFFLINE_OUTPUT_PATTERNS = [
  /fetch failed/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /failed to connect to/i,
  /connection refused/i,
  /network is unreachable/i,
  /no route to host/i,
  /getaddrinfo/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /ETIMEDOUT/,
  /timed out/i,
];

export function resolveSkillsCli(packageJsonPath?: string): ResolvedSkillsCli {
  const require = createRequire(import.meta.url);
  let resolvedPackageJsonPath = packageJsonPath;

  if (!resolvedPackageJsonPath) {
    try {
      resolvedPackageJsonPath = require.resolve('skills/package.json');
    } catch (error) {
      throw new CcpsError('SKILLS_CLI_UNAVAILABLE', 'The pinned Skills CLI is not installed.', {
        guidance: `Run npm install so the pinned skills@${SKILLS_CLI_PINNED_VERSION} dependency is present.`,
        cause: error,
      });
    }
  }

  let manifest: { version?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedPackageJsonPath, 'utf8')) as {
      version?: unknown;
      bin?: unknown;
    };
  } catch (error) {
    throw new CcpsError('SKILLS_CLI_UNAVAILABLE', 'The pinned Skills CLI manifest is unreadable.', {
      guidance: `Reinstall the pinned skills@${SKILLS_CLI_PINNED_VERSION} dependency.`,
      cause: error,
    });
  }

  if (manifest.version !== SKILLS_CLI_PINNED_VERSION) {
    throw new CcpsError(
      'SKILLS_CLI_VERSION_MISMATCH',
      `The installed Skills CLI is ${String(manifest.version)}, not the pinned ${SKILLS_CLI_PINNED_VERSION}.`,
      {
        guidance: `Install the pinned version with npm install skills@${SKILLS_CLI_PINNED_VERSION} --save-exact.`,
      },
    );
  }

  const binEntry =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : isRecord(manifest.bin) && typeof manifest.bin.skills === 'string'
        ? manifest.bin.skills
        : undefined;
  if (!binEntry) {
    throw new CcpsError('SKILLS_CLI_UNAVAILABLE', 'The pinned Skills CLI exposes no bin entry.', {
      guidance: `Reinstall the pinned skills@${SKILLS_CLI_PINNED_VERSION} dependency.`,
    });
  }

  const entryPath = resolveFilesystemPath(resolvedPackageJsonPath, '..', binEntry);
  if (!fs.pathExistsSync(entryPath)) {
    throw new CcpsError('SKILLS_CLI_UNAVAILABLE', 'The pinned Skills CLI entry file is missing.', {
      guidance: `Reinstall the pinned skills@${SKILLS_CLI_PINNED_VERSION} dependency.`,
    });
  }

  return {
    packagePath: resolvedPackageJsonPath,
    entryPath,
    version: SKILLS_CLI_PINNED_VERSION,
  };
}

export function buildSkillsAcquisitionPlan(
  options: SkillsAcquisitionOptions,
): SkillsAcquisitionPlan {
  const stagingRoot = resolveFilesystemPath(options.stagingPath);
  const claudeHomePath = resolveInside(stagingRoot, 'claude-home');
  const stateHomePath = resolveInside(stagingRoot, 'state');
  const cli = resolveSkillsCli();

  const args = [cli.entryPath, 'add', options.source];
  if (options.skill) {
    args.push('--skill', options.skill);
  }
  args.push('--global', '--agent', 'claude-code', '--copy', '--yes');

  return {
    command: process.execPath,
    args,
    cwd: stagingRoot,
    envChanges: {
      CLAUDE_CONFIG_DIR: claudeHomePath,
      XDG_STATE_HOME: stateHomePath,
      DISABLE_TELEMETRY: '1',
      NODE_DISABLE_COMPILE_CACHE: '1',
      ...options.extraEnv,
    },
    stagedSkillsPath: resolveInside(claudeHomePath, 'skills'),
    stateHomePath,
  };
}

export async function acquireSkillIntoStaging(
  options: SkillsAcquisitionOptions & { captureProcess?: CaptureProcess },
): Promise<SkillsAcquisitionResult> {
  const plan = buildSkillsAcquisitionPlan(options);
  await fs.ensureDir(plan.cwd);
  const run = options.captureProcess ?? defaultCaptureProcess;

  let result;
  try {
    result = await run(plan.command, plan.args, {
      cwd: plan.cwd,
      shell: false,
      env: { ...process.env, ...plan.envChanges },
      timeoutMs: SKILLS_ACQUISITION_TIMEOUT_MS,
    });
  } catch (error) {
    throw new CcpsError('SKILLS_CLI_UNAVAILABLE', 'Failed to start the pinned Skills CLI.', {
      guidance: 'Confirm Node.js can run the pinned skills dependency, then retry.',
      cause: error,
    });
  }

  if (result.timedOut) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_TIMEOUT',
      'The pinned Skills CLI did not finish before the acquisition timeout.',
      {
        guidance: 'Check the source and network, then retry the acquisition.',
      },
    );
  }

  if (result.exitCode === 0) {
    const stagedSkills = await listStagedSkills(plan.stagedSkillsPath);
    if (stagedSkills.length === 0) {
      throw new CcpsError(
        'SKILLS_ACQUISITION_EMPTY',
        'The pinned Skills CLI exited successfully but staged no Skill.',
        {
          guidance: 'Check the source and --skill selection, then retry the acquisition.',
        },
      );
    }

    return { plan, exitCode: result.exitCode, stagedSkills };
  }

  if (isOfflineFailure(result.stdout, result.stderr)) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_OFFLINE',
      'The Skill source could not be reached over the network.',
      {
        guidance: 'Check the network connection and retry the acquisition when online.',
      },
    );
  }

  throw new CcpsError(
    'SKILLS_ACQUISITION_FAILED',
    `The pinned Skills CLI failed to acquire the source (exit ${String(result.exitCode)}).`,
    {
      guidance: `Review the Skills CLI diagnostics, then retry. ${summarizeOutput(result.stderr, result.stdout)}`,
    },
  );
}

export function isOfflineFailure(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`;
  return OFFLINE_OUTPUT_PATTERNS.some((pattern) => pattern.test(output));
}

async function listStagedSkills(stagedSkillsPath: string): Promise<string[]> {
  if (!(await fs.pathExists(stagedSkillsPath))) {
    return [];
  }

  const entries = await fs.readdir(stagedSkillsPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function summarizeOutput(...chunks: string[]): string {
  const combined = chunks
    .flatMap((chunk) => chunk.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Strip ANSI styling from upstream CLI output before quoting it.
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  const tail = combined.slice(-3).join(' | ');
  return tail.length > 0 ? `Skills CLI said: ${tail}` : 'The Skills CLI produced no output.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
