import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import type { SearchResult } from '../../core/resource/types';
import { useI18n } from './i18n/react';
import type { LocaleKey } from './i18n/en';
import { NoMatchEmptyState, useHints, ZeroProfilesEmptyState } from './guidance';
import {
  LIFECYCLE_ACTIONS,
  LAUNCH_ACTIONS,
  getTemplateList,
  type LifecycleState,
  type LifecycleAction,
  type LifecyclePromptKind,
} from './lifecycle';
import { CATEGORIES } from './main-pane';
import type { CustomTemplateSummary, WorkbenchProfile } from './profile-data';
import {
  buildSidebarRows,
  SIDEBAR_CATEGORY_KEYS,
  type CategoryKey,
  type TreeRow,
} from './sidebar-tree';

const CATEGORY_LABEL_KEYS: Record<CategoryKey, LocaleKey> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c.labelKey]),
) as Record<CategoryKey, LocaleKey>;

/** Debounce for the cross-profile content search behind the sidebar box. */
const CONTENT_SEARCH_DEBOUNCE_MS = 200;

type TemplateOption = { name: string; source: 'built-in' | 'custom' };

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
  /** Custom templates listed after the built-ins in the create picker (§11.3). */
  customTemplates?: CustomTemplateSummary[];
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
  /** Drill from a tree category/item row into the category's surface (#83). */
  onDrillCategory?: (profileName: string, categoryKey: CategoryKey, itemName?: string) => void;
  /** Jump to a cross-profile content hit surfaced by sidebar search (#83). */
  onJumpContentHit?: (hit: SearchResult) => void;
  /** Cross-profile content search backing the sidebar box (searchAllResources). */
  onSearchContent?: (query: string) => Promise<SearchResult[]>;
  /** Reports search-box focus so the app can suppress its top-level keys
   * while the box owns input (issue #83/#84). */
  onSearchFocusChange?: (focused: boolean) => void;
  /** Zero-confirm removal of a custom template from the create picker (S104). */
  onRemoveCustomTemplate?: (templateName: string) => void;
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
  customTemplates = [],
  onLifecycleAction,
  onAction,
  onLaunchBar,
  onLaunchDirScreen,
  onAddSkill,
  onDrillCategory,
  onJumpContentHit,
  onSearchContent,
  onSearchFocusChange,
  onRemoveCustomTemplate,
}: SidebarProps): React.ReactElement {
  const { t } = useI18n();
  const { markUsed, liveKeys } = useHints();
  const { stdin: inkStdin } = useStdin();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [templateIndex, setTemplateIndex] = useState(0);
  // Card-tree state (§4.1): user-driven expansion plus a cursor over the
  // visible rows; search auto-expands inside buildSidebarRows instead.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [rowCursor, setRowCursor] = useState(0);
  const [contentHits, setContentHits] = useState<SearchResult[]>([]);
  // First-search-focus tip: shown only during the first search focus of the
  // session, then gone for good (§5 discovery tips).
  const searchTipShown = useRef(false);
  const [searchTipVisible, setSearchTipVisible] = useState(false);

  const categoryLabels = useMemo(
    () =>
      Object.fromEntries(
        SIDEBAR_CATEGORY_KEYS.map((key) => [key, t(CATEGORY_LABEL_KEYS[key])]),
      ) as Record<CategoryKey, string>,
    [t],
  );

  const rows = useMemo(
    () =>
      buildSidebarRows({
        profiles,
        expanded,
        query: searchQuery,
        categoryLabels,
        contentHits,
      }),
    [profiles, expanded, searchQuery, categoryLabels, contentHits],
  );

  // Debounced cross-profile content search (§4.2): hits become auto-expanded
  // content-hit rows. Stale responses are dropped via the cancelled flag.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !onSearchContent) {
      setContentHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      onSearchContent(q)
        .then((hits) => {
          if (!cancelled) setContentHits(hits);
        })
        .catch(() => {
          if (!cancelled) setContentHits([]);
        });
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, onSearchContent]);

  // Report search-box focus to the app (issue #83/#84): Ink broadcasts every
  // keypress to all active useInput handlers with no propagation stop, so the
  // app-level handler must know when this box owns input and stay quiet.
  useEffect(() => {
    onSearchFocusChange?.(searchFocused);
  }, [searchFocused, onSearchFocusChange]);

  // Keep the cursor inside the visible rows as filtering shrinks the tree.
  useEffect(() => {
    if (rowCursor >= rows.length) {
      setRowCursor(Math.max(0, rows.length - 1));
    }
  }, [rows.length, rowCursor]);

  // Follow external selection changes (e.g. content-hit jumps, launch remount)
  // unless the cursor already sits inside the selected Profile's subtree.
  useEffect(() => {
    const selected = profiles[selectedIndex];
    if (!selected) return;
    const current = rows[rowCursor];
    if (current && current.profileName === selected.name) return;
    const idx = rows.findIndex((r) => r.kind === 'profile' && r.profileName === selected.name);
    if (idx >= 0 && idx !== rowCursor) setRowCursor(idx);
  }, [selectedIndex, profiles, rows, rowCursor]);

  const moveCursor = (next: number): void => {
    const clamped = Math.max(0, Math.min(next, rows.length - 1));
    setRowCursor(clamped);
    const row = rows[clamped];
    if (!row) return;
    const profileIdx = profiles.findIndex((p) => p.name === row.profileName);
    if (profileIdx >= 0 && profileIdx !== selectedIndex) onSelect(profileIdx);
  };

  const toggleExpand = (profileName: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(profileName)) {
        next.delete(profileName);
      } else {
        next.add(profileName);
      }
      return next;
    });
  };

  const focusSearch = (): void => {
    markUsed('/');
    setSearchFocused(true);
    if (!searchTipShown.current) {
      searchTipShown.current = true;
      setSearchTipVisible(true);
    }
  };

  const listHeight = Math.max(1, height - 4);
  const canUseInput = !headless && inkStdin.isTTY;
  const launchActive = lifecycle.launch.phase !== 'idle';
  const searchActive = searchQuery.trim().length > 0;

  const cursorRow: TreeRow | undefined = rows[rowCursor];
  const cursorProfile = cursorRow
    ? profiles.find((p) => p.name === cursorRow.profileName)
    : profiles[selectedIndex];

  // Create-flow template picker: built-ins first, then customs with a clear
  // source distinction (§11.3). Arrows wrap over the combined selectable list.
  const templateOptions: TemplateOption[] = [
    ...getTemplateList().map((name): TemplateOption => ({ name, source: 'built-in' })),
    ...customTemplates.map((c): TemplateOption => ({ name: c.name, source: 'custom' })),
  ];
  // Clamp after a zero-confirm custom-template removal shrinks the list.
  const safeTemplateIndex = Math.min(templateIndex, Math.max(0, templateOptions.length - 1));

  useInput((input: string, key: Record<string, boolean>) => {
    if (capture || wizardOpen) return;

    // Destructive-action panel input is owned by the app (full-width dialog).
    if (lifecycle.phase === 'confirm') return;

    // Lifecycle prompt input handling (highest priority)
    if (lifecycle.phase === 'prompting') {
      if (key.escape) {
        onLifecycleAction({ type: 'CANCEL' });
        return;
      }
      if (lifecycle.kind === 'create' && lifecycle.step === 1) {
        if (key.upArrow) {
          setTemplateIndex((i) => (i > 0 ? i - 1 : templateOptions.length - 1));
          return;
        }
        if (key.downArrow) {
          setTemplateIndex((i) => (i < templateOptions.length - 1 ? i + 1 : 0));
          return;
        }
        if (input === 'x') {
          // Zero-confirm removal, custom templates only (S104); built-ins are
          // not removable.
          const option = templateOptions[safeTemplateIndex];
          if (option?.source === 'custom') {
            onRemoveCustomTemplate?.(option.name);
          }
          return;
        }
        if (key.return) {
          const template = templateOptions[safeTemplateIndex]?.name ?? 'general';
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

    // Search box input (§4.2): Esc clears; ↓/Enter returns to the filtered list.
    if (searchFocused) {
      if (key.escape) {
        setSearchFocused(false);
        setSearchTipVisible(false);
        setSearchQuery('');
        return;
      }
      if (key.return || key.downArrow) {
        setSearchFocused(false);
        setSearchTipVisible(false);
        moveCursor(0);
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
      if (cursorProfile) {
        if (input === 'l') {
          markUsed('l');
          onLaunchBar(cursorProfile.name);
          return;
        }
        if (input === 'L') {
          markUsed('L');
          onLaunchDirScreen(cursorProfile.name);
          return;
        }
        if (input === 'a' && onAddSkill) {
          markUsed('a');
          onAddSkill(cursorProfile.name);
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
          // Create works even with zero Profiles (the zero-Profile recipe
          // offers [n] — no selected Profile is needed to create one).
          if (act.kind === 'create') {
            markUsed(act.key);
            setTemplateIndex(0);
            onLifecycleAction({ type: 'START_PROMPT', kind: 'create', profileName: '' });
            return;
          }

          if (!cursorProfile) return;

          if (act.kind === 'validate' || act.kind === 'backup' || act.kind === 'default') {
            const immediateAction: LifecycleAction = {
              type: 'START_IMMEDIATE',
              kind: act.kind,
              profileName: cursorProfile.name,
            };
            markUsed(act.key);
            onLifecycleAction(immediateAction);
            onAction(immediateAction, cursorProfile.name, '', null);
          } else if (act.kind === 'remove') {
            // Workbench removal opens the inline destructive panel (§9.1).
            markUsed(act.key);
            onLifecycleAction({ type: 'START_CONFIRM', kind: act.kind, profileName: cursorProfile.name });
          } else {
            onLifecycleAction({
              type: 'START_PROMPT',
              kind: act.kind,
              profileName: cursorProfile.name,
            });
            markUsed(act.key);
          }
          return;
        }
      }
    }

    // Navigation (skipped entirely while a resource view owns the keys)
    if (resourceNavActive) return;
    if (input === '/') {
      focusSearch();
      return;
    }
    if (key.upArrow) {
      // ↑ past the top of the list focuses the search box (§4.2).
      if (rowCursor <= 0) {
        focusSearch();
      } else {
        moveCursor(rowCursor - 1);
      }
      return;
    }
    if (key.downArrow) {
      moveCursor(rowCursor + 1);
      return;
    }
    if (key.rightArrow) {
      if (cursorRow?.kind === 'profile' && !searchActive) {
        setExpanded((prev) => new Set(prev).add(cursorRow.profileName));
      }
      return;
    }
    if (key.leftArrow) {
      if (cursorRow?.kind === 'profile' && !searchActive) {
        if (expanded.has(cursorRow.profileName)) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.delete(cursorRow.profileName);
            return next;
          });
        }
      } else if (cursorRow && cursorRow.kind !== 'profile') {
        // Jump back to the parent Profile row.
        const parentIdx = rows.findIndex(
          (r) => r.kind === 'profile' && r.profileName === cursorRow.profileName,
        );
        if (parentIdx >= 0) setRowCursor(parentIdx);
      }
      return;
    }
    if (key.return) {
      if (!cursorRow) return;
      if (cursorRow.kind === 'profile') {
        if (!searchActive) toggleExpand(cursorRow.profileName);
        return;
      }
      if (cursorRow.kind === 'category') {
        onDrillCategory?.(cursorRow.profileName, cursorRow.categoryKey);
        return;
      }
      if (cursorRow.kind === 'item') {
        onDrillCategory?.(cursorRow.profileName, cursorRow.categoryKey, cursorRow.itemName);
        return;
      }
      onJumpContentHit?.(cursorRow.hit);
      return;
    }
  }, { isActive: canUseInput && !capture && !wizardOpen });

  // Auto-dismiss success after 1.5s (generation counter: messageId, not message,
  // so an identical repeat flash still resets its timer — issue #76).
  useEffect(() => {
    if (lifecycle.phase !== 'success') return;
    const timer = setTimeout(() => {
      onLifecycleAction({ type: 'DISMISS' });
    }, 1500);
    return () => clearTimeout(timer);
  }, [lifecycle.phase, lifecycle.messageId]);

  // Auto-dismiss launch exit flash after 3s
  useEffect(() => {
    if (lifecycle.launch.phase !== 'exited') return;
    const timer = setTimeout(() => {
      onLifecycleAction({ type: 'LAUNCH_DISMISS' });
    }, 3000);
    return () => clearTimeout(timer);
  }, [lifecycle.launch.phase, lifecycle.launch.exitCode]);

  // Retiring contextual hints: a key's hint drops after HINT_RETIRE_AFTER uses.
  const lifecycleLive = liveKeys(LIFECYCLE_ACTIONS.map((a) => a.key));
  const launchLive = liveKeys(LAUNCH_ACTIONS.map((a) => a.key));
  const skillsLive = liveKeys(['a']);
  const allHintsRetired = lifecycleLive.length === 0 && launchLive.length === 0;

  // Follow-the-cursor scroll window over the visible rows.
  const windowStart = Math.max(0, Math.min(rowCursor - listHeight + 1, rows.length - listHeight));
  const visibleRows = rows.slice(windowStart, windowStart + listHeight);

  const renderRow = (row: TreeRow, absoluteIndex: number): React.ReactElement => {
    const isCursor = absoluteIndex === rowCursor;
    const profile = profiles.find((p) => p.name === row.profileName);

    if (row.kind === 'profile') {
      const marker = profile?.isDefault ? ` [${t('sidebar.default')}]` : '';
      const lastUsed = profile?.isLastUsed ? ` ${t('sidebar.lastUsed')}` : '';
      const totalResources = profile
        ? Object.values(profile.resourceCounts).reduce((a, b) => a + b, 0)
        : 0;
      const chevron = searchActive || expanded.has(row.profileName) ? '▾' : '▸';
      return React.createElement(
        Box,
        { key: `p:${row.profileName}`, paddingX: 1 },
        React.createElement(
          Text,
          {
            bold: isCursor,
            color: isCursor ? 'cyan' : undefined,
            inverse: isCursor,
            wrap: 'truncate',
          },
          `${chevron} ${row.profileName}${marker}${lastUsed} (${totalResources} ${t('sidebar.resources')})`,
        ),
      );
    }

    if (row.kind === 'category') {
      const count = profile ? profile.resourceCounts[row.categoryKey] : 0;
      return React.createElement(
        Box,
        { key: `c:${row.profileName}:${row.categoryKey}`, paddingX: 1 },
        React.createElement(
          Text,
          {
            bold: isCursor,
            color: isCursor ? 'cyan' : undefined,
            inverse: isCursor,
            wrap: 'truncate',
          },
          `  ${categoryLabels[row.categoryKey]} (${count})`,
        ),
      );
    }

    if (row.kind === 'item') {
      return React.createElement(
        Box,
        { key: `i:${row.profileName}:${row.categoryKey}:${row.itemName}`, paddingX: 1 },
        React.createElement(
          Text,
          {
            color: isCursor ? 'cyan' : undefined,
            inverse: isCursor,
            dimColor: !isCursor,
            wrap: 'truncate',
          },
          `    ${row.itemName}`,
        ),
      );
    }

    return React.createElement(
      Box,
      { key: `h:${row.profileName}:${row.hit.relativePath}:${row.hit.lineNumber}`, paddingX: 1 },
      React.createElement(
        Text,
        {
          color: isCursor ? 'cyan' : 'yellow',
          inverse: isCursor,
          wrap: 'truncate',
        },
        `    ↳ ${row.hit.matchLine.trim()} (${t('sidebar.search.hitLine')} ${row.hit.lineNumber})`,
      ),
    );
  };

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
      { paddingX: 1, flexDirection: 'column' },
      searchFocused
        ? React.createElement(Text, { color: 'cyan' }, `/${searchQuery}█`)
        : searchActive
          ? React.createElement(Text, { color: 'cyan' }, `/${searchQuery}`)
          : React.createElement(Text, { dimColor: true }, t('sidebar.search.placeholder')),
      searchFocused && searchQuery === '' && searchTipVisible &&
        React.createElement(Text, { dimColor: true, wrap: 'wrap' }, t('search.tip')),
    ),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      rows.length === 0
        ? searchActive
          ? React.createElement(
              NoMatchEmptyState,
              { query: searchQuery },
            )
          : React.createElement(
              ZeroProfilesEmptyState,
              null,
            )
        : React.createElement(
            Box,
            { flexDirection: 'column' },
            ...visibleRows.map((row, i) => renderRow(row, windowStart + i)),
          ),
    ),
    // Lifecycle UI sections
    lifecycle.phase === 'idle' && !launchActive && React.createElement(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      allHintsRetired && skillsLive.length === 0
        ? React.createElement(Text, { dimColor: true, wrap: 'wrap' }, t('guidance.hints.knowRopes'))
        : React.createElement(
            Box,
            { flexDirection: 'column' },
            lifecycleLive.length > 0 &&
              React.createElement(
                Text,
                { dimColor: true, wrap: 'wrap' },
                LIFECYCLE_ACTIONS.filter((a) => lifecycleLive.includes(a.key)).map((a) => `[${a.key}] ${t(a.labelKey)}`).join('  '),
              ),
            launchLive.length > 0 &&
              React.createElement(
                Text,
                { dimColor: true, wrap: 'wrap' },
                LAUNCH_ACTIONS.filter((a) => launchLive.includes(a.key)).map((a) => `[${a.key}] ${t(a.labelKey)}`).join('  '),
              ),
            skillsLive.length > 0 &&
              React.createElement(
                Text,
                { dimColor: true, wrap: 'wrap' },
                `[a] ${t('skill.add')}`,
              ),
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
            React.createElement(Text, { dimColor: true }, t('template.section.builtin')),
            ...getTemplateList().map((tmpl, i) =>
              React.createElement(
                Text,
                {
                  key: tmpl,
                  color: i === safeTemplateIndex ? 'cyan' : undefined,
                  bold: i === safeTemplateIndex,
                },
                `${i === safeTemplateIndex ? '▸ ' : '  '}${tmpl}`,
              ),
            ),
            ...(customTemplates.length > 0
              ? [
                  React.createElement(
                    Text,
                    { key: 'custom-header', dimColor: true },
                    t('template.section.custom'),
                  ),
                  ...customTemplates.map((custom, j) => {
                    const i = getTemplateList().length + j;
                    return React.createElement(
                      Text,
                      {
                        key: custom.name,
                        color: i === safeTemplateIndex ? 'cyan' : undefined,
                        bold: i === safeTemplateIndex,
                      },
                      `${i === safeTemplateIndex ? '▸ ' : '  '}${custom.name} (${t('template.source.custom')})`,
                    );
                  }),
                ]
              : []),
            templateOptions[safeTemplateIndex]?.source === 'custom' &&
              React.createElement(Text, { dimColor: true }, t('template.removeHint')),
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
    lifecycle.findings !== null && lifecycle.findings.length > 0 && React.createElement(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      ...lifecycle.findings.map((f, i) =>
        React.createElement(
          Text,
          { key: i, color: f.severity === 'error' ? 'red' : 'yellow', wrap: 'wrap' },
          `[${t(f.severity === 'error' ? 'finding.severity.error' : 'finding.severity.warning')}] ${f.code}: ${f.message}`,
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
    case 'save-template': return t('lifecycle.prompt.saveTemplate');
    default: return '';
  }
}
