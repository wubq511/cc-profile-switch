// Inline destructive-action panel (issue #76 §5, spec §9.1).
// One consequence line plus the graduated options: [y] backup default,
// [u] no-backup → Recovery Bin, [esc] keep. The Workbench's own removal flow
// does NOT require exact-name typing — that is a frozen CLI-only contract.
// flexShrink={0} prevents clipping (prototype note, #29).

import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';
import type { WorkbenchProfile } from '../profile-data';

type RemoveProfilePanelProps = {
  profile: WorkbenchProfile;
};

export function RemoveProfilePanel({ profile }: RemoveProfilePanelProps): React.ReactElement {
  const { t } = useI18n();

  const consequence = t('destructive.removeConsequence')
    .replace('{skills}', String(profile.resourceCounts.skills))
    .replace('{agents}', String(profile.resourceCounts.agents));

  return React.createElement(
    Box,
    { flexShrink: 0, flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { bold: true }, t('destructive.removeTitle').replace('{name}', profile.name)),
    ),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { dimColor: true, wrap: 'wrap' }, consequence),
    ),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { wrap: 'wrap' }, t('destructive.backup')),
    ),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { wrap: 'wrap' }, t('destructive.noBackup')),
    ),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { dimColor: true, wrap: 'wrap' }, t('destructive.cancel')),
    ),
  );
}
