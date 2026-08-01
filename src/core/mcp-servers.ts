import fs from 'fs-extra';
import path from 'node:path';

import { resolveInside } from '../platform/path';
import { captureProcess as defaultCaptureProcess, type CaptureProcess } from '../platform/process';
import { CcpsError } from '../utils/errors';
import {
  mcpAddOptionsSchema,
  type McpAddOptions,
  type McpConnectionState,
  type McpCopyResult,
  type McpDiffResult,
  type McpInspectResult,
  type McpServerPreview,
  type McpTransport,
} from '../schemas/mcp';
import { atomicWriteJson } from './versioned-json';
import { getAppHomePaths, type Clock } from './app-config';
import { createFragmentItem, getRecoveryItem } from './recovery-bin';

export type { Clock } from './app-config';

// `claude mcp list` is given a 30s ceiling so a hung server cannot block
// inspection indefinitely; on timeout every server reports `connection: unknown`.
const MCP_LIST_TIMEOUT_MS = 30_000;

// The fragment file path stored in Recovery Bin items for MCP servers, relative
// to the profile root. Always this exact value — `claude-home/.claude.json`.
const CLAUDE_JSON_REL = 'claude-home/.claude.json';

// ─── Path helpers ────────────────────────────────────────────────────────

export function getClaudeJsonPath(profileRootPath: string): string {
  return resolveInside(profileRootPath, 'claude-home', '.claude.json');
}

export function getLegacyMcpJsonPath(profileRootPath: string): string {
  return resolveInside(profileRootPath, 'mcp.json');
}

function getClaudeHomePath(profileRootPath: string): string {
  return resolveInside(profileRootPath, 'claude-home');
}

// ─── Reading .claude.json (never writes directly; mutation is delegated) ──

type ServerEntry = Record<string, unknown>;

/** Read the profile's native user-scope MCP servers as a name→entry map. */
export async function readMcpServersMap(profileRootPath: string): Promise<Map<string, ServerEntry>> {
  const map = new Map<string, ServerEntry>();
  const filePath = getClaudeJsonPath(profileRootPath);
  let json: unknown;
  try {
    json = await fs.readJson(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return map;
    }
    throw error;
  }
  if (!isRecord(json) || !isRecord(json.mcpServers)) {
    return map;
  }
  for (const [name, entry] of Object.entries(json.mcpServers)) {
    if (isRecord(entry)) {
      map.set(name, entry);
    }
  }
  return map;
}

// ─── Pure helpers ────────────────────────────────────────────────────────

/**
 * Whether a parsed legacy `mcp.json` carries configured servers. Used by the
 * validator to surface the legacy launch-flag path (spec §7.5, AC #6).
 */
export function isLegacyMcpConfigured(parsedMcpJson: unknown): boolean {
  return isRecord(parsedMcpJson) && isRecord(parsedMcpJson.mcpServers) && Object.keys(parsedMcpJson.mcpServers).length > 0;
}

export function deriveTransport(entry: ServerEntry): McpTransport {
  const type = typeof entry.type === 'string' ? entry.type : undefined;
  if (type === 'sse' || type === 'http' || type === 'stdio') {
    return type;
  }
  if (typeof entry.command === 'string') {
    return 'stdio';
  }
  if (typeof entry.url === 'string') {
    // Without a `type` we cannot distinguish sse from http safely.
    return 'unknown';
  }
  return 'unknown';
}

/** Build a redacted preview (command/args/env KEY NAMES only — never env values). */
export function redactServerPreview(name: string, entry: ServerEntry): McpServerPreview {
  const transport = deriveTransport(entry);
  const envKeyNames = isRecord(entry.env) ? Object.keys(entry.env).sort((a, b) => a.localeCompare(b)) : [];

  const preview: McpServerPreview = {
    name,
    scope: 'user',
    transport,
    envKeyNames,
  };
  if (typeof entry.command === 'string') {
    preview.command = entry.command;
  }
  if (Array.isArray(entry.args)) {
    preview.args = entry.args.filter((a): a is string => typeof a === 'string');
  }
  if (typeof entry.url === 'string') {
    preview.url = entry.url;
  }
  return preview;
}

/**
 * Defensively parse `claude mcp list` output into a name→connection-state map.
 * Tolerant of format drift: the first whitespace-delimited token is the server
 * name; the rest of the line is scanned for connection markers. Unparseable
 * lines record `unknown` so the caller can still match known server names.
 */
