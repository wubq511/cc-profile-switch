import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';

type KeymapOverlayProps = {
  visible: boolean;
};

const KEYBINDINGS = [
  { key: '↑/↓', group: 'nav' as const, labelKey: 'keymap.up' as const },
  { key: 'Enter', group: 'nav' as const, labelKey: 'keymap.enter' as const },
  { key: 'Esc', group: 'nav' as const, labelKey: 'keymap.esc' as const },
  { key: '/', group: 'nav' as const, labelKey: 'keymap.search' as const },
  { key: '?', group: 'nav' as const, labelKey: 'keymap.help' as const },
  { key: 'q/Ctrl+C', group: 'nav' as const, labelKey: 'keymap.quit' as const },
  { key: 'l', group: 'actions' as const, labelKey: 'keymap.launch' as const },
  { key: 'e', group: 'actions' as const, labelKey: 'keymap.edit' as const },
  { key: 'b', group: 'actions' as const, labelKey: 'keymap.backup' as const },
  { key: 'x', group: 'actions' as const, labelKey: 'keymap.remove' as const },
];

export function KeymapOverlay({ visible }: KeymapOverlayProps): React.ReactElement | null {
  const { t } = useI18n();

  if (!visible) return null;

  const navBindings = KEYBINDINGS.filter((b) => b.group === 'nav');
  const actionBindings = KEYBINDINGS.filter((b) => b.group === 'actions');

  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', paddingX: 1, paddingY: 0 },
    React.createElement(Text, { bold: true }, t('keymap.title')),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.nav')),
    ),
    ...navBindings.map((b) =>
      React.createElement(
        Box,
        { key: b.key },
        React.createElement(Text, { color: 'cyan' }, `  ${b.key.padEnd(10)}`),
        React.createElement(Text, null, t(b.labelKey)),
      ),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.actions')),
    ),
    ...actionBindings.map((b) =>
      React.createElement(
        Box,
        { key: b.key },
        React.createElement(Text, { color: 'cyan' }, `  ${b.key.padEnd(10)}`),
        React.createElement(Text, null, t(b.labelKey)),
      ),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, 'Esc to close'),
    ),
  );
}
