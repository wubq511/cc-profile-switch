import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Key } from 'ink';

import { getAppHomePaths } from '../../../core/app-config';
import { loadAppState } from '../../../core/app-state';
import { buildLaunchPlan, type LaunchPlan } from '../../../core/launcher';
import { validateProfile, type ValidationFinding } from '../../../core/validator';
import {
  ensureProfileClaudeMdExcludes,
  ensureCcpsProfileRule,
} from '../../../core/profile-template';
import { resolveInside } from '../../../platform/path';
import {
  initialLifecycleState,
  lifecycleReducer,
  type LifecycleAction,
  type LifecycleState,
  type RecentDir,
} from '../lifecycle';
import { publishLaunchResumeState } from '../launch/launch-resume';

type UseLaunchFlowOptions = {
  lifecycle: LifecycleState;
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  /** Called when the Workbench needs to unmount, spawn Claude, and remount. */
  onLaunch?: (plan: LaunchPlan, appHomePath: string) => number | null;
  coreTranslator: (key: string, params?: Record<string, string | number>) => string;
};

/** Launch flow (pre-launch bar, directory screen, dry-run, spawn, exit flash):
 *  state transitions and input handling extracted from app.tsx (issue #89).
 *  The launch substate lives in the shared lifecycle reducer; this unit owns
 *  the flow's logic and its resume-state publication (spec §10). */
