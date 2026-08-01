import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import { useHints } from './guidance';
import type { WorkbenchProfile, ResourceCounts } from './profile-data';

type MainPaneProps = {
  profile: WorkbenchProfile | undefined;
  mcpFailed?: string[];
  width: number;
  height: number;
};

const CATEGORIES = [
  { key: 'userMemory' as const, labelKey: 'main.category.userMemory' as const },
  { key: 'autoMemory' as const, labelKey: 'main.category.autoMemory' as const },
  { key: 'skills' as const, labelKey: 'main.category.skills' as const },
  { key: 'agents' as const, labelKey: 'main.category.agents' as const },
  { key: 'mcp' as const, labelKey: 'main.category.mcp' as const },
  { key: 'settings' as const, labelKey: 'main.category.settings' as const },
  { key: 'launchConfig' as const, labelKey: 'main.category.launchConfig' as const },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]['key'];

// Focused-element contextual hints (retire after HINT_RETIRE_AFTER uses).
const PROFILE_HINTS = [
  { key: 'l' as const, labelKey: 'lifecycle.launch' as const },
  { key: 'b' as const, labelKey: 'lifecycle.backup' as const },
  { key: 'x' as const, labelKey: 'lifecycle.remove' as const },
  { key: 'n' as const, labelKey: 'lifecycle.create' as const },
];

export function MainPane({ profile, mcpFailed, width, height }: MainPaneProps): React.ReactElement {
  const { t } = useI18n();
  const { liveKeys } = useHints();

  if (!profile) {
    return React.createElement(
      Box,
      { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width, height },
      React.createElement(Text, { dimColor: true }, t('main.selectProfile')),
    );
  }

  const colWidth = Math.floor((width - 4) / 2);
  const liveProfileHints = liveKeys(PROFILE_HINTS.map((h) => h.key));

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
    // Just-in-time amber nudge: MCP servers that failed to connect (§5).
    (mcpFailed?.length ?? 0) > 0 && React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(
        Text,
        { color: 'yellow', wrap: 'wrap' },
        `⚠ ${t('mcp.failed').replace('{name}', mcpFailed.join(', '))}`,
      ),
    ),
    React.createElement(
      Box,
      { flexDirection: 'column', gap: 1, flexGrow: 1 },
      ...renderCategoryGrid(profile.resourceCounts, colWidth),
    ),
    React.createElement(
      Box,
      { marginTop: 1 },
      liveProfileHints.length > 0
        ? React.createElement(
            Text,
            { color: 'cyan', wrap: 'wrap' },
            liveProfileHints.map((k) => {
              const hint = PROFILE_HINTS.find((h) => h.key === k);
              return hint ? `[${hint.key}]${t(hint.labelKey)}` : '';
            }).filter(Boolean).join(' '),
          )
        : React.createElement(Text, { dimColor: true, wrap: 'wrap' }, t('guidance.hints.knowRopes')),
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
          renderCategoryCard(left.key, left.labelKey, counts[left.key], colW),
          right
            ? renderCategoryCard(right.key, right.labelKey, counts[right.key as CategoryKey], colW)
            : React.createElement(Box, { width: colW }),
        ),
      );
    }
    return rows;
  }

  function renderCategoryCard(
    key: string,
    labelKey: (typeof CATEGORIES)[number]['labelKey'],
    count: number,
    colW: number,
  ): React.ReactElement {
    // Empty-category offer: `[a] add` (Skills also name the Copy/Link choice).
    const emptyLabel =
      count === 0
        ? key === 'skills'
          ? t('empty.category.skills')
          : t('empty.category')
        : null;

    return React.createElement(
      Box,
      { flexDirection: 'column', width: colW, borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, { bold: true, wrap: 'wrap' }, t(labelKey)),
      React.createElement(Text, null, `${count}`),
      emptyLabel && React.createElement(Text, { dimColor: true, wrap: 'wrap' }, emptyLabel),
    );
  }
}
