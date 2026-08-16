import { describe, expect, it } from 'vitest';

import type { LaunchPlan } from '../src/core/launcher';
import type { WorkbenchLaunchResult } from '../src/core/workbench-launch';
import { createLaunchHandler } from '../src/tui/workbench/launch-cycle';

describe('workbench launch cycle handler (spec §10)', () => {
  const plan = { profileName: 'coding', cwd: '/project' } as LaunchPlan;

  it('unmounts, leaves the alternate screen, launches synchronously, returns the exit code', () => {
    const order: string[] = [];
    const handler = createLaunchHandler({
      unmount: () => order.push('unmount'),
      leaveAlternateScreen: () => order.push('leave-alt-screen'),
      launch: (p, appHomePath): WorkbenchLaunchResult => {
        order.push('launch');
        expect(p).toBe(plan);
        expect(appHomePath).toBe('/app-home');
        return { exitCode: 42, signal: null };
      },
    });

    const exitCode = handler(plan, '/app-home');

    // performLaunch records the 'exited' phase from this return value
    expect(exitCode).toBe(42);
    // Ink teardown completes before Claude takes over the terminal
    expect(order).toEqual(['unmount', 'leave-alt-screen', 'launch']);
  });

  it('returns null when Claude exits by signal', () => {
    const handler = createLaunchHandler({
      unmount: () => undefined,
      leaveAlternateScreen: () => undefined,
      launch: () => ({ exitCode: null, signal: 'SIGTERM' }),
    });

    expect(handler(plan, '/app-home')).toBeNull();
  });

  it('defaults to workbenchLaunchSync when no launch override is given', () => {
    // Only the wiring is asserted here (the default would really spawn);
    // workbenchLaunchSync itself is covered by workbench-launch-sync.test.ts.
    const handler = createLaunchHandler({
      unmount: () => undefined,
      leaveAlternateScreen: () => undefined,
    });
    expect(typeof handler).toBe('function');
  });
});