export function parseMcpListOutput(stdout: string): Map<string, McpConnectionState> {
  const map = new Map<string, McpConnectionState>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const tokens = line.split(/\s+/);
    const name = tokens[0];
    if (!name || name.toLowerCase() === 'name') continue; // skip header rows

    const rest = line.toLowerCase();
    let state: McpConnectionState;
    if (rest.includes('✓') || rest.includes('connected') || rest.includes('ready') || rest.includes('ok')) {
      state = 'connected';
    } else if (rest.includes('✗') || rest.includes('failed') || rest.includes('error') || rest.includes('not connected')) {
      state = 'failed';
    } else {
      state = 'unknown';
    }
    // First occurrence wins; `claude mcp list` lists each server once.
    if (!map.has(name)) {
      map.set(name, state);
    }
  }
  return map;
}

/** Build the `claude mcp add --scope user ...` argv array. */
export function buildMcpAddArgs(options: McpAddOptions): string[] {
  const args = ['add', '--scope', 'user'];
  if (options.transport === 'sse' || options.transport === 'http') {
    args.push('--transport', options.transport);
  }
  if (options.env) {
    // env values are passed to the delegated `claude mcp add` command. This is
    // the unavoidable handoff: Claude Code's MCP add interface only accepts env
    // via `-e KEY=VALUE` (or add-json). ccps itself never logs or displays these
    // values; the spawn uses shell:false so they are not shell-interpolated.
    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }
  args.push(options.name);
  if (options.transport === 'sse' || options.transport === 'http') {
    args.push(options.url as string);
  } else {
    // stdio: `--` separates claude args from the server's own command/args.
    args.push('--', options.command as string);
    if (options.args) {
      args.push(...options.args);
    }
  }
  return args;
}

function validateAddOptions(options: McpAddOptions): void {
  const parsed = mcpAddOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new CcpsError('MCP_INVALID_CONFIG', 'MCP server configuration is invalid.', {
      guidance: 'stdio requires a command; sse/http require a url.',
      cause: parsed.error,
    });
  }
  if (parsed.data.transport === 'stdio' && typeof parsed.data.command !== 'string') {
    throw new CcpsError('MCP_INVALID_CONFIG', 'stdio MCP server requires a command.', {
      guidance: 'Provide a `command` for the stdio server.',
    });
  }
  if ((parsed.data.transport === 'sse' || parsed.data.transport === 'http') && typeof parsed.data.url !== 'string') {
    throw new CcpsError('MCP_INVALID_CONFIG', `${parsed.data.transport} MCP server requires a url.`, {
      guidance: `Provide a \`url\` for the ${parsed.data.transport} server.`,
    });
  }
}

// ─── Delegated `claude mcp` invocation ───────────────────────────────────

type RunMcpOptions = { cwd: string; timeoutMs?: number };

async function runClaudeMcp(
  args: string[],
  claudeHomePath: string,
  options: RunMcpOptions,
  captureProcess?: CaptureProcess,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const run = captureProcess ?? defaultCaptureProcess;
  try {
    return await run('claude', args, {
      cwd: options.cwd,
      shell: false,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHomePath },
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw new CcpsError('MCP_CLAUDE_UNAVAILABLE', 'The `claude` command could not be started.', {
      guidance: 'Install Claude Code and ensure `claude` is on PATH.',
      cause: error,
    });
  }
}

function requireExitZero(
  result: { exitCode: number | null; stderr: string; timedOut: boolean },
  code: string,
  message: string,
  guidance: string,
): void {
  if (result.timedOut) {
    throw new CcpsError(code, `${message} (timed out)`, { guidance });
  }
  if (result.exitCode !== 0) {
    throw new CcpsError(code, message, { guidance });
  }
}

// ─── Inspect / Preview ───────────────────────────────────────────────────

export type InspectMcpServersOptions = {
  captureProcess?: CaptureProcess;
};

export async function inspectMcpServers(
  profileRootPath: string,
  options: InspectMcpServersOptions = {},
): Promise<McpInspectResult> {
  const map = await readMcpServersMap(profileRootPath);

  // Connection state via `claude mcp list`. Non-fatal: any failure degrades to
  // `unknown` for every server and sets connectionAvailable=false (the UI shows
  // the amber nudge only for explicitly `failed` servers, not `unknown`).
  let connectionMap = new Map<string, McpConnectionState>();
  let connectionAvailable = false;
  if (map.size > 0) {
    try {
      const result = await runClaudeMcp(
        ['mcp', 'list'],
        getClaudeHomePath(profileRootPath),
        { cwd: profileRootPath, timeoutMs: MCP_LIST_TIMEOUT_MS },
        options.captureProcess,
      );
      if (result.exitCode === 0 && !result.timedOut) {
        connectionAvailable = true;
        connectionMap = parseMcpListOutput(result.stdout);
      }
    } catch (error) {
      if (error instanceof CcpsError && error.code === 'MCP_CLAUDE_UNAVAILABLE') {
        // claude not on PATH — degrade to unknown, do not throw.
      } else {
        throw error;
      }
    }
  }

  const servers = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      ...redactServerPreview(name, entry),
      connection: connectionMap.get(name) ?? 'unknown',
    }));

  return {
    servers,
    connectionAvailable,
    legacyMcpActive: await isLegacyMcpActiveForProfile(profileRootPath),
  };
}

