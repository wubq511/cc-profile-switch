import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, useApp, useInput, useStdin, useStdout } from 'ink';

import { getAppHomePaths, loadAppConfig, loadAppConfigSync } from '../../core/app-config';
import { type LaunchPlan } from '../../core/launcher';
import { SkillsDiscoverySession } from '../../core/skills-discovery';
import { type McpServerState } from '../../core/mcp-list';
import { I18nProvider, useI18n } from './i18n/react';
import type { Locale, LocaleKey } from './i18n/react';
import { CaptureProvider } from './capture-context';
import { type SearchResult } from '../../core/resource';
import { KeymapOverlay } from './keymap';
import { MainPane, CATEGORY_COUNT, categoryKeyAt, diffCategoryFor } from './main-pane';
import type { WorkbenchProfile, WorkbenchData } from './profile-data';
import { loadWorkbenchData } from './profile-data';
import { ResizeGuard } from './resize-guard';
import { Sidebar } from './sidebar';
import { type CategoryKey } from './sidebar-tree';
import { enterDrillFor, resourceCategoryFor, treeDrillFor } from './categories';
import { renderLaunchOverlay } from './launch/launch-overlay';
import { type LaunchResumeState } from './launch/launch-resume';
import { InstallWizard } from './skills/install-wizard';
import { DiscoverView } from './skills/discover';
import { type PluginInventory } from '../../core/plugins';
import { useFlash } from './hooks/use-flash';
import { useProfileProbes } from './hooks/use-profile-probes';
import { useDrillDown } from './hooks/use-drill-down';
import { useSkillsFlows } from './hooks/use-skills-flows';
import { useLaunchFlow } from './hooks/use-launch-flow';
import { useEditSessions } from './hooks/use-edit-sessions';
import { useResourceNav } from './hooks/use-resource-nav';
import { useLifecycleFlows } from './hooks/use-lifecycle-flows';
import { WelcomeCard } from './welcome-card';
import { GuidanceBand } from './guidance-band';
import { FooterBar } from './footer-bar';
import { DrillSurface } from './drill-surface';
import { HintsProvider, useHints } from './guidance';
import { type CaptureProcess } from '../../platform/process';

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
  /** Resume state handed back by the entry's render loop after a launch
   * remount (spec §10): restores selection and shows the exit flash. */
  resumeState?: LaunchResumeState | null;
  /** Override the MCP connection-state probe (tests). */
  mcpProbe?: (appHomePath: string, profileName: string) => Promise<McpServerState[]>;
  /** Override the Plugins inventory read for the read-only card (tests, #96). */
  pluginInventoryReader?: (
    appHomePath: string,
    profileName: string,
  ) => Promise<PluginInventory>;
  /** Override the sidebar cross-Profile content search (tests, #83). */
  searchContent?: (query: string) => Promise<SearchResult[]>;
  /** Override the Discover session factory (tests inject a fake-session/http). */
  discoverySessionFactory?: (
    appHomePath: string,
    experimentalEnabled: boolean,
  ) => SkillsDiscoverySession;
  /** Override the app-config read (tests avoid touching the real app home). */
  configLoader?: (appHomePath: string) => Promise<ReturnType<typeof loadAppConfig>>;
  /** Injected process capture for MCP remove / Skill update (hermetic tests). */
  captureProcess?: CaptureProcess;
  /** Persisted hint use-counts from state.json (issue #76); absent = the
   * provider tracks counts for this session only. */
  initialHintUsage?: Record<string, number>;
  /** Persist hook fired on each hint-key use (state.json, issue #76). */
  onHintUsed?: (key: string) => void;
  /** `workbench.editor` from config.json (§13.2): editor command override for
   * the external-edit handoff, e.g. "code -w". Undefined = VS Code default. */
  editorOverride?: string;
  /** Override the welcome banner config read (tests). Undefined = read
   * `welcomeBanner` from config.json, defaulting to enabled. */
  welcomeBannerEnabled?: boolean;
};

