import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { WorkbenchProfile, ResourceCounts } from './profile-data';

type MainPaneProps = {
  profile: WorkbenchProfile | undefined;
  width: number;
  height: number;
  /** Whether the main pane holds keyboard focus (Tab-toggleable from sidebar). */
  focused?: boolean;
  /** Index of the highlighted category card when focused. */
  selectedCategoryIndex?: number;
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

export const CATEGORY_COUNT = CATEGORIES.length;

/** Category key at a given cursor index (mirrors the card grid order). */
export function categoryKeyAt(index: number): (typeof CATEGORIES)[number]['key'] | undefined {
  return CATEGORIES[index]?.key;
}

type CategoryKey = (typeof CATEGORIES)[number]['key'];

export function MainPane({ profile, width, height, focused, selectedCategoryIndex }: MainPaneProps): React.ReactElement {
  const { t } = useI18n();

  if (!profile) {
    return React.createElement(
      Box,
      { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width, height },
      React.createElement(Text, { dimColor: true }, t('main.selectProfile')),
    );
  }

  const colWidth = Math.floor((width - 4) / 2);
  const cursor = selectedCategoryIndex ?? 0;

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
      ...renderCategoryGrid(profile.resourceCounts, colWidth, cursor, focused ?? false),
    ),
    focused && React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, t('main.drillIn')),
    ),
  );

  function renderCategoryGrid(counts: ResourceCounts, colW: number, cursorIdx: number, isFocused: boolean): React.ReactElement[] {
    const rows: React.ReactElement[] = [];
    for (let i = 0; i < CATEGORIES.length; i += 2) {
      const left = CATEGORIES[i];
      const right = i + 1 < CATEGORIES.length ? CATEGORIES[i + 1] : null;

      rows.push(
        React.createElement(
          Box,
          { key: left.key, gap: 1 },
          renderCategoryCard(left.key, left.labelKey, counts[left.key], colW, i === cursorIdx && isFocused),
          right
            ? renderCategoryCard(right.key, right.labelKey, counts[right.key as CategoryKey], colW, i + 1 === cursorIdx && isFocused)
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
    highlighted: boolean,
  ): React.ReactElement {
    return React.createElement(
      Box,
      { flexDirection: 'column', width: colW, borderStyle: 'round', paddingX: 1 },
      React.createElement(
        Text,
        { bold: true, inverse: highlighted, color: highlighted ? 'cyan' : undefined },
        `${highlighted ? '▸ ' : ''}${t(labelKey)}`,
      ),
      React.createElement(Text, null, `${count}`),
    );
  }
}
