import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import path from 'node:path';

import { getAppHomePaths } from '../../core/app-config';
import { backupProfile, createProfile } from '../../core/profile';
import {
  clearDefaultProfile,
  copyProfile,
  removeProfile,
  renameProfile,
  setDefaultProfile,
} from '../../core/profile-management';
import { buildLaunchPlan, type LaunchPlan } from '../../core/launcher';
import { validateProfile, type ValidationFinding } from '../../core/validator';
import { loadAppState } from '../../core/app-state';
import { ensureProfileClaudeMdExcludes, ensureCcpsProfileRule } from '../../core/profile-template';
import {
  installLocalSkill,
  previewInstall,
  validateLocalSkillSource,
} from '../../core/skills-install';
import { resolveInside } from '../../platform/path';
import { I18nProvider, useI18n } from './i18n/react';
import type { Locale } from './i18n/react';
import {
  initialLifecycleState,
  lifecycleReducer,
  type LifecycleAction,
  type LifecyclePromptKind,
  type LaunchState,
  type RecentDir,
} from './lifecycle';
import { KeymapOverlay } from './keymap';
import { MainPane, CATEGORY_COUNT, categoryKeyAt } from './main-pane';
import type { WorkbenchProfile, WorkbenchData } from './profile-data';
import { loadWorkbenchData } from './profile-data';
import { ResizeGuard } from './resize-guard';
import { Sidebar } from './sidebar';
import { PreLaunchBar } from './launch/pre-launch-bar';
import { DirectoryScreen } from './launch/directory-screen';
import { DryRunPage } from './launch/dry-run-page';
import { InstallWizard } from './skills/install-wizard';
import { AutoMemoryView } from './resources/auto-memory-view';
import { EditSessionManager } from '../../core/edit-session';
import { type ProfileTemplateName } from '../../core/profile-template';

type DrillDown = { kind: 'none' } | { kind: 'autoMemory' };

type CaptureSetter = (on: boolean) => void;
const CaptureContext = createContext<CaptureSetter>(() => {});
export function useCapture(): CaptureSetter {
  return useContext(CaptureContext);
}

type WorkbenchAppProps = {
  data: WorkbenchData;
  onLocaleChange?: (locale: Locale) => void;
  initialLocale?: Locale;
  headless?: boolean;
  skipWelcome?: boolean;
  /** Called when the Workbench needs to unmount, spawn Claude, and remount. */
  onLaunch?: (plan: LaunchPlan, appHomePath: string) => number | null;
};

export function WorkbenchApp({ data, onLocaleChange, initialLocale, headless, skipWelcome, onLaunch }: WorkbenchAppProps): React.ReactElement {
  const inner = React.createElement(WorkbenchInner, { data, headless, skipWelcome, onLaunch });
  return React.createElement(
    I18nProvider,
    { initialLocale, onLocaleChange },
    inner,
  );
}

