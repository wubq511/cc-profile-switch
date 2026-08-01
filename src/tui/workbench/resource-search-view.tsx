import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { SearchResult } from '../../core/resource';

type ResourceSearchViewProps = {
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  width: number;
  height: number;
};

export function ResourceSearchView({
  query,
  results,
  selectedIndex,
  width,
  height,
}: ResourceSearchViewProps): React.ReactElement {
  const { t } = useI18n();

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(Text, { bold: true }, `${t('resource.search.title')} › ${query}█`),
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      results.length === 0
        ? React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(Text, { dimColor: true }, t('resource.search.noResults')),
            React.createElement(Text, { dimColor: true }, t('resource.preview.back')),
          )
        : results.map((hit, i) => {
            const isSelected = i === selectedIndex;
            const label =
              hit.category === 'user-memory'
                ? t('resource.search.memoryMatch').replace('{profile}', hit.profileName)
                : t('resource.search.agentMatch').replace('{profile}', hit.profileName);

            return React.createElement(
              Box,
              { key: `${hit.profileName}:${hit.relativePath}:${hit.lineNumber}`, flexDirection: 'column', marginBottom: 1 },
              React.createElement(
                Text,
                { inverse: isSelected, bold: isSelected },
                `${isSelected ? '▸ ' : '  '}${label} · ${hit.itemName}:${hit.lineNumber}`,
              ),
              React.createElement(Text, { dimColor: true, wrap: 'truncate' }, `    ${hit.matchLine}`),
            );
          }),
    ),
  );
}
