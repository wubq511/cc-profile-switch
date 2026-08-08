import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import { useHints } from './guidance';
import type { WorkbenchProfile, ResourceCounts } from './profile-data';
import type { ResourceNavState } from './resource-nav';
import type { AgentFrontmatter, SearchResult } from '../../core/resource';
import type { ResourceDiffResult } from '../../core/resource/diff-all';
import type { EditSession } from '../../core/edit-session';
import { ResourceMainPane } from './resource-main';
import { WatchingBadge } from './edit-session/WatchingBadge';
import { FallbackMenu, type EditFallbackHandlers } from './edit-session/FallbackMenu';
import { CATEGORIES, diffCategoryFor } from './categories';

// Re-export for consumers that import from main-pane.
export { CATEGORIES, CATEGORY_COUNT, categoryKeyAt, diffCategoryFor } from './categories';

type MainPaneProps = {
  profile: WorkbenchProfile | undefined;
  profiles: WorkbenchProfile[];
  nav: ResourceNavState;
  /** MCP servers that failed to connect — amber nudge (§5). */
  mcpFailed?: string[];
  width: number;
  height: number;
  /** Whether the main pane holds keyboard focus (Tab-toggleable from sidebar). */
  focused?: boolean;
  /** Index of the highlighted category card when focused. */
  selectedCategoryIndex?: number;
  /** Active edit session for the selected Profile's User Memory (CLAUDE.md)
   *  when edited from the top-level grid `e` (§4.3/§8). */
  editSession?: EditSession;
  sessionFor: (resourceName: string) => EditSession | undefined;
  /** Inline description-edit draft (S5); null when not editing. */
  descriptionDraft?: string | null;
  /** §8 editor-unavailable fallback actions for failed edit sessions. */
  editFallback: EditFallbackHandlers;
  content: string | null;
  diff: ResourceDiffResult | null;
  drilledAgent: string | null;
  agentFrontmatter: AgentFrontmatter | null;
  searchResults: SearchResult[];
  onSaveFrontmatter: (updates: Partial<AgentFrontmatter>) => void;
  onBack: () => void;
  hintLine: string;
};

type CategoryDef = (typeof CATEGORIES)[number];
type CategoryKey = CategoryDef['key'];

// Focused-element contextual hints (retire after HINT_RETIRE_AFTER uses).
const PROFILE_HINTS = [
  { key: 'l' as const, labelKey: 'lifecycle.launch' as const },
  { key: 'e' as const, labelKey: 'keymap.edit' as const },
  { key: 'D' as const, labelKey: 'lifecycle.editDescription' as const },
  { key: 'E' as const, labelKey: 'lifecycle.export' as const },
  { key: 'i' as const, labelKey: 'lifecycle.import' as const },
  { key: 'b' as const, labelKey: 'lifecycle.backup' as const },
  { key: 's' as const, labelKey: 'lifecycle.saveTemplate' as const },
  { key: 'x' as const, labelKey: 'lifecycle.remove' as const },
  { key: 'n' as const, labelKey: 'lifecycle.create' as const },
];

