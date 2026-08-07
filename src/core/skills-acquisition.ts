import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'fs-extra';

import { captureProcess as defaultCaptureProcess, type CaptureProcess } from '../platform/process';
import { resolveFilesystemPath, resolveInside } from '../platform/path';
import { parseFrontmatter } from './resource/frontmatter';
import { CcpsError } from '../utils/errors';
import { isRecord } from '../utils/type-guards';

export const SKILLS_CLI_PINNED_VERSION = '1.5.21';
export const SKILLS_ACQUISITION_TIMEOUT_MS = 10 * 60 * 1000;

// Bounded archives (spec §7.3): download-byte / extract-byte / file-count limits.
// Defaults match the pinned skills CLI so ccps controls the envelope; callers may
// override per-acquire via `extraEnv` (`SKILLS_DOWNLOAD_MAX_BYTES` etc.).
export const SKILLS_DOWNLOAD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
export const SKILLS_EXTRACT_MAX_BYTES_DEFAULT = 25 * 1024 * 1024;
export const SKILLS_EXTRACT_MAX_FILES_DEFAULT = 1000;

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

// Classified remote source (spec §7.3 "Source identity"). The pinned CLI parses
// every source form itself, so `sourceArg` is always the raw input; `kind` is
// ccps's provenance classification, and `ref`/`skillPath` are extracted from
// tree URLs for the provenance record only.
export type ClassifiedRemoteSource =
  | { kind: 'git-remote'; sourceArg: string; ref?: string; skillPath?: string }
  | { kind: 'url'; sourceArg: string };

// Verified frontmatter identity of a staged Skill (spec §7.3 "matching frontmatter
// identity"). `name` + `description` are required; `name` must match the requested
// `--skill` selection when one was given.
export type StagedSkillIdentity = {
  name: string;
  description: string;
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
        guidance: `1. Run npm install in the ccps install directory.\n2. Confirm skills@${SKILLS_CLI_PINNED_VERSION} is present in node_modules.\n3. Retry the acquisition.`,
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
      guidance: `1. Remove node_modules/skills.\n2. Run npm install to restore skills@${SKILLS_CLI_PINNED_VERSION}.\n3. Retry the acquisition.`,
      cause: error,
    });
  }

  if (manifest.version !== SKILLS_CLI_PINNED_VERSION) {
    throw new CcpsError(
      'SKILLS_CLI_VERSION_MISMATCH',
      `The installed Skills CLI is ${String(manifest.version)}, not the pinned ${SKILLS_CLI_PINNED_VERSION}.`,
      {
        guidance: `1. Run npm install skills@${SKILLS_CLI_PINNED_VERSION} --save-exact in the ccps install directory.\n2. Confirm the pin in package.json is skills@${SKILLS_CLI_PINNED_VERSION}.\n3. Retry the acquisition.`,
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
      guidance: `1. Remove node_modules/skills.\n2. Run npm install to restore skills@${SKILLS_CLI_PINNED_VERSION}.\n3. Retry the acquisition.`,
    });
  }

  const entryPath = resolveFilesystemPath(resolvedPackageJsonPath, '..', binEntry);
  if (!fs.pathExistsSync(entryPath)) {
    throw new CcpsError('SKILLS_CLI_UNAVAILABLE', 'The pinned Skills CLI entry file is missing.', {
      guidance: `1. Remove node_modules/skills.\n2. Run npm install to restore skills@${SKILLS_CLI_PINNED_VERSION}.\n3. Retry the acquisition.`,
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
      // Archive bounds (spec §7.3). Injected before extraEnv so a caller's
      // explicit override still wins.
      SKILLS_DOWNLOAD_MAX_BYTES: String(SKILLS_DOWNLOAD_MAX_BYTES_DEFAULT),
      SKILLS_EXTRACT_MAX_BYTES: String(SKILLS_EXTRACT_MAX_BYTES_DEFAULT),
      SKILLS_EXTRACT_MAX_FILES: String(SKILLS_EXTRACT_MAX_FILES_DEFAULT),
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
      guidance:
        '1. Confirm Node.js can run the pinned skills dependency.\n2. Reinstall skills@1.5.21 if the entry file is broken.\n3. Retry the acquisition.',
      cause: error,
    });
  }

  if (result.timedOut) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_TIMEOUT',
      'The pinned Skills CLI did not finish before the acquisition timeout.',
      {
        guidance:
          '1. Check the source and network — a large or slow repo can time out.\n2. Raise SKILLS_CLONE_TIMEOUT_MS if the source is known to be large.\n3. Retry the acquisition.',
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
          guidance:
            '1. Confirm the source points at a Skill (a directory with a SKILL.md).\n2. If the source holds multiple Skills, pass a --skill selection.\n3. Retry the acquisition.',
        },
      );
    }
    // Spec §7.3: stage exactly the selected Skill. A multi-Skill stage means
    // the selection was ambiguous or the source is not a single Skill.
    if (stagedSkills.length > 1) {
      throw new CcpsError(
        'SKILLS_ACQUISITION_FAILED',
        `The pinned Skills CLI staged ${String(stagedSkills.length)} Skills; exactly one is required.`,
        {
          guidance:
            '1. Pass a --skill selection to pick one Skill from the source.\n2. Or point the source at a single Skill directory.\n3. Retry the acquisition.',
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
        guidance:
          '1. Check the network connection.\n2. If the source is a private repo, confirm credentials are configured.\n3. Retry the acquisition when online.',
      },
    );
  }

  throw new CcpsError(
    'SKILLS_ACQUISITION_FAILED',
    `The pinned Skills CLI failed to acquire the source (exit ${String(result.exitCode)}).`,
    {
      guidance: `1. Review the Skills CLI diagnostics below.\n2. Verify the source is reachable and is a valid Skill.\n3. Retry the acquisition.\n${summarizeOutput(result.stderr, result.stdout)}`,
    },
  );
}

