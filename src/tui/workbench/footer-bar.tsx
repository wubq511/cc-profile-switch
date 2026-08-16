import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import { type LifecycleState } from './lifecycle';

type FooterBarProps = {
  lifecycle: LifecycleState;
  mainPaneFocus: boolean;
  /** Show the Tab focus hint (drill-down at root with at least one Profile). */
  showFocusHint: boolean;
  flashMessage: string;
  width: number;
  height: number;
};

/** Footer (issue #98, V7/V12): one row with fixed, non-overlapping slots —
 *  the locale/help/quit strip truncates before ever touching the right slot.
 *  While the lifecycle success flash is live it owns the whole row (the flash
 *  is a notification with its own slot, never appended onto the hints); the
 *  strip and badge return afterwards. Extracted from app.tsx (issue #89). */
export function FooterBar({
  lifecycle,
  mainPaneFocus,
  showFocusHint,
  flashMessage,
  width,
  height,
}: FooterBarProps): React.ReactElement {
  const { t, locale } = useI18n();

  return React.createElement(
    Box,
    { width, justifyContent: 'space-between' },
    lifecycle.phase === 'success'
      ? (() => {
          // V9: a validate summary that reports errors is not a success —
          // the count line gets the error glyph, not a green ✓.
          const hasErrorFindings =
            lifecycle.findings?.some((f) => f.severity === 'error') ?? false;
          return React.createElement(
            Text,
            { color: hasErrorFindings ? 'red' : 'green', wrap: 'truncate' },
            ` ${hasErrorFindings ? '✗' : '✓'} ${lifecycle.message}`,
          );
        })()
      : [
          React.createElement(
            Text,
            { key: 'strip', color: 'gray', wrap: 'truncate', flexShrink: 1 },
            ` ${locale === 'zh' ? 'zh' : 'en'} │ ? ${t('keymap.help')} │ q ${t('app.quit')}` +
              (mainPaneFocus
                ? ` │ ${t('main.backToList')}`
                : showFocusHint
                  ? ` │ ${t('main.focusHint')}`
                  : ''),
          ),
          flashMessage
            ? React.createElement(
                Text,
                { key: 'badge', color: 'green', wrap: 'truncate', flexShrink: 0 },
                flashMessage,
              )
            : React.createElement(
                Text,
                { key: 'badge', color: 'gray', flexShrink: 0 },
                `${width}×${height} `,
              ),
        ],
  );
}
