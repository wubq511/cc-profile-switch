import fs from 'fs-extra';
import path from 'node:path';

import { getAppHomePaths } from './app-config';
import {
  createFileTreeItem,
  type RecoveryBinItem,
} from './recovery-bin';
import { resolveInside, validateProfileName } from '../platform/path';
import { CcpsError } from '../utils/errors';
import type { Clock } from './types';

// ─── Public types ───────────────────────────────────────────────────────

/**
 * Relative path of the Auto Memory directory inside a profile, measured from
 * the profile root. Used for Recovery Bin coordinates so restore can write the
 * entry back to exactly where it came from.
 */
export const AUTO_MEMORY_RELATIVE_DIR = 'claude-home/memory/auto';

export type AutoMemoryEntry = {
  /** File name within `memory/auto/` (no path separators). */
  name: string;
  sizeBytes: number;
  /** ISO 8601 mtime of the file. */
  modifiedAt: string;
};

export type AutoMemorySearchMatch = {
  profileName: string;
  entryName: string;
  /** 1-based line number of the match. */
  line: number;
  /** The matching line's text. */
  text: string;
};

export type ListAutoMemoryOptions = {
  appHomePath?: string;
  profileName: string;
};

export type ReadAutoMemoryOptions = {
  appHomePath?: string;
  profileName: string;
  entryName: string;
};

export type SearchAutoMemoryOptions = {
  appHomePath?: string;
  /** When omitted, search crosses every profile. */
  profileName?: string;
  query: string;
};

export type CopyAutoMemoryOptions = {
  appHomePath?: string;
  fromProfile: string;
  toProfile: string;
  entryName: string;
};

export type RemoveAutoMemoryOptions = {
  appHomePath?: string;
  profileName: string;
  entryName: string;
  clock?: Clock;
};

export type CopyResult = {
  targetEntryName: string;
};

// ─── Path helpers ───────────────────────────────────────────────────────

/**
 * Resolve the absolute path of a single Auto Memory entry. Exposed so the UI
 * layer (edit sessions, watchers) can target the same file the service reads
 * without re-implementing the path contract.
 */
export function getAutoMemoryEntryPath(options: {
  appHomePath?: string;
  profileName: string;
  entryName: string;
}): string {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { profilesPath } = getAppHomePaths(appHomePath);
  validateProfileName(options.profileName);
  return entryFilePath(profilesPath, options.profileName, options.entryName);
}

function profileAutoMemoryDir(profilesPath: string, profileName: string): string {
  return resolveInside(profilesPath, profileName, ...AUTO_MEMORY_RELATIVE_DIR.split('/'));
}

function entryFilePath(profilesPath: string, profileName: string, entryName: string): string {
  validateEntryName(entryName);
  return resolveInside(profilesPath, profileName, ...AUTO_MEMORY_RELATIVE_DIR.split('/'), entryName);
}

/**
 * Extract the entry name (last path segment) from a Recovery Bin item's
 * `targetRelativePath` coordinate. Owns the coordinate shape so the UI layer
 * does not reach into Bin internals.
 */
export function getEntryNameFromBinItem(item: RecoveryBinItem): string {
  const rel = (item.coordinates as { targetRelativePath: string }).targetRelativePath;
  return rel.split('/').pop() ?? rel;
}

/**
 * Reject entry names that could escape the Auto Memory directory. A valid name
 * is a single path segment (no separators, no `.`/`..`) so `resolveInside`
 * keeps it inside `memory/auto/`.
 */
function validateEntryName(entryName: string): string {
  if (!entryName || entryName !== entryName.trim()) {
    throw invalidEntryName(entryName);
  }
  if (entryName === '.' || entryName === '..') {
    throw invalidEntryName(entryName);
  }
  // Block any platform separator or NUL. `path.basename` must round-trip.
  if (entryName.includes('/') || entryName.includes('\\') || entryName.includes('\0')) {
    throw invalidEntryName(entryName);
  }
  if (path.basename(entryName) !== entryName) {
    throw invalidEntryName(entryName);
  }
  return entryName;
}

function invalidEntryName(entryName: string): CcpsError {
  return new CcpsError('INVALID_ENTRY_NAME', `Auto Memory entry name is not safe: "${entryName}".`, {
    guidance: 'Use a plain file name with no path separators.',
  });
}

// ─── Operations ─────────────────────────────────────────────────────────

