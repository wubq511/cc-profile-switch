import { spawnSync } from 'node:child_process';

import type { Clock } from './types';
import type { LaunchPlan } from './launcher';
import { loadAppConfigSync, saveAppConfigSync } from './app-config';
import { recordRecentProjectDirSync } from './app-state';

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
  // Windows: no PTY wrapper needed — Claude Code detects ConPTY automatically.
  // Linux: no PTY wrapper — Claude Code launches directly.
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

  const exitCode = result.status ?? null;

  // Recents and last-used profile are recorded only after a successful real
  // launch (exit 0) — dry runs, blocked launches, and failed sessions record
  // nothing (spec §13.3), mirroring the CLI launch path.
  if (exitCode === 0) {
    updateMetadataSync(options);
  }

  return {
    exitCode,
    signal: result.signal ?? null,
  };
}

function updateMetadataSync(options: WorkbenchLaunchOptions): void {
  const { plan, appHomePath, clock } = options;

  // config.json lastUsedProfile — same schema parse + atomic temp+rename
  // write as the CLI path (saveAppConfig), in sync form for the
  // post-spawnSync context.
  try {
    const config = loadAppConfigSync(appHomePath);
    saveAppConfigSync(appHomePath, { ...config, lastUsedProfile: plan.profileName }, { clock });
  } catch {
    // Non-fatal — last-used metadata is best-effort
  }

  // state.json recentProjectDirs — same schema parse + atomic write as
  // recordRecentProjectDir. A state.json that fails strict schema parsing
  // (e.g. unknown fields, spec §13.4) is left untouched, never silently
  // rewritten without them.
  try {
    recordRecentProjectDirSync(appHomePath, plan.cwd, { clock });
  } catch {
    // Non-fatal — recents are best-effort
  }
}