export async function previewMcpServer(profileRootPath: string, name: string): Promise<McpServerPreview> {
  const map = await readMcpServersMap(profileRootPath);
  const entry = map.get(name);
  if (!entry) {
    throw new CcpsError('MCP_SERVER_NOT_FOUND', `MCP server "${name}" was not found in this profile.`, {
      guidance: `Run ccps inspect or list MCP servers for this profile. Server name: ${name}`,
    });
  }
  return redactServerPreview(name, entry);
}

// ─── Create (delegated add) ──────────────────────────────────────────────

export type AddMcpServerOptions = {
  captureProcess?: CaptureProcess;
};

export type AddMcpServerResult = {
  name: string;
  profileRootPath: string;
};

export async function addMcpServer(
  profileRootPath: string,
  options: McpAddOptions,
  runOptions: AddMcpServerOptions = {},
): Promise<AddMcpServerResult> {
  validateAddOptions(options);

  const existing = await readMcpServersMap(profileRootPath);
  if (existing.has(options.name)) {
    throw new CcpsError('MCP_SERVER_EXISTS', `MCP server "${options.name}" already exists in this profile.`, {
      guidance: `Edit the existing server or remove it first: ${options.name}`,
    });
  }

  const args = ['mcp', ...buildMcpAddArgs(options)];
  const result = await runClaudeMcp(args, getClaudeHomePath(profileRootPath), { cwd: profileRootPath }, runOptions.captureProcess);
  requireExitZero(result, 'MCP_ADD_FAILED', 'Failed to add MCP server via `claude mcp add`.', 'Review the server configuration and try again.');

  // Verify the entry landed in this profile's .claude.json (delegation success +
  // real-home isolation: the entry must be here, not in the real ~/.claude.json).
  const after = await readMcpServersMap(profileRootPath);
  if (!after.has(options.name)) {
    throw new CcpsError('MCP_ADD_FAILED', '`claude mcp add` exited 0 but the server did not land in this profile.', {
      guidance: 'Ensure CLAUDE_CONFIG_DIR is respected by your Claude Code version and retry.',
    });
  }

  return { name: options.name, profileRootPath };
}

// ─── Remove (delegated remove + fragment Bin item, zero-confirm) ──────────

export type RemoveMcpServerOptions = {
  appHomePath?: string;
  captureProcess?: CaptureProcess;
  clock?: Clock;
};

export type RemoveMcpServerResult = {
  name: string;
  recoveryItemDirPath: string;
};

export async function removeMcpServer(
  profileRootPath: string,
  name: string,
  options: RemoveMcpServerOptions = {},
): Promise<RemoveMcpServerResult> {
  const before = await readMcpServersMap(profileRootPath);
  const entry = before.get(name);
  if (!entry) {
    throw new CcpsError('MCP_SERVER_NOT_FOUND', `MCP server "${name}" was not found in this profile.`, {
      guidance: `List this profile's MCP servers before removing. Server name: ${name}`,
    });
  }

  const result = await runClaudeMcp(
    ['mcp', 'remove', '--scope', 'user', name],
    getClaudeHomePath(profileRootPath),
    { cwd: profileRootPath },
    options.captureProcess,
  );
  requireExitZero(result, 'MCP_REMOVE_FAILED', 'Failed to remove MCP server via `claude mcp remove`.', `Confirm the server exists and retry: ${name}`);

  // Verify removal landed before creating the Bin item, so a failed delegation
  // never produces an orphan Recovery Item.
  const after = await readMcpServersMap(profileRootPath);
  if (after.has(name)) {
    throw new CcpsError('MCP_REMOVE_FAILED', '`claude mcp remove` exited 0 but the server is still present.', {
      guidance: 'Ensure CLAUDE_CONFIG_DIR is respected by your Claude Code version and retry.',
    });
  }

  const profileName = path.basename(profileRootPath);
  const secretBearing = isRecord(entry.env) && Object.keys(entry.env).length > 0;
  const item = await createFragmentItem({
    appHomePath: options.appHomePath,
    origin: 'remove',
    kind: 'mcp-server',
    profile: profileName,
    coordinates: {
      file: CLAUDE_JSON_REL,
      keyPath: `mcpServers.${name}`,
      value: entry,
    },
    secretBearing,
    clock: options.clock,
  });

  return { name, recoveryItemDirPath: item.itemDirPath };
}