export async function listAutoMemoryEntries(
  options: ListAutoMemoryOptions,
): Promise<AutoMemoryEntry[]> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { profilesPath } = getAppHomePaths(appHomePath);
  validateProfileName(options.profileName);
  const dir = profileAutoMemoryDir(profilesPath, options.profileName);

  if (!(await fs.pathExists(dir))) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: AutoMemoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    const stat = await fs.stat(filePath);
    result.push({
      name: entry.name,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  // Stable, readable ordering: alphabetical by name.
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export async function readAutoMemoryEntry(
  options: ReadAutoMemoryOptions,
): Promise<{ content: string; entry: AutoMemoryEntry }> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { profilesPath } = getAppHomePaths(appHomePath);
  validateProfileName(options.profileName);
  const filePath = entryFilePath(profilesPath, options.profileName, options.entryName);

  if (!(await fs.pathExists(filePath))) {
    throw new CcpsError(
      'AUTO_MEMORY_ENTRY_NOT_FOUND',
      `Auto Memory entry "${options.entryName}" does not exist in profile "${options.profileName}".`,
      { guidance: 'List entries first to see what is available.' },
    );
  }

  const [content, stat] = await Promise.all([
    fs.readFile(filePath, 'utf8'),
    fs.stat(filePath),
  ]);
  return {
    content,
    entry: {
      name: options.entryName,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    },
  };
}

export async function searchAutoMemory(
  options: SearchAutoMemoryOptions,
): Promise<AutoMemorySearchMatch[]> {
  const trimmed = options.query.trim();
  if (trimmed === '') return [];
  const needle = trimmed.toLowerCase();

  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { profilesPath } = getAppHomePaths(appHomePath);

  const targetProfiles: string[] = options.profileName
    ? [validateProfileName(options.profileName)]
    : await listProfileNames(profilesPath);

  const matches: AutoMemorySearchMatch[] = [];
  for (const profileName of targetProfiles) {
    let entries: AutoMemoryEntry[];
    try {
      entries = await listAutoMemoryEntries({ appHomePath, profileName });
    } catch {
      // A malformed profile should not abort a cross-profile search.
      continue;
    }
    for (const entry of entries) {
      const filePath = entryFilePath(profilesPath, profileName, entry.name);
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          matches.push({
            profileName,
            entryName: entry.name,
            line: i + 1,
            text: lines[i]!,
          });
        }
      }
    }
  }
  return matches;
}

export async function copyAutoMemoryEntry(
  options: CopyAutoMemoryOptions,
): Promise<CopyResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { profilesPath } = getAppHomePaths(appHomePath);
  validateProfileName(options.fromProfile);
  validateProfileName(options.toProfile);
  validateEntryName(options.entryName);

  const sourcePath = entryFilePath(profilesPath, options.fromProfile, options.entryName);
  if (!(await fs.pathExists(sourcePath))) {
    throw new CcpsError(
      'AUTO_MEMORY_ENTRY_NOT_FOUND',
      `Auto Memory entry "${options.entryName}" does not exist in profile "${options.fromProfile}".`,
      { guidance: 'List entries first to see what is available.' },
    );
  }

  const targetDir = profileAutoMemoryDir(profilesPath, options.toProfile);
  const targetPath = resolveInside(targetDir, options.entryName);

  if (await fs.pathExists(targetPath)) {
    throw new CcpsError(
      'AUTO_MEMORY_COPY_COLLISION',
      `An entry named "${options.entryName}" already exists in profile "${options.toProfile}".`,
      { guidance: 'Rename or remove the target entry first; Auto Memory copy never overwrites.' },
    );
  }

  await fs.ensureDir(targetDir);
  await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: true });
  return { targetEntryName: options.entryName };
}

export async function removeAutoMemoryEntry(
  options: RemoveAutoMemoryOptions,
): Promise<RecoveryBinItem> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const { profilesPath } = getAppHomePaths(appHomePath);
  validateProfileName(options.profileName);
  validateEntryName(options.entryName);

  const sourcePath = entryFilePath(profilesPath, options.profileName, options.entryName);
  if (!(await fs.pathExists(sourcePath))) {
    throw new CcpsError(
      'AUTO_MEMORY_ENTRY_NOT_FOUND',
      `Auto Memory entry "${options.entryName}" does not exist in profile "${options.profileName}".`,
      { guidance: 'List entries first to see what is available.' },
    );
  }

  const targetRelativePath = `${AUTO_MEMORY_RELATIVE_DIR}/${options.entryName}`;
  const item = await createFileTreeItem({
    appHomePath,
    origin: 'remove',
    kind: 'auto-memory',
    profile: options.profileName,
    coordinates: { targetRelativePath },
    sourcePath,
    secretBearing: false,
    clock: options.clock,
  });

  await fs.remove(sourcePath);
  return item;
}

// ─── Internal helpers ───────────────────────────────────────────────────

async function listProfileNames(profilesPath: string): Promise<string[]> {
  if (!(await fs.pathExists(profilesPath))) return [];
  const entries = await fs.readdir(profilesPath, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      validateProfileName(entry.name);
      names.push(entry.name);
    } catch {
      // Skip non-profile directories.
    }
  }
  return names.sort();
}
