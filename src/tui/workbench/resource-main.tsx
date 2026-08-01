import React from 'react';

import type { WorkbenchProfile } from './profile-data';
import type { ResourceNavState } from './resource-nav';
import type {
  ResourceCategory,
  AgentFrontmatter,
  UserMemoryDiff,
  AgentsDiff,
  SearchResult,
} from '../../core/resource';
import type { EditSession } from '../../core/edit-session';
import { ResourceList } from './resource-list';
import { ResourcePreview } from './resource-preview';
import { ResourceDiffView } from './resource-diff-view';
import { ResourceSearchView } from './resource-search-view';
import { AgentFrontmatterEditor } from './agent-frontmatter-editor';

type ResourceMainPaneProps = {
  profile: WorkbenchProfile;
  profiles: WorkbenchProfile[];
  nav: ResourceNavState;
  /** Active edit session for a resource file, keyed by resource name. */
  sessionFor: (resourceName: string) => EditSession | undefined;
  /** Loaded preview content for the currently selected resource. */
  content: string | null;
  diff: UserMemoryDiff | AgentsDiff | null;
  drilledAgent: string | null;
  agentFrontmatter: AgentFrontmatter | null;
  searchResults: SearchResult[];
  hintLine: string;
  onSaveFrontmatter: (updates: Partial<AgentFrontmatter>) => void;
  onBack: () => void;
  width: number;
  height: number;
};

export function ResourceMainPane({
  profile,
  profiles,
  nav,
  sessionFor,
  content,
  diff,
  drilledAgent,
  agentFrontmatter,
  searchResults,
  hintLine,
  onSaveFrontmatter,
  onBack,
  width,
  height,
}: ResourceMainPaneProps): React.ReactElement {
  const { phase, category } = nav;

  if (phase === 'idle' || category === null) {
    // The parent MainPane renders the category grid in this phase.
    return React.createElement(React.Fragment, null);
  }

  if (phase === 'search') {
    return React.createElement(ResourceSearchView, {
      query: nav.searchQuery,
      results: searchResults,
      selectedIndex: nav.searchSelectedIndex,
      width,
      height,
    });
  }

  if (phase === 'list') {
    return React.createElement(ResourceList, {
      profile,
      category,
      selectedIndex: nav.selectedIndex,
      sessionFor,
      width,
      height,
      hintLine,
    });
  }

  if (phase === 'preview') {
    const resourceName = selectedResourceName(nav, profile, category);
    const session = sessionFor(resourceName);
    // Prefer the session's last-read content so external saves refresh the
    // preview live (spec §8 refresh: automatic).
    const displayContent =
      session && session.lastContent !== null ? session.lastContent : content;
    return React.createElement(ResourcePreview, {
      profile,
      category,
      resourceName,
      content: displayContent,
      scrollOffset: nav.scrollOffset,
      session,
      width,
      height,
    });
  }

  if (phase === 'diff') {
    return React.createElement(ResourceDiffView, {
      profile,
      category,
      diff,
      drilledAgent,
      profiles,
      width,
      height,
    });
  }

  if (phase === 'agent-edit') {
    const agentName = selectedResourceName(nav, profile, 'agents');
    const session = sessionFor(agentName);
    return React.createElement(AgentFrontmatterEditor, {
      agentName,
      frontmatter: agentFrontmatter,
      isBlocked: isActiveSession(session),
      onSave: onSaveFrontmatter,
      onBack,
      width,
      height,
    });
  }

  return React.createElement(React.Fragment, null);
}

function selectedResourceName(
  nav: ResourceNavState,
  profile: WorkbenchProfile,
  category: ResourceCategory,
): string {
  if (category === 'user-memory') return 'CLAUDE.md';
  const agent = profile.resourceDetails.agents[nav.selectedIndex];
  return agent?.name ?? 'agent';
}

function isActiveSession(session: EditSession | undefined): boolean {
  if (!session) return false;
  return session.phase === 'watching' || session.phase === 'opening' || session.phase === 'missing';
}
