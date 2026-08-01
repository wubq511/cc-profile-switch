import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';
import type { LaunchState } from '../lifecycle';
import type { ValidationFinding } from '../../../core/validator';

type PreLaunchBarProps = {
  launch: LaunchState;
  width: number;
  profileName: string;
};

export function PreLaunchBar({ launch, width, profileName }: PreLaunchBarProps): React.ReactElement {
  const { t } = useI18n();
  const hasErrors = launch.validationFindings.some((f: ValidationFinding) => f.severity === 'error');
  const warnings = launch.validationFindings.filter((f: ValidationFinding) => f.severity === 'warning');

  return React.createElement(
    Box,
    { flexDirection: 'column', width, borderStyle: 'round', paddingX: 1 },
    // Title + directory
    React.createElement(
      Box,
      null,
      React.createElement(Text, { bold: true }, t('launch.bar.title')),
      React.createElement(Text, null, ' '),
      React.createElement(Text, { dimColor: true }, t('launch.bar.cwd')),
      React.createElement(Text, null, ' '),
      React.createElement(Text, { color: 'cyan' }, launch.dir),
    ),
    // Validation errors (inline, red)
    ...launch.validationFindings
      .filter((f: ValidationFinding) => f.severity === 'error')
      .map((f: ValidationFinding, i: number) =>
        React.createElement(
          Box,
          { key: `err-${i}` },
          React.createElement(
            Text,
            { color: 'red' },
            `✗ [${f.severity}] ${f.code}: ${f.message}`,
          ),
        ),
      ),
    // Validation warnings (inline, yellow)
    ...warnings.map((f: ValidationFinding, i: number) =>
      React.createElement(
        Box,
        { key: `warn-${i}` },
        React.createElement(
          Text,
          { color: 'yellow' },
          `⚠ [${f.severity}] ${f.code}: ${f.message}`,
        ),
      ),
    ),
    // Action hint
    React.createElement(
      Box,
      null,
      hasErrors
        ? React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(Text, { color: 'red' }, t('launch.bar.blocked')),
            React.createElement(Text, { dimColor: true }, t('launch.bar.validateHint').replace('{name}', profileName)),
          )
        : React.createElement(Text, { color: 'green' }, t('launch.bar.enter')),
    ),
  );
}
