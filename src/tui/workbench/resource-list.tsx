import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { WorkbenchProfile } from './profile-data';
import type { ResourceCategory } from '../../core/resource';
import type { EditSession } from '../../core/edit-session';
import { WatchingBadge } from './edit-session/WatchingBadge';

type ResourceListProps = {
  profile: WorkbenchProfile;
  category: ResourceCategory;
  selectedIndex: number;
  /** Returns the active edit session for a resource file, if any. */
  sessionFor: (resourceName: string) => EditSession | undefined;
  width: number;
  height: number;
  hintLine: string;
};

/**
 * Renders the resource rows for a drilled-in category.
 *
 * - User Memory: a single CLAUDE.md row (or a "missing → recreate" hint).
 * - Agents: one row per agents/*.md file.
 */
export function ResourceList({
  profile,
  category,
  selectedIndex,
  sessionFor,
  width,
  height,
  hintLine,
}: ResourceListProps): React.ReactElement {
  const { t } = useI18n();

  const isAgents = category === 'agents';
  const userMemory = profile.resourceDetails.userMemory;
  const agents = profile.resourceDetails.agents;

  const empty = isAgents ? agents.length === 0 : !userMemory.exists;
  const headerText = isAgents ? t('resource.agents.title') : t('resource.userMemory.title');

  if (empty) {
    return React.createElement(
      Box,
      { flexDirection: 'column', width, height, paddingX: 1 },
      React.createElement(Text, { bold: true }, `${profile.name} › ${headerText}`),
      React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
        React.createElement(Text, { dimColor: true },
          isAgents ? t('resource.agents.empty') : t('resource.userMemory.missing'),
        ),
      ),
    );
  }

  const rows = isAgents
    ? agents.map((a) => ({
        key: a.name,
        label: a.name,
        detail: a.frontmatter?.description
          ? String(a.frontmatter.description)
          : a.bodyExcerpt,
      }))
    : [
        {
          key: 'CLAUDE.md',
          label: 'CLAUDE.md',
          detail: t('resource.userMemory.lines').replace('{count}', String(userMemory.lineCount)),
        },
      ];

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(Text, { bold: true }, `${profile.name} › ${headerText}`),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      ...rows.map((row, i) => {
        const isSelected = i === selectedIndex;
        const session = sessionFor(row.key);
        return React.createElement(
          Box,
          { key: row.key, paddingX: 1, flexDirection: 'column', marginBottom: 1 },
          React.createElement(
            Box,
            { gap: 1 },
            React.createElement(
              Text,
              { inverse: isSelected, bold: isSelected },
              `${isSelected ? '▸ ' : '  '}${row.label}`,
            ),
            session &&
              React.createElement(WatchingBadge, {
                phase: session.phase,
                changeCount: session.changeCount,
                lastUpdated: session.lastUpdated,
              }),
          ),
          React.createElement(
            Text,
            { dimColor: true, wrap: 'truncate' },
            `    ${row.detail}`,
          ),
        );
      }),
    ),
    React.createElement(Box, { flexGrow: 1 }),
    React.createElement(Text, { dimColor: true, wrap: 'truncate' }, hintLine),
  );
}
