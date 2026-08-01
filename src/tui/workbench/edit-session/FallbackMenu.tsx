import React from 'react';
import { Box, Text } from 'ink';
import pc from 'picocolors';

import { useI18n } from '../i18n/react';

interface FallbackMenuProps {
  reason: string | null;
  onSystemEditor?: () => void;
  onCopyPath?: () => void;
  onRetry?: () => void;
}

export function FallbackMenu({ reason, onSystemEditor, onCopyPath, onRetry }: FallbackMenuProps) {
  const { t } = useI18n();

  if (!reason) return null;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>
          {pc.red('●')} {t('editSession.fallback.title')}: {reason}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <Text bold={!!onSystemEditor}>[1] {t('editSession.fallback.systemEditor')}</Text>
        <Text bold={!!onCopyPath}>[2] {t('editSession.fallback.copyPath')}</Text>
        <Text bold={!!onRetry}>[3] {t('editSession.fallback.retry')}</Text>
      </Box>
    </Box>
  );
}
