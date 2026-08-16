import React from 'react';
import { Box, Text } from 'ink';
import pc from 'picocolors';

import { useI18n } from '../i18n/react';

interface EditBannerProps {
  activeCount: number;
}

export function EditBanner({ activeCount }: EditBannerProps) {
  const { t } = useI18n();

  if (activeCount === 0) return null;

  return (
    <Box>
      <Text>
        {pc.green('✎')} {t('editSession.banner', { count: String(activeCount) })}
      </Text>
    </Box>
  );
}