export function useLaunchFlow({
  lifecycle,
  setLifecycle,
  selectedIndex,
  setSelectedIndex,
  onLaunch,
  coreTranslator,
}: UseLaunchFlowOptions): {
  handleLaunchInput: (input: string, key: Key) => void;
  handleLaunchBar: (profileName: string) => Promise<void>;
  handleLaunchDirScreen: (profileName: string) => Promise<void>;
} {
  // Persisted selection across launch remount
  const persistedSelection = useRef(selectedIndex);

  const performLaunch = useCallback(async () => {
    const launch = lifecycle.launch;
    const profileName = lifecycle.profileName;
    const appHomePath = getAppHomePaths().appHomePath;

    try {
      // Build the launch plan (may throw on validation errors)
      const plan = await buildLaunchPlan(
        {
          appHomePath,
          profileName,
          cwd: launch.dir,
        },
        coreTranslator,
      );

      // Run async side effects before spawning
      await ensureProfileClaudeMdExcludes(resolveInside(plan.claudeHomePath, 'settings.json'));
      await ensureCcpsProfileRule(resolveInside(plan.claudeHomePath, 'rules', 'ccps-profile.md'));

      // Transition to launching state
      setLifecycle((prev) => ({
        ...prev,
        launch: { ...prev.launch, phase: 'launching' },
      }));

      // Persist selection across the launch remount
      persistedSelection.current = selectedIndex;

      if (onLaunch) {
        // Publish the UI state that must survive the unmount/remount cycle
        // (spec §10) outside the React tree; the entry (index.mts) hands it
        // to the next WorkbenchApp mount as the `resumeState` prop.
        publishLaunchResumeState({
          selectedIndex,
          profileName,
          dir: launch.dir,
          exitCode: null,
        });
        // The entry's handler unmounts Ink, spawns Claude synchronously, and
        // returns Claude's exit code. In production this state update lands
        // on the unmounted tree, so the remounted Workbench reads the same
        // data from the published resume state; in tests (handler does not
        // unmount) it drives the 'exited' flash directly.
        const exitCode = onLaunch(plan, appHomePath);
        publishLaunchResumeState({ selectedIndex, profileName, dir: launch.dir, exitCode });
        setLifecycle((prev) => ({
          ...prev,
          launch: { ...prev.launch, phase: 'exited', exitCode },
        }));
      }
      // onLaunch is always provided by the Workbench entry (index.mts);
      // without it there is no spawn and the phase stays 'launching'.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLifecycle((prev) => ({
        ...prev,
        launch: {
          ...prev.launch,
          phase: 'bar', // stay in bar on error
          validationFindings: [{ severity: 'error' as const, code: 'LAUNCH_FAILED', message }],
        },
      }));
    }
  }, [lifecycle, selectedIndex, onLaunch, coreTranslator, setLifecycle]);

  const handleLaunchInput = useCallback(
    (input: string, key: Key) => {
      const launch = lifecycle.launch;
      // Helper to dispatch through the reducer
      const dispatch = (action: LifecycleAction) => {
        setLifecycle((prev) => lifecycleReducer(prev, action));
      };

      if (launch.phase === 'bar') {
        if (key.escape) {
          dispatch({ type: 'LAUNCH_DISMISS' });
          return;
        }
        if (key.return) {
          dispatch({ type: 'LAUNCH_CONFIRM' });
          // performLaunch reads current state; the reducer transition
          // to 'launching' happens inside performLaunch after plan builds.
          const hasErrors = launch.validationFindings.some((f) => f.severity === 'error');
          if (!hasErrors) {
            performLaunch();
          }
          return;
        }
        if (input === 'd') {
          handleLaunchDryRun(lifecycle.profileName);
          return;
        }
        return;
      }

      if (launch.phase === 'dir-screen') {
        if (key.escape) {
          // Return to bar — clear dirInput
          dispatch({ type: 'CANCEL' });
          return;
        }
        if (key.return) {
          // Use typed path or selected recent
          const selectedRecent =
            launch.recentIndex >= 0 ? launch.recentDirs[launch.recentIndex] : null;
          const chosenDir = selectedRecent ? selectedRecent.path : launch.dirInput || launch.dir;
          dispatch({ type: 'LAUNCH_SET_DIR', dir: chosenDir });
          return;
        }
        if (key.tab) {
          dispatch({ type: 'LAUNCH_DIR_TAB' });
          return;
        }
        if (key.backspace || key.delete) {
          dispatch({ type: 'LAUNCH_DIR_BACKSPACE' });
          return;
        }
        // Digit pick (1-9)
        if (!key.ctrl && !key.meta && input.length === 1 && /^[1-9]$/.test(input)) {
          const idx = parseInt(input, 10) - 1;
          dispatch({ type: 'LAUNCH_DIR_PICK', index: idx });
          return;
        }
        if (!key.ctrl && !key.meta && input.length === 1) {
          dispatch({ type: 'LAUNCH_DIR_INPUT_CHAR', char: input });
          return;
        }
        return;
      }

      if (launch.phase === 'dry-run') {
        if (key.escape) {
          // Return to bar from dry-run
          setLifecycle((prev) => ({
            ...prev,
            launch: { ...prev.launch, phase: 'bar', dryRunPlan: null },
          }));
          return;
        }
        if (key.return) {
          dispatch({ type: 'LAUNCH_START' });
          performLaunch();
          return;
        }
        return;
      }

      if (launch.phase === 'exited') {
        if (key.escape || key.return || input === ' ') {
          dispatch({ type: 'LAUNCH_DISMISS' });
          // Restore persisted selection after exit flash dismiss
          setSelectedIndex(persistedSelection.current);
          return;
        }
        return;
      }
    },
    [lifecycle, setLifecycle, setSelectedIndex],
  );

  // Launch action handlers
  const handleLaunchBar = useCallback(
    async (profileName: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      let recentDirs: RecentDir[] = [];
      try {
        const state = await loadAppState(appHomePath);
        recentDirs = state.recentProjectDirs;
      } catch {
        // Non-fatal
      }

      // Validate the profile to get inline findings
      let validationFindings: ValidationFinding[] = [];
      try {
        const result = await validateProfile({ appHomePath, name: profileName }, coreTranslator);
        validationFindings = result.findings;
      } catch {
        // Non-fatal — user can still try to launch
      }

      setLifecycle((prev) => ({
        ...initialLifecycleState(),
        profileName,
        launch: {
          ...prev.launch,
          phase: 'bar',
          dir: process.cwd(),
          recentDirs,
          validationFindings,
        },
      }));
    },
    [coreTranslator, setLifecycle],
  );

  const handleLaunchDirScreen = useCallback(
    async (profileName: string) => {
      // L opens bar first (loading recents + validation), then transitions to dir-screen
      await handleLaunchBar(profileName);
      setLifecycle((prev) => ({
        ...prev,
        launch: {
          ...prev.launch,
          phase: 'dir-screen',
          dirInput: '',
          recentIndex: -1,
        },
      }));
    },
    [handleLaunchBar, setLifecycle],
  );

  const handleLaunchDryRun = useCallback(
    async (profileName: string) => {
      const appHomePath = getAppHomePaths().appHomePath;
      try {
        const plan = await buildLaunchPlan(
          {
            appHomePath,
            profileName,
            cwd: lifecycle.launch.dir,
          },
          coreTranslator,
        );
        setLifecycle((prev) => ({
          ...prev,
          launch: {
            ...prev.launch,
            phase: 'dry-run',
            dryRunPlan: plan,
          },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLifecycle((prev) => ({
          ...prev,
          launch: {
            ...prev.launch,
            validationFindings: [
              { severity: 'error' as const, code: 'LAUNCH_PLAN_FAILED', message },
            ],
          },
        }));
      }
    },
    [lifecycle.launch.dir, coreTranslator, setLifecycle],
  );

  return { handleLaunchInput, handleLaunchBar, handleLaunchDirScreen };
}
