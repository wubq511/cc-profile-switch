import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';

import type { Clock } from './types';
import type { LaunchPlan } from './launcher';
import { resolveFilesystemPath } from '../platform/path';

export type WorkbenchLaunchOptions = {
  plan: LaunchPlan;
  appHomePath: string;
  clock?: Clock;
  /** Override the spawn implementation for testing. */
  spawnImpl?: typeof spawnSync;
};

export type WorkbenchLaunchResult = {
  exitCode: number | null;
  signal: string | null;
};

/**
 * Execute a launch after Ink has unmounted and raw mode is torn down.
 *
 * Uses spawnSync to avoid the SIGCHLD hazard: after Ink's raw-mode stdin
 * teardown, async spawn's `exit` event is unreliable on macOS (defunct
 * zombie, event never fires). spawnSync blocks until Claude exits, which
 * is the correct behavior for the Workbench's synchronous-wait requirement.
 *
 * The caller is responsible for running side-effect preconditions
 * (ensureProfileClaudeMdExcludes, ensureCcpsProfileRule) before calling
 * this function, because those are async and must run while Ink is still
 * mounted.
 */
export function workbenchLaunchSync(options: WorkbenchLaunchOptions): WorkbenchLaunchResult {
  const { plan, spawnImpl } = options;
  const doSpawn = spawnImpl ?? spawnSync;

  // macOS PTY wrapper: `script -q /dev/null` allocates a PTY so
  // Claude Code stays in interactive mode.
  const isMac = process.platform === 'darwin';
  const spawnCommand = isMac ? 'script' : plan.command;
  const spawnArgs = isMac ? ['-q', '/dev/null', plan.command, ...plan.args] : plan.args;

  const env = {
    ...process.env,
    ...plan.apiEnv,
    ...plan.realClaudeEnv,
    ...plan.envChanges,
  };

  const result = doSpawn(spawnCommand, spawnArgs, {
    cwd: plan.cwd,
    stdio: 'inherit',
    shell: false,
    env,
  });

  // Record last-used profile and recent project dir synchronously
  updateMetadataSync(options);

  return {
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
  };
}

function updateMetadataSync(options: WorkbenchLaunchOptions): void {
  const { plan, appHomePath, clock } = options;
  const now = (clock ?? (() => new Date()))().toISOString();

  // Update config.json lastUsedProfile
  try {
    const configPath = resolveFilesystemPath(appHomePath, 'config.json');
    if (fs.pathExistsSync(configPath)) {
      const config = fs.readJsonSync(configPath);
      fs.writeJsonSync(configPath, {
        ...config,
        lastUsedProfile: plan.profileName,
        updatedAt: now,
      });
    }
  } catch {
    // Non-fatal — last-used metadata is best-effort
  }

  // Update state.json recentProjectDirs
  try {
    const statePath = resolveFilesystemPath(appHomePath, 'state.json');
    let state: { version: number; recentProjectDirs: Array<{ path: string; lastUsedAt: string }> };
    if (fs.pathExistsSync(statePath)) {
      state = fs.readJsonSync(statePath);
    } else {
      state = { version: 1, recentProjectDirs: [] };
    }

    const filtered = state.recentProjectDirs.filter(
      (entry) => !areSameFilesystemPathSync(entry.path, plan.cwd),
    );
    const updated = [{ path: plan.cwd, lastUsedAt: now }, ...filtered].slice(0, 10);
    fs.writeJsonSync(statePath, { version: 1, recentProjectDirs: updated });
  } catch {
    // Non-fatal
  }
}

function areSameFilesystemPathSync(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
