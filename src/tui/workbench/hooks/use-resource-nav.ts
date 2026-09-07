import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

import { getAppHomePaths } from '../../../core/app-config';
import { getProfileTemplatePaths } from '../../../core/profile-template';
import { resolveInside } from '../../../platform/path';
import type { EditSession, EditSessionManager } from '../../../core/edit-session';
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
  searchAllResources,
  classifyReadError,
  type AgentFrontmatter,
  type SearchResult,
  type ResourceCategory,
} from '../../../core/resource';
import {
  diffResources,
  type ResourceDiffResult,
  type DiffCategory,
} from '../../../core/resource/diff-all';
import {
  effectiveDiffCategory,
  initialResourceNavState,
  resourceNavReducer,
  type ResourceNavAction,
  type ResourceNavState,
} from '../resource-nav';
import type { I18nParams, LocaleKey } from '../i18n/react';
import { readStateFor, type WorkbenchData, type WorkbenchProfile } from '../profile-data';

type UseResourceNavOptions = {
  workbenchData: WorkbenchData;
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  appHomePath: string;
  flash: (message: string) => void;
  refreshData: () => Promise<void>;
  t: (key: LocaleKey, params?: I18nParams) => string;
  /** The Workbench-lifetime edit-session manager (from useEditSessions). */
  sessionManager: EditSessionManager;
  /** Override the sidebar cross-Profile content search (tests, #83). */
  searchContent?: (query: string) => Promise<SearchResult[]>;
};

/** User Memory / Agents resource navigation (issue #60): list / preview /
 *  diff / copy / search / agent frontmatter edit / agent creation, plus the
 *  sidebar-tree resource drill (issue #83). Extracted from app.tsx (issue
 *  #89) — the ~18-dependency central handler now closes over hook-local
 *  state only. */