export function MainPane({
  profile,
  profiles,
  nav,
  mcpFailed,
  width,
  height,
  focused,
  selectedCategoryIndex,
  editSession,
  sessionFor,
  descriptionDraft,
  editFallback,
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
  const { liveKeys } = useHints();

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
      editFallback,
    });
  }

  const colWidth = Math.floor((width - 4) / 2);
  const cursor = selectedCategoryIndex ?? 0;
  const liveProfileHints = liveKeys(PROFILE_HINTS.map((h) => h.key));

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { bold: true }, profile.name),
      profile.isDefault &&
        React.createElement(Text, { color: 'green' }, ` [${t('sidebar.default')}]`),
    ),
    // S5 inline description edit: while editing, the description line becomes
    // the draft input row; the saved value re-renders here after refreshData.
    descriptionDraft != null
      ? React.createElement(
          Box,
          { marginBottom: 1 },
          React.createElement(Text, { color: 'cyan', wrap: 'truncate' }, `${descriptionDraft}█`),
        )
      : profile.description &&
          React.createElement(
            Box,
            { marginBottom: 1 },
            React.createElement(Text, { dimColor: true }, profile.description),
          ),
    // Just-in-time amber nudge: MCP servers that failed to connect (§5).
    (mcpFailed?.length ?? 0) > 0 &&
      React.createElement(
        Box,
        { marginBottom: 1 },
        React.createElement(
          Text,
          { color: 'yellow', wrap: 'wrap' },
          `⚠ ${t('mcp.failed', { name: mcpFailed.join(', ') })}`,
        ),
      ),
    // §8 watching banner: the selected Profile's CLAUDE.md is being edited in
    // VS Code (top-level `e`). The badge re-renders on every external save,
    // carrying the per-session change counter and refresh timestamp.
    editSession &&
      editSession.phase !== 'idle' &&
      React.createElement(
        Box,
        { marginBottom: 1 },
        React.createElement(WatchingBadge, {
          phase: editSession.phase,
          changeCount: editSession.changeCount,
          lastUpdated: editSession.lastUpdated,
        }),
      ),
    // §8 VS Code unavailable: the failed handoff is no silent dead-end — the
    // fallback menu offers system editor / show path / retry.
    editSession?.openFailedReason &&
      React.createElement(
        Box,
        { marginBottom: 1 },
        React.createElement(FallbackMenu, {
          reason: editSession.openFailedReason,
          filePath: editSession.filePath,
          onSystemEditor: () => editFallback.systemEditor(editSession.filePath),
          onRetry: () => editFallback.retry(editSession.filePath),
          onDismiss: () => editFallback.dismiss(editSession.filePath),
        }),
      ),
    React.createElement(
      Box,
      { flexDirection: 'column', gap: 1, flexGrow: 1 },
      ...renderCategoryGrid(profile.resourceCounts, colWidth, cursor, focused ?? false),
    ),
    focused &&
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { dimColor: true }, t('main.drillIn')),
      ),
    React.createElement(
      Box,
      { marginTop: 1 },
      liveProfileHints.length > 0
        ? React.createElement(
            Text,
            { color: 'cyan', wrap: 'wrap' },
            liveProfileHints
              .map((k) => {
                const hint = PROFILE_HINTS.find((h) => h.key === k);
                return hint ? `[${hint.key}]${t(hint.labelKey)}` : '';
              })
              .filter(Boolean)
              .join(' '),
          )
        : React.createElement(
            Text,
            { dimColor: true, wrap: 'wrap' },
            t('guidance.hints.knowRopes'),
          ),
    ),
  );

  function renderCategoryGrid(
    counts: ResourceCounts,
    colW: number,
    cursorIdx: number,
    isFocused: boolean,
  ): React.ReactElement[] {
    const rows: React.ReactElement[] = [];
    for (let i = 0; i < CATEGORIES.length; i += 2) {
      const left = CATEGORIES[i];
      const right = i + 1 < CATEGORIES.length ? CATEGORIES[i + 1] : null;

      rows.push(
        React.createElement(
          Box,
          { key: left.key, gap: 1 },
          renderCategoryCard(left, counts[left.key], colW, i === cursorIdx && isFocused),
          right
            ? renderCategoryCard(
                right,
                counts[right.key as CategoryKey],
                colW,
                i + 1 === cursorIdx && isFocused,
              )
            : React.createElement(Box, { width: colW }),
        ),
      );
    }
    return rows;
  }

  function renderCategoryCard(
    def: CategoryDef,
    count: number,
    colW: number,
    highlighted: boolean,
  ): React.ReactElement {
    const drillHint = def.drillable
      ? def.key === 'userMemory'
        ? ` ${t('main.drillUserMemory')}`
        : def.key === 'agents'
          ? ` ${t('main.drillAgents')}`
          : ` ${t('main.drillBulk')}`
      : '';
    // Empty-category offer: `[a] add` (Skills also name the Copy/Link choice).
    const emptyLabel =
      count === 0
        ? def.key === 'skills'
          ? t('empty.category.skills')
          : t('empty.category')
        : null;
    const diffHint = diffCategoryFor(def.key) ? t('resource.diff.gridHint') : null;

    return React.createElement(
      Box,
      {
        flexDirection: 'column',
        width: colW,
        borderStyle: 'round',
        paddingX: 1,
      },
      React.createElement(
        Text,
        { bold: true, inverse: highlighted, color: highlighted ? 'cyan' : undefined, wrap: 'wrap' },
        `${highlighted ? '▸ ' : ''}${t(def.labelKey)}`,
      ),
      React.createElement(Text, null, `${count}`),
      drillHint && React.createElement(Text, { dimColor: true, wrap: 'wrap' }, drillHint),
      diffHint && React.createElement(Text, { dimColor: true, wrap: 'wrap' }, diffHint),
      emptyLabel && React.createElement(Text, { dimColor: true, wrap: 'wrap' }, emptyLabel),
    );
  }
}
