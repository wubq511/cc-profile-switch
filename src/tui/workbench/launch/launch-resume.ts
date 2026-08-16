/** UI state carried outside the React tree across the launch
 *  unmount/spawn/remount cycle (spec §10): the pre-launch selection plus the
 *  data for the "Claude exited (N)" flash. The entry (index.mts) hands it to
 *  the next WorkbenchApp mount as the `resumeState` prop.
 *  Extracted from app.tsx (issue #89). */
export type LaunchResumeState = {
  selectedIndex: number;
  profileName: string;
  dir: string;
  exitCode: number | null;
};

let pendingResumeState: LaunchResumeState | null = null;

/** Publish the UI state that must survive the unmount/remount cycle. The
 *  launch flow calls this right before the entry's handler unmounts Ink, and
 *  again with the exit code once Claude returns. */
export function publishLaunchResumeState(state: LaunchResumeState): void {
  pendingResumeState = state;
}

/** Read and clear the resume state published by the last launch. Called by
 *  the Workbench entry's render loop (index.mts) between cycles. */
export function takeLaunchResumeState(): LaunchResumeState | null {
  const state = pendingResumeState;
  pendingResumeState = null;
  return state;
}