// ─── Edit (delegated remove + re-add, no Bin item) ───────────────────────

export type EditMcpServerOptions = {
  captureProcess?: CaptureProcess;
};

export type EditMcpServerResult = {
  name: string;
  profileRootPath: string;
};

export async function editMcpServer(
  profileRootPath: string,
  name: string,
  options: McpAddOptions,
  runOptions: EditMcpServerOptions = {},
): Promise<EditMcpServerResult> {
  validateAddOptions({ ...options, name });

  const before = await readMcpServersMap(profileRootPath);
  if (!before.has(name)) {
    throw new CcpsError('MCP_SERVER_NOT_FOUND', `MCP server "${name}" was not found in this profile.`, {
      guidance: `List this profile's MCP servers before editing. Server name: ${name}`,
    });
  }

  const removeResult = await runClaudeMcp(
    ['mcp', 'remove', '--scope', 'user', name],
    getClaudeHomePath(profileRootPath),
    { cwd: profileRootPath },
    runOptions.captureProcess,
  );
  requireExitZero(removeResult, 'MCP_REMOVE_FAILED', 'Failed to remove the existing MCP server during edit.', `Confirm the server exists and retry: ${name}`);

  // Edit is a single logical mutation (remove + re-add) and produces no Recovery
  // Item (spec §6.3); only Remove does. If re-add fails the old config is lost —
  // the documented edit semantics (no undo via Bin for edit).
  const addArgs = ['mcp', ...buildMcpAddArgs({ ...options, name })];
  const addResult = await runClaudeMcp(addArgs, getClaudeHomePath(profileRootPath), { cwd: profileRootPath }, runOptions.captureProcess);
  requireExitZero(addResult, 'MCP_ADD_FAILED', 'Failed to re-add MCP server during edit. The previous server was removed.', `Retry the add manually: claude mcp add --scope user ${name} ...`);

  const after = await readMcpServersMap(profileRootPath);
  if (!after.has(name)) {
    throw new CcpsError('MCP_ADD_FAILED', '`claude mcp add` exited 0 but the edited server did not land in this profile.', {
      guidance: 'Ensure CLAUDE_CONFIG_DIR is respected by your Claude Code version and retry.',
    });
  }

  return { name, profileRootPath };
}

// ─── Cross-Profile copy (non-secret fields only, secrets prompted) ───────

export type CopyMcpServerOptions = {
  sourceProfileRootPath: string;
  sourceName: string;
  targetProfileRootPath: string;
  /** Defaults to sourceName. */
  targetName?: string;
  captureProcess?: CaptureProcess;
};

