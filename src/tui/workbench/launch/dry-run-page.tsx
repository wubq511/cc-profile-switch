import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';
import type { LocaleKey } from '../i18n/en';
import { formatLaunchDryRun, type LaunchPlan } from '../../../core/launcher';

type DryRunPageProps = {
  plan: LaunchPlan;
  width: number;
  height: number;
};

export function DryRunPage({ plan, width, height }: DryRunPageProps): React.ReactElement {
  const { t } = useI18n();
  // Core formatLaunchDryRun stays English by default (CLI contract); the page
  // supplies its catalog-backed translator so the plan body renders localized.
  const dryRunText = formatLaunchDryRun(plan, (key, params) => t(key as LocaleKey, params));

  // Clip the plan body to the rows between the title bar and the hints bar
  // (issue #98, V6): an overlong plan used to paint over the hints bar. The
  // overflow line keeps the truncation honest instead of dropping lines
  // silently.
  const allLines = dryRunText.split('\n');
  const bodyRows = Math.max(1, height - 6); // title bar (3) + hints bar (3)
  const clipped = allLines.length > bodyRows;
  const lines = clipped ? allLines.slice(0, bodyRows - 1) : allLines;

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height },
    // Title bar
    React.createElement(
      Box,
      { borderStyle: 'round', paddingX: 1 },
      React.createElement(Text, { bold: true }, t('launch.dryrun.title')),
      React.createElement(Text, null, ' — '),
      React.createElement(Text, { color: 'gray' }, plan.profileName),
    ),
    // Plan content (clipped area)
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1, paddingX: 1, overflow: 'hidden' },
      ...lines.map((line: string, i: number) =>
        React.createElement(Text, { key: i, wrap: 'truncate' }, line),
      ),
      clipped
        ? React.createElement(
            Text,
            { color: 'gray' },
            t('launch.dryrun.more', { count: String(allLines.length - lines.length) }),
          )
        : null,
    ),
    // Action hints
    React.createElement(
      Box,
      { borderStyle: 'round', paddingX: 1, justifyContent: 'space-between' },
      React.createElement(Text, { color: 'green' }, t('launch.dryrun.enter')),
      React.createElement(Text, { color: 'gray' }, t('launch.dryrun.esc')),
    ),
  );
}
