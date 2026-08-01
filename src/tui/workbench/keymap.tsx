import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { LocaleKey } from './i18n/en';

type KeymapOverlayProps = {
  visible: boolean;
};

type Binding = {
  key: string;
  group: 'nav' | 'actions' | 'resource' | 'discover' | 'bulk';
  labelKey: LocaleKey;
};

const KEYBINDINGS: Binding[] = [
  // Navigation
  { key: '↑/↓', group: 'nav', labelKey: 'keymap.up' },
  { key: '←/→', group: 'nav', labelKey: 'keymap.tree' },
  { key: 'Enter', group: 'nav', labelKey: 'keymap.enter' },
  { key: 'Esc', group: 'nav', labelKey: 'keymap.esc' },
  { key: '/', group: 'nav', labelKey: 'keymap.search' },
  { key: '?', group: 'nav', labelKey: 'keymap.help' },
  { key: 'q/Ctrl+C', group: 'nav', labelKey: 'keymap.quit' },
  // Profile lifecycle actions
  { key: 'l', group: 'actions', labelKey: 'keymap.launch' },
  { key: 'L', group: 'actions', labelKey: 'lifecycle.launchDir' },
  { key: 'a', group: 'actions', labelKey: 'skill.add' },
  { key: 'e', group: 'actions', labelKey: 'keymap.edit' },
  { key: 'n', group: 'actions', labelKey: 'lifecycle.create' },
  { key: 'c', group: 'actions', labelKey: 'lifecycle.copy' },
  { key: 'r', group: 'actions', labelKey: 'lifecycle.rename' },
  { key: 'd', group: 'actions', labelKey: 'lifecycle.default' },
  { key: 'v', group: 'actions', labelKey: 'lifecycle.validate' },
  { key: 'b', group: 'actions', labelKey: 'lifecycle.backup' },
  { key: 's', group: 'actions', labelKey: 'lifecycle.saveTemplate' },
  { key: 'x', group: 'actions', labelKey: 'lifecycle.remove' },
  // Resource rows (User Memory / Agents)
  { key: 'u', group: 'resource', labelKey: 'main.category.userMemory' },
  { key: 'a', group: 'resource', labelKey: 'main.category.agents' },
  { key: 'Enter', group: 'resource', labelKey: 'keymap.enter' },
  // Split per #83: sidebar `/` filters the tree cross-Profile; this `/`
  // searches content inside the current resource list only.
  { key: '/', group: 'resource', labelKey: 'keymap.searchResource' },
  { key: 'e', group: 'resource', labelKey: 'resource.edit' },
  { key: 'x', group: 'resource', labelKey: 'resource.remove' },
  { key: 'c', group: 'resource', labelKey: 'resource.copy' },
  { key: 'd', group: 'resource', labelKey: 'resource.diff.title' },
  { key: 'f', group: 'resource', labelKey: 'resource.agent.frontmatter.edit' },
  // Discover surface (spec §7.4)
  { key: '/', group: 'discover', labelKey: 'keymap.discover.search' },
  { key: 'Enter', group: 'discover', labelKey: 'keymap.discover.install' },
  { key: 's', group: 'discover', labelKey: 'keymap.discover.source' },
  { key: 'b', group: 'discover', labelKey: 'keymap.discover.browser' },
  { key: 'r', group: 'discover', labelKey: 'keymap.discover.refresh' },
  // Bulk ops surface (spec §11.1)
  { key: 'space', group: 'bulk', labelKey: 'keymap.bulk.select' },
  { key: 'a', group: 'bulk', labelKey: 'keymap.bulk.selectAll' },
  { key: 'x', group: 'bulk', labelKey: 'keymap.bulk.remove' },
  { key: 'c', group: 'bulk', labelKey: 'keymap.bulk.copy' },
  { key: 'u', group: 'bulk', labelKey: 'keymap.bulk.update' },
  { key: 'd', group: 'bulk', labelKey: 'keymap.bulk.discover' },
];

const CONCEPTS: Array<{ term: LocaleKey; definition: LocaleKey }> = [
  { term: 'keymap.concept.profile.term', definition: 'keymap.concept.profile.def' },
  { term: 'keymap.concept.copied.term', definition: 'keymap.concept.copied.def' },
  { term: 'keymap.concept.linked.term', definition: 'keymap.concept.linked.def' },
  { term: 'keymap.concept.backup.term', definition: 'keymap.concept.backup.def' },
  { term: 'keymap.concept.bin.term', definition: 'keymap.concept.bin.def' },
  { term: 'keymap.concept.plugins.term', definition: 'keymap.concept.plugins.def' },
];

export function KeymapOverlay({ visible }: KeymapOverlayProps): React.ReactElement | null {
  const { t } = useI18n();

  if (!visible) return null;

  const navBindings = KEYBINDINGS.filter((b) => b.group === 'nav');
  const actionBindings = KEYBINDINGS.filter((b) => b.group === 'actions');
  const resourceBindings = KEYBINDINGS.filter((b) => b.group === 'resource');
  const discoverBindings = KEYBINDINGS.filter((b) => b.group === 'discover');
  const bulkBindings = KEYBINDINGS.filter((b) => b.group === 'bulk');

  const renderRow = (bindings: Binding[]): React.ReactElement =>
    React.createElement(
      Box,
      { paddingX: 2, flexWrap: 'wrap' },
      ...bindings.map((b) =>
        React.createElement(
          Box,
          { key: b.key, marginRight: 2 },
          React.createElement(Text, { color: 'cyan' }, `[${b.key}]`),
          React.createElement(Text, { dimColor: true }, ` ${t(b.labelKey)}`),
        ),
      ),
    );

  return React.createElement(
    Box,
    { flexDirection: 'column', flexGrow: 1, paddingX: 1 },
    React.createElement(Text, { bold: true }, t('keymap.title')),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.nav')),
    ),
    renderRow(navBindings),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.actions')),
    ),
    renderRow(actionBindings),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.resources')),
    ),
    ...resourceBindings.map((b) =>
      React.createElement(
        Box,
        { key: b.key },
        React.createElement(Text, { color: 'cyan' }, `  ${b.key.padEnd(10)}`),
        React.createElement(Text, null, t(b.labelKey)),
      ),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.bulk')),
    ),
    ...bulkBindings.map((b) =>
      React.createElement(
        Box,
        { key: b.key },
        React.createElement(Text, { color: 'cyan' }, `  ${b.key.padEnd(10)}`),
        React.createElement(Text, null, t(b.labelKey)),
      ),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.discover')),
    ),
    renderRow(discoverBindings),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.concepts')),
    ),
    ...CONCEPTS.map((concept) =>
      React.createElement(
        Box,
        { key: concept.term, paddingX: 2 },
        React.createElement(Text, { wrap: 'wrap' },
          React.createElement(Text, { bold: true }, t(concept.term)),
          React.createElement(Text, null, ' — '),
          React.createElement(Text, null, t(concept.definition)),
        ),
      ),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { dimColor: true, wrap: 'wrap' },
        `${t('guidance.hints.fade')} · [esc] ${t('keymap.esc')}`,
      ),
    ),
  );
}
