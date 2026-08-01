import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  ensureProfileClaudeMdExcludes,
  ensureCcpsProfileRule,
  getProfileTemplatePaths,
  type ProfileTemplateName,
} from '../../core/profile-template';
import {
  installLocalSkill,
  previewInstall,
  validateLocalSkillSource,
} from '../../core/skills-install';
import {
  acquireAndPreviewRemoteInstall,
  installRemoteSkill,
} from '../../core/skills-remote-install';
import fs from 'fs-extra';
import { resolveInside } from '../../platform/path';
import { CcpsError } from '../../utils/errors';
import { listMcpServers, type McpServerState } from '../../core/mcp-list';
import { I18nProvider, useI18n } from './i18n/react';
import type { Locale } from './i18n/react';
import { CaptureProvider } from './capture-context';
import { EditSessionManager, type EditSession } from '../../core/edit-session';
import {
  readUserMemoryContent,
  readAgentContent,
  createUserMemory,
  createAgent,
  removeUserMemory,
  removeAgent,
  copyUserMemoryToProfile,
  copyAgentToProfile,
  updateAgentFrontmatter,
  diffUserMemory,
  diffAgents,
  searchAllResources,
  type UserMemoryDiff,
  type AgentsDiff,
  type AgentFrontmatter,
  type SearchResult,
} from '../../core/resource';
import {
  initialResourceNavState,
  resourceNavReducer,
  type ResourceNavAction,
  type ResourceNavState,
} from './resource-nav';
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
import { ErrorPanel, HintsProvider, RemoveProfilePanel, useHints } from './guidance';

type DrillDown = { kind: 'none' } | { kind: 'autoMemory' };

// The welcome card is once-per-session: this module-level flag survives the
// unmount/remount cycle of a launch resume, so the card never reappears
// mid-session (issue #76 §5).
let sessionWelcomeShown = false;

/** Test-only: reset the once-per-session welcome flag for a fresh render. */
export function resetWelcomeSessionForTests(): void {
  sessionWelcomeShown = false;
}

type WorkbenchAppProps = {
  data: WorkbenchData;
  onLocaleChange?: (locale: Locale) => void;
  initialLocale?: Locale;
  headless?: boolean;
  skipWelcome?: boolean;
  /** Called when the Workbench needs to unmount, spawn Claude, and remount. */
  onLaunch?: (plan: LaunchPlan, appHomePath: string) => number | null;
  /** Override the MCP connection-state probe (tests). */
  mcpProbe?: (appHomePath: string, profileName: string) => Promise<McpServerState[]>;
};

export function WorkbenchApp({ data, onLocaleChange, initialLocale, headless, skipWelcome, onLaunch, mcpProbe }: WorkbenchAppProps): React.ReactElement {
  const inner = React.createElement(WorkbenchInner, { data, headless, skipWelcome, onLaunch, mcpProbe });
  return React.createElement(
    I18nProvider,
    { initialLocale, onLocaleChange },
    React.createElement(HintsProvider, null, inner),
  );
}

