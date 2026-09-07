import fs from 'fs-extra';

import { isNodeError } from '../../utils/type-guards';

/**
 * Explicit read-state classification for Workbench resource loads (issue #110,
 * spec §7): a resource read resolves to `ok`, `missing`, or `unreadable` — a
 * filesystem error (EISDIR, EACCES, ELOOP, format corruption) is never allowed
 * to masquerade as a successful empty listing, and an absent path is distinct
 * from both.
 */

/** The failure half of a read outcome: absent vs explicitly unreadable. */
export type ResourceReadFailure =
  | { status: 'missing' }
  | { status: 'unreadable'; code: string; detail: string };

function isReadFailureShape(value: unknown): value is ResourceReadFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { status?: unknown; code?: unknown };
  if (candidate.status === 'missing') return true;
  return candidate.status === 'unreadable' && typeof candidate.code === 'string';
}

/** Diagnose a thrown error from a resource read: ENOENT means the resource is
 *  absent; anything else — ENOTDIR/EISDIR (wrong type), EACCES/ELOOP
 *  (permission/link), I/O, format — is an explicit read failure. A wrapper
 *  error is classified by its `cause` when one is present, so an app-level
 *  wrapper (RESOURCE_READ_FAILED) does not shadow the real errno. */
export function classifyReadError(error: unknown): ResourceReadFailure {
  if (isReadFailureShape(error)) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined && cause !== error) {
    const fromCause = classifyReadError(cause);
    if (fromCause.status !== 'unreadable' || fromCause.code !== 'UNKNOWN') {
      return fromCause;
    }
  }
  if (isNodeError(error)) {
    if (error.code === 'ENOENT') {
      return { status: 'missing' };
    }
    if (typeof error.code === 'string') {
      return {
        status: 'unreadable',
        code: error.code,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    status: 'unreadable',
    code: 'UNKNOWN',
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** Successful read outcome shape shared by the typed readers below. */
export type ResourceReadSuccess<T> = { status: 'ok'; value: T };

export type ResourceReadResult<T> = ResourceReadSuccess<T> | ResourceReadFailure;

/**
 * Read a file as raw text with explicit state: missing stays distinct from a
 * failed read, so a corrupt/unreadable file can never render as empty content.
 */
export async function readFileWithState(filePath: string): Promise<ResourceReadResult<string>> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { status: 'ok', value: content };
  } catch (error) {
    return classifyReadError(error);
  }
}

/**
 * Read and parse a JSON file with explicit state. A parse failure is an
 * explicit `unreadable` (JSON_INVALID) result, not an empty object; a missing
 * file is `missing`.
 */
export async function readJsonWithState(filePath: string): Promise<ResourceReadResult<unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    return classifyReadError(error);
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) as unknown };
  } catch (error) {
    return {
      status: 'unreadable',
      code: 'JSON_INVALID',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * List directory entry names with explicit state. EISDIR (the path is a file),
 * EACCES (no read permission), and ELOOP (link cycle) surface as
 * `unreadable` — never as a successful empty listing. `filesOnly` filters to
 * regular files, mirroring the previous dirent-based callers.
 */
export async function listDirWithState(
  dirPath: string,
  options: { filesOnly?: boolean } = {},
): Promise<ResourceReadResult<string[]>> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    return classifyReadError(error);
  }
  const names = entries
    .filter((e) => (options.filesOnly ? e.isFile() : true))
    .map((e) => e.name)
    .sort();
  return { status: 'ok', value: names };
}