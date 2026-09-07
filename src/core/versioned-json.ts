import fs from 'fs-extra';
import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { CcpsError } from '../utils/errors';
import { isNodeError, isRecord } from '../utils/type-guards';

export type VersionedJsonSpec<T, V extends number = number> = {
  fileName: string;
  currentVersion: V;
  currentSchema: z.ZodSchema<T>;
  migrate: (raw: unknown, rawVersion: number) => T;
  errorPrefix: string;
};

function prefix(spec: VersionedJsonSpec<unknown>, suffix: string): string {
  return `${spec.errorPrefix}_${suffix}`;
}

// ─── CCPS temp-file protocol (issue #106) ───────────────────────────────────
//
// Every JSON document is published by writing a uniquely-named temp file in
// the target's own directory and renaming it over the target. The temp name
// encodes a CCPS-exclusive protocol that lets residue cleanup prove both
// ownership and writer liveness:
//
//   .ccps-tmp-<token(target basename)>-<token(meta JSON)>
//
// where token() is a dash-free base64url variant and meta carries the target
// name (f), the writer's process id (p), the write timestamp (t) and a random
// nonce (n). Because the protocol name is never a plain `*.tmp` suffix,
// cleanup can tell CCPS residue from user files: generic `.tmp` entries are
// never touched, and a protocol entry is only removed when its recorded
// writer process is confirmed dead. Writer liveness is decided with
// signal-0 probing, which is a direct test of whether any process still
// holds the recorded pid — pid reuse can only make a dead writer look alive
// (cleanup defers), never the reverse.

/** Hidden, CCPS-exclusive prefix; plain `*.tmp` names never match. */
export const CCPS_TEMP_PREFIX = '.ccps-tmp-';

type CcpsTempMeta = {
  /** Target file basename the temp publishes. */
  f: string;
  /** Writer process id. */
  p: number;
  /** Write timestamp (diagnostics; liveness is probed, not inferred from it). */
  t: number;
  /** Random nonce so two writers never share a temp path. */
  n: string;
};

/** Dash-free base64url: `-`→`~`, `_`→`!`, so the name's `-` separators stay unambiguous. */
export function encodeTempToken(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url').replaceAll('-', '~').replaceAll('_', '!');
}

const TEMP_TOKEN_PATTERN = /^[A-Za-z0-9~!]+$/;

function decodeTempToken(token: string): string | null {
  if (!TEMP_TOKEN_PATTERN.test(token)) return null;
  const decoded = Buffer.from(
    token.replaceAll('~', '-').replaceAll('!', '_'),
    'base64url',
  ).toString('utf8');
  return encodeTempToken(decoded) === token ? decoded : null;
}

function isPlainFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

/** Build the unique temp sibling for a target path. Same directory, so the
 * final rename stays on one filesystem and remains atomic. */
export function createTempSiblingPath(filePath: string): string {
  const targetName = path.basename(filePath);
  const meta: CcpsTempMeta = {
    f: targetName,
    p: process.pid,
    t: Date.now(),
    n: randomBytes(6).toString('hex'),
  };
  return path.join(
    path.dirname(filePath),
    `${CCPS_TEMP_PREFIX}${encodeTempToken(targetName)}-${encodeTempToken(JSON.stringify(meta))}`,
  );
}

/** Parse a temp name back into its protocol parts, or null when the name is
 * not a well-formed CCPS temp (foreign format or unknown ownership). */
export function parseTempName(tempName: string): { targetName: string; meta: CcpsTempMeta } | null {
  if (!tempName.startsWith(CCPS_TEMP_PREFIX)) return null;
  const rest = tempName.slice(CCPS_TEMP_PREFIX.length);
  const separator = rest.indexOf('-');
  if (separator <= 0) return null;
  const targetName = decodeTempToken(rest.slice(0, separator));
  if (targetName === null || !isPlainFileName(targetName)) return null;
  const metaJson = decodeTempToken(rest.slice(separator + 1));
  if (metaJson === null) return null;
  let metaRaw: unknown;
  try {
    metaRaw = JSON.parse(metaJson);
  } catch {
    return null;
  }
  if (!isRecord(metaRaw)) return null;
  const { f, p, t, n } = metaRaw;
  if (f !== targetName) return null;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) return null;
  if (typeof t !== 'number' || !Number.isInteger(t) || t <= 0) return null;
  if (typeof n !== 'string' || n.length === 0) return null;
  return { targetName, meta: { f: targetName, p, t, n } };
}

/** Tri-state writer liveness: true = alive, false = confirmed ended,
 * null = cannot tell (everything but a confirmed end preserves the file). */
function isWriterProcessAlive(pid: number): boolean | null {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error)) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
    }
    return null;
  }
}

/**
 * I/O primitives used to publish JSON documents. Internal seam for tests:
 * fault-injection spies replace individual operations; production paths use
 * the real implementations.
 */
export const jsonWriteIo = {
  async writeFile(filePath: string, payload: string, mode: number): Promise<void> {
    await fsp.writeFile(filePath, payload, { flag: 'wx', mode });
  },
  writeFileSync(filePath: string, payload: string, mode: number): void {
    fsSync.writeFileSync(filePath, payload, { flag: 'wx', mode });
  },
  async chmod(filePath: string, mode: number): Promise<void> {
    await fsp.chmod(filePath, mode);
  },
  chmodSync(filePath: string, mode: number): void {
    fsSync.chmodSync(filePath, mode);
  },
  async rename(fromPath: string, toPath: string): Promise<void> {
    await fsp.rename(fromPath, toPath);
  },
  renameSync(fromPath: string, toPath: string): void {
    fsSync.renameSync(fromPath, toPath);
  },
  async unlink(filePath: string): Promise<void> {
    await fsp.unlink(filePath);
  },
  unlinkSync(filePath: string): void {
    fsSync.unlinkSync(filePath);
  },
};

type TargetModePlan = { createMode: number; replicateMode: number | null };

/**
 * Resolve the temp's permissions from the file being replaced. The temp is
 * always created at 0o600 unless the target is a brand-new file, so a
 * restricted (0o600) file is never briefly replaced by a wider file and
 * chmod is never involved on the restricted path — an ineffective chmod can
 * never masquerade as verified permissions, and no code path claims
 * permission verification. For other existing regular files the replacement
 * replicates the file's own mode (never widening beyond what the replaced
 * file already allowed); a failed chmod there leaves the replacement
 * tighter, never wider.
 */
async function resolveTargetModePlan(filePath: string): Promise<TargetModePlan> {
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isFile()) {
      const mode = stats.mode & 0o777;
      return { createMode: 0o600, replicateMode: mode === 0o600 ? null : mode };
    }
    // Symlink or special file: stay tight, never widen an uncertain target.
    return { createMode: 0o600, replicateMode: null };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      // New file: default creation mode, umask applies as before.
      return { createMode: 0o666, replicateMode: null };
    }
    // Cannot verify the target's permissions: stay tight.
    return { createMode: 0o600, replicateMode: null };
  }
}

function resolveTargetModePlanSync(filePath: string): TargetModePlan {
  try {
    const stats = fsSync.lstatSync(filePath);
    if (stats.isFile()) {
      const mode = stats.mode & 0o777;
      return { createMode: 0o600, replicateMode: mode === 0o600 ? null : mode };
    }
    return { createMode: 0o600, replicateMode: null };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { createMode: 0o666, replicateMode: null };
    }
    return { createMode: 0o600, replicateMode: null };
  }
}

async function removeOwnedTemp(tempPath: string): Promise<void> {
  try {
    await jsonWriteIo.unlink(tempPath);
  } catch {
    // The temp is a sibling this writer exclusively created; if it is already
    // gone or cannot be removed right now, the residue protocol owns its
    // eventual cleanup. Never mask the original publish error from here.
  }
}

function removeOwnedTempSync(tempPath: string): void {
  try {
    jsonWriteIo.unlinkSync(tempPath);
  } catch {
    // See removeOwnedTemp.
  }
}