export function useResourceNav({
  workbenchData,
  selectedIndex,
  setSelectedIndex,
  appHomePath,
  flash,
  refreshData,
  t,
  sessionManager,
  searchContent,
}: UseResourceNavOptions): {
  resourceNav: ResourceNavState;
  resourceContent: string | null;
  /** Issue #110: diagnostic for a failed preview load; null when content loaded
   *  or the target is simply absent. */
  resourceReadError: { code: string; detail: string } | null;
  diffResult: ResourceDiffResult | null;
  drilledAgent: string | null;
  agentFrontmatter: AgentFrontmatter | null;
  searchResults: SearchResult[];
  resourceHintLine: string;
  resourceNavActive: boolean;
  sessionFor: (resourceName: string) => EditSession | undefined;
  openCategory: (category: ResourceCategory) => void;
  openTreeEntry: (
    profileIndex: number,
    category: ResourceCategory,
    itemName?: string,
  ) => Promise<void>;
  openDiff: (category: DiffCategory, profileOverride?: string) => Promise<void>;
  saveAgentFrontmatter: (updates: Partial<AgentFrontmatter>) => Promise<void>;
  jumpToSearchHit: (hit: SearchResult) => Promise<void>;
  handleSearchContent: (query: string) => Promise<SearchResult[]>;
  handleResourceInput: (input: string, key: Record<string, boolean>) => void;
  navBack: () => void;
} {
  // User Memory / Agents resource rows (issue #60)
  const [resourceNav, setResourceNav] = useState<ResourceNavState>(initialResourceNavState);
  const [resourceContent, setResourceContent] = useState<string | null>(null);
  // Issue #110: an unreadable preview target (EISDIR/EACCES/format) keeps an
  // explicit error instead of rendering the "missing/empty" view; re-entering
  // the category after a disk fix reloads and clears it.
  const [resourceReadError, setResourceReadError] = useState<{
    code: string;
    detail: string;
  } | null>(null);
  const [diffResult, setDiffResult] = useState<ResourceDiffResult | null>(null);
  const [drilledAgent, setDrilledAgent] = useState<string | null>(null);
  const [agentFrontmatter, setAgentFrontmatter] = useState<AgentFrontmatter | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  // Agent-creation name prompt state
  const [promptingAgentName, setPromptingAgentName] = useState(false);
  const [agentNameDraft, setAgentNameDraft] = useState('');

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

  const selectedResourceName = (
    profile: WorkbenchProfile,
    category: 'user-memory' | 'agents',
  ): string => {
    if (category === 'user-memory') return 'CLAUDE.md';
    const agent = profile.resourceDetails.agents[resourceNav.selectedIndex];
    return agent?.name ?? 'agent';
  };

  const sessionFor = (resourceName: string): EditSession | undefined => {
    const profile = currentProfile();
    if (!profile || !resourceNav.category) return undefined;
    const filePath = resourceFilePath(profile.name, resourceNav.category, resourceName);
    return sessionManager.getSession(filePath);
  };

  // The shared drill-exit sequence for the resource browse surface (issue
  // #89): content/diff/agent drill-in all reset together.
  const resetResourceViewState = useCallback(() => {
    setResourceContent(null);
    setResourceReadError(null);
    setDiffResult(null);
    setDrilledAgent(null);
    setAgentFrontmatter(null);
  }, []);

  // The `u` / `a` idle keys and the main-grid Enter on User Memory (issue
  // #101 sweep): open the category's browse surface with a clean view state.
  const openCategory = useCallback(
    (category: ResourceCategory) => {
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_CATEGORY', category }));
      resetResourceViewState();
    },
    [resetResourceViewState],
  );

  const openPreview = useCallback(async () => {
    const profile = currentProfile();
    if (!profile || !resourceNav.category) return;
    const category = resourceNav.category;
    const resourceName = selectedResourceName(profile, category);
    const appHome = getAppHomePaths().appHomePath;

    let content: string | null = null;
    try {
      if (category === 'agents') {
        content = await readAgentContent(appHome, profile.name, resourceName);
      } else {
        content = await readUserMemoryContent(appHome, profile.name);
      }
      // Issue #110: an unreadable target (EISDIR/EACCES/format) shows the
      // explicit error state, not the missing/empty view. The error clears on
      // the next successful load (refresh after fixing on disk).
      setResourceReadError(null);
    } catch (error) {
      content = null;
      setResourceReadError(classifyReadError(error) as { code: string; detail: string });
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
      await sessionManager.open(filePath);
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [resourceNav, selectedIndex, workbenchData, flash, sessionManager]);

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
      sessionManager.endSession(resourceFilePath(profile.name, category, resourceName));
      flash(
        category === 'agents'
          ? t('resource.agents.removed', { name: resourceName })
          : t('resource.userMemory.removed'),
      );
      await refreshData();
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [resourceNav, selectedIndex, workbenchData, refreshData, flash, t, sessionManager]);

  const openDiff = useCallback(
    async (category: DiffCategory, profileOverride?: string) => {
      const profile = currentProfile();
      if (!profile) return;
      const appHome = getAppHomePaths().appHomePath;

      const others = workbenchData.profiles.map((p) => p.name).filter((n) => n !== profile.name);
      if (others.length === 0) {
        flash(t('resource.diff.noOtherProfile'));
        return;
      }
      const counterpart = profileOverride ?? resourceNav.diffProfile ?? others[0];

      try {
        const result = await diffResources(appHome, profile.name, counterpart, category);
        setDiffResult(result);
        setDrilledAgent(null);
        // Enter the diff phase: from the category grid use OPEN_DIFF_CATEGORY
        // (Esc → grid), from a resource list/preview keep OPEN_DIFF (Esc → list).
        // An in-diff counterpart switch only reloads the result (phase unchanged).
        if (resourceNav.phase === 'idle') {
          setResourceNav((prev) =>
            resourceNavReducer(prev, { type: 'OPEN_DIFF_CATEGORY', category }),
          );
        } else if (resourceNav.phase === 'list' || resourceNav.phase === 'preview') {
          setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_DIFF' }));
        }
        setResourceNav((prev) =>
          resourceNavReducer(prev, { type: 'SET_DIFF_PROFILE', profile: counterpart }),
        );
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error));
      }
    },
    [resourceNav, selectedIndex, workbenchData, flash, t],
  );

  const openAgentEdit = useCallback(() => {
    const profile = currentProfile();
    if (!profile || resourceNav.category !== 'agents') return;
    const agent = profile.resourceDetails.agents[resourceNav.selectedIndex];
    setAgentFrontmatter(agent?.frontmatter ?? null);
    setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_AGENT_EDIT' }));
  }, [resourceNav, selectedIndex, workbenchData]);

  const saveAgentFrontmatter = useCallback(
    async (updates: Partial<AgentFrontmatter>) => {
      const profile = currentProfile();
      if (!profile || resourceNav.category !== 'agents') return;
      const resourceName = selectedResourceName(profile, 'agents');
      const filePath = resourceFilePath(profile.name, 'agents', resourceName);
      const appHome = getAppHomePaths().appHomePath;

      // Dual-channel block: refuse Workbench writes while VS Code holds the file.
      if (sessionManager.isFileUnderSession(filePath)) {
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
    },
    [resourceNav, selectedIndex, workbenchData, refreshData, flash, t, sessionManager],
  );

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
      flash(t('resource.copy.success', { profile: target }));
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
      await refreshData();
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [resourceNav, selectedIndex, workbenchData, refreshData, flash, t]);

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
      flash(t('resource.agents.createSuccess', { name }));
      await refreshData();
      // Hand off the new agent body to VS Code (spec S36).
      sessionManager.open(filePath);
      // Return to the agents list so the new row is visible.
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
      setResourceNav((prev) =>
        resourceNavReducer(prev, { type: 'OPEN_CATEGORY', category: 'agents' }),
      );
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    }
  }, [agentNameDraft, refreshData, flash, t, sessionManager]);

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

  const jumpToSearchHit = useCallback(
    async (hit: SearchResult) => {
      const profileIndex = workbenchData.profiles.findIndex((p) => p.name === hit.profileName);
      if (profileIndex >= 0) setSelectedIndex(profileIndex);

      const appHome = getAppHomePaths().appHomePath;
      let content: string | null = null;
      try {
        if (hit.category === 'agents') {
          content = await readAgentContent(appHome, hit.profileName, hit.itemName);
        } else {
          content = await readUserMemoryContent(appHome, hit.profileName);
        }
        setResourceReadError(null);
      } catch (error) {
        content = null;
        setResourceReadError(classifyReadError(error) as { code: string; detail: string });
      }
      setResourceContent(content);
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
      setResourceNav((prev) =>
        resourceNavReducer(prev, { type: 'OPEN_CATEGORY', category: hit.category }),
      );

      // Position the list selection on the hit's own row so preview/actions
      // operate on the matched item, not the first one in the list.
      if (hit.category === 'agents') {
        const targetProfile = workbenchData.profiles[profileIndex];
        const itemIndex = targetProfile?.resourceDetails.agents.findIndex(
          (a) => a.name === hit.itemName,
        );
        if (itemIndex !== undefined && itemIndex >= 0) {
          setResourceNav((prev) =>
            resourceNavReducer(prev, { type: 'SET_SELECTED_INDEX', index: itemIndex }),
          );
        }
      }

      setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_PREVIEW' }));
    },
    [workbenchData, setSelectedIndex],
  );

  // Sidebar tree resource drill (issue #83): Enter on a User Memory / Agents
  // category or item row opens the browse surface, loading the item's content
  // when a row names one.
  const openTreeEntry = useCallback(
    async (profileIndex: number, category: ResourceCategory, itemName?: string) => {
      const profile = workbenchData.profiles[profileIndex];
      if (!profile) return;
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'CLOSE' }));
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_CATEGORY', category }));
      setDiffResult(null);
      setDrilledAgent(null);
      setAgentFrontmatter(null);
      if (!itemName) {
        setResourceContent(null);
        return;
      }
      const appHome = getAppHomePaths().appHomePath;
      let content: string | null;
      if (category === 'agents') {
        const itemIndex = profile.resourceDetails.agents.findIndex((a) => a.name === itemName);
        if (itemIndex < 0) {
          setResourceContent(null);
          return;
        }
        setResourceNav((prev) =>
          resourceNavReducer(prev, { type: 'SET_SELECTED_INDEX', index: itemIndex }),
        );
        try {
          content = await readAgentContent(appHome, profile.name, itemName);
          setResourceReadError(null);
        } catch (error) {
          content = null;
          setResourceReadError(classifyReadError(error) as { code: string; detail: string });
        }
      } else {
        try {
          content = await readUserMemoryContent(appHome, profile.name);
          setResourceReadError(null);
        } catch (error) {
          content = null;
          setResourceReadError(classifyReadError(error) as { code: string; detail: string });
        }
      }
      setResourceContent(content);
      setResourceNav((prev) => resourceNavReducer(prev, { type: 'OPEN_PREVIEW' }));
    },
    [workbenchData],
  );

  // Cross-Profile content search backing the sidebar search box (§4.2, #83).
  const handleSearchContent = useCallback(
    (query: string): Promise<SearchResult[]> =>
      searchContent
        ? searchContent(query)
        : searchAllResources({ appHomePath: getAppHomePaths().appHomePath, query }),
    [searchContent],
  );

  const handleResourceInput = useCallback(
    (input: string, key: Record<string, boolean>) => {
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
        // Issue #110: when the category itself is unreadable, the only working
        // action is leaving the surface — the item actions stay disabled
        // because there are no readable items to act on.
        const categoryState = readStateFor(profile, category);
        const categoryUnreadable = categoryState.status === 'unreadable';

        const itemCount = categoryUnreadable
          ? 0
          : category === 'agents'
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
          setResourceReadError(null);
          setDiffResult(null);
          setDrilledAgent(null);
          return;
        }
        if (input === '/') {
          dispatchNav({ type: 'OPEN_SEARCH' });
          setSearchResults([]);
          return;
        }
        if (categoryUnreadable) {
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
        if (input === 'd' && itemCount > 0 && category) {
          openDiff(category);
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
        if (
          category === 'user-memory' &&
          !profile.resourceDetails.userMemory.exists &&
          input === 'n'
        ) {
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
        if (input === 'd' && category) {
          openDiff(category);
          return;
        }
        return;
      }

      // Diff phase
      if (nav.phase === 'diff') {
        const diffCategory = effectiveDiffCategory(nav);
        if (!diffCategory) return;
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
          openDiff(diffCategory, next);
          return;
        }
        if (key.downArrow) {
          const idx = others.indexOf(nav.diffProfile ?? others[0]);
          const next = others[(idx + 1) % others.length];
          dispatchNav({ type: 'SET_DIFF_PROFILE', profile: next });
          openDiff(diffCategory, next);
          return;
        }
        // ↑/↓ switch the counterpart; PgUp/PgDn scroll long diff bodies (spec §4.3).
        if (key.pageUp) {
          dispatchNav({ type: 'SCROLL_UP' });
          return;
        }
        if (key.pageDown) {
          dispatchNav({ type: 'SCROLL_DOWN' });
          return;
        }
        if (
          key.return &&
          diffCategory === 'agents' &&
          diffResult &&
          diffResult.category === 'agents'
        ) {
          const changed = diffResult.diff.files.filter((f) => f.verdict === 'changed');
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
    },
    [
      resourceNav,
      selectedIndex,
      workbenchData,
      promptingAgentName,
      agentNameDraft,
      openPreview,
      editSelectedResource,
      removeSelectedResource,
      openDiff,
      confirmCopy,
      openAgentEdit,
      saveAgentFrontmatter,
      startCreateAgent,
      submitCreateAgent,
      recreateUserMemory,
      runSearch,
      jumpToSearchHit,
      searchResults,
    ],
  );

  const navBack = useCallback(() => {
    setResourceNav((prev) => resourceNavReducer(prev, { type: 'BACK' }));
  }, []);

  // Resource view hint line (contextual guidance).
  const selectedProfile = currentProfile();
  const resourceHintLine =
    resourceNav.phase === 'list'
      ? resourceNav.category === 'agents'
        ? t('resource.list.hint.agents')
        : resourceNav.category === 'user-memory' &&
            selectedProfile &&
            !selectedProfile.resourceDetails.userMemory.exists
          ? t('resource.userMemory.missing')
          : t('resource.list.hint')
      : resourceNav.phase === 'diff'
        ? t('resource.diff.switchHint')
        : resourceNav.phase === 'preview' || resourceNav.phase === 'copy'
          ? t('resource.list.hint')
          : '';

  return {
    resourceNav,
    resourceContent,
    resourceReadError,
    diffResult,
    drilledAgent,
    agentFrontmatter,
    searchResults,
    resourceHintLine,
    resourceNavActive: resourceNav.phase !== 'idle',
    sessionFor,
    openCategory,
    openTreeEntry,
    openDiff,
    saveAgentFrontmatter,
    jumpToSearchHit,
    handleSearchContent,
    handleResourceInput,
    navBack,
  };
}
