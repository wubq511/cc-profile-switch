// Inline destructive-action panel (issue #76 §5, spec §9.1).
// One consequence line plus the graduated options: [y] backup default,
// [u] no-backup → Recovery Bin, [esc] keep. The Workbench's own removal flow
// does NOT require exact-name typing — that is a frozen CLI-only contract.
// flexShrink={0} prevents clipping (prototype note, #29).

import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';
import { GuidancePanel } from './panel';
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
    GuidancePanel,
    { borderColor: 'yellow' },
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

type SaveTemplatePanelProps = {
  templateName: string;
  strippedCount: number;
};

// Save-as-template light confirmation (spec §11.3): one stripping summary
// line plus [y] save / [esc] cancel. Nothing is written until [y]. Auto
// Memory exclusion is unconditional, so the summary copy states it outright.
export function SaveTemplatePanel({
  templateName,
  strippedCount,
}: SaveTemplatePanelProps): React.ReactElement {
  const { t } = useI18n();

  const summary = t('template.summary.stripped').replace('{count}', String(strippedCount));

  return React.createElement(
    GuidancePanel,
    { borderColor: 'yellow' },
    React.createElement(
      Box,
      null,
      React.createElement(Text, { bold: true }, t('template.confirm.title').replace('{name}', templateName)),
    ),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { dimColor: true, wrap: 'wrap' }, summary),
    ),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { wrap: 'wrap' }, t('template.confirm.save')),
    ),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { dimColor: true, wrap: 'wrap' }, t('template.confirm.cancel')),
    ),
  );
}
