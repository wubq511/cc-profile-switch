import React from 'react';
import { Box, Text } from 'ink';
import pc from 'picocolors';

import { useI18n } from '../i18n/react';

interface WatchingBadgeProps {
  phase: 'idle' | 'opening' | 'watching' | 'missing';
  changeCount: number;
  lastUpdated: Date | null;
}

export function WatchingBadge({ phase, changeCount, lastUpdated }: WatchingBadgeProps) {
  const { t } = useI18n();

  if (phase === 'idle') return null;

  if (phase === 'opening') {
    return (
      <Box>
        <Text>{pc.cyan('…opening')}</Text>
      </Box>
    );
  }

  if (phase === 'missing') {
    return (
      <Box>
        <Text>{pc.yellow('⚠')} {t('editSession.missing.title')}</Text>
      </Box>
    );
  }

  const timeStr = lastUpdated
    ? lastUpdated.toLocaleTimeString('en-GB', { hour12: false })
    : null;

  return (
    <Box gap={1}>
      <Text>{pc.green('✎')} {t('editSession.watching')}</Text>
      {changeCount > 0 && (
        <Text>{pc.dim(t('editSession.watching.changeCount').replace('{count}', String(changeCount)))}</Text>
      )}
      {timeStr && (
        <Text>{pc.dim(t('editSession.watching.updated').replace('{time}', timeStr))}</Text>
      )}
    </Box>
  );
}
