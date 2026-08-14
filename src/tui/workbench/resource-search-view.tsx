import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { SearchResult } from '../../core/resource/types';

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

  // One row per hit (issue #98, V13): the label (kind + profile) gets a
  // bounded slot truncated with `…`, the match text fills the remainder — the
  // old three-row-per-hit blocks squeezed until the label overwrote the match
  // text mid-row. The list renders through a clipped follow-cursor window so
  // a long result set never squeezes rows into each other.
  const inner = width - 2; // paddingX
  const labelWidth = Math.max(20, Math.min(30, Math.ceil(inner * 0.48)));
  const windowSize = Math.max(1, height - 2); // title + list margin
  const start = Math.max(0, selectedIndex - Math.floor(windowSize / 2));
  const visibleResults = results.slice(start, start + windowSize);

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `${t('resource.search.title')} › ${query}█`,
    ),
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      results.length === 0
        ? React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(Text, { color: 'gray' }, t('resource.search.noResults')),
            React.createElement(Text, { color: 'gray' }, t('resource.preview.back')),
          )
        : visibleResults.map((hit, vi) => {
            const i = start + vi;
            const isSelected = i === selectedIndex;
            const label =
              hit.category === 'user-memory'
                ? t('resource.search.memoryMatch', { profile: hit.profileName })
                : t('resource.search.agentMatch', { profile: hit.profileName });
            const segmentProps = {
              inverse: isSelected,
              bold: isSelected,
            } as const;

            return React.createElement(
              Box,
              {
                key: `${hit.profileName}:${hit.relativePath}:${hit.lineNumber}`,
                flexDirection: 'row',
                flexShrink: 0,
              },
              // Layout slots live on Boxes — Ink <Text> ignores width and
              // flex props — with a single truncating Text inside each.
              React.createElement(
                Box,
                { flexShrink: 0 },
                React.createElement(
                  Text,
                  { ...segmentProps, color: isSelected ? 'cyan' : undefined },
                  `${isSelected ? '▸ ' : '  '}${hit.itemName}:${hit.lineNumber}`,
                ),
              ),
              React.createElement(
                Box,
                { flexShrink: 0 },
                React.createElement(Text, segmentProps, ' · '),
              ),
              React.createElement(
                Box,
                { width: labelWidth, flexShrink: 0 },
                React.createElement(Text, { ...segmentProps, wrap: 'truncate' }, label),
              ),
              React.createElement(
                Box,
                { flexShrink: 0 },
                React.createElement(Text, segmentProps, ' · '),
              ),
              React.createElement(
                Box,
                { flexGrow: 1, minWidth: 0 },
                React.createElement(
                  Text,
                  { ...segmentProps, color: 'gray', wrap: 'truncate' },
                  hit.matchLine.trim(),
                ),
              ),
            );
          }),
    ),
  );
}
