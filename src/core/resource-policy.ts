import fs from 'fs-extra';
import path from 'node:path';

import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';

/**
 * Managed Profile Resource selection policy (spec #103 Implementation
 * Decisions 1 + 11, issue #105).
 *
 * Export and custom-template save share ONE selection pipeline: the profile
 * tree is copied entry-by-entry through this allowlist into staging — never a
 * whole-tree copy followed by deletion, which would read (and briefly stage)
 * runtime content the product must never carry. Every entry is lstat-checked:
 * a symlink or junction anywhere inside the profile tree aborts the copy
 * before the linked content is read, so a configuration file (or one of its
 * ancestor directories) cannot be swapped for excluded external content.
 *
 * `includeSecrets` widens env/header VALUE redaction only; it never widens
 * this tree selection. Known runtime data (credentials, sessions, history,
 * projects, caches) and unknown top-level entries are excluded in every mode.
 */

/** claude-home directories that are Claude runtime state, never a profile resource. */
export const RUNTIME_EXCLUDED_CLAUDE_HOME_DIRS = [
  'sessions',
  'history',
  'projects',
  'todos',
  'statsig',
  'cache',
  'shell-snapshots',
  'logs',
] as const;

/** claude-home files that hold Claude runtime credentials (OAuth/API state). */
export const RUNTIME_EXCLUDED_CLAUDE_HOME_FILES = ['.credentials.json'] as const;

/** Runtime cache directory inside the supported plugins/ resource category. */
const PLUGIN_CACHE_DIR = 'cache';

/** The supported Profile Resource top-level shape (spec §6, AGENTS.md contract). */
const SUPPORTED_CLAUDE_HOME_DIRS = ['memory', 'skills', 'agents', 'rules', 'plugins'] as const;
const SUPPORTED_CLAUDE_HOME_FILES = ['CLAUDE.md', 'settings.json', '.claude.json'] as const;
const SUPPORTED_PROFILE_ROOT_FILES = ['profile.json', 'mcp.json'] as const;
/** ccps-owned Skill Provenance Record at the profile root (spec §7.1). */
const PROVENANCE_FILE = 'skills-provenance.json';

const PROTECTED_CONFIG_PATHS = new Set([
  'profile.json',
  'mcp.json',
  'claude-home/settings.json',
  'claude-home/.claude.json',
  'claude-home/CLAUDE.md',
]);

/** Staging-path-relative directories the pipeline must never descend into. */
const ALWAYS_EXCLUDED_RELATIVE_DIRS = new Set(['claude-home/plugins/cache']);

export type ResourceCopyFailure = {
  /** Path relative to the profile root, e.g. `claude-home/skills/github`. */
  relativePath: string;
  code: 'RESOURCE_LINK_FORBIDDEN' | 'RESOURCE_CONFIG_LINK_FORBIDDEN';
  message: string;
  guidance: string;
};

export type ResourceSelectionResult = {
  copiedFiles: number;
  copiedDirs: number;
  skipped: string[];
  failures: ResourceCopyFailure[];
  /** Top-level profile entries copied (claude-home, profile.json, mcp.json,
   * skills-provenance.json) — recorded in the manifest. */
  copiedTopLevelEntries: string[];
};

export type SelectResourcesOptions = {
  sourceProfileRoot: string;
  stagingProfileRoot: string;
  /** Export keeps Auto Memory; templates exclude it (spec Implementation Decision 1). */
  includeAutoMemory: boolean;
  /** Templates keep Linked Skill references: skill symlinks are skipped
   * (recorded by the caller) instead of refusing the whole save. Portable
   * Export never sets this — links are refused there (spec Decision 11). */
  keepLinkedSkillReferences?: boolean;
};

/** Raised when a symlink/junction is found inside the profile tree. */
export class ResourceLinkForbiddenError extends CcpsError {
  readonly relativePath: string;

  constructor(relativePath: string, message: string, guidance: string) {
    super('RESOURCE_LINK_FORBIDDEN', message, { guidance });
    this.relativePath = relativePath;
  }
}

/** Classify one top-level claude-home entry against the resource policy. */
export function classifyClaudeHomeEntry(
  name: string,
): 'supported' | 'runtime-excluded' | 'unknown' {
  if ((SUPPORTED_CLAUDE_HOME_DIRS as readonly string[]).includes(name)) return 'supported';
  if ((SUPPORTED_CLAUDE_HOME_FILES as readonly string[]).includes(name)) return 'supported';
  if ((RUNTIME_EXCLUDED_CLAUDE_HOME_DIRS as readonly string[]).includes(name)) {
    return 'runtime-excluded';
  }
  if ((RUNTIME_EXCLUDED_CLAUDE_HOME_FILES as readonly string[]).includes(name)) {
    return 'runtime-excluded';
  }
  return 'unknown';
}

