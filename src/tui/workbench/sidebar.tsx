import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import { useI18n } from './i18n/react';
import type { WorkbenchProfile } from './profile-data';

type SidebarProps = {
  profiles: WorkbenchProfile[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  width: number;
  height: number;
  capture: boolean;
  headless?: boolean;
};

export function Sidebar({
  profiles,
  selectedIndex,
  onSelect,
  width,
  height,
  capture,
  headless,
}: SidebarProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const filtered = searchQuery
    ? profiles.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.description.toLowerCase().includes(searchQuery.toLowerCase()))
    : profiles;

  const filteredIndex = (originalIndex: number): number => {
    const profile = profiles[originalIndex];
    return filtered.findIndex((f) => f.name === profile.name);
  };

  const listHeight = Math.max(1, height - 4);
  const canUseInput = !headless && inkStdin.isTTY;

  useInput((input: string, key: Record<string, boolean>) => {
    if (capture) return;
    if (searchFocused) {
      if (key.escape) {
        setSearchFocused(false);
        setSearchQuery('');
        return;
      }
      if (key.return) {
        setSearchFocused(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q: string) => q.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        setSearchQuery((q: string) => q + input);
      }
      return;
    }
    if (input === '/') {
      setSearchFocused(true);
      return;
    }
    if (key.upArrow) {
      const currentFiltered = filteredIndex(selectedIndex);
      if (currentFiltered > 0) {
        onSelect(profiles.findIndex((p) => p.name === filtered[currentFiltered - 1].name));
      }
      return;
    }
    if (key.downArrow) {
      const currentFiltered = filteredIndex(selectedIndex);
      if (currentFiltered < filtered.length - 1) {
        onSelect(profiles.findIndex((p) => p.name === filtered[currentFiltered + 1].name));
      }
      return;
    }
  }, { isActive: canUseInput && !capture });

  return React.createElement(
    Box,
    { flexDirection: 'column', width, borderStyle: 'single', borderRight: true },
    React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(Text, { bold: true }, t('sidebar.title')),
    ),
    React.createElement(
      Box,
      { paddingX: 1 },
      searchFocused
        ? React.createElement(Text, { color: 'cyan' }, `/${searchQuery}█`)
        : React.createElement(Text, { dimColor: true }, t('sidebar.search.placeholder')),
    ),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      filtered.length === 0
        ? React.createElement(
            Box,
            { paddingX: 1, flexDirection: 'column' },
            React.createElement(Text, { dimColor: true }, t('sidebar.empty')),
            React.createElement(Text, { color: 'green' }, t('sidebar.empty.hint')),
          )
        : React.createElement(
            Box,
            { flexDirection: 'column' },
            ...filtered.slice(0, listHeight).map((profile) => {
              const isOriginalSelected = profiles[selectedIndex]?.name === profile.name;
              const marker = profile.isDefault ? ` [${t('sidebar.default')}]` : '';
              const lastUsed = profile.isLastUsed ? ` ${t('sidebar.lastUsed')}` : '';
              const totalResources = Object.values(profile.resourceCounts).reduce((a, b) => a + b, 0);

              return React.createElement(
                Box,
                { key: profile.name, paddingX: 1 },
                React.createElement(
                  Text,
                  {
                    bold: isOriginalSelected,
                    color: isOriginalSelected ? 'cyan' : undefined,
                    inverse: isOriginalSelected,
                  },
                  `${isOriginalSelected ? '▸ ' : '  '}${profile.name}${marker}${lastUsed} (${totalResources} ${t('sidebar.resources')})`,
                ),
              );
            }),
          ),
    ),
  );
}
