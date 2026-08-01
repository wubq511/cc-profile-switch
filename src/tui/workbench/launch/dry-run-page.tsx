import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';
import { formatLaunchDryRun, type LaunchPlan } from '../../../core/launcher';

type DryRunPageProps = {
  plan: LaunchPlan;
  width: number;
  height: number;
};

export function DryRunPage({ plan, width, height }: DryRunPageProps): React.ReactElement {
  const { t } = useI18n();
  const dryRunText = formatLaunchDryRun(plan);

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height },
    // Title bar
    React.createElement(
      Box,
      { borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, { bold: true }, t('launch.dryrun.title')),
      React.createElement(Text, null, ' — '),
      React.createElement(Text, { dimColor: true }, plan.profileName),
    ),
    // Plan content (scrollable area)
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1, paddingX: 1 },
      ...dryRunText.split('\n').map((line: string, i: number) =>
        React.createElement(Text, { key: i, wrap: 'truncate' }, line),
      ),
    ),
    // Action hints
    React.createElement(
      Box,
      { borderStyle: 'round', paddingX: 1, justifyContent: 'space-between' },
      React.createElement(Text, { color: 'green' }, t('launch.dryrun.enter')),
      React.createElement(Text, { dimColor: true }, t('launch.dryrun.esc')),
    ),
  );
}
