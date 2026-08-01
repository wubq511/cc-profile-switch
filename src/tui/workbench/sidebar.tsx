import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import { useI18n } from './i18n/react';
import type { LocaleKey } from './i18n/en';
import {
  LIFECYCLE_ACTIONS,
  LAUNCH_ACTIONS,
  TEMPLATE_LIST,
  type LifecycleState,
  type LifecycleAction,
  type LifecyclePromptKind,
} from './lifecycle';
import type { WorkbenchProfile } from './profile-data';

type SidebarProps = {
  profiles: WorkbenchProfile[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  width: number;
  height: number;
  capture: boolean;
  headless?: boolean;
  lifecycle: LifecycleState;
  wizardOpen?: boolean;
  /** When true, resource navigation owns arrow keys and action keys. */
  resourceNavActive?: boolean;
  onLifecycleAction: (action: LifecycleAction) => void;
  onAction: (
    action: LifecycleAction,
    profileName: string,
    input: string,
    selectedTemplate: string | null,
  ) => void;
  onLaunchBar: (profileName: string) => void;
  onLaunchDirScreen: (profileName: string) => void;
  onAddSkill?: (profileName: string) => void;
};

export function Sidebar({
  profiles,
  selectedIndex,
  onSelect,
  width,
  height,
  capture,
  headless,
  lifecycle,
  wizardOpen,
  resourceNavActive = false,
  onLifecycleAction,
  onAction,
  onLaunchBar,
  onLaunchDirScreen,
  onAddSkill,
}: SidebarProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [templateIndex, setTemplateIndex] = useState(0);

  const filtered = searchQuery
    ? profiles.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.description.toLowerCase().includes(searchQuery.toLowerCase()))
    : profiles;

  const filteredIndex = (originalIndex: number): number => {
    const profile = profiles[originalIndex];
    return filtered.findIndex((f) => f.name === profile.name);
  };

  const listHeight = Math.max(1, height - 4);
  const canUseInput = !headless && inkStdin.isTTY;
  const launchActive = lifecycle.launch.phase !== 'idle';

  useInput((input: string, key: Record<string, boolean>) => {
    if (capture || wizardOpen) return;

    // Lifecycle prompt input handling (highest priority)
    if (lifecycle.phase === 'prompting') {
      if (key.escape) {
        onLifecycleAction({ type: 'CANCEL' });
        return;
      }
      if (lifecycle.kind === 'create' && lifecycle.step === 1) {
        if (key.upArrow) {
          setTemplateIndex((i) => (i > 0 ? i - 1 : TEMPLATE_LIST.length - 1));
          return;
        }
        if (key.downArrow) {
          setTemplateIndex((i) => (i < TEMPLATE_LIST.length - 1 ? i + 1 : 0));
          return;
        }
        if (key.return) {
          const template = TEMPLATE_LIST[templateIndex] ?? 'general';
          onLifecycleAction({ type: 'SELECT_TEMPLATE', templateName: template });
          onLifecycleAction({ type: 'NEXT_STEP' });
          return;
        }
        return;
      }
      if (key.backspace || key.delete) {
        onLifecycleAction({ type: 'BACKSPACE' });
        return;
      }
      if (key.return) {
        onLifecycleAction({ type: 'SUBMIT' });
        onAction(
          { type: 'SUBMIT' },
          lifecycle.profileName,
          lifecycle.input,
          lifecycle.selectedTemplate,
        );
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        onLifecycleAction({ type: 'INPUT_CHAR', char: input });
        return;
      }
      return;
    }

    // Dismiss success/error
    if (lifecycle.phase === 'success' || lifecycle.phase === 'error') {
      if (key.escape || key.return || input === ' ') {
        onLifecycleAction({ type: 'DISMISS' });
        return;
      }
    }

    // Search input handling
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

    // Launch flow keys (only when idle and not in launch flow)
    if (lifecycle.phase === 'idle' && !launchActive && !resourceNavActive) {
      const profile = filtered[filteredIndex(selectedIndex)];
      if (profile) {
        if (input === 'l') {
          onLaunchBar(profile.name);
          return;
        }
        if (input === 'L') {
          onLaunchDirScreen(profile.name);
          return;
        }
        if (input === 'a' && onAddSkill) {
          onAddSkill(profile.name);
          return;
        }
        // Note: 'd' is already used for 'default' in LIFECYCLE_ACTIONS.
        // The dry-run key will be triggered from the pre-launch bar.
      }
    }

    // Lifecycle action keys (only when idle)
    if (lifecycle.phase === 'idle' && !launchActive && !resourceNavActive) {
      for (const act of LIFECYCLE_ACTIONS) {
        if (input === act.key) {
          const profile = filtered[filteredIndex(selectedIndex)];
          if (!profile) return;

          if (act.kind === 'validate' || act.kind === 'backup' || act.kind === 'default') {
            const immediateAction: LifecycleAction = {
              type: 'START_IMMEDIATE',
              kind: act.kind,
              profileName: profile.name,
            };
            onLifecycleAction(immediateAction);
            onAction(immediateAction, profile.name, '', null);
          } else {
            onLifecycleAction({
              type: 'START_PROMPT',
              kind: act.kind,
              profileName: profile.name,
            });
            if (act.kind === 'create') {
              setTemplateIndex(0);
            }
          }
          return;
        }
      }
    }

    // Navigation (skipped entirely while a resource view owns the keys)
    if (resourceNavActive) return;
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
  }, { isActive: canUseInput && !capture && !wizardOpen });

  // Auto-dismiss success after 1.5s
  useEffect(() => {
    if (lifecycle.phase !== 'success') return;
    const timer = setTimeout(() => {
      onLifecycleAction({ type: 'DISMISS' });
    }, 1500);
    return () => clearTimeout(timer);
  }, [lifecycle.phase, lifecycle.message]);

  // Auto-dismiss launch exit flash after 3s
  useEffect(() => {
    if (lifecycle.launch.phase !== 'exited') return;
    const timer = setTimeout(() => {
      onLifecycleAction({ type: 'LAUNCH_DISMISS' });
    }, 3000);
    return () => clearTimeout(timer);
  }, [lifecycle.launch.phase, lifecycle.launch.exitCode]);

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
    // Lifecycle UI sections
    lifecycle.phase === 'idle' && !launchActive && React.createElement(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      React.createElement(
        Text,
        { dimColor: true },
        LIFECYCLE_ACTIONS.map((a) => `[${a.key}]${t(a.labelKey)}`).join(' '),
      ),
      React.createElement(
        Text,
        { dimColor: true },
        `${LAUNCH_ACTIONS.map((a) => `[${a.key}]${t(a.labelKey)}`).join(' ')}[a]${t('skill.add')}`,
      ),
    ),
    lifecycle.phase === 'prompting' && React.createElement(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      lifecycle.kind === 'create' && lifecycle.step === 1
        ? React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(Text, { bold: true }, t('lifecycle.prompt.createTemplate')),
            ...TEMPLATE_LIST.map((tmpl, i) =>
              React.createElement(
                Text,
                { key: tmpl, color: i === templateIndex ? 'cyan' : undefined, bold: i === templateIndex },
                `${i === templateIndex ? '▸ ' : '  '}${tmpl}`,
              ),
            ),
          )
        : React.createElement(
            Box,
            null,
            React.createElement(Text, { bold: true }, promptLabel(lifecycle.kind, t)),
            React.createElement(Text, { color: 'cyan' }, `${lifecycle.input}█`),
          ),
    ),
    lifecycle.phase === 'executing' && React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(Text, { color: 'yellow' }, t('lifecycle.executing')),
    ),
    lifecycle.phase === 'success' && React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(Text, { color: 'green' }, `${t('lifecycle.success')} ${lifecycle.message}`),
    ),
    lifecycle.phase === 'error' && React.createElement(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      React.createElement(Text, { color: 'red' }, `${t('lifecycle.error')}: ${lifecycle.message}`),
      React.createElement(Text, { dimColor: true }, t('keymap.esc')),
    ),
    lifecycle.findings !== null && lifecycle.findings.length > 0 && React.createElement(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      ...lifecycle.findings.map((f, i) =>
        React.createElement(
          Text,
          { key: i, color: f.severity === 'error' ? 'red' : 'yellow' },
          `[${f.severity}] ${f.code}: ${f.message}`,
        ),
      ),
    ),
  );
}

function promptLabel(kind: LifecyclePromptKind | null, t: (key: LocaleKey) => string): string {
  switch (kind) {
    case 'rename': return t('lifecycle.prompt.rename');
    case 'copy': return t('lifecycle.prompt.copy');
    case 'remove': return t('lifecycle.prompt.remove');
    case 'create': return t('lifecycle.prompt.createName');
    default: return '';
  }
}
