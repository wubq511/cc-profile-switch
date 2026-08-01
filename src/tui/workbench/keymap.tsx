import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { LocaleKey } from './i18n/en';

type KeymapOverlayProps = {
  visible: boolean;
};

type Binding = {
  key: string;
  group: 'nav' | 'actions';
  labelKey:
    | 'keymap.up'
    | 'keymap.down'
    | 'keymap.enter'
    | 'keymap.esc'
    | 'keymap.search'
    | 'keymap.help'
    | 'keymap.quit'
    | 'keymap.launch'
    | 'keymap.edit'
    | 'lifecycle.launchDir'
    | 'lifecycle.create'
    | 'lifecycle.copy'
    | 'lifecycle.rename'
    | 'lifecycle.default'
    | 'lifecycle.validate'
    | 'lifecycle.backup'
    | 'lifecycle.remove';
};

const KEYBINDINGS: Binding[] = [
  { key: '↑/↓', group: 'nav', labelKey: 'keymap.up' },
  { key: 'Enter', group: 'nav', labelKey: 'keymap.enter' },
  { key: 'Esc', group: 'nav', labelKey: 'keymap.esc' },
  { key: '/', group: 'nav', labelKey: 'keymap.search' },
  { key: '?', group: 'nav', labelKey: 'keymap.help' },
  { key: 'q/Ctrl+C', group: 'nav', labelKey: 'keymap.quit' },
  { key: 'l', group: 'actions', labelKey: 'keymap.launch' },
  { key: 'L', group: 'actions', labelKey: 'lifecycle.launchDir' },
  { key: 'e', group: 'actions', labelKey: 'keymap.edit' },
  { key: 'n', group: 'actions', labelKey: 'lifecycle.create' },
  { key: 'c', group: 'actions', labelKey: 'lifecycle.copy' },
  { key: 'r', group: 'actions', labelKey: 'lifecycle.rename' },
  { key: 'd', group: 'actions', labelKey: 'lifecycle.default' },
  { key: 'v', group: 'actions', labelKey: 'lifecycle.validate' },
  { key: 'b', group: 'actions', labelKey: 'lifecycle.backup' },
  { key: 'x', group: 'actions', labelKey: 'lifecycle.remove' },
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
