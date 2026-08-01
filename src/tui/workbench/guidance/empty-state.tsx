// Recipe-style empty states (issue #76 §5): 2–3 line recipes with the concrete
// next step — never bare "nothing here". Copy wraps rather than truncates so it
// stays readable in the narrowest sidebar (~26 cols).

import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';

/** Zero-Profile state: what a Profile is + the [n] create offer. */
export function ZeroProfilesEmptyState(): React.ReactElement {
  const { t } = useI18n();

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, t('empty.noProfiles.title')),
    React.createElement(Text, { dimColor: true, wrap: 'wrap' }, t('empty.noProfiles.recipe')),
    React.createElement(Text, { color: 'green' }, t('empty.noProfiles.create')),
  );
}

/** No-match search state: what search covers + how to clear. */
export function NoMatchEmptyState({ query }: { query: string }): React.ReactElement {
  const { t } = useI18n();

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { bold: true, wrap: 'wrap' }, t('empty.noMatch.title').replace('{query}', query)),
    React.createElement(Text, { dimColor: true, wrap: 'wrap' }, t('empty.noMatch.recipe')),
    React.createElement(Text, { color: 'green' }, t('empty.noMatch.clear')),
  );
}
