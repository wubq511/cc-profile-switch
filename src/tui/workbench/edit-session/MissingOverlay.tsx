import React from 'react';
import { Box, Text } from 'ink';
import pc from 'picocolors';

import { useI18n } from '../i18n/react';

interface MissingOverlayProps {
  lastContent: string | null;
  maxLines?: number;
}

export function MissingOverlay({ lastContent, maxLines = 20 }: MissingOverlayProps) {
  const { t } = useI18n();
  const lines = (lastContent ?? '').split('\n').slice(0, maxLines);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{pc.yellow('⚠')} {t('editSession.missing.title')}</Text>
      </Box>
      <Box>
        <Text dimColor>{t('editSession.missing.hint')}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => (
          <Text key={i} wrap="truncate">
            {line || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
