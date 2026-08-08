import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';
import type { LaunchState, RecentDir } from '../lifecycle';

type DirectoryScreenProps = {
  launch: LaunchState;
  width: number;
  height: number;
};

export function DirectoryScreen({ launch, width, height }: DirectoryScreenProps): React.ReactElement {
  const { t } = useI18n();
  const { recentDirs, recentIndex, dirInput } = launch;

  const listHeight = Math.max(1, height - 8);

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, borderStyle: 'round', paddingX: 1 },
    // Title
    React.createElement(Text, { bold: true }, t('launch.dir.title')),
    // Current directory
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, `${t('launch.dir.current')}: `),
      React.createElement(Text, { color: 'cyan' }, launch.dir),
    ),
    // Recent directories
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, { dimColor: true }, `${t('launch.dir.recents')}:`),
      recentDirs.length === 0
        ? React.createElement(Text, { dimColor: true }, `  ${t('common.none')}`)
        : React.createElement(
            Box,
            { flexDirection: 'column' },
            ...recentDirs.slice(0, listHeight).map((entry: RecentDir, i: number) => {
              const isSelected = i === recentIndex;
              return React.createElement(
                Box,
                { key: entry.path },
                React.createElement(
                  Text,
                  {
                    bold: isSelected,
                    color: isSelected ? 'cyan' : undefined,
                  },
                  `${isSelected ? '▸ ' : '  '}${i + 1}. ${entry.path}`,
                ),
              );
            }),
          ),
    ),
    // Path input
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, t('launch.dir.type')),
      React.createElement(Text, { color: 'cyan' }, `${dirInput}█`),
    ),
    // Hints
    React.createElement(
      Box,
      { marginTop: 1 },
      recentDirs.length > 0
        ? React.createElement(Text, { dimColor: true }, `${t('launch.dir.tab')} │ `)
        : null,
      React.createElement(Text, { dimColor: true }, t('launch.dir.enter')),
    ),
  );
}
