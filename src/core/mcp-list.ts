// MCP server inventory + connection-state check (delegated, guidance amber nudge).
//
// Reads the configured server names from the profile's own `claude-home/.claude.json`
// (names only — never `claude mcp get`, never secret values) and delegates the
// connection-state probe to `claude mcp list` with `CLAUDE_CONFIG_DIR` pointed at
// that profile. `claude mcp list` is Claude Code's own health-check surface, so
// the failure signal is the CLI's, not ours.
//
// Failure policy: this powers a just-in-time guidance nudge, so it must never
// block or break the Workbench. Every failure mode (missing claude binary,
// spawn error, timeout, unparseable output) fails closed — the caller simply
// gets no failed servers and shows no nudge.

import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import { join } from 'node:path';

import { getProfileTemplatePaths } from './profile-template';
import { isRecord } from '../utils/type-guards';

export type McpServerState = {
  name: string;
  failed: boolean;
};

export type ListMcpServersOptions = {
  appHomePath: string;
  profileName: string;
  /** Override the claude CLI path for testing. */
  claudeCommand?: string;
  /** Override the spawn implementation for testing. */
  spawnImpl?: typeof spawn;
  /** Cap on the `claude mcp list` health-check wait. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export async function listMcpServers(options: ListMcpServersOptions): Promise<McpServerState[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const paths = getProfileTemplatePaths(options.appHomePath, options.profileName);
  const configuredNames = await readConfiguredMcpNames(paths.claudeHomePath);
  if (configuredNames.length === 0) {
    return [];
  }

  const output = await runMcpList({
    claudeHomePath: paths.claudeHomePath,
    command: options.claudeCommand ?? 'claude',
    spawnImpl: options.spawnImpl,
    timeoutMs,
  });

  if (output === null) {
    // Fail closed: probe inconclusive, treat every server as unknown (not failed).
    return configuredNames.map((name) => ({ name, failed: false }));
  }

  const failedNames = parseFailedMcpNames(output, configuredNames);
  return configuredNames.map((name) => ({
    name,
    failed: failedNames.has(name),
  }));
}

/** Configured server names from the profile's own `.claude.json` (no connection state). */
export async function readConfiguredMcpNames(claudeHomePath: string): Promise<string[]> {
  const claudeJsonPath = join(claudeHomePath, '.claude.json');
  try {
    const claudeJson: unknown = await fs.readJson(claudeJsonPath);
    if (!isRecord(claudeJson)) return [];
    const mcpServers = claudeJson.mcpServers;
    if (!isRecord(mcpServers)) return [];
    return Object.keys(mcpServers);
  } catch {
    return [];
  }
}

async function runMcpList(options: {
  claudeHomePath: string;
  command: string;
  spawnImpl?: typeof spawn;
  timeoutMs: number;
}): Promise<string | null> {
  const { claudeHomePath, command, spawnImpl, timeoutMs } = options;
  const doSpawn = spawnImpl ?? spawn;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const timerHolder: { current: NodeJS.Timeout | null } = { current: null };
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timerHolder.current) clearTimeout(timerHolder.current);
      resolve(value);
    };

    let child;
    try {
      child = doSpawn(command, ['mcp', 'list'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: claudeHomePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch {
      // Missing claude binary or invalid spawn — fail closed.
      finish(null);
      return;
    }

    timerHolder.current = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', () => {
      // `claude mcp list` may write progress to stderr; failure state is in stdout.
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(stdout));
  });
}

/**
 * Parse failed server names from `claude mcp list` output.
 *
 * The CLI prints one line per server:
 *   `<name>: <command> <args> - ✓ Connected` or `✘ Failed to connect — <reason>`
 * plus a "Checking MCP server health…" header line. Only names that were actually
 * configured in this profile are considered; a line whose prefix is not a
 * configured name is ignored (it may be a project-scope `.mcp.json` server).
 * Unparseable lines are ignored — the nudge must never misfire on format drift.
 */
export function parseFailedMcpNames(
  output: string,
  configuredNames: string[],
): Set<string> {
  const configured = new Set(configuredNames);
  const failed = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = /^([^:]+):\s/.exec(line);
    if (!match) continue;
    const name = match[1]!.trim();
    if (!configured.has(name)) continue;
    const isFailed = line.includes('✘') || /Failed to connect/i.test(line);
    if (isFailed) failed.add(name);
  }

  return failed;
}