async function publishJsonDocument(filePath: string, payload: string): Promise<void> {
  const tempPath = createTempSiblingPath(filePath);
  const modePlan = await resolveTargetModePlan(filePath);
  try {
    await jsonWriteIo.writeFile(tempPath, payload, modePlan.createMode);
    if (modePlan.replicateMode !== null) {
      try {
        await jsonWriteIo.chmod(tempPath, modePlan.replicateMode);
      } catch {
        // An ineffective chmod leaves the replacement tighter than the file
        // it replaces (never wider); no permission claim is made anywhere.
      }
    }
  } catch (error) {
    await removeOwnedTemp(tempPath);
    throw error;
  }
  try {
    await jsonWriteIo.rename(tempPath, filePath);
  } catch (error) {
    await removeOwnedTemp(tempPath);
    throw error;
  }
}

function publishJsonDocumentSync(filePath: string, payload: string): void {
  const tempPath = createTempSiblingPath(filePath);
  const modePlan = resolveTargetModePlanSync(filePath);
  try {
    jsonWriteIo.writeFileSync(tempPath, payload, modePlan.createMode);
    if (modePlan.replicateMode !== null) {
      try {
        jsonWriteIo.chmodSync(tempPath, modePlan.replicateMode);
      } catch {
        // See publishJsonDocument — stay tight, never claim verification.
      }
    }
  } catch (error) {
    removeOwnedTempSync(tempPath);
    throw error;
  }
  try {
    jsonWriteIo.renameSync(tempPath, filePath);
  } catch (error) {
    removeOwnedTempSync(tempPath);
    throw error;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await publishJsonDocument(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Synchronous temp+rename write — same atomicity and temp-protocol contract
 * as atomicWriteJson, for call sites that must stay sync (e.g. after
 * spawnSync). */
export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  publishJsonDocumentSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * App-home subdirectories scanned for atomic-write residue. backups/ is the
 * durable Backup store and is deliberately never traversed for cleanup
 * (issue #106): backup content must stay untouched, and ccps never publishes
 * JSON inside it.
 */
const TMP_SCAN_SUBDIRS = ['profiles'] as const;

/**
 * Directory levels to descend below each scan subdir. Two levels reach
 * profiles/<name>/ and profiles/<name>/claude-home/ without walking
 * Claude-managed bulk (claude-home/projects, sessions, caches).
 */
const TMP_SCAN_DEPTH = 2;

/**
 * Remove residue left by interrupted CCPS JSON writes. Scans the app-home
 * root plus the known write-target subtrees (profiles/), bounded to
 * TMP_SCAN_DEPTH levels. An entry is removed only when the CCPS temp
 * protocol proves CCPS ownership and its writer process has ended; foreign
 * names, malformed tokens and live or unknown writers are preserved. Runs
 * from ensureAppHomeStructure (init/backup paths), not on the per-command
 * hot path.
 */
export async function cleanupTmpResidue(dirPath: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  const pending: Promise<void>[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(CCPS_TEMP_PREFIX)) {
      pending.push(removeConfirmedResidue(path.join(dirPath, entry.name)));
    }
  }
  for (const subdir of TMP_SCAN_SUBDIRS) {
    const dirent = entries.find((candidate) => candidate.name === subdir);
    // Dirent.isDirectory() is false for symlinks — never descend through links.
    if (dirent?.isDirectory()) {
      pending.push(scanTmpResidue(path.join(dirPath, subdir), TMP_SCAN_DEPTH));
    }
  }
  await Promise.all(pending);
}

/** Remove one residue file when the protocol proves its writer has ended.
 * Everything else — foreign names, malformed tokens, live or unknown writer
 * processes — is preserved. */
async function removeConfirmedResidue(tempPath: string): Promise<void> {
  const parsed = parseTempName(path.basename(tempPath));
  if (parsed === null) return;
  if (isWriterProcessAlive(parsed.meta.p) !== false) return;
  try {
    await fsp.unlink(tempPath);
  } catch {
    // Unreadable or vanished entries stay put; a later pass may retry.
  }
}

/** Remove protocol residue inside dirPath, descending at most `depth`
 * directory levels. Symlinked directories are never followed and only plain
 * files are considered for removal — user directories are never touched. */
async function scanTmpResidue(dirPath: string, depth: number): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  const pending: Promise<void>[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) {
        pending.push(scanTmpResidue(entryPath, depth - 1));
      }
    } else if (entry.isFile() && entry.name.startsWith(CCPS_TEMP_PREFIX)) {
      pending.push(removeConfirmedResidue(entryPath));
    }
  }
  await Promise.all(pending);
}

