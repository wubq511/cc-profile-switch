import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { WorkbenchProfile } from './profile-data';
import type { ResourceCategory } from '../../core/resource';
import type { EditSession } from '../../core/edit-session';
import { WatchingBadge } from './edit-session/WatchingBadge';
import { MissingOverlay } from './edit-session/MissingOverlay';
import { FallbackMenu, type EditFallbackHandlers } from './edit-session/FallbackMenu';

type ResourcePreviewProps = {
  profile: WorkbenchProfile;
  category: ResourceCategory;
  resourceName: string;
  content: string | null;
  /** Issue #110: diagnostic for a failed preview read (EISDIR/EACCES/format);
   *  rendered instead of the missing/empty state. */
  contentReadError?: { code: string; detail: string } | null;
  scrollOffset: number;
  session: EditSession | undefined;
  width: number;
  height: number;
  /** §8 editor-unavailable fallback actions for a failed edit session. */
  editFallback: EditFallbackHandlers;
};

/**
 * The content window is derived from the actual pane height, not a fixed
 * constant — a hardcoded 12-line window left the rest of a tall pane empty
 * (issue #87 acceptance finding L3). Chrome rows around the content area:
 * header (1), content marginTop (1), footer (1), plus the optional watching
 * badge block (marginTop + 1 row) and the fallback menu (marginTop + title +
 * marginBottom + 3 actions + optional revealed path = 7, counted
 * pessimistically so the footer is never pushed off-screen).
 */
const CHROME_ROWS = 3;
const BADGE_ROWS = 2;
const FALLBACK_ROWS = 7;
const MIN_CONTENT_ROWS = 3;

export function ResourcePreview({
  profile,
  category,
  resourceName,
  content,
  contentReadError,
  scrollOffset,
  session,
  width,
  height,
  editFallback,
}: ResourcePreviewProps): React.ReactElement {
  const { t } = useI18n();

  const headerText =
    category === 'agents'
      ? `${profile.name} › ${t('resource.agents.title')} › ${resourceName}`
      : `${profile.name} › ${t('resource.userMemory.title')} › CLAUDE.md`;

  const badgeRows = session && session.phase !== 'missing' ? BADGE_ROWS : 0;
  const fallbackRows = session?.openFailedReason ? FALLBACK_ROWS : 0;
  const contentHeight = Math.max(
    MIN_CONTENT_ROWS,
    height - CHROME_ROWS - badgeRows - fallbackRows,
  );

  const lines = content === null ? [] : content.split('\n');
  const visibleLines = lines.slice(scrollOffset, scrollOffset + contentHeight);

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(Text, { bold: true, wrap: 'truncate' }, headerText),
    session &&
      // The 'missing' badge row is suppressed here: the MissingOverlay below
      // carries the same title (plus hint and last-known content), and
      // rendering both put the identical warning line on screen twice
      // (issue #98, V15). Other badge contexts have no overlay and keep it.
      session.phase !== 'missing' &&
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(WatchingBadge, {
          phase: session.phase,
          changeCount: session.changeCount,
          lastUpdated: session.lastUpdated,
        }),
      ),
    // §8 VS Code unavailable: surface the failure with its fallback actions.
    session?.openFailedReason && React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(FallbackMenu, {
        reason: session.openFailedReason,
        filePath: session.filePath,
        onSystemEditor: () => editFallback.systemEditor(session.filePath),
        onRetry: () => editFallback.retry(session.filePath),
        onDismiss: () => editFallback.dismiss(session.filePath),
      }),
    ),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      contentReadError
        ? React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(
              Text,
              { color: 'red', wrap: 'wrap' },
              `✗ ${t('resource.state.loadFailed', { code: contentReadError.code })}`,
            ),
            React.createElement(
              Text,
              { color: 'gray', wrap: 'truncate' },
              contentReadError.detail,
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
          )
        : session && session.phase === 'missing'
          ? React.createElement(MissingOverlay, { lastContent: session.lastContent })
          : content === null
            ? React.createElement(Text, { color: 'gray' }, t('resource.userMemory.missing'))
            : visibleLines.map((line, i) =>
                React.createElement(
                  Text,
                  { key: i, wrap: 'truncate' },
                  String(scrollOffset + i + 1).padStart(3),
                  ' ',
                  line,
                ),
              ),
    ),
    React.createElement(Box, { flexGrow: 1 }),
    React.createElement(
      Text,
      { color: 'gray' },
      `${t('resource.preview.title')} · ${t('resource.preview.back')}`,
    ),
  );
}