export async function copyMcpServerToProfile(options: CopyMcpServerOptions): Promise<McpCopyResult> {
  const sourceMap = await readMcpServersMap(options.sourceProfileRootPath);
  const sourceEntry = sourceMap.get(options.sourceName);
  if (!sourceEntry) {
    throw new CcpsError('MCP_SERVER_NOT_FOUND', `MCP server "${options.sourceName}" was not found in the source profile.`, {
      guidance: `List the source profile's MCP servers before copying. Server name: ${options.sourceName}`,
    });
  }

  const targetName = options.targetName ?? options.sourceName;
  const targetMap = await readMcpServersMap(options.targetProfileRootPath);
  if (targetMap.has(targetName)) {
    throw new CcpsError('MCP_SERVER_EXISTS', `MCP server "${targetName}" already exists in the target profile.`, {
      guidance: `Choose a different target name or remove the existing server first: ${targetName}`,
    });
  }

  // Non-secret fields only: transport/command/args/url. env values are NEVER
  // copied (secret-in-memory rule, spec §6.5 fallback); their key names are
  // returned so the caller can prompt for guided re-entry.
  const transport = deriveTransport(sourceEntry);
  const addOptions: McpAddOptions = { name: targetName, transport };
  if (transport === 'stdio') {
    if (typeof sourceEntry.command === 'string') addOptions.command = sourceEntry.command;
    if (Array.isArray(sourceEntry.args)) addOptions.args = sourceEntry.args.filter((a): a is string => typeof a === 'string');
  } else if (transport === 'sse' || transport === 'http') {
    if (typeof sourceEntry.url === 'string') addOptions.url = sourceEntry.url;
  }
  validateAddOptions(addOptions);

  const addArgs = ['mcp', ...buildMcpAddArgs(addOptions)];
  const result = await runClaudeMcp(addArgs, getClaudeHomePath(options.targetProfileRootPath), { cwd: options.targetProfileRootPath }, options.captureProcess);
  requireExitZero(result, 'MCP_ADD_FAILED', 'Failed to copy MCP server to the target profile via `claude mcp add`.', 'Review the target profile and try again.');

  const after = await readMcpServersMap(options.targetProfileRootPath);
  if (!after.has(targetName)) {
    throw new CcpsError('MCP_ADD_FAILED', '`claude mcp add` exited 0 but the copied server did not land in the target profile.', {
      guidance: 'Ensure CLAUDE_CONFIG_DIR is respected by your Claude Code version and retry.',
    });
  }

  const strippedEnvKeys = isRecord(sourceEntry.env)
    ? Object.keys(sourceEntry.env).sort((a, b) => a.localeCompare(b))
    : [];

  return { copiedName: targetName, strippedEnvKeys };
}

// ─── Diff (inventory comparison only — never config values) ──────────────

export type DiffMcpServersOptions = {
  captureProcess?: CaptureProcess;
};

export async function diffMcpServers(
  profileRootPathA: string,
  profileRootPathB: string,
  options: DiffMcpServersOptions = {},
): Promise<McpDiffResult> {
  const [a, b] = await Promise.all([
    inspectMcpServers(profileRootPathA, { captureProcess: options.captureProcess }),
    inspectMcpServers(profileRootPathB, { captureProcess: options.captureProcess }),
  ]);

  const aByName = new Map(a.servers.map((s) => [s.name, s]));
  const bByName = new Map(b.servers.map((s) => [s.name, s]));

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const inBoth: McpDiffResult['inBoth'] = [];

  for (const name of aByName.keys()) {
    if (!bByName.has(name)) {
      onlyInA.push(name);
    }
  }
  for (const name of bByName.keys()) {
    if (!aByName.has(name)) {
      onlyInB.push(name);
    }
  }
  for (const [name, sa] of aByName) {
    const sb = bByName.get(name);
    if (!sb) continue;
    inBoth.push({
      name,
      transportVerdict: sa.transport === sb.transport ? 'same' : 'different',
      connectionVerdict: sa.connection === sb.connection ? 'same' : 'different',
    });
  }

  onlyInA.sort((x, y) => x.localeCompare(y));
  onlyInB.sort((x, y) => x.localeCompare(y));
  inBoth.sort((x, y) => x.name.localeCompare(y.name));

  return { onlyInA, onlyInB, inBoth };
}

// ─── Restore (MCP-specific fragment restore; entry-level collisions) ─────
// Not reusing recovery-bin's `restoreFragmentItem`: that path treats
// `newName` as a new PROFILE, but MCP entry-level collision needs a new SERVER
// name within the same profile. Restore is the one documented place ccps writes
// `.claude.json` directly (spec §9.2 "written back on restore") — the
// "never write directly" rule governs Create/Edit/Remove, not Bin restore.

export type RestoreMcpServerOptions = {
  appHomePath?: string;
  itemId: string;
  collisionResolution?: 'refuse' | 'restore-as-new-name' | 'delete-and-restore';
  /** Required when collisionResolution is 'restore-as-new-name' (the new server name). */
  newName?: string;
  clock?: Clock;
};

export type RestoreMcpServerResult = {
  restoredProfile: string;
  restoredServerName: string;
  consumed: true;
};

export async function restoreMcpServer(options: RestoreMcpServerOptions): Promise<RestoreMcpServerResult> {
  const item = await getRecoveryItem(options.itemId, options.appHomePath);
  if (item.kind !== 'mcp-server' || item.shape !== 'fragment') {
    throw new CcpsError('MCP_RESTORE_ITEM_INVALID', 'Recovery item is not an MCP server fragment.', {
      guidance: 'Use the matching restore entry point for this item kind.',
    });
  }

  const coords = item.coordinates as { file: string; keyPath: string; value: unknown };
  const origName = parseServerNameFromKeyPath(coords.keyPath);

  const { profilesPath } = getAppHomePaths(options.appHomePath);
  const profileDir = path.join(profilesPath, item.profile);
  const targetFile = path.join(profileDir, coords.file);
  blockTraversal(profileDir, targetFile);

  const resolution = options.collisionResolution ?? 'refuse';
  const targetName = resolution === 'restore-as-new-name' ? options.newName : origName;
  if (resolution === 'restore-as-new-name' && !targetName) {
    throw new CcpsError('RESTORE_NEW_NAME_REQUIRED', 'A new server name is required for restore-as-new-name.', {
      guidance: 'Provide a new server name for the restored MCP server.',
    });
  }

  let target: Record<string, unknown>;
  try {
    target = (await fs.readJson(targetFile)) as Record<string, unknown>;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      target = {};
    } else {
      throw error;
    }
  }
  if (!isRecord(target)) {
    target = {};
  }
  if (!isRecord(target.mcpServers)) {
    target.mcpServers = {};
  }
  const servers = target.mcpServers as Record<string, unknown>;

  if (servers[targetName] !== undefined) {
    if (resolution === 'refuse') {
      throw new CcpsError('RESTORE_COLLISION', `An MCP server named "${targetName}" already exists in this profile.`, {
        guidance: 'Use restore-as-new-name or delete-and-restore to resolve the collision.',
      });
    }
    if (resolution === 'restore-as-new-name') {
      // The chosen new name also collides.
      throw new CcpsError('RESTORE_COLLISION', `An MCP server named "${targetName}" already exists in this profile.`, {
        guidance: 'Pick a different new server name.',
      });
    }
    // delete-and-restore: auto-bin the conflicting entry, then delete it.
    const conflicting = servers[targetName];
    await createFragmentItem({
      appHomePath: options.appHomePath,
      origin: 'remove',
      kind: 'mcp-server',
      profile: item.profile,
      coordinates: {
        file: coords.file,
        keyPath: `mcpServers.${targetName}`,
        value: conflicting,
      },
      secretBearing: isRecord(conflicting) && isRecord(conflicting.env) && Object.keys(conflicting.env).length > 0,
      clock: options.clock,
    });
    delete servers[targetName];
  }

  servers[targetName] = coords.value;
  await atomicWriteJson(targetFile, target);

  await fs.remove(item.itemDirPath);

  return { restoredProfile: item.profile, restoredServerName: targetName, consumed: true };
}

function parseServerNameFromKeyPath(keyPath: string): string {
  const prefix = 'mcpServers.';
  if (!keyPath.startsWith(prefix)) {
    throw new CcpsError('MCP_RESTORE_ITEM_INVALID', `Recovery item keyPath is not an MCP server path: ${keyPath}`, {
      guidance: 'The Recovery Item may be corrupt; inspect it manually.',
    });
  }
  return keyPath.slice(prefix.length);
}

function blockTraversal(profileDir: string, targetFile: string): void {
  const rel = path.relative(profileDir, targetFile);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CcpsError('PATH_OUTSIDE_BASE', 'Restore target escapes the profile directory.', {
      guidance: 'The Recovery Item coordinates must point inside the profile directory.',
    });
  }
}

async function isLegacyMcpActiveForProfile(profileRootPath: string): Promise<boolean> {
  const legacyPath = getLegacyMcpJsonPath(profileRootPath);
  if (!(await fs.pathExists(legacyPath))) {
    return false;
  }
  try {
    const parsed = await fs.readJson(legacyPath);
    if (!isLegacyMcpConfigured(parsed)) {
      return false;
    }
  } catch {
    return false;
  }
  // Legacy MCP is only "active" when the profile's launch.mcpMode is not 'none'.
  // When mcpMode is 'none' the legacy --mcp-config flag is not passed at launch,
  // so configured servers don't take effect. The validator mirrors this check
  // (config.launch.mcpMode !== 'none' && isLegacyMcpConfigured(...)).
  const configPath = resolveInside(profileRootPath, 'profile.json');
  try {
    const config = await fs.readJson(configPath);
    const mcpMode = config?.launch?.mcpMode;
    return typeof mcpMode === 'string' && mcpMode !== 'none';
  } catch {
    return false;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