function WorkbenchInner({ data, headless, skipWelcome, onLaunch, mcpProbe }: { data: WorkbenchData; headless?: boolean; skipWelcome?: boolean; onLaunch?: (plan: LaunchPlan, appHomePath: string) => number | null; mcpProbe?: (appHomePath: string, profileName: string) => Promise<McpServerState[]> }): React.ReactElement {
  const { t, locale } = useI18n();
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin: inkStdin } = useStdin();
  const { markUsed } = useHints();

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [helpVisible, setHelpVisible] = useState(false);
  const [capture, setCapture] = useState(false);
  const [welcomeVisible, setWelcomeVisible] = useState(() => {
    if (skipWelcome) return false;
    if (sessionWelcomeShown) return false;
    sessionWelcomeShown = true;
    return true;
  });
  const [, forceRerender] = useState(0);
  const [workbenchData, setWorkbenchData] = useState(data);
  const [lifecycle, setLifecycle] = useState(initialLifecycleState);
  // Skill install wizard overlay (issue #64, spec §7.2)
  const [wizardProfileName, setWizardProfileName] = useState<string | null>(null);
  // Main-pane category focus + resource-row drill-down (issue #69)
  const [mainPaneFocus, setMainPaneFocus] = useState(false);
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
  const [drillDown, setDrillDown] = useState<DrillDown>({ kind: 'none' });
  // User Memory / Agents resource rows (issue #60)
  const [resourceNav, setResourceNav] = useState<ResourceNavState>(initialResourceNavState);
  const [resourceContent, setResourceContent] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<UserMemoryDiff | AgentsDiff | null>(null);
  const [drilledAgent, setDrilledAgent] = useState<string | null>(null);
  const [agentFrontmatter, setAgentFrontmatter] = useState<AgentFrontmatter | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [flashMessage, setFlashMessage] = useState('');
  const [mcpFailedByProfile, setMcpFailedByProfile] = useState<Record<string, string[]>>({});
  // Persisted selection across launch remount
  const persistedSelection = useRef(selectedIndex);
  const sessionManagerRef = useRef(
    new EditSessionManager({
      onChange: () => forceRerender((n: number) => n + 1),
    }),
  );

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

  // Just-in-time MCP nudge: probe the selected Profile's MCP connection state
  // once per session (cached by profile name), fail closed on any error.
  useEffect(() => {
    const profile = workbenchData.profiles[selectedIndex];
    if (!profile || (profile.mcpServers?.length ?? 0) === 0) return;
    if (mcpFailedByProfile[profile.name]) return; // already probed this session

    let cancelled = false;
    const probe = mcpProbe ?? ((appHomePath: string, name: string) => listMcpServers({ appHomePath, profileName: name }));
    (async () => {
      try {
        const states = await probe(getAppHomePaths().appHomePath, profile.name);
        if (cancelled) return;
        const failed = states.filter((s) => s.failed).map((s) => s.name);
        setMcpFailedByProfile((prev) => ({ ...prev, [profile.name]: failed }));
      } catch {
        // fail closed — no nudge
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedIndex, workbenchData.profiles, mcpFailedByProfile, mcpProbe]);

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
        setCapture(false);
      }
      return;
    }

    if (capture) return;

    // The install wizard owns its own input; let it handle everything else.
    if (wizardOpen) return;

    // Resource navigation input handling
    if (resourceNav.phase !== 'idle') {
      handleResourceInput(input, key);
      return;
    }

    // Grid: drill into User Memory or Agents categories
    if (input === 'u') {
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_CATEGORY', category: 'user-memory' }));
      setResourceContent(null);
      setDiffResult(null);
      setDrilledAgent(null);
      setAgentFrontmatter(null);
      return;
    }
    if (input === 'a') {
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_CATEGORY', category: 'agents' }));
      setResourceContent(null);
      setDiffResult(null);
      setDrilledAgent(null);
      setAgentFrontmatter(null);
      return;
    }

    // Destructive-action panel input (§9.1)
    if (lifecycle.phase === 'confirm') {
      handleConfirmInput(input, key);
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }
    if (input === '?') {
      markUsed('?');
      setCapture(true); // the full-pane help sheet owns all input while open
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

  // ─── Resource navigation helpers ──────────────────────────────────────

  const appHomePath = getAppHomePaths().appHomePath;

  const currentProfile = (): WorkbenchProfile | undefined => workbenchData.profiles[selectedIndex];

  const resourceFilePath = (
    profileName: string,
    category: 'user-memory' | 'agents',
    resourceName: string,
  ): string => {
    const paths = getProfileTemplatePaths(appHomePath, profileName);
    if (category === 'user-memory') return paths.claudeMdPath;
    return resolveInside(paths.agentsPath, `${resourceName}.md`);
  };

  const selectedResourceName = (profile: WorkbenchProfile, category: 'user-memory' | 'agents'): string => {
    if (category === 'user-memory') return 'CLAUDE.md';
    const agent = profile.resourceDetails.agents[resourceNav.selectedIndex];
    return agent?.name ?? 'agent';
  };

  const sessionFor = (resourceName: string): EditSession | undefined => {
    const profile = currentProfile();
    if (!profile || !resourceNav.category) return undefined;
    const filePath = resourceFilePath(profile.name, resourceNav.category, resourceName);
    return sessionManagerRef.current.getSession(filePath);
  };

  const flash = useCallback((message: string) => {
    setFlashMessage(message);
    setTimeout(() => setFlashMessage(''), 2500);
  }, []);

  const refreshData = useCallback(async () => {
    try {
      const freshData = await loadWorkbenchData(appHomePath);
      setWorkbenchData(freshData);
    } catch {
      // refresh failure is non-fatal
    }
  }, [appHomePath]);

  const openPreview = useCallback(async () => {
    const profile = currentProfile();
    if (!profile || !resourceNav.category) return;
    const category = resourceNav.category;
    const resourceName = selectedResourceName(profile, category);
    const appHome = getAppHomePaths().appHomePath;

    let content: string | null = null;
    if (category === 'agents') {
      content = await readAgentContent(appHome, profile.name, resourceName);
    } else {
      content = await readUserMemoryContent(appHome, profile.name);
    }
    setResourceContent(content);
    setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_PREVIEW' }));
  }, [resourceNav, selectedIndex, workbenchData]);

  const editSelectedResource = useCallback(async () => {
    const profile = currentProfile();
    if (!profile || !resourceNav.category) return;
    const resourceName = selectedResourceName(profile, resourceNav.category);
    const filePath = resourceFilePath(profile.name, resourceNav.category, resourceName);

    try {
      await sessionManagerRef.current.open(filePath);
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [resourceNav, selectedIndex, workbenchData, flash]);

  const removeSelectedResource = useCallback(async () => {
    const profile = currentProfile();
    if (!profile || !resourceNav.category) return;
    const category = resourceNav.category;
    const resourceName = selectedResourceName(profile, category);
    const appHome = getAppHomePaths().appHomePath;

    try {
      if (category === 'agents') {
        await removeAgent(appHome, profile.name, resourceName);
      } else {
        await removeUserMemory(appHome, profile.name);
      }
      sessionManagerRef.current.endSession(resourceFilePath(profile.name, category, resourceName));
      flash(
        category === 'agents'
          ? t('resource.agents.removed').replace('{name}', resourceName)
          : t('resource.userMemory.removed'),
      );
      await refreshData();
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [resourceNav, selectedIndex, workbenchData, refreshData, flash, t]);

  const openDiff = useCallback(async (profileOverride?: string) => {
    const profile = currentProfile();
    if (!profile || !resourceNav.category) return;
    const category = resourceNav.category;
    const appHome = getAppHomePaths().appHomePath;

    const others = workbenchData.profiles.map((p) => p.name).filter((n) => n !== profile.name);
    if (others.length === 0) {
      flash(t('resource.diff.noOtherProfile'));
      return;
    }
    const counterpart = profileOverride ?? resourceNav.diffProfile ?? others[0];

    try {
      let result: UserMemoryDiff | AgentsDiff;
      if (category === 'agents') {
        result = await diffAgents(appHome, profile.name, counterpart);
      } else {
        result = await diffUserMemory(appHome, profile.name, counterpart);
      }
      setDiffResult(result);
      setDrilledAgent(null);
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_DIFF' }));
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [resourceNav, selectedIndex, workbenchData, flash, t]);

  const openAgentEdit = useCallback(() => {
    const profile = currentProfile();
    if (!profile || resourceNav.category !== 'agents') return;
    const agent = profile.resourceDetails.agents[resourceNav.selectedIndex];
    setAgentFrontmatter(agent?.frontmatter ?? null);
    setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_AGENT_EDIT' }));
  }, [resourceNav, selectedIndex, workbenchData]);

  const saveAgentFrontmatter = useCallback(async (updates: Partial<AgentFrontmatter>) => {
    const profile = currentProfile();
    if (!profile || resourceNav.category !== 'agents') return;
    const resourceName = selectedResourceName(profile, 'agents');
    const filePath = resourceFilePath(profile.name, 'agents', resourceName);
    const appHome = getAppHomePaths().appHomePath;

    // Dual-channel block: refuse Workbench writes while VS Code holds the file.
    if (sessionManagerRef.current.isFileUnderSession(filePath)) {
      flash(t('resource.agent.frontmatter.blocked'));
      return;
    }

    try {
      await updateAgentFrontmatter(appHome, profile.name, resourceName, updates);
      flash(t('resource.agent.frontmatter.saved'));
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'BACK' }));
      await refreshData();
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [resourceNav, selectedIndex, workbenchData, refreshData, flash, t]);

  const confirmCopy = useCallback(async () => {
    const profile = currentProfile();
    if (!profile || !resourceNav.category || !resourceNav.targetProfile) return;
    const category = resourceNav.category;
    const resourceName = selectedResourceName(profile, category);
    const target = resourceNav.targetProfile;
    const appHome = getAppHomePaths().appHomePath;

    try {
      if (category === 'agents') {
        await copyAgentToProfile(appHome, profile.name, target, resourceName);
      } else {
        await copyUserMemoryToProfile(appHome, profile.name, target);
      }
      flash(t('resource.copy.success').replace('{profile}', target));
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
      await refreshData();
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [resourceNav, selectedIndex, workbenchData, refreshData, flash, t]);

  // Agent-creation name prompt state
  const [promptingAgentName, setPromptingAgentName] = useState(false);
  const [agentNameDraft, setAgentNameDraft] = useState('');

  const startCreateAgent = useCallback(() => {
    setAgentNameDraft('');
    setPromptingAgentName(true);
  }, []);

  const submitCreateAgent = useCallback(async () => {
    const profile = currentProfile();
    if (!profile) return;
    const appHome = getAppHomePaths().appHomePath;
    const name = agentNameDraft.trim();

    setPromptingAgentName(false);
    if (!name) return;

    try {
      const filePath = await createAgent(appHome, profile.name, name);
      flash(t('resource.agents.createSuccess').replace('{name}', name));
      await refreshData();
      // Hand off the new agent body to VS Code (spec S36).
      sessionManagerRef.current.open(filePath);
      // Return to the agents list so the new row is visible.
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_CATEGORY', category: 'agents' }));
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [agentNameDraft, refreshData, flash, t]);

  const recreateUserMemory = useCallback(async () => {
    const profile = currentProfile();
    if (!profile) return;
    const appHome = getAppHomePaths().appHomePath;

    try {
      await createUserMemory(appHome, profile.name);
      flash(t('resource.userMemory.recreated'));
      await refreshData();
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [selectedIndex, workbenchData, refreshData, flash, t]);

  const runSearch = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const appHome = getAppHomePaths().appHomePath;
    try {
      const results = await searchAllResources({ appHomePath: appHome, query: q });
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    }
  }, []);

  const jumpToSearchHit = useCallback(async (hit: SearchResult) => {
    const profileIndex = workbenchData.profiles.findIndex((p) => p.name === hit.profileName);
    if (profileIndex >= 0) setSelectedIndex(profileIndex);

    const appHome = getAppHomePaths().appHomePath;
    let content: string | null = null;
    if (hit.category === 'agents') {
      content = await readAgentContent(appHome, hit.profileName, hit.itemName);
    } else {
      content = await readUserMemoryContent(appHome, hit.profileName);
    }
    setResourceContent(content);
    setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
    setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_CATEGORY', category: hit.category }));

    // Position the list selection on the hit's own row so preview/actions
    // operate on the matched item, not the first one in the list.
    if (hit.category === 'agents') {
      const targetProfile = workbenchData.profiles[profileIndex];
      const itemIndex = targetProfile?.resourceDetails.agents.findIndex((a) => a.name === hit.itemName);
      if (itemIndex !== undefined && itemIndex >= 0) {
        setResourceNav((prev) => resourceNavReducer(prev, { type: 'SET_SELECTED_INDEX', index: itemIndex }));
      }
    }

    setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_PREVIEW' }));
  }, [workbenchData]);

  const handleResourceInput = useCallback((input: string, key: Record<string, boolean>) => {
    const profile = currentProfile();
    if (!profile) return;
    const nav = resourceNav;
    const category = nav.category;

    // Agent-name creation prompt input
    if (promptingAgentName) {
      if (key.escape) {
        setPromptingAgentName(false);
        return;
      }
      if (key.return) {
        submitCreateAgent();
        return;
      }
      if (key.backspace || key.delete) {
        setAgentNameDraft((d) => d.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        setAgentNameDraft((d) => d + input);
      }
      return;
    }

    const dispatchNav = (action: ResourceNavAction) =>
      setResourceNav((prev) => resourceNavReducer(prev, action));

    // Cross-Profile resource search phase
    if (nav.phase === 'search') {
      if (key.escape) {
        dispatchNav({ type: 'BACK' });
        return;
      }
      if (key.return) {
        const hit = searchResults[nav.searchSelectedIndex];
        if (hit) {
          jumpToSearchHit(hit);
        }
        return;
      }
      if (key.upArrow) {
        dispatchNav({ type: 'SEARCH_NAV_UP' });
        return;
      }
      if (key.downArrow) {
        dispatchNav({ type: 'SEARCH_NAV_DOWN' });
        return;
      }
      if (key.backspace || key.delete) {
        const nextQuery = nav.searchQuery.slice(0, -1);
        dispatchNav({ type: 'SEARCH_BACKSPACE' });
        runSearch(nextQuery);
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        const nextQuery = nav.searchQuery + input;
        dispatchNav({ type: 'SEARCH_INPUT', char: input });
        runSearch(nextQuery);
        return;
      }
      return;
    }

    // List phase
    if (nav.phase === 'list' && category) {
      const itemCount =
        category === 'agents'
          ? profile.resourceDetails.agents.length
          : profile.resourceDetails.userMemory.exists
            ? 1
            : 0;

      if (key.upArrow) {
        dispatchNav({ type: 'NAV_UP' });
        return;
      }
      if (key.downArrow) {
        if (nav.selectedIndex < itemCount - 1) dispatchNav({ type: 'NAV_DOWN' });
        return;
      }
      if (key.escape) {
        dispatchNav({ type: 'CLOSE' });
        setResourceContent(null);
        setDiffResult(null);
        setDrilledAgent(null);
        return;
      }
      if (input === '/') {
        dispatchNav({ type: 'OPEN_SEARCH' });
        setSearchResults([]);
        return;
      }
      if (key.return && itemCount > 0) {
        openPreview();
        return;
      }
      if (input === 'e' && itemCount > 0) {
        editSelectedResource();
        return;
      }
      if (input === 'x' && itemCount > 0) {
        removeSelectedResource();
        return;
      }
      if (input === 'c' && itemCount > 0) {
        dispatchNav({ type: 'OPEN_COPY' });
        return;
      }
      if (input === 'd' && itemCount > 0) {
        openDiff();
        return;
      }
      if (category === 'agents' && input === 'a') {
        startCreateAgent();
        return;
      }
      if (category === 'agents' && input === 'f' && itemCount > 0) {
        openAgentEdit();
        return;
      }
      if (category === 'user-memory' && !profile.resourceDetails.userMemory.exists && input === 'n') {
        recreateUserMemory();
        return;
      }
      return;
    }

    // Preview phase
    if (nav.phase === 'preview') {
      if (key.escape) {
        dispatchNav({ type: 'BACK' });
        return;
      }
      if (key.upArrow) {
        dispatchNav({ type: 'SCROLL_UP' });
        return;
      }
      if (key.downArrow) {
        dispatchNav({ type: 'SCROLL_DOWN' });
        return;
      }
      if (input === 'e') {
        editSelectedResource();
        return;
      }
      if (input === 'x') {
        removeSelectedResource();
        return;
      }
      if (input === 'c') {
        dispatchNav({ type: 'OPEN_COPY' });
        return;
      }
      if (input === 'd') {
        openDiff();
        return;
      }
      return;
    }

    // Diff phase
    if (nav.phase === 'diff' && category) {
      const others = workbenchData.profiles.map((p) => p.name).filter((n) => n !== profile.name);
      if (others.length === 0) return;

      if (key.escape) {
        dispatchNav({ type: 'BACK' });
        setDiffResult(null);
        setDrilledAgent(null);
        return;
      }
      if (key.upArrow) {
        const idx = others.indexOf(nav.diffProfile ?? others[0]);
        const next = others[(idx - 1 + others.length) % others.length];
        dispatchNav({ type: 'SET_DIFF_PROFILE', profile: next });
        openDiff(next);
        return;
      }
      if (key.downArrow) {
        const idx = others.indexOf(nav.diffProfile ?? others[0]);
        const next = others[(idx + 1) % others.length];
        dispatchNav({ type: 'SET_DIFF_PROFILE', profile: next });
        openDiff(next);
        return;
      }
      if (key.return && category === 'agents' && diffResult && 'files' in diffResult) {
        const changed = diffResult.files.filter((f) => f.verdict === 'changed');
        if (changed.length === 0) return;
        // Enter cycles through the changed files; wrapping around closes drill-in.
        if (drilledAgent === null) {
          setDrilledAgent(changed[0].name);
        } else {
          const idx = changed.findIndex((f) => f.name === drilledAgent);
          const nextIdx = (idx + 1) % changed.length;
          setDrilledAgent(nextIdx === 0 ? null : changed[nextIdx].name);
        }
        return;
      }
      return;
    }

    // Copy phase
    if (nav.phase === 'copy') {
      const targets = workbenchData.profiles.map((p) => p.name).filter((n) => n !== profile.name);
      if (key.escape) {
        dispatchNav({ type: 'BACK' });
        return;
      }
      if (key.upArrow) {
        const idx = targets.indexOf(nav.targetProfile ?? targets[0]);
        const next = targets[(idx - 1 + targets.length) % targets.length];
        dispatchNav({ type: 'SET_TARGET_PROFILE', profile: next });
        return;
      }
      if (key.downArrow) {
        const idx = targets.indexOf(nav.targetProfile ?? targets[0]);
        const next = targets[(idx + 1) % targets.length];
        dispatchNav({ type: 'SET_TARGET_PROFILE', profile: next });
        return;
      }
      if (key.return && nav.targetProfile) {
        confirmCopy();
        return;
      }
      return;
    }
  }, [resourceNav, selectedIndex, workbenchData, promptingAgentName, agentNameDraft, openPreview, editSelectedResource, removeSelectedResource, openDiff, confirmCopy, openAgentEdit, saveAgentFrontmatter, startCreateAgent, submitCreateAgent, recreateUserMemory, runSearch, jumpToSearchHit, searchResults]);

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
    if (action.type !== 'SUBMIT' && action.type !== 'START_IMMEDIATE' && action.type !== 'CONFIRM_CHOICE') return;

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
        // Workbench removal follows §9.1 (graduated options, no exact-name
        // typing): [y] backup default, [u] no-backup → Recovery Bin.
        const noBackup = input === 'u';
        await removeProfile({ appHomePath, name: profileName, confirmation: profileName, noBackup });
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
      const code = error instanceof CcpsError ? error.code : undefined;
      const guidance = error instanceof CcpsError ? error.guidance : undefined;
      setLifecycle((prev) => lifecycleReducer(prev, { type: 'EXECUTE_ERROR', message, code, guidance }));
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

  const handleConfirmInput = useCallback((input: string, key: Record<string, boolean>) => {
    if (key.escape) {
      setLifecycle((prev) => lifecycleReducer(prev, { type: 'CANCEL' }));
      return;
    }
    if (input === 'y') {
      confirmRemove(false);
      return;
    }
    if (input === 'u') {
      confirmRemove(true);
      return;
    }
  }, [lifecycle, handleLifecycleAction]);

  const confirmRemove = useCallback((noBackup: boolean) => {
    setLifecycle((prev) => lifecycleReducer(prev, { type: 'CONFIRM_CHOICE' }));
    void handleLifecycleAction(
      { type: 'CONFIRM_CHOICE' },
      lifecycle.profileName,
      noBackup ? 'u' : 'y',
      null,
    );
  }, [lifecycle, handleLifecycleAction]);

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
      onAcquireRemote: async (input: { rawSource: string }) => {
        const appHomePath = getAppHomePaths().appHomePath;
        const { profilesPath } = getAppHomePaths(appHomePath);
        const profileRootPath = path.join(profilesPath, wizardProfileName!);
        return acquireAndPreviewRemoteInstall({
          appHomePath,
          profileName: wizardProfileName!,
          profileRootPath,
          rawSource: input.rawSource,
          // name omitted: derived from the staged Skill's directory name
          // (its frontmatter name) — the remote wizard has no name-input step.
        });
      },
      onInstallRemote: async (input: {
        stagingRoot: string;
        stagedName: string;
        name: string;
        provenanceSource: RemoteInstallPreview['provenanceSource'];
        collisionResolution?: 'rename' | 'replace';
      }) => {
        const appHomePath = getAppHomePaths().appHomePath;
        const { profilesPath } = getAppHomePaths(appHomePath);
        const profileRootPath = path.join(profilesPath, wizardProfileName!);
        return installRemoteSkill({
          appHomePath,
          profileName: wizardProfileName!,
          profileRootPath,
          name: input.name,
          stagingRoot: input.stagingRoot,
          stagedName: input.stagedName,
          provenanceSource: input.provenanceSource,
          collisionResolution: input.collisionResolution,
        });
      },
      onCleanupStaging: (stagingRoot: string) => {
        fs.remove(stagingRoot).catch(() => {
          // cleanup failure is non-fatal
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

  // Dispose edit sessions on unmount (after launch remount or app quit).
  useEffect(() => {
    const sessionManager = sessionManagerRef.current;
    return () => {
      sessionManager.dispose();
    };
  }, []);

  // Resource view hint line (contextual guidance).
  const resourceHintLine = resourceNav.phase === 'list'
    ? resourceNav.category === 'agents'
      ? `${t('resource.list.hint')}  [a] create  [f] frontmatter`
      : resourceNav.category === 'user-memory' && selectedProfile && !selectedProfile.resourceDetails.userMemory.exists
        ? t('resource.userMemory.missing')
        : t('resource.list.hint')
    : resourceNav.phase === 'preview' || resourceNav.phase === 'diff' || resourceNav.phase === 'copy'
      ? t('resource.list.hint')
      : '';

  const mcpFailed = selectedProfile ? (mcpFailedByProfile[selectedProfile.name] ?? []) : [];

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
    CaptureProvider,
    { value: setCapture },
    React.createElement(
      Box,
      { flexDirection: 'column', width, height },
      welcomeVisible
        ? React.createElement(WelcomeCard, { width, height })
        : helpVisible
          ? React.createElement(KeymapOverlay, { visible: true })
          : wizardOverlay
            ? wizardOverlay
          : launchOverlay
            ? launchOverlay
            : React.createElement(
                Box,
                { flexDirection: 'column', flexGrow: 1 },
                React.createElement(
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
                    resourceNavActive: resourceNav.phase !== 'idle',
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
                        profiles: workbenchData.profiles,
                        nav: resourceNav,
                        mcpFailed,
                        width: mainWidth,
                        height: height - 1,
                        focused: mainPaneFocus,
                        selectedCategoryIndex,
                        sessionFor,
                        content: resourceContent,
                        diff: diffResult,
                        drilledAgent,
                        agentFrontmatter,
                        searchResults,
                        onSaveFrontmatter: saveAgentFrontmatter,
                        onBack: () => setResourceNav((prev) => resourceNavReducer(prev, { type: 'BACK' })),
                        hintLine: resourceHintLine,
                      }),
                ),
                renderGuidanceDialogs(),
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
        flashMessage
          ? React.createElement(Text, { color: 'green', wrap: 'truncate' }, flashMessage)
          : React.createElement(Text, { dimColor: true }, `${width}×${height} `),
      ),
    ),
  );

  return React.createElement(ResizeGuard, { width, height, children: inner });

  // Guidance dialogs: full-width, flexShrink=0 so they never shrink-clip (#29).
  function renderGuidanceDialogs(): React.ReactElement | null {
    if (lifecycle.phase === 'confirm' && selectedProfile) {
      return React.createElement(RemoveProfilePanel, { profile: selectedProfile });
    }
    if (lifecycle.phase === 'error') {
      return React.createElement(ErrorPanel, {
        message: lifecycle.message,
        code: lifecycle.errorCode,
        guidance: lifecycle.guidance,
      });
    }
    if (lifecycle.phase === 'success') {
      return React.createElement(
        Box,
        { flexShrink: 0, paddingX: 1 },
        React.createElement(Text, { color: 'green' }, `✓ ${lifecycle.message}`),
      );
    }
    return null;
  }

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
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { bold: true }, t('welcome.keys')),
      ),
      React.createElement(Text, null, t('welcome.key.navigate')),
      React.createElement(Text, null, t('welcome.key.search')),
      React.createElement(Text, null, t('welcome.key.help')),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { dimColor: true }, t('welcome.dismiss')),
      ),
    ),
  );
}
