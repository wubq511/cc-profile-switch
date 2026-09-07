import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import { readStateFor, type WorkbenchProfile } from './profile-data';
import type { ResourceCategory } from '../../core/resource';
import type { EditSession } from '../../core/edit-session';
import { WatchingBadge } from './edit-session/WatchingBadge';
import { FallbackMenu, type EditFallbackHandlers } from './edit-session/FallbackMenu';

type ResourceListProps = {
  profile: WorkbenchProfile;
  category: ResourceCategory;
  selectedIndex: number;
  /** Returns the active edit session for a resource file, if any. */
  sessionFor: (resourceName: string) => EditSession | undefined;
  width: number;
  height: number;
  hintLine: string;
  /** §8 editor-unavailable fallback actions for a failed edit session. */
  editFallback: EditFallbackHandlers;
};

/**
 * Renders the resource rows for a drilled-in category.
 *
 * - User Memory: a single CLAUDE.md row (or a "missing → recreate" hint).
 * - Agents: one row per agents/*.md file.
 * - An unreadable category (EISDIR/EACCES/format, issue #110) shows the
 *   diagnostic with a fix direction instead of a successful empty list, and
 *   the item actions stay unavailable.
 */
export function ResourceList({
  profile,
  category,
  selectedIndex,
  sessionFor,
  width,
  height,
  hintLine,
  editFallback,
}: ResourceListProps): React.ReactElement {
  const { t } = useI18n();

  const isAgents = category === 'agents';
  const userMemory = profile.resourceDetails.userMemory;
  const agents = profile.resourceDetails.agents;
  // Issue #110: an unreadable category renders the explicit error state; the
  // graceful-degradation fixture paths (missing userMemory entry) fall back to
  // `ok` + empty details.
  const categoryState = readStateFor(profile, category);
  const unreadable = categoryState.status === 'unreadable' ? categoryState : null;

  const empty = !unreadable && (isAgents ? agents.length === 0 : !userMemory.exists);
  const headerText = isAgents ? t('resource.agents.title') : t('resource.userMemory.title');

  if (unreadable) {
    return React.createElement(
      Box,
      { flexDirection: 'column', width, height, paddingX: 1 },
      React.createElement(Text, { bold: true }, `${profile.name} › ${headerText}`),
      React.createElement(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        React.createElement(
          Text,
          { color: 'red' },
          `✗ ${t('resource.state.unreadable', { code: unreadable.code })}`,
        ),
        React.createElement(
          Text,
          { color: 'gray', wrap: 'truncate' },
          `    ${unreadable.detail}`,
        ),
        React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(
            Text,
            { color: 'gray', wrap: 'wrap' },
            t('resource.state.fixDirection'),
          ),
        ),
        React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(Text, { color: 'gray' }, t('resource.state.refreshHint')),
        ),
      ),
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(Text, { color: 'gray', wrap: 'truncate' }, hintLine),
    );
  }

  if (empty) {
    return React.createElement(
      Box,
      { flexDirection: 'column', width, height, paddingX: 1 },
      React.createElement(Text, { bold: true }, `${profile.name} › ${headerText}`),
      React.createElement(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        React.createElement(
          Text,
          { color: 'gray' },
          isAgents ? t('resource.agents.empty') : t('resource.userMemory.missing'),
        ),
      ),
    );
  }

  const rows = isAgents
    ? agents.map((a) => ({
        key: a.name,
        label: a.name,
        detail: a.frontmatter?.description ? String(a.frontmatter.description) : a.bodyExcerpt,
      }))
    : [
        {
          key: 'CLAUDE.md',
          label: 'CLAUDE.md',
          detail: t('resource.userMemory.lines', { count: String(userMemory.lineCount) }),
        },
      ];

  const selectedRowKey = rows[selectedIndex]?.key;
  const failedSession = selectedRowKey ? sessionFor(selectedRowKey) : undefined;

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(Text, { bold: true }, `${profile.name} › ${headerText}`),
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
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
          React.createElement(Text, { color: 'gray', wrap: 'truncate' }, `    ${row.detail}`),
        );
      }),
    ),
    // §8 VS Code unavailable: surface the selected row's failed handoff with
    // its fallback actions (at most one menu — the selected row's).
    failedSession?.openFailedReason &&
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(FallbackMenu, {
          reason: failedSession.openFailedReason,
          filePath: failedSession.filePath,
          onSystemEditor: () => editFallback.systemEditor(failedSession.filePath),
          onRetry: () => editFallback.retry(failedSession.filePath),
          onDismiss: () => editFallback.dismiss(failedSession.filePath),
        }),
      ),
    React.createElement(Box, { flexGrow: 1 }),
    React.createElement(Text, { color: 'gray', wrap: 'truncate' }, hintLine),
  );
}