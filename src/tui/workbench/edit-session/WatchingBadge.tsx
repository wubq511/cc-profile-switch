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
  const { t, locale } = useI18n();

  if (phase === 'idle') return null;

  if (phase === 'opening') {
    return (
      <Box>
        <Text>{pc.cyan(t('editSession.watching.opening'))}</Text>
      </Box>
    );
  }

  if (phase === 'missing') {
    return (
      <Box>
        <Text>
          {pc.yellow('⚠')} {t('editSession.missing.title')}
        </Text>
      </Box>
    );
  }

  const timeStr = lastUpdated
    ? lastUpdated.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false })
    : null;

  return (
    <Box gap={1}>
      <Text>
        {pc.green('✎')} {t('editSession.watching')}
      </Text>
      {changeCount > 0 && (
        // gray (SGR 90), not dim (SGR 2): dim is unreadable on light
        // terminal themes (issue #98, V19).
        <Text>{pc.gray(t('editSession.watching.changeCount', { count: String(changeCount) }))}</Text>
      )}
      {timeStr && <Text>{pc.gray(t('editSession.watching.updated', { time: timeStr }))}</Text>}
    </Box>
  );
}