function readVersionedJsonText(spec: VersionedJsonSpec<unknown>, filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CcpsError(prefix(spec, 'NOT_FOUND'), `${spec.fileName} does not exist.`, {
        guidance: `Run ccps init to create ${spec.fileName}.`,
        cause: error,
      });
    }
    throw error;
  }
}

function parseVersionedJson<T>(spec: VersionedJsonSpec<T>, raw: string): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new CcpsError(prefix(spec, 'INVALID_JSON'), `${spec.fileName} is not valid JSON.`, {
      guidance: `Fix ${spec.fileName} or recreate it from a backup.`,
      cause: error,
    });
  }

  if (!isRecord(parsedJson) || typeof parsedJson.version !== 'number') {
    throw new CcpsError(
      prefix(spec, 'INVALID_VERSION'),
      `${spec.fileName} has a missing or invalid version field.`,
      {
        guidance: `Check the version field in ${spec.fileName}.`,
      },
    );
  }

  const rawVersion = parsedJson.version;

  if (rawVersion > spec.currentVersion) {
    throw new CcpsError(
      prefix(spec, 'FUTURE_VERSION'),
      `${spec.fileName} version ${rawVersion} is newer than supported version ${spec.currentVersion}.`,
      {
        guidance: 'Upgrade ccps to a version that supports this format.',
      },
    );
  }

  if (rawVersion < spec.currentVersion) {
    return spec.migrate(parsedJson, rawVersion);
  }

  const parsed = spec.currentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new CcpsError(
      prefix(spec, 'INVALID'),
      `${spec.fileName} does not match the expected schema.`,
      {
        guidance: `Check ${spec.fileName} fields.`,
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
}

function validateForSave<T>(spec: VersionedJsonSpec<T>, data: T): T {
  const parsed = spec.currentSchema.safeParse(data);
  if (!parsed.success) {
    throw new CcpsError(
      prefix(spec, 'INVALID'),
      `${spec.fileName} data does not match the expected schema.`,
      {
        guidance: `Check ${spec.fileName} fields.`,
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
}

export async function loadVersionedJson<T>(
  spec: VersionedJsonSpec<T>,
  filePath: string,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new CcpsError(prefix(spec, 'NOT_FOUND'), `${spec.fileName} does not exist.`, {
        guidance: `Run ccps init to create ${spec.fileName}.`,
        cause: error,
      });
    }
    throw error;
  }

  return parseVersionedJson(spec, raw);
}

/** Synchronous variant of loadVersionedJson — identical parse/migrate/errors. */
export function loadVersionedJsonSync<T>(spec: VersionedJsonSpec<T>, filePath: string): T {
  return parseVersionedJson(spec, readVersionedJsonText(spec, filePath));
}

export async function saveVersionedJson<T>(
  spec: VersionedJsonSpec<T>,
  filePath: string,
  data: T,
): Promise<T> {
  const validated = validateForSave(spec, data);
  await atomicWriteJson(filePath, validated);
  return validated;
}

/** Synchronous variant of saveVersionedJson — identical validation + atomic write. */
export function saveVersionedJsonSync<T>(spec: VersionedJsonSpec<T>, filePath: string, data: T): T {
  const validated = validateForSave(spec, data);
  atomicWriteJsonSync(filePath, validated);
  return validated;
}