function WorkbenchInner({ data, headless, skipWelcome, onLaunch }: { data: WorkbenchData; headless?: boolean; skipWelcome?: boolean; onLaunch?: (plan: LaunchPlan, appHomePath: string) => number | null }): React.ReactElement {
  const { t, locale } = useI18n();
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin: inkStdin } = useStdin();

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [helpVisible, setHelpVisible] = useState(false);
  const [capture, setCapture] = useState(false);
  const [welcomeVisible, setWelcomeVisible] = useState(!skipWelcome);
  const [, forceRerender] = useState(0);
  const [workbenchData, setWorkbenchData] = useState(data);
  const [lifecycle, setLifecycle] = useState(initialLifecycleState);
  // Skill install wizard overlay (issue #64, spec §7.2)
  const [wizardProfileName, setWizardProfileName] = useState<string | null>(null);
  // Main-pane category focus + resource-row drill-down (issue #69)
  const [mainPaneFocus, setMainPaneFocus] = useState(false);
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
  const [drillDown, setDrillDown] = useState<DrillDown>({ kind: 'none' });
  // Persisted selection across launch remount
  const persistedSelection = useRef(selectedIndex);

  // Edit-session manager — one instance for the Workbench lifetime. Its onChange
  // bumps a counter so watching banners re-render on external saves.
  const editSessionManagerRef = useRef<EditSessionManager | null>(null);
  if (editSessionManagerRef.current === null) {
    editSessionManagerRef.current = new EditSessionManager({
      onChange: () => forceRerender((n: number) => n + 1),
    });
  }
  const editSessionManager = editSessionManagerRef.current;

  const width = stdout.columns ?? 80;
  const height = stdout.rows ?? 24;

  useEffect(() => {
    const onResize = () => forceRerender((n: number) => n + 1);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Release file watchers and debounce timers when the Workbench unmounts
  // (e.g. on launch remount or exit) so the manager never leaks OS handles.
  useEffect(() => {
    return () => {
      editSessionManager.dispose();
    };
  }, [editSessionManager]);

  const canUseInput = !headless && inkStdin.isTTY;

  // Whether the launch flow is active (captures all other input)
  const launchActive = lifecycle.launch.phase !== 'idle';
  const wizardOpen = wizardProfileName !== null;

  useInput((input: string, key: Record<string, boolean>) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (welcomeVisible) {
      setWelcomeVisible(false);
      return;
    }

    if (helpVisible) {
      if (key.escape || input === '?') {
        setHelpVisible(false);
      }
      return;
    }

    if (capture) return;

    // The install wizard owns its own input; let it handle everything else.
    if (wizardOpen) return;

    if (input === 'q') {
      exit();
      return;
    }
    if (input === '?') {
      setHelpVisible(true);
      return;
    }

    // Launch flow input handling (highest priority when active)
    if (launchActive) {
      handleLaunchInput(input, key);
      return;
    }

    // Tab toggles main-pane category focus (only at lifecycle idle)
    if (key.tab && lifecycle.phase === 'idle') {
      if (!mainPaneFocus && workbenchData.profiles.length > 0) {
        setMainPaneFocus(true);
      } else if (mainPaneFocus) {
        setMainPaneFocus(false);
      }
      return;
    }

    // Main-pane category navigation (issue #69 drill-down entry)
    if (mainPaneFocus && lifecycle.phase === 'idle') {
      if (key.escape || key.leftArrow) {
        setMainPaneFocus(false);
        return;
      }
      if (key.upArrow) {
        setSelectedCategoryIndex((prev) => (prev > 0 ? prev - 1 : CATEGORY_COUNT - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedCategoryIndex((prev) => (prev < CATEGORY_COUNT - 1 ? prev + 1 : 0));
        return;
      }
      if (key.return) {
        const catKey = categoryKeyAt(selectedCategoryIndex);
        if (catKey === 'autoMemory') {
          setDrillDown({ kind: 'autoMemory' });
          setCapture(true);
        }
        return;
      }
      return;
    }
  }, { isActive: canUseInput });

  const handleExitDrillDown = useCallback(() => {
    setDrillDown({ kind: 'none' });
    setCapture(false);
    // Return focus to the category grid so the user can keep navigating.
    setMainPaneFocus(true);
  }, []);

  const handleLaunchInput = useCallback((input: string, key: Record<string, boolean>) => {
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
        const selectedRecent = launch.recentIndex >= 0 ? launch.recentDirs[launch.recentIndex] : null;
        const chosenDir = selectedRecent ? selectedRecent.path : (launch.dirInput || launch.dir);
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
  }, [lifecycle]);

  const performLaunch = useCallback(async () => {
    const launch = lifecycle.launch;
    const profileName = lifecycle.profileName;
    const appHomePath = getAppHomePaths().appHomePath;

    try {
      // Build the launch plan (may throw on validation errors)
      const plan = await buildLaunchPlan({
        appHomePath,
        profileName,
        cwd: launch.dir,
      });

      // Run async side effects before spawning
      await ensureProfileClaudeMdExcludes(
        resolveInside(plan.claudeHomePath, 'settings.json'),
      );
      await ensureCcpsProfileRule(
        resolveInside(plan.claudeHomePath, 'rules', 'ccps-profile.md'),
      );

      // Transition to launching state
      setLifecycle((prev) => ({
        ...prev,
        launch: { ...prev.launch, phase: 'launching' },
      }));

      // Persist selection across remount
      persistedSelection.current = selectedIndex;

      // Call the external launch handler (which unmounts Ink, spawns, remounts)
      // or fall back to workbenchLaunchSync for the real spawn
      if (onLaunch) {
        const exitCode = onLaunch(plan, appHomePath);
        setLifecycle((prev) => ({
          ...prev,
          launch: { ...prev.launch, phase: 'exited', exitCode },
        }));
      }
      // When onLaunch is not provided, the Workbench entry (index.mts)
      // handles the unmount-spawn-remount cycle.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLifecycle((prev) => ({
        ...prev,
        launch: {
          ...prev.launch,
          phase: 'bar', // stay in bar on error
          validationFindings: [
            { severity: 'error' as const, code: 'LAUNCH_FAILED', message },
          ],
        },
      }));
    }
  }, [lifecycle, selectedIndex, onLaunch]);

  const onLifecycleAction = useCallback((action: LifecycleAction) => {
    setLifecycle((prev) => lifecycleReducer(prev, action));
  }, []);

  const handleLifecycleAction = useCallback(async (
    action: LifecycleAction,
    profileName: string,
    input: string,
    selectedTemplate: string | null,
  ) => {
    if (action.type !== 'SUBMIT' && action.type !== 'START_IMMEDIATE') return;

    const appHomePath = getAppHomePaths().appHomePath;
    // For SUBMIT actions, kind comes from the current lifecycle state
    const kind = (action.type === 'START_IMMEDIATE' ? action.kind : lifecycle.kind) as LifecyclePromptKind;

    try {
      if (kind === 'create') {
        await createProfile({
          appHomePath,
          name: input,
          template: (selectedTemplate ?? 'general') as ProfileTemplateName,
        });
        setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: `"${input}" ${t('lifecycle.success.created')}` }));
      } else if (kind === 'copy') {
        await copyProfile({ appHomePath, from: profileName, to: input });
        setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: `${t('lifecycle.success.copiedTo')} "${input}"` }));
      } else if (kind === 'rename') {
        await renameProfile({ appHomePath, oldName: profileName, newName: input });
        setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: `${t('lifecycle.success.renamedTo')} "${input}"` }));
      } else if (kind === 'remove') {
        await removeProfile({ appHomePath, name: profileName, confirmation: input });
        setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: `"${profileName}" ${t('lifecycle.success.removed')}` }));
      } else if (kind === 'default') {
        const profile = workbenchData.profiles.find((p) => p.name === profileName);
        if (profile?.isDefault) {
          await clearDefaultProfile({ appHomePath });
          setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: t('lifecycle.default.cleared') }));
        } else {
          await setDefaultProfile({ appHomePath, name: profileName });
          setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: t('lifecycle.default.set') }));
        }
      } else if (kind === 'validate') {
        const result = await validateProfile({ appHomePath, name: profileName });
        const findings = result.findings.map((f) => ({
          severity: f.severity,
          code: f.code,
          message: f.message,
        }));
        setLifecycle((prev) => lifecycleReducer(prev, { type: 'SET_FINDINGS', findings }));
        if (findings.length === 0) {
          setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: t('lifecycle.success.valid') }));
        } else {
          const errorCount = findings.filter((f) => f.severity === 'error').length;
          const warningCount = findings.filter((f) => f.severity === 'warning').length;
          setLifecycle((prev) => lifecycleReducer(prev, {
            type: 'EXECUTE_SUCCESS',
            message: `${errorCount} ${t('lifecycle.findings.errors')}, ${warningCount} ${t('lifecycle.findings.warnings')}`,
          }));
        }
      } else if (kind === 'backup') {
        await backupProfile({ appHomePath, name: profileName });
        setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: `"${profileName}" ${t('lifecycle.success.backedUp')}` }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_ERROR', message }));
      return;
    }

    // Refresh data after any mutation
    if (kind !== 'validate') {
      try {
        const freshData = await loadWorkbenchData(appHomePath);
        setWorkbenchData(freshData);
        // Clamp selectedIndex if profiles were removed
        setSelectedIndex((prev) => Math.min(prev, Math.max(0, freshData.profiles.length - 1)));
      } catch {
        // refresh failure is non-fatal
      }
    }
  }, [workbenchData, t, lifecycle.kind]);

  // Launch action handlers
  const handleLaunchBar = useCallback(async (profileName: string) => {
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
      const result = await validateProfile({ appHomePath, name: profileName });
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
  }, []);

  const handleLaunchDirScreen = useCallback(async (profileName: string) => {
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
  }, [handleLaunchBar]);

  const handleLaunchDryRun = useCallback(async (profileName: string) => {
    const appHomePath = getAppHomePaths().appHomePath;
    try {
      const plan = await buildLaunchPlan({
        appHomePath,
        profileName,
        cwd: lifecycle.launch.dir,
      });
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
  }, [lifecycle.launch.dir]);

  // Skill install wizard (issue #64, spec §7.2). The wizard overlay drives a
  // 3-step flow: pick a Local Skill Source, choose Copy (default) or Link,
  // then confirm over a target-change preview with health checks.
  const handleAddSkill = useCallback((profileName: string) => {
    setWizardProfileName(profileName);
  }, []);

  const wizardCallbacks = useMemo(
    () => ({
      onResolveSource: async (sourceInput: string) =>
        validateLocalSkillSource(sourceInput),
      onComputePreview: async (input: {
        sourcePath: string;
        mode: 'copy' | 'link';
        name: string;
      }) => {
        const appHomePath = getAppHomePaths().appHomePath;
        const { profilesPath } = getAppHomePaths(appHomePath);
        const profileRootPath = path.join(profilesPath, wizardProfileName!);
        return previewInstall({
          profileRootPath,
          sourcePath: input.sourcePath,
          mode: input.mode,
          name: input.name,
        });
      },
      onInstall: async (input: {
        sourcePath: string;
        mode: 'copy' | 'link';
        name: string;
        collisionResolution?: 'rename' | 'replace';
      }) => {
        const appHomePath = getAppHomePaths().appHomePath;
        const { profilesPath } = getAppHomePaths(appHomePath);
        const profileRootPath = path.join(profilesPath, wizardProfileName!);
        return installLocalSkill({
          appHomePath,
          profileName: wizardProfileName!,
          profileRootPath,
          sourcePath: input.sourcePath,
          mode: input.mode,
          name: input.name,
          collisionResolution: input.collisionResolution,
        });
      },
      onClose: () => setWizardProfileName(null),
      onInstalled: () => {
        // Refresh data so the Skills count updates after a successful install.
        const appHomePath = getAppHomePaths().appHomePath;
        loadWorkbenchData(appHomePath)
          .then((freshData) => setWorkbenchData(freshData))
          .catch(() => {
            // refresh failure is non-fatal
          });
      },
    }),
    [wizardProfileName],
  );

  const sidebarWidth = Math.max(26, Math.floor(width * 0.3));
  const mainWidth = width - sidebarWidth - 2;
  const selectedProfile: WorkbenchProfile | undefined = workbenchData.profiles[selectedIndex] ?? undefined;

  // Render launch overlays
  const launchOverlay = renderLaunchOverlay(lifecycle.launch, width, height);

  // The install wizard overlay takes priority over the launch overlay and the
  // main workbench surface.
  const wizardOverlay =
    wizardOpen && wizardProfileName
      ? React.createElement(InstallWizard, {
          profileName: wizardProfileName,
          callbacks: wizardCallbacks,
          width,
          height,
          headless,
        })
      : null;

  const inner = React.createElement(
    CaptureContext.Provider,
    { value: setCapture },
    React.createElement(
      Box,
      { flexDirection: 'column', width, height },
      welcomeVisible
        ? React.createElement(WelcomeCard, { width, height })
        : wizardOverlay
          ? wizardOverlay
          : launchOverlay
            ? launchOverlay
            : React.createElement(
                Box,
                { flexDirection: 'row', flexGrow: 1 },
                React.createElement(Sidebar, {
                  profiles: workbenchData.profiles,
                  selectedIndex,
                  onSelect: setSelectedIndex,
                  width: sidebarWidth,
                  height: height - 1,
                  capture: capture || mainPaneFocus,
                  headless,
                  lifecycle,
                  wizardOpen,
                  onLifecycleAction,
                  onAction: handleLifecycleAction,
                  onLaunchBar: handleLaunchBar,
                  onLaunchDirScreen: handleLaunchDirScreen,
                  onAddSkill: handleAddSkill,
                }),
                drillDown.kind === 'autoMemory' && selectedProfile
                  ? React.createElement(AutoMemoryView, {
                      profile: selectedProfile,
                      appHomePath: getAppHomePaths().appHomePath,
                      profileNames: workbenchData.profiles.map((p) => p.name),
                      width: mainWidth,
                      height: height - 1,
                      editSessionManager,
                      onBack: handleExitDrillDown,
                    })
                  : React.createElement(MainPane, {
                      profile: selectedProfile,
                      width: mainWidth,
                      height: height - 1,
                      focused: mainPaneFocus,
                      selectedCategoryIndex,
                    }),
              ),
      React.createElement(
        Box,
        { width, justifyContent: 'space-between' },
        React.createElement(
          Text,
          { dimColor: true },
          ` ${locale === 'zh' ? 'zh' : 'en'} │ ? ${t('keymap.help')} │ q ${t('app.quit')}` +
            (mainPaneFocus ? ` │ ${t('main.backToList')}` : (drillDown.kind === 'none' && workbenchData.profiles.length > 0 ? ` │ ${t('main.focusHint')}` : '')),
        ),
        React.createElement(Text, { dimColor: true }, `${width}×${height} `),
      ),
    ),
    helpVisible && React.createElement(KeymapOverlay, { visible: true }),
  );

  return React.createElement(ResizeGuard, { width, height, children: inner });

  function renderLaunchOverlay(launch: LaunchState, w: number, h: number): React.ReactElement | null {
    if (launch.phase === 'idle' || launch.phase === 'launching') return null;

    if (launch.phase === 'bar') {
      return React.createElement(PreLaunchBar, { launch, width: w, profileName: lifecycle.profileName });
    }

    if (launch.phase === 'dir-screen') {
      return React.createElement(DirectoryScreen, { launch, width: w, height: h });
    }

    if (launch.phase === 'dry-run' && launch.dryRunPlan) {
      return React.createElement(DryRunPage, { plan: launch.dryRunPlan, width: w, height: h });
    }

    if (launch.phase === 'exited') {
      const code = launch.exitCode;
      const msg = code === 0
        ? t('launch.exited.zero')
        : t('launch.exited').replace('{code}', String(code));
      return React.createElement(
        Box,
        { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width: w, height: h },
        React.createElement(
          Box,
          { borderStyle: 'round', paddingX: 2, paddingY: 1 },
          React.createElement(Text, { bold: true, color: code === 0 ? 'green' : 'yellow' }, msg),
        ),
        React.createElement(Box, { marginTop: 1 },
          React.createElement(Text, { dimColor: true }, t('keymap.esc')),
        ),
      );
    }

    return null;
  }
}

function WelcomeCard({ width, height }: { width: number; height: number }): React.ReactElement {
  const { t } = useI18n();

  return React.createElement(
    Box,
    { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width, height },
    React.createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'round', paddingX: 2, paddingY: 1 },
      React.createElement(Text, { bold: true }, t('welcome.title')),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, null, t('welcome.line1')),
      ),
      React.createElement(Text, null, t('welcome.line2')),
      React.createElement(Text, null, t('welcome.line3')),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { dimColor: true }, t('welcome.dismiss')),
      ),
    ),
  );
}
