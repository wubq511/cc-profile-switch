import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import { WelcomeBanner } from './welcome-banner/WelcomeBanner';

/** Once-per-session welcome card (issue #76 §5), extracted from app.tsx
 *  (issue #89). Pure presentation; the session flag that gates it lives in
 *  app.tsx next to `resetWelcomeSessionForTests`. */
export function WelcomeCard({
  width,
  height,
  configEnabled,
}: {
  width: number;
  height: number;
  configEnabled: boolean;
}): React.ReactElement {
  const { t } = useI18n();

  return React.createElement(
    Box,
    { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width, height },
    React.createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'round', paddingX: 2, paddingY: 1 },
      React.createElement(WelcomeBanner, { columns: width, configEnabled }),
      React.createElement(Text, { bold: true }, t('welcome.title')),
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, null, t('welcome.line1')),
      ),
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { bold: true }, t('welcome.keys')),
      ),
      React.createElement(Text, null, t('welcome.key.navigate')),
      React.createElement(Text, null, t('welcome.key.search')),
      React.createElement(Text, null, t('welcome.key.help')),
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { color: 'gray' }, t('welcome.dismiss')),
      ),
    ),
  );
}