export function WorkbenchApp({
  data,
  onLocaleChange,
  initialLocale,
  headless,
  skipWelcome,
  onLaunch,
  resumeState,
  mcpProbe,
  pluginInventoryReader,
  searchContent,
  discoverySessionFactory,
  configLoader,
  captureProcess,
  initialHintUsage,
  onHintUsed,
  editorOverride,
  welcomeBannerEnabled,
}: WorkbenchAppProps): React.ReactElement {
  const inner = React.createElement(WorkbenchInner, {
    data,
    headless,
    skipWelcome,
    onLaunch,
    resumeState,
    mcpProbe,
    pluginInventoryReader,
    searchContent,
    discoverySessionFactory,
    configLoader,
    captureProcess,
    editorOverride,
    welcomeBannerEnabled,
  });
  return React.createElement(
    I18nProvider,
    { initialLocale, onLocaleChange },
    React.createElement(
      HintsProvider,
      { initialUsage: initialHintUsage, onMarkUsed: onHintUsed },
      inner,
    ),
  );
}

function WorkbenchInner({
  data,
  headless,
  skipWelcome,
  onLaunch,
  resumeState,
  mcpProbe,
  pluginInventoryReader,
  searchContent,
  discoverySessionFactory,
  configLoader,
  captureProcess,
  editorOverride,
  welcomeBannerEnabled,
}: {
  data: WorkbenchData;
  headless?: boolean;
  skipWelcome?: boolean;
  onLaunch?: (plan: LaunchPlan, appHomePath: string) => number | null;
  resumeState?: LaunchResumeState | null;
  mcpProbe?: (appHomePath: string, profileName: string) => Promise<McpServerState[]>;
  pluginInventoryReader?: (
    appHomePath: string,
    profileName: string,
  ) => Promise<PluginInventory>;
  searchContent?: (query: string) => Promise<SearchResult[]>;
  discoverySessionFactory?: (
    appHomePath: string,
    experimentalEnabled: boolean,
  ) => SkillsDiscoverySession;
  configLoader?: (appHomePath: string) => Promise<ReturnType<typeof loadAppConfig>>;
  captureProcess?: CaptureProcess;
  editorOverride?: string;
  welcomeBannerEnabled?: boolean;
}): React.ReactElement {
  const { t, locale, switchLocale } = useI18n();
  // Core services (buildLaunchPlan, validateProfile, preview…) produce user-
  // visible text with an English default; the workbench hands them its
  // catalog-backed translator so a zh-locale user sees localized messages.
  const coreTranslator = useCallback(
    (key: string, params?: Record<string, string | number>) => t(key as LocaleKey, params),
    [t],
  );
  const appHomePath = getAppHomePaths().appHomePath;
  const welcomeBannerConfigEnabled = useMemo(() => {
    if (welcomeBannerEnabled !== undefined) return welcomeBannerEnabled;
    try {
      return loadAppConfigSync(appHomePath).welcomeBanner !== false;
    } catch {
      return true;
    }
  }, [appHomePath, welcomeBannerEnabled]);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin: inkStdin } = useStdin();
  const { markUsed } = useHints();

  const [selectedIndex, setSelectedIndex] = useState(() => {
    if (!resumeState) return 0;
    // Clamp: the profile list may have changed while Claude ran.
    return Math.min(resumeState.selectedIndex, Math.max(0, data.profiles.length - 1));
  });
  const [helpVisible, setHelpVisible] = useState(false);
  const [capture, setCapture] = useState(false);
  // Sidebar search-box focus, lifted here (issue #83/#84): Ink's useInput
  // broadcasts every keypress to all active handlers, so while the search box
  // owns input the app-level letter/action keys (q, e, u, a, ?, …) must stay
  // suppressed or they fire on top of the typed query.
  const [sidebarSearchFocused, setSidebarSearchFocused] = useState(false);
  const handleSearchFocusChange = useCallback((focused: boolean) => {
    setSidebarSearchFocused(focused);
  }, []);
  const [welcomeVisible, setWelcomeVisible] = useState(() => {
    if (skipWelcome) return false;
    if (sessionWelcomeShown) return false;
    sessionWelcomeShown = true;
    return true;
  });
  const [, forceRerender] = useState(0);
  const [workbenchData, setWorkbenchData] = useState(data);
  // Main-pane category focus + resource-row drill-down (issue #69)
  const [mainPaneFocus, setMainPaneFocus] = useState(false);
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);

  const { flashMessage, flash } = useFlash();
  const { mcpFailedByProfile, pluginInventoryByProfile, clearPluginInventory } =
    useProfileProbes({
      workbenchData,
      selectedIndex,
      setWorkbenchData,
      mcpProbe,
      pluginInventoryReader,
      captureProcess,
    });
  const refreshData = useCallback(async () => {
    try {
      const freshData = await loadWorkbenchData(appHomePath);
      setWorkbenchData(freshData);
    } catch {
      // refresh failure is non-fatal
    }
    // The cached plugin inventory belongs to the previous data generation;
    // clear it so the selected Profile is re-probed after any refresh.
    clearPluginInventory();
  }, [appHomePath, clearPluginInventory]);
  const { drillDown, openDrill, exitDrillDown } = useDrillDown({ setCapture, setMainPaneFocus });

  // External-edit sessions (§8) + description inline edit (S5)
  const {
    sessionManager: editSessionManager,
    topLevelEditSession,
    editingDescription,
    descriptionDraft,
    startDescriptionEdit,
    handleDescriptionInput,
    handleTopLevelEdit,
    handleFallbackSystemEditor,
    handleFallbackRetry,
    handleFallbackDismiss,
  } = useEditSessions({
    workbenchData,
    selectedIndex,
    appHomePath,
    flash,
    refreshData,
    t,
    editorOverride,
    setCapture,
  });

  // User Memory / Agents resource navigation (issue #60) + tree drill (#83)
  const {
    resourceNav,
    resourceContent,
    diffResult,
    drilledAgent,
    agentFrontmatter,
    searchResults,
    resourceHintLine,
    resourceNavActive,
    sessionFor,
    openCategory,
    openTreeEntry,
    openDiff,
    saveAgentFrontmatter,
    jumpToSearchHit,
    handleSearchContent,
    handleResourceInput,
    navBack,
  } = useResourceNav({
    workbenchData,
    selectedIndex,
    setSelectedIndex,
    appHomePath,
    flash,
    refreshData,
    t,
    sessionManager: editSessionManager,
    searchContent,
  });

  // Profile lifecycle + dialogs (create/copy/rename/remove/default/validate/
  // backup/export/import/save-template), the import manifest gate (issue #95),
  // and the destructive-action confirm panel (§9.1).
  const {
    lifecycle,
    setLifecycle,
    importPreview,
    importCollisionName,
    importNameError,
    guidanceRows,
    onLifecycleAction,
    handleLifecycleAction,
    handleConfirmInput,
    handleRemoveCustomTemplate,
  } = useLifecycleFlows({
    workbenchData,
    setWorkbenchData,
    setSelectedIndex,
    t,
    coreTranslator,
    captureProcess,
    resumeState,
    flash,
    refreshData,
    appHomePath,
  });

  // Skill install wizard + Discover surface (issue #64/#68, spec §7.2/§7.4)
  const {
    wizardProfileName,
    wizardInitialRemote,
    wizardOpen,
    discoverActive,
    discoverSession,
    wizardCallbacks,
    handleAddSkill,
    openDiscover,
    handleDiscoverInstall,
    closeDiscover,
    handleOpenBrowser,
  } = useSkillsFlows({
    workbenchData,
    selectedIndex,
    appHomePath,
    coreTranslator,
    setWorkbenchData,
    discoverySessionFactory,
    configLoader,
  });
  // Launch flow: pre-launch bar, directory screen, dry-run, spawn, exit flash
  const { handleLaunchInput, handleLaunchBar, handleLaunchDirScreen } = useLaunchFlow({
    lifecycle,
    setLifecycle,
    selectedIndex,
    setSelectedIndex,
    onLaunch,
    coreTranslator,
  });
  const width = stdout.columns ?? 80;
  const height = stdout.rows ?? 24;

  useEffect(() => {
    const onResize = () => forceRerender((n: number) => n + 1);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const canUseInput = !headless && inkStdin.isTTY;

  // Whether the launch flow is active (captures all other input)
  const launchActive = lifecycle.launch.phase !== 'idle';

  useInput(
    (input: string, key: Record<string, boolean>) => {
      if (key.ctrl && input === 'c') {
        exit();
        return;
      }

      if (welcomeVisible) {
        // Focus-in/out reports are not keypresses: the terminal answers the
        // \x1b[?1004h focus-reporting probe written at mount (workbench/
        // index.mts) with \x1b[I / \x1b[O, and Ink's keypress parser strips
        // the escape prefix, so handlers see the bare '[I' / '[O'. Without
        // this filter the card self-dismissed on the focus-in answer right
        // after startup.
        if (input === '[I' || input === '[O') return;
        setWelcomeVisible(false);
        return;
      }

      // The sidebar search box owns every key while focused (issue #83/#84) —
      // typing a query must not reach the app-level actions below (`q` quit,
      // `e` edit, `u`/`a` category drill, `?` help). Ctrl+C stays a hard quit.
      if (sidebarSearchFocused) return;

      if (helpVisible) {
        if (key.escape || input === '?') {
          setHelpVisible(false);
          setCapture(false);
          return;
        }
        // In-Workbench language switch (issue #54, spec §14.10): [l] toggles
        // zh↔en from the help sheet. switchLocale re-renders immediately and
        // the entry's onLocaleChange writes back to config.json.
        if (input === 'l') {
          switchLocale(locale === 'zh' ? 'en' : 'zh');
        }
        return;
      }

      // Profile description inline edit (S5) owns all input while active —
      // handled before the capture check because the edit itself sets capture.
      if (handleDescriptionInput(input, key)) return;

      if (capture) return;

      // The install wizard owns its own input; let it handle everything else.
      if (wizardOpen) return;

      // The Discover surface owns its own input while open.
      if (discoverActive) return;

      // Lifecycle prompts (Profile/template name input, template picker) are
      // owned by the Sidebar. While any text input is active the global keys
      // must stay literal text: `q` types "q" instead of quitting, `?` types
      // "?" instead of opening help (issue #90).
      if (lifecycle.phase === 'prompting') return;

      // Resource navigation input handling
      if (resourceNav.phase !== 'idle') {
        handleResourceInput(input, key);
        return;
      }

      // The launch directory screen's typed path owns every key — `q`/`?` and
      // letters stay literal characters (issue #90). The other launch phases
      // fall through: the global keys below (`q` quit, `?` help) stay live
      // there as before, and the launchActive branch further down owns the
      // rest. Ctrl+C (above) stays the hard quit.
      if (lifecycle.launch.phase === 'dir-screen') {
        handleLaunchInput(input, key);
        return;
      }

      // Destructive-action panel input (§9.1). Ahead of the category drills:
      // the panel's [u] (no-backup remove) must not also open User Memory.
      if (lifecycle.phase === 'confirm') {
        handleConfirmInput(input, key);
        return;
      }

      // Grid: drill into User Memory or Agents categories. Ownership follows
      // the focus region (issue #90): `u` has no sidebar binding and stays
      // live in both regions (like `e`); `a` belongs to the sidebar's Add
      // Skill wizard unless the main pane is focused — exactly one owner per
      // UI state, so a keypress never triggers two handlers at once. Neither
      // drill fires over the launch flow's overlays.
      if (input === 'u' && lifecycle.phase === 'idle' && !launchActive) {
        openCategory('user-memory');
        return;
      }
      if (input === 'a' && mainPaneFocus && lifecycle.phase === 'idle' && !launchActive) {
        openCategory('agents');
        return;
      }

      // Recovery Bin browse/restore (issue #94, spec §9.5): app-level `B`
      // (uppercase) pairs with the sidebar's `b` backup. Works with zero
      // Profiles — the Bin can hold items even after every Profile is removed.
      if (input === 'B' && lifecycle.phase === 'idle' && !launchActive) {
        markUsed('B');
        openDrill({ kind: 'recovery' });
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

      // Launch bar / dry-run / exit-flash capture all remaining input (their
      // documented keys only); the global keys above stay live there.
      if (launchActive) {
        handleLaunchInput(input, key);
        return;
      }

      // Top-level `e`: open the selected Profile's User Memory (CLAUDE.md) in
      // VS Code (§4.3 `e`, §8 watching). Lives with the grid's other idle action
      // keys, before the category-focus block, so it stays live while the grid
      // is focused — matching how `u`/`a` keep working there. Resource views and
      // the wizard return earlier and own their own `e`.
      if (input === 'e' && lifecycle.phase === 'idle') {
        markUsed('e');
        void handleTopLevelEdit();
        return;
      }

      // Top-level `D`: edit the selected Profile's description inline on the
      // card (S5) — structured metadata edits stay inside the Workbench (§8).
      if (input === 'D' && lifecycle.phase === 'idle') {
        markUsed('D');
        startDescriptionEdit();
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
          // The category table (categories.ts) owns which surface Enter opens:
          // bulk-ops for autoMemory/skills/agents/mcp, the key-level editor for
          // settings/launchConfig (#101 L1), the read-only inventory for
          // plugins (#101 L4), and the resource browse for userMemory — which
          // mirrors the live `u` drill (#101 sweep), so every card answers
          // Enter the same way.
          const catKey = categoryKeyAt(selectedCategoryIndex);
          if (catKey) {
            const target = enterDrillFor(catKey);
            if (target.kind === 'resource') {
              const category = resourceCategoryFor(catKey);
              if (category) openCategory(category);
            } else {
              openDrill(target);
            }
          }
          return;
        }
        if (input === 'd') {
          // Single Diff entry point (spec §12): diff the focused category vs the
          // first other Profile, switchable in place. Auto Memory has no diff.
          const catKey = categoryKeyAt(selectedCategoryIndex);
          const diffCat = catKey ? diffCategoryFor(catKey) : undefined;
          if (diffCat) {
            markUsed('d');
            void openDiff(diffCat);
          } else {
            flash(t('resource.diff.noAutoMemory'));
          }
          return;
        }
        return;
      }
    },
    { isActive: canUseInput },
  );

  // Sidebar tree drill-down (issue #83): Enter on a category or item row opens
  // the category's existing surface — resource list/preview for User Memory and
  // Agents (#60), the Auto Memory view (#69), or the main-pane category grid.
  // The category table (categories.ts) owns which surface each key opens (#89).
  const handleDrillCategory = useCallback(
    async (profileName: string, categoryKey: CategoryKey, itemName?: string) => {
      const profileIndex = workbenchData.profiles.findIndex((p) => p.name === profileName);
      if (profileIndex < 0) return;
      setSelectedIndex(profileIndex);

      const target = treeDrillFor(categoryKey);
      if (target.kind === 'resource') {
        const category = resourceCategoryFor(categoryKey);
        if (category) await openTreeEntry(profileIndex, category, itemName);
        return;
      }
      // Settings / Launch Config focus the tree row's key in the editor (#101 L1).
      openDrill(target.kind === 'kv' ? { ...target, focusKey: itemName } : target);
    },
    [workbenchData, openDrill, openTreeEntry],
  );

  const handleDrillDataChanged = useCallback(() => {
    void refreshData();
  }, [refreshData]);

  const sidebarWidth = Math.max(26, Math.floor(width * 0.3));
  const mainWidth = width - sidebarWidth - 2;
  const selectedProfile: WorkbenchProfile | undefined =
    workbenchData.profiles[selectedIndex] ?? undefined;

  const mcpFailed = selectedProfile ? (mcpFailedByProfile[selectedProfile.name] ?? []) : [];

  const paneHeight = Math.max(4, height - 1 - guidanceRows);

  // Render launch overlays
  const launchOverlay = renderLaunchOverlay(lifecycle.launch, lifecycle.profileName, width, height, t);

  // The install wizard overlay takes priority over the launch overlay and the
  // main workbench surface. It receives height-1: the footer row below stays
  // visible, and the wizard's internal budget must exactly fit its own
  // fixed-height root — an overflowing column there makes yoga hand
  // freshly-mounted source rows a zero-height layout (rows paint blank or
  // vanish; issue #98 follow-up).
  const wizardOverlay =
    wizardOpen && wizardProfileName
      ? React.createElement(InstallWizard, {
          profileName: wizardProfileName,
          callbacks: wizardCallbacks,
          width,
          height: height - 1,
          headless,
          initialRemote: wizardInitialRemote ?? undefined,
        })
      : null;

  // The Discover surface is the Skills drilling surface (issue #68, §7.4).
  const discoverOverlay =
    discoverActive && discoverSession
      ? React.createElement(DiscoverView, {
          profileName: workbenchData.profiles[selectedIndex]?.name ?? '',
          session: discoverSession,
          width,
          height,
          headless,
          onBack: closeDiscover,
          onInstallSource: handleDiscoverInstall,
          onOpenBrowser: handleOpenBrowser,
        })
      : null;

  const inner = React.createElement(
    CaptureProvider,
    { value: setCapture },
    React.createElement(
      Box,
      { flexDirection: 'column', width, height },
      welcomeVisible
        ? React.createElement(WelcomeCard, {
            width,
            height,
            configEnabled: welcomeBannerConfigEnabled,
          })
        : helpVisible
          ? React.createElement(KeymapOverlay, { visible: true })
          : wizardOverlay
            ? wizardOverlay
            : discoverOverlay
              ? discoverOverlay
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
                        height: paneHeight,
                        capture: capture || mainPaneFocus,
                        headless,
                        lifecycle,
                        wizardOpen,
                        resourceNavActive,
                        customTemplates: workbenchData.customTemplates,
                        onLifecycleAction,
                        onAction: handleLifecycleAction,
                        onLaunchBar: handleLaunchBar,
                        onLaunchDirScreen: handleLaunchDirScreen,
                        onAddSkill: handleAddSkill,
                        onDrillCategory: handleDrillCategory,
                        onJumpContentHit: jumpToSearchHit,
                        onSearchContent: handleSearchContent,
                        onSearchFocusChange: handleSearchFocusChange,
                        onRemoveCustomTemplate: handleRemoveCustomTemplate,
                      }),
                      React.createElement(
                        DrillSurface,
                        {
                          drillDown,
                          selectedProfile,
                          appHomePath,
                          profileNames: workbenchData.profiles.map((p) => p.name),
                          pluginInventory: selectedProfile
                            ? pluginInventoryByProfile[selectedProfile.name]
                            : undefined,
                          editSessionManager,
                          width: mainWidth,
                          height: paneHeight,
                          headless,
                          captureProcess,
                          onBack: exitDrillDown,
                          onDataChanged: handleDrillDataChanged,
                          onDiscover: () => {
                            void openDiscover();
                          },
                        },
                        React.createElement(MainPane, {
                          profile: selectedProfile,
                          profiles: workbenchData.profiles,
                          nav: resourceNav,
                          mcpFailed,
                          width: mainWidth,
                          height: paneHeight,
                          focused: mainPaneFocus,
                          selectedCategoryIndex,
                          editSession: topLevelEditSession,
                          sessionFor,
                          descriptionDraft: editingDescription ? descriptionDraft : null,
                          editFallback: {
                            systemEditor: (filePath: string) =>
                              void handleFallbackSystemEditor(filePath),
                            retry: handleFallbackRetry,
                            dismiss: handleFallbackDismiss,
                          },
                          content: resourceContent,
                          diff: diffResult,
                          drilledAgent,
                          agentFrontmatter,
                          searchResults,
                          onSaveFrontmatter: saveAgentFrontmatter,
                          onBack: navBack,
                          hintLine: resourceHintLine,
                        }),
                      ),
                    ),
                    React.createElement(GuidanceBand, {
                      lifecycle,
                      importPreview,
                      importCollisionName,
                      importNameError,
                      selectedProfile,
                      rows: guidanceRows,
                    }),
                  ),
      React.createElement(FooterBar, {
        lifecycle,
        mainPaneFocus,
        showFocusHint: drillDown.kind === 'none' && workbenchData.profiles.length > 0,
        flashMessage,
        width,
        height,
      }),
    ),
  );

  return React.createElement(ResizeGuard, { width, height, children: inner });
}
