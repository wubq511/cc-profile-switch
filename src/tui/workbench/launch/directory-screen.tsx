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
    // Current directory — long paths keep one row with leading-ellipsis
    // truncation so the tail never wraps flush against the border (V14).
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(
        Box,
        { flexShrink: 0 },
        React.createElement(Text, { color: 'gray' }, `${t('launch.dir.current')}: `),
      ),
      React.createElement(
        Box,
        { flexGrow: 1, minWidth: 0 },
        React.createElement(Text, { color: 'cyan', wrap: 'truncate-start' }, launch.dir),
      ),
    ),
    // Recent directories
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, { color: 'gray' }, `${t('launch.dir.recents')}:`),
      recentDirs.length === 0
        ? React.createElement(Text, { color: 'gray' }, `  ${t('common.none')}`)
        : React.createElement(
            Box,
            { flexDirection: 'column' },
            ...recentDirs.slice(0, listHeight).map((entry: RecentDir, i: number) => {
              const isSelected = i === recentIndex;
              // The `▸ n.` prefix keeps its slot; only the path truncates
              // (leading ellipsis), so the cursor marker survives (V14).
              return React.createElement(
                Box,
                { key: entry.path, flexDirection: 'row', flexShrink: 0 },
                React.createElement(
                  Box,
                  { flexShrink: 0 },
                  React.createElement(
                    Text,
                    {
                      bold: isSelected,
                      color: isSelected ? 'cyan' : undefined,
                    },
                    `${isSelected ? '▸ ' : '  '}${i + 1}. `,
                  ),
                ),
                React.createElement(
                  Box,
                  { flexGrow: 1, minWidth: 0 },
                  React.createElement(
                    Text,
                    {
                      bold: isSelected,
                      color: isSelected ? 'cyan' : undefined,
                      wrap: 'truncate-start',
                    },
                    entry.path,
                  ),
                ),
              );
            }),
          ),
    ),
    // Path input
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(
        Box,
        { flexShrink: 0 },
        React.createElement(Text, { color: 'gray' }, t('launch.dir.type')),
      ),
      React.createElement(
        Box,
        { flexGrow: 1, minWidth: 0 },
        React.createElement(Text, { color: 'cyan', wrap: 'truncate-start' }, `${dirInput}█`),
      ),
    ),
    // Hints
    React.createElement(
      Box,
      { marginTop: 1 },
      recentDirs.length > 0
        ? React.createElement(Text, { color: 'gray' }, `${t('launch.dir.tab')} │ `)
        : null,
      React.createElement(Text, { color: 'gray' }, t('launch.dir.enter')),
    ),
  );
}