export function isOfflineFailure(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`;
  return OFFLINE_OUTPUT_PATTERNS.some((pattern) => pattern.test(output));
}

// Classify a remote Skill source for provenance (spec §7.3 "Source identity").
// Pure: no filesystem, no network. The pinned CLI parses every form itself, so
// `sourceArg` is always the raw input; `kind` is ccps's provenance classification
// (`git-remote` for repo sources, `url` for direct downloads), and `ref`/`skillPath`
// are extracted from tree URLs for the record only. Local paths are rejected —
// local installs live on the §7.2 path, disambiguated by the wizard kind picker.
export function classifyRemoteSkillSource(raw: string): ClassifiedRemoteSource {
  const input = raw.trim();
  if (input.length === 0) {
    throw new CcpsError('SKILLS_ACQUISITION_INVALID_SOURCE', 'Remote Skill source is empty.', {
      guidance:
        '1. Enter a GitHub shorthand (owner/repo), GitHub URL, .git URL, tree URL, or direct SKILL.md URL.\n2. For a local directory, choose the Local install path instead.',
    });
  }

  if (isLocalPathIndicator(input)) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_INVALID_SOURCE',
      'The source looks like a local path; use the Local install path instead.',
      {
        guidance:
          '1. Choose Local in the install wizard for a local directory.\n2. Or enter a remote source (GitHub shorthand/URL, .git URL, tree URL, SKILL.md URL).',
      },
    );
  }

  // github:owner/repo prefix → git-remote.
  if (/^github:.+$/i.test(input)) {
    return { kind: 'git-remote', sourceArg: input };
  }

  // SSH / git protocols → git-remote.
  if (/^(git@|ssh:\/\/|git:\/\/)/i.test(input)) {
    return { kind: 'git-remote', sourceArg: input };
  }

  if (/^https?:\/\//i.test(input)) {
    return classifyHttpUrl(input);
  }

  // owner/repo shorthand (no scheme). The kind picker disambiguates this from a
  // local relative path; here it is treated as a GitHub shorthand.
  if (/^[A-Za-z0-9][\w.-]*\/[\w./-]*$/.test(input)) {
    return { kind: 'git-remote', sourceArg: input };
  }

  throw new CcpsError(
    'SKILLS_ACQUISITION_INVALID_SOURCE',
    'The remote source could not be recognized.',
    {
      guidance:
        '1. Use GitHub shorthand (owner/repo), a GitHub URL, .git URL, tree URL, or a direct SKILL.md URL.\n2. For a local directory, choose the Local install path.',
    },
  );
}

function isLocalPathIndicator(input: string): boolean {
  if (input === '~' || input.startsWith('~/') || input.startsWith('/')) return true;
  if (input === '.' || input === '..' || input.startsWith('./') || input.startsWith('../')) return true;
  if (input.startsWith('.\\') || input.startsWith('..\\')) return true;
  // Windows drive letter (C:\ or C:/).
  if (/^[A-Za-z]:[\\/]/.test(input)) return true;
  return false;
}

function classifyHttpUrl(input: string): ClassifiedRemoteSource {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CcpsError('SKILLS_ACQUISITION_INVALID_SOURCE', 'The remote source URL is not valid.', {
      guidance: '1. Check the URL syntax.\n2. Retry with a valid GitHub URL, .git URL, tree URL, or SKILL.md URL.',
    });
  }

  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;

  // Hosted-artifact hosts serve a direct download → url.
  if (
    host === 'raw.githubusercontent.com' ||
    host === 'codeload.github.com' ||
    host === 'objects.githubusercontent.com'
  ) {
    return { kind: 'url', sourceArg: input };
  }

  // Archive URLs → url (direct download).
  if (/\.(zip|tar|tgz)(\.gz)?$/i.test(pathname) || /\.tar\.gz$/i.test(pathname)) {
    return { kind: 'url', sourceArg: input };
  }

  // GitHub tree/blob URL → git-remote, extract ref + skillPath for the record.
  //   https://github.com/<owner>/<repo>/tree/<ref>/<path...>
  //   https://github.com/<owner>/<repo>/blob/<ref>/<path>
  if (host === 'github.com' || host === 'www.github.com') {
    const treeMatch = pathname.match(/^\/[^/]+\/[^/]+\/(?:tree|blob)\/([^/]+)\/?(.*)$/);
    if (treeMatch) {
      const ref = decodeURIComponent(treeMatch[1]);
      const skillPath = treeMatch[2].replace(/\/$/, '');
      return {
        kind: 'git-remote',
        sourceArg: input,
        ref,
        skillPath: skillPath.length > 0 ? skillPath : undefined,
      };
    }
    return { kind: 'git-remote', sourceArg: input };
  }

  // GitLab tree URL → git-remote.
  if (host === 'gitlab.com' || host === 'www.gitlab.com') {
    const treeMatch = pathname.match(/^\/[^/]+\/[^/]+\/-\/tree\/([^/]+)\/?(.*)$/);
    if (treeMatch) {
      const ref = decodeURIComponent(treeMatch[1]);
      const skillPath = treeMatch[2].replace(/\/$/, '');
      return {
        kind: 'git-remote',
        sourceArg: input,
        ref,
        skillPath: skillPath.length > 0 ? skillPath : undefined,
      };
    }
    return { kind: 'git-remote', sourceArg: input };
  }

  // Any other http(s) URL is treated as a direct download (url).
  return { kind: 'url', sourceArg: input };
}

// Verify the staged Skill's frontmatter identity (spec §7.3 "matching frontmatter
// identity"). Requires a readable SKILL.md with non-empty `name` and `description`;
// when an `--skill` selection was given, the frontmatter `name` must match it.
export async function verifyStagedSkillIdentity(options: {
  stagedSkillsPath: string;
  stagedName: string;
  expectedSkill?: string;
}): Promise<StagedSkillIdentity> {
  const skillMdPath = path.join(options.stagedSkillsPath, options.stagedName, 'SKILL.md');
  let content: string;
  try {
    content = await fs.readFile(skillMdPath, 'utf8');
  } catch (error) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_IDENTITY_MISMATCH',
      `The staged Skill "${options.stagedName}" has no readable SKILL.md.`,
      {
        guidance:
          '1. Confirm the source is a Skill (a directory with a SKILL.md).\n2. If the source holds multiple Skills, pass a --skill selection.\n3. Retry the acquisition.',
        cause: error,
      },
    );
  }

  const { frontmatter, parseError } = parseFrontmatter(content);
  if (parseError || !frontmatter) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_IDENTITY_MISMATCH',
      `The staged Skill "${options.stagedName}" has unparseable SKILL.md frontmatter.`,
      {
        guidance: '1. Fix the SKILL.md frontmatter at the source.\n2. Retry the acquisition.',
      },
    );
  }

  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_IDENTITY_MISMATCH',
      `The staged Skill "${options.stagedName}" is missing a frontmatter name.`,
      {
        guidance: '1. Add a name field to the source SKILL.md frontmatter.\n2. Retry the acquisition.',
      },
    );
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_IDENTITY_MISMATCH',
      `The staged Skill "${options.stagedName}" is missing a frontmatter description.`,
      {
        guidance: '1. Add a description field to the source SKILL.md frontmatter.\n2. Retry the acquisition.',
      },
    );
  }

  if (options.expectedSkill && options.expectedSkill !== name) {
    throw new CcpsError(
      'SKILLS_ACQUISITION_IDENTITY_MISMATCH',
      `The staged Skill "${options.stagedName}" (name "${name}") does not match the requested --skill "${options.expectedSkill}".`,
      {
        guidance:
          '1. Verify the --skill selection matches a Skill name in the source.\n2. Retry the acquisition.',
      },
    );
  }

  return { name, description };
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
