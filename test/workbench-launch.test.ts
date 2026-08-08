import { describe, expect, it } from 'vitest';
import {
  initialLifecycleState,
  lifecycleReducer,
} from '../src/tui/workbench/lifecycle';
import type { LaunchPlan } from '../src/core/launcher';

describe('launch lifecycle reducer', () => {
  it('starts with launch idle', () => {
    const state = initialLifecycleState();
    expect(state.launch.phase).toBe('idle');
  });

  it('LAUNCH_BAR opens pre-launch bar with cwd and recents', () => {
    const state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [{ path: '/recent1', lastUsedAt: '2026-01-01' }],
    });
    expect(state.launch.phase).toBe('bar');
    expect(state.launch.dir).toBe('/project');
    expect(state.launch.recentDirs).toHaveLength(1);
    expect(state.profileName).toBe('coding');
  });

  it('LAUNCH_DIR_SCREEN transitions from bar to dir-screen', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_SCREEN' });
    expect(state.launch.phase).toBe('dir-screen');
    expect(state.launch.dirInput).toBe('');
    expect(state.launch.recentIndex).toBe(-1);
  });

  it('LAUNCH_DIR_SCREEN is no-op when not in bar phase', () => {
    const state = lifecycleReducer(initialLifecycleState(), { type: 'LAUNCH_DIR_SCREEN' });
    expect(state.launch.phase).toBe('idle');
  });

  it('LAUNCH_SET_DIR sets directory and returns to bar', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_SCREEN' });
    state = lifecycleReducer(state, { type: 'LAUNCH_SET_DIR', dir: '/new-dir' });
    expect(state.launch.phase).toBe('bar');
    expect(state.launch.dir).toBe('/new-dir');
  });

  it('LAUNCH_DIR_INPUT_CHAR accumulates typed path', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_SCREEN' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_INPUT_CHAR', char: '/' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_INPUT_CHAR', char: 'h' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_INPUT_CHAR', char: 'o' });
    expect(state.launch.dirInput).toBe('/ho');
    expect(state.launch.recentIndex).toBe(-1);
  });

  it('LAUNCH_DIR_BACKSPACE deletes last char', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_SCREEN' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_INPUT_CHAR', char: 'a' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_INPUT_CHAR', char: 'b' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_BACKSPACE' });
    expect(state.launch.dirInput).toBe('a');
  });

  it('LAUNCH_DIR_TAB cycles through recents', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [
        { path: '/r1', lastUsedAt: '2026-01-01' },
        { path: '/r2', lastUsedAt: '2026-01-02' },
      ],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_SCREEN' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_TAB' });
    expect(state.launch.recentIndex).toBe(0);
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_TAB' });
    expect(state.launch.recentIndex).toBe(1);
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_TAB' });
    expect(state.launch.recentIndex).toBe(0); // wraps around
  });

  it('LAUNCH_DIR_TAB is no-op when no recents', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_SCREEN' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_TAB' });
    expect(state.launch.recentIndex).toBe(-1);
  });

  it('LAUNCH_DIR_PICK selects a recent by index and returns to bar', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [
        { path: '/r1', lastUsedAt: '2026-01-01' },
        { path: '/r2', lastUsedAt: '2026-01-02' },
      ],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_SCREEN' });
    state = lifecycleReducer(state, { type: 'LAUNCH_DIR_PICK', index: 1 });
    expect(state.launch.phase).toBe('bar');
    expect(state.launch.dir).toBe('/r2');
  });

  it('LAUNCH_CONFIRM transitions bar to launching when no errors', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_CONFIRM' });
    expect(state.launch.phase).toBe('launching');
  });

  it('LAUNCH_CONFIRM is blocked when validation has errors', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, {
      type: 'LAUNCH_SET_VALIDATION',
      findings: [{ severity: 'error' as const, code: 'TEST', message: 'broken', path: '/foo' }],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_CONFIRM' });
    expect(state.launch.phase).toBe('bar'); // stays in bar
  });

  it('LAUNCH_CONFIRM allows launch with warnings only', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, {
      type: 'LAUNCH_SET_VALIDATION',
      findings: [{ severity: 'warning' as const, code: 'WARN', message: 'fyi', path: '/foo' }],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_CONFIRM' });
    expect(state.launch.phase).toBe('launching');
  });

  it('LAUNCH_SHOW_DRYRUN transitions bar to dry-run with plan', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    const fakePlan = { profileName: 'coding' } as unknown as LaunchPlan;
    state = lifecycleReducer(state, { type: 'LAUNCH_SHOW_DRYRUN', plan: fakePlan });
    expect(state.launch.phase).toBe('dry-run');
    expect(state.launch.dryRunPlan).toBe(fakePlan);
  });

  it('LAUNCH_START transitions dry-run to launching', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_SHOW_DRYRUN', plan: {} as unknown as LaunchPlan });
    state = lifecycleReducer(state, { type: 'LAUNCH_START' });
    expect(state.launch.phase).toBe('launching');
  });

  it('LAUNCH_EXIT transitions launching to exited with exit code', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_CONFIRM' }); // bar -> launching
    state = lifecycleReducer(state, { type: 'LAUNCH_EXIT', exitCode: 0 });
    expect(state.launch.phase).toBe('exited');
    expect(state.launch.exitCode).toBe(0);
  });

  it('LAUNCH_EXIT records non-zero exit code', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_CONFIRM' });
    state = lifecycleReducer(state, { type: 'LAUNCH_EXIT', exitCode: 1 });
    expect(state.launch.phase).toBe('exited');
    expect(state.launch.exitCode).toBe(1);
  });

  it('LAUNCH_DISMISS resets launch state from exited', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_CONFIRM' });
    state = lifecycleReducer(state, { type: 'LAUNCH_EXIT', exitCode: 0 });
    state = lifecycleReducer(state, { type: 'LAUNCH_DISMISS' });
    expect(state.launch.phase).toBe('idle');
  });

  it('LAUNCH_DISMISS is no-op when not in exited phase', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    state = lifecycleReducer(state, { type: 'LAUNCH_DISMISS' });
    expect(state.launch.phase).toBe('bar'); // unchanged
  });

  it('LAUNCH_BAR resets other lifecycle state', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'old',
    });
    expect(state.phase).toBe('prompting');
    state = lifecycleReducer(state, {
      type: 'LAUNCH_BAR',
      profileName: 'coding',
      cwd: '/project',
      recentDirs: [],
    });
    expect(state.phase).toBe('idle'); // lifecycle reset
    expect(state.launch.phase).toBe('bar');
    expect(state.profileName).toBe('coding');
  });

  it('LAUNCH_SET_VALIDATION works from any phase', () => {
    const state = lifecycleReducer(initialLifecycleState(), {
      type: 'LAUNCH_SET_VALIDATION',
      findings: [
        { severity: 'error' as const, code: 'E1', message: 'err', path: '/a' },
        { severity: 'warning' as const, code: 'W1', message: 'warn', path: '/b' },
      ],
    });
    expect(state.launch.validationFindings).toHaveLength(2);
  });
});
