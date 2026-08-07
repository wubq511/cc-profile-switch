// Launch cycle glue between the Workbench Ink tree and the entry render loop
// (index.mts) — spec §10. The handler produced here is passed to WorkbenchApp
// as `onLaunch`: it unmounts the Ink instance, leaves the alternate screen,
// spawns Claude synchronously, and returns Claude's exit code so
// performLaunch can record the 'exited' phase. The entry's render loop
// re-enters the alternate screen and re-renders after waitUntilExit resolves.

import type { LaunchPlan } from '../../core/launcher';
import { workbenchLaunchSync, type WorkbenchLaunchResult } from '../../core/workbench-launch';

export type LaunchCycleDeps = {
  /** Tear down the mounted Ink instance (final frame + raw-mode restore). */
  unmount: () => void;
  /** Leave the alternate screen before Claude takes over the terminal. */
  leaveAlternateScreen: () => void;
  /** Run Claude synchronously; injectable for tests. Defaults to workbenchLaunchSync. */
  launch?: (plan: LaunchPlan, appHomePath: string) => WorkbenchLaunchResult;
};

/**
 * Build the `onLaunch(plan, appHomePath)` handler for one render cycle.
 *
 * Order matters: unmount while the alternate screen is still active so Ink's
 * final frame lands there, then leave the screen so Claude starts on a clean
 * main screen. The spawn blocks the event loop until Claude exits
 * (spawnSync — see workbench-launch.ts for the SIGCHLD rationale).
 */
export function createLaunchHandler(
  deps: LaunchCycleDeps,
): (plan: LaunchPlan, appHomePath: string) => number | null {
  const launch = deps.launch ?? ((plan, appHomePath) => workbenchLaunchSync({ plan, appHomePath }));

  return (plan: LaunchPlan, appHomePath: string): number | null => {
    deps.unmount();
    deps.leaveAlternateScreen();
    const result = launch(plan, appHomePath);
    return result.exitCode;
  };
}
