// PROTOTYPE (throwaway) — launch bridge between the Ink Workbench and the
// process-spawning driver in index.mts (issue #32: launch flow variants J/K).
// A variant sets bridge.pending and exits; index.mts spawns the Claude Code
// stand-in, then either re-renders the Workbench (resume) or ends (exit).

import { spawnSync } from 'node:child_process';

export interface LaunchRequest {
  profileName: string;
  cwd: string;
  resume: boolean;
}

export const bridge: {
  pending: LaunchRequest | null;
  lastExit: { code: number | null; profileName: string } | null;
  // shell variant/dataset selection, restored across Workbench-resume remounts
  ui: { vi: number; di: number };
} = {
  pending: null,
  lastExit: null,
  ui: { vi: 0, di: 0 },
};

// Spawns a bare bash standing in for Claude Code, mirroring the real launcher's
// PTY wrapper on macOS (script -q /dev/null …). The stand-in gets an
// unmistakable prompt — the first demo used the user's own login shell, whose
// prompt was indistinguishable from the real terminal and read as "it just
// quit to the shell without starting anything".
// spawnSync on purpose: async spawn's SIGCHLD-based 'exit' event is unreliable
// here after Ink's raw-mode stdin teardown (child ends up a defunct zombie);
// the driver has nothing to do while Claude runs, so blocking is correct.
export function runFakeClaude(req: LaunchRequest): number | null {
  const claudeHome = `~/.cc-profile-switch/profiles/${req.profileName}/claude-home`;
  console.log('');
  console.log('── Claude Code starts here (STAND-IN: bare bash) ──');
  console.log(`  profile: ${req.profileName}`);
  console.log(`  cwd:     ${req.cwd}  (project config preserved — Claude starts here)`);
  console.log(`  env:     CLAUDE_CONFIG_DIR=${claudeHome}`);
  console.log('  the [claude-stand-in] prompt below IS fake Claude — not your normal shell');
  console.log("  type 'exit' to end the session");
  console.log('');

  const cmd = 'bash';
  const shellArgs = ['--noprofile', '--norc', '-i'];
  const isMac = process.platform === 'darwin';
  const spawnCmd = isMac ? 'script' : cmd;
  const args = isMac ? ['-q', '/dev/null', cmd, ...shellArgs] : shellArgs;
  // Mock recent directories (~-paths) don't exist; only chdir into real ones.
  const cwd = req.cwd.startsWith('~') ? undefined : req.cwd;

  const result = spawnSync(spawnCmd, args, {
    stdio: 'inherit',
    cwd,
    shell: false,
    env: { ...process.env, PS1: '[claude-stand-in] \\w $ ' },
  });
  const code = result.status;
  console.log('');
  console.log(`── Claude Code exited (code ${code ?? 0}) ──`);
  return code;
}
