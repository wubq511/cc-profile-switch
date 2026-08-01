// Boxed error panel with numbered recovery steps (issue #76 §5).
// Errors render as a bordered panel; the CcpsError guidance becomes step 1.
// flexShrink={0} keeps Yoga from clipping the first row (prototype note, #29).

import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';

type ErrorPanelProps = {
  message: string;
  code?: string;
  guidance?: string;
};

export function ErrorPanel({ message, code, guidance }: ErrorPanelProps): React.ReactElement {
  const { t } = useI18n();

  const heading = code ? `${code}: ${message}` : message;

  return React.createElement(
    Box,
    { flexShrink: 0, flexDirection: 'column', borderStyle: 'round', borderColor: 'red', paddingX: 1 },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: 'red', bold: true }, '✗ '),
      React.createElement(Text, { color: 'red', wrap: 'wrap' }, heading),
    ),
    guidance !== undefined &&
      React.createElement(
        Box,
        null,
        React.createElement(Text, null, '  1. '),
        React.createElement(Text, { wrap: 'wrap' }, guidance),
      ),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, `[esc] ${t('keymap.esc')}`),
    ),
  );
}