async function listDirSafe(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

function toPosixRelative(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/** A Linked Skill is a symlink DIRECTLY under claude-home/skills/ (§7.2). */
function isDirectSkillEntry(relativePath: string): boolean {
  return /^claude-home\/skills\/[^/]+$/.test(relativePath.replace(/\\/g, '/'));
}

function linkFailure(relativePath: string, isProtectedConfig: boolean): ResourceCopyFailure {
  const posixRelative = relativePath.replace(/\\/g, '/');
  if (isProtectedConfig || PROTECTED_CONFIG_PATHS.has(posixRelative)) {
    return {
      relativePath,
      code: 'RESOURCE_CONFIG_LINK_FORBIDDEN',
      message: `Configuration path "${relativePath}" is a symlink/junction, which cannot be carried safely.`,
      guidance:
        'A linked configuration could point at excluded runtime content. Replace it with a real file inside the profile, or remove the link.',
    };
  }
  if (isDirectSkillEntry(posixRelative)) {
    return {
      relativePath,
      code: 'RESOURCE_LINK_FORBIDDEN',
      message: `Skill "${path.basename(relativePath)}" is a Linked Skill (symlink); a portable bundle cannot carry its external source.`,
      guidance:
        'Create a Copied Skill for it first (ccps skill install already offers copy mode), then retry, or remove the Linked Skill from the profile.',
    };
  }
  return {
    relativePath,
    code: 'RESOURCE_LINK_FORBIDDEN',
    message: `Resource path "${relativePath}" is a symlink/junction, which cannot be carried safely.`,
    guidance:
      'Links are not trusted for export (they could point at excluded runtime content). Replace the link with a real directory or file.',
  };
}

/**
 * Copy the profile tree into staging entry-by-entry through the allowlist.
 * Each entry is lstat'd: any symlink/junction aborts with a refusal BEFORE the
 * linked content is read, so neither a configuration file nor an ancestor
 * directory can route the copy into excluded content. Unknown top-level
 * claude-home entries are skipped (reported), and the known runtime
 * directories never leave the source tree.
 */
export async function selectResourcesIntoStaging(
  options: SelectResourcesOptions,
): Promise<ResourceSelectionResult> {
  const { sourceProfileRoot, stagingProfileRoot } = options;

  const sourceStats = await fs.lstat(sourceProfileRoot);
  if (sourceStats.isSymbolicLink()) {
    throw new ResourceLinkForbiddenError(
      '.',
      'The profile directory itself is a symlink/junction, which cannot be exported safely.',
      { guidance: 'Profiles must be real directories inside the ccps app home.' },
    );
  }

  const result: ResourceSelectionResult = {
    copiedFiles: 0,
    copiedDirs: 0,
    skipped: [],
    failures: [],
    copiedTopLevelEntries: [],
  };
  await fs.ensureDir(stagingProfileRoot);

  for (const entry of await listDirSafe(sourceProfileRoot)) {
    const sourcePath = path.join(sourceProfileRoot, entry.name);
    if (entry.name === 'claude-home') {
      if (!entry.isDirectory()) {
        result.failures.push(linkFailure(entry.name, false));
        continue;
      }
      result.copiedTopLevelEntries.push(entry.name);
      await fs.ensureDir(path.join(stagingProfileRoot, 'claude-home'));
      const claudeHomeResult = await copySupportedDir({
        sourceDir: sourcePath,
        stagingDir: path.join(stagingProfileRoot, 'claude-home'),
        relativeBase: 'claude-home',
        excludeAutoMemory: !options.includeAutoMemory,
        keepLinkedSkillReferences: options.keepLinkedSkillReferences === true,
        result,
      });
      if (claudeHomeResult) {
        result.failures.push(claudeHomeResult);
      }
      continue;
    }
    if ((SUPPORTED_PROFILE_ROOT_FILES as readonly string[]).includes(entry.name)) {
      const failure = await copyFileEntry(
        sourcePath,
        path.join(stagingProfileRoot, entry.name),
        entry.name,
      );
      if (failure !== undefined) {
        result.failures.push(failure);
        continue;
      }
      result.copiedFiles += 1;
      result.copiedTopLevelEntries.push(entry.name);
      continue;
    }
    if (entry.name === PROVENANCE_FILE) {
      const failure = await copyFileEntry(
        sourcePath,
        path.join(stagingProfileRoot, entry.name),
        entry.name,
      );
      if (failure !== undefined) {
        result.failures.push(failure);
        continue;
      }
      result.copiedFiles += 1;
      result.copiedTopLevelEntries.push(entry.name);
      continue;
    }
    // Unknown top-level entries never travel (spec Implementation Decision 1).
    result.skipped.push(entry.name);
  }

  return result;
}

/** Copy a single real file; a symlink/junction is refused before reading. */
async function copyFileEntry(
  sourcePath: string,
  stagingPath: string,
  relativePath: string,
): Promise<ResourceCopyFailure | undefined> {
  let stats: fs.Stats;
  try {
    stats = await fs.lstat(sourcePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return linkFailure(relativePath, PROTECTED_CONFIG_PATHS.has(toPosixRelative(relativePath)));
  }
  await fs.copy(sourcePath, stagingPath);
  return undefined;
}

type CopySupportedDirArgs = {
  sourceDir: string;
  stagingDir: string;
  /** Relative base for reporting, e.g. `claude-home`. */
  relativeBase: string;
  excludeAutoMemory: boolean;
  keepLinkedSkillReferences: boolean;
  result: ResourceSelectionResult;
};

/**
 * Recursively copy one supported directory (memory/skills/agents/rules/
 * plugins or their subdirectories). Returns a failure when the walk must
 * abort; partial staging callers always discard on failure. Every entry is
 * classified first: runtime-excluded and unknown claude-home entries never
 * leave the source tree — the walk never descends into them, so their
 * content is not read.
 */
async function copySupportedDir(
  args: CopySupportedDirArgs,
): Promise<ResourceCopyFailure | undefined> {
  const {
    sourceDir,
    stagingDir,
    relativeBase,
    excludeAutoMemory,
    keepLinkedSkillReferences,
    result,
  } = args;
  for (const entry of await listDirSafe(sourceDir)) {
    const relativePath = `${relativeBase}/${entry.name}`;
    const sourcePath = path.join(sourceDir, entry.name);
    const stagingPath = path.join(stagingDir, entry.name);

    // One level below claude-home the policy is enforced by name; deeper
    // levels inherit it (any entry under an unknown parent was never reached).
    if (relativeBase === 'claude-home') {
      const classification = classifyClaudeHomeEntry(entry.name);
      if (classification !== 'supported') {
        result.skipped.push(relativePath);
        continue;
      }
    }

    let stats: fs.Stats;
    try {
      stats = await fs.lstat(sourcePath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue;
      throw error;
    }

    if (stats.isSymbolicLink()) {
      if (keepLinkedSkillReferences && isDirectSkillEntry(relativePath)) {
        // The caller records the reference (name + target) and re-creates it
        // on create-from-template; the external directory is never copied.
        result.skipped.push(relativePath);
        continue;
      }
      return linkFailure(relativePath, PROTECTED_CONFIG_PATHS.has(toPosixRelative(relativePath)));
    }

    if (stats.isFile()) {
      await fs.copy(sourcePath, stagingPath);
      result.copiedFiles += 1;
      continue;
    }

    if (stats.isDirectory()) {
      if (excludeAutoMemory && relativePath === 'claude-home/memory/auto') {
        result.skipped.push(relativePath);
        continue;
      }
      if (ALWAYS_EXCLUDED_RELATIVE_DIRS.has(toPosixRelative(relativePath))) {
        result.skipped.push(relativePath);
        continue;
      }
      if (relativePath === 'claude-home/memory' && excludeAutoMemory) {
        // Recurse into memory/ but keep the exclusion in force for auto/.
        await fs.ensureDir(stagingPath);
        result.copiedDirs += 1;
        const failure = await copySupportedDir({
          ...args,
          sourceDir: sourcePath,
          stagingDir: stagingPath,
          relativeBase: relativePath,
        });
        if (failure) return failure;
        continue;
      }
      await fs.ensureDir(stagingPath);
      result.copiedDirs += 1;
      const failure = await copySupportedDir({
        ...args,
        sourceDir: sourcePath,
        stagingDir: stagingPath,
        relativeBase: relativePath,
      });
      if (failure) return failure;
      continue;
    }

    // FIFOs, sockets, devices and other non-regular entries are not resources.
    result.skipped.push(relativePath);
  }
  return undefined;
}

/**
 * Import-side sweep for pre-policy bundles (manifest v1 and older v2): runtime
 * entries and unknown top-level entries that an old exporter may have carried
 * are removed from the STAGED tree before it is published into profiles/.
 * Supported resources (including Auto Memory, which v1 exports keep) travel.
 * Returns the removed paths relative to the profile root.
 */
export async function sweepRuntimeEntriesFromStagedProfile(
  stagingProfileRoot: string,
): Promise<string[]> {
  const removed: string[] = [];

  const claudeHome = path.join(stagingProfileRoot, 'claude-home');
  for (const entry of await listDirSafe(claudeHome)) {
    const classification = classifyClaudeHomeEntry(entry.name);
    if (classification === 'supported') {
      if (entry.name === 'plugins') {
        const pluginCache = path.join(claudeHome, 'plugins', PLUGIN_CACHE_DIR);
        try {
          await fs.lstat(pluginCache);
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') continue;
          throw error;
        }
        await fs.remove(pluginCache);
        removed.push(`claude-home/plugins/${PLUGIN_CACHE_DIR}`);
      }
      continue;
    }
    await fs.remove(path.join(claudeHome, entry.name));
    removed.push(`claude-home/${entry.name}`);
  }

  for (const entry of await listDirSafe(stagingProfileRoot)) {
    if (
      entry.name === 'claude-home' ||
      (SUPPORTED_PROFILE_ROOT_FILES as readonly string[]).includes(entry.name) ||
      entry.name === PROVENANCE_FILE
    ) {
      continue;
    }
    await fs.remove(path.join(stagingProfileRoot, entry.name));
    removed.push(entry.name);
  }

  return removed;
}
