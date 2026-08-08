// Boxed error panel with numbered recovery steps (issue #76 §5).
// The CcpsError guidance is split at sentence boundaries into numbered steps;
// a single-sentence guidance renders as step 1.

import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';
import { GuidancePanel } from './panel';

type ErrorPanelProps = {
  message: string;
  code?: string;
  guidance?: string;
};

/** Split guidance into numbered recovery steps at sentence boundaries. */
function splitSteps(guidance: string): string[] {
  return guidance
    .split(/\.\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function ErrorPanel({ message, code, guidance }: ErrorPanelProps): React.ReactElement {
  const { t } = useI18n();

  const heading = code ? `${code}: ${message}` : message;
  const steps = guidance !== undefined ? splitSteps(guidance) : [];

  return React.createElement(
    GuidancePanel,
    { borderColor: 'red' },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { color: 'red', bold: true }, '✗ '),
      React.createElement(Text, { color: 'red', wrap: 'wrap' }, heading),
    ),
    ...steps.map((step, i) =>
      React.createElement(
        Box,
        { key: i },
        React.createElement(Text, null, `  ${i + 1}. `),
        React.createElement(Text, { wrap: 'wrap' }, step),
      ),
    ),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, `[esc] ${t('keymap.esc')}`),
    ),
  );
}
