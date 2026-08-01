import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { WorkbenchProfile, ResourceCounts } from './profile-data';
import type { ResourceNavState } from './resource-nav';
import type {
  AgentFrontmatter,
  UserMemoryDiff,
  AgentsDiff,
  SearchResult,
} from '../../core/resource';
import type { EditSession } from '../../core/edit-session';
import { ResourceMainPane } from './resource-main';

type MainPaneProps = {
  profile: WorkbenchProfile | undefined;
  profiles: WorkbenchProfile[];
  nav: ResourceNavState;
  width: number;
  height: number;
  sessionFor: (resourceName: string) => EditSession | undefined;
  content: string | null;
  diff: UserMemoryDiff | AgentsDiff | null;
  drilledAgent: string | null;
  agentFrontmatter: AgentFrontmatter | null;
  searchResults: SearchResult[];
  onSaveFrontmatter: (updates: Partial<AgentFrontmatter>) => void;
  onBack: () => void;
  hintLine: string;
};

const CATEGORIES = [
  { key: 'userMemory' as const, labelKey: 'main.category.userMemory' as const, drillable: true as const, resourceCategory: 'user-memory' as const },
  { key: 'autoMemory' as const, labelKey: 'main.category.autoMemory' as const, drillable: false as const },
  { key: 'skills' as const, labelKey: 'main.category.skills' as const, drillable: false as const },
  { key: 'agents' as const, labelKey: 'main.category.agents' as const, drillable: true as const, resourceCategory: 'agents' as const },
  { key: 'mcp' as const, labelKey: 'main.category.mcp' as const, drillable: false as const },
  { key: 'settings' as const, labelKey: 'main.category.settings' as const, drillable: false as const },
  { key: 'launchConfig' as const, labelKey: 'main.category.launchConfig' as const, drillable: false as const },
] as const;

type CategoryDef = (typeof CATEGORIES)[number];
type CategoryKey = CategoryDef['key'];

export function MainPane({
  profile,
  profiles,
  nav,
  width,
  height,
  sessionFor,
  content,
  diff,
  drilledAgent,
  agentFrontmatter,
  searchResults,
  onSaveFrontmatter,
  onBack,
  hintLine,
}: MainPaneProps): React.ReactElement {
  const { t } = useI18n();

  if (!profile) {
    return React.createElement(
      Box,
      { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width, height },
      React.createElement(Text, { dimColor: true }, t('main.selectProfile')),
    );
  }

  // When drilled into a resource category, render the resource sub-view.
  if (nav.phase !== 'idle') {
    return React.createElement(ResourceMainPane, {
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
    });
  }

  const colWidth = Math.floor((width - 4) / 2);

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { bold: true }, profile.name),
      profile.isDefault && React.createElement(Text, { color: 'green' }, ` [${t('sidebar.default')}]`),
    ),
    profile.description && React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { dimColor: true }, profile.description),
    ),
    React.createElement(
      Box,
      { flexDirection: 'column', gap: 1 },
      ...renderCategoryGrid(profile.resourceCounts, colWidth),
    ),
  );

  function renderCategoryGrid(counts: ResourceCounts, colW: number): React.ReactElement[] {
    const rows: React.ReactElement[] = [];
    for (let i = 0; i < CATEGORIES.length; i += 2) {
      const left = CATEGORIES[i];
      const right = i + 1 < CATEGORIES.length ? CATEGORIES[i + 1] : null;

      rows.push(
        React.createElement(
          Box,
          { key: left.key, gap: 1 },
          renderCategoryCard(left, counts[left.key], colW),
          right
            ? renderCategoryCard(right, counts[right.key as CategoryKey], colW)
            : React.createElement(Box, { width: colW }),
        ),
      );
    }
    return rows;
  }

  function renderCategoryCard(def: CategoryDef, count: number, colW: number): React.ReactElement {
    const drillHint = def.drillable
      ? def.resourceCategory === 'user-memory'
        ? ' [u]'
        : ' [a]'
      : '';
    return React.createElement(
      Box,
      {
        flexDirection: 'column',
        width: colW,
        borderStyle: 'round',
        borderColor: 'gray',
        paddingX: 1,
      },
      React.createElement(Text, { bold: true }, t(def.labelKey)),
      React.createElement(Text, null, `${count}`),
      drillHint && React.createElement(Text, { dimColor: true }, drillHint),
    );
  }
}
