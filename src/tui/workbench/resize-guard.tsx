import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';

type ResizeGuardProps = {
  width: number;
  height: number;
  children: React.ReactElement;
};

const MIN_WIDTH = 80;
const MIN_HEIGHT = 24;

export function isBelowMinimum(width: number, height: number): boolean {
  return width < MIN_WIDTH || height < MIN_HEIGHT;
}

export function ResizeGuard({ width, height, children }: ResizeGuardProps): React.ReactElement {
  const { t } = useI18n();

  if (!isBelowMinimum(width, height)) {
    return children;
  }

  return React.createElement(
    Box,
    { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height },
    React.createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'round', paddingX: 2, paddingY: 1 },
      React.createElement(Text, { bold: true, color: 'yellow' }, t('resize.title')),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(
          Text,
          null,
          `${t('resize.current')}: ${width}×${height}`,
        ),
      ),
      React.createElement(
        Text,
        null,
        `${t('resize.minimum')}: ${MIN_WIDTH}×${MIN_HEIGHT}`,
      ),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { dimColor: true }, t('resize.hint')),
      ),
    ),
  );
}
