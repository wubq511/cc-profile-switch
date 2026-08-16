import React from 'react';
import { Box, Text } from 'ink';

import type { I18nParams, LocaleKey } from '../i18n/react';
import type { LaunchState } from '../lifecycle';
import { PreLaunchBar } from './pre-launch-bar';
import { DirectoryScreen } from './directory-screen';
import { DryRunPage } from './dry-run-page';

/** Render the active launch overlay, or null when the launch flow is idle
 *  (issue #89: extracted from app.tsx unchanged — the null return drives the
 *  root's overlay-or-main-surface ternary, so this stays a plain function
 *  rather than a component). */
export function renderLaunchOverlay(
  launch: LaunchState,
  profileName: string,
  w: number,
  h: number,
  t: (key: LocaleKey, params?: I18nParams) => string,
): React.ReactElement | null {
  if (launch.phase === 'idle' || launch.phase === 'launching') return null;

  if (launch.phase === 'bar') {
    return React.createElement(PreLaunchBar, {
      launch,
      width: w,
      profileName,
    });
  }

  if (launch.phase === 'dir-screen') {
    return React.createElement(DirectoryScreen, { launch, width: w, height: h });
  }

  if (launch.phase === 'dry-run' && launch.dryRunPlan) {
    return React.createElement(DryRunPage, { plan: launch.dryRunPlan, width: w, height: h });
  }

  if (launch.phase === 'exited') {
    const code = launch.exitCode;
    const msg =
      code === null
        ? t('launch.exited.interrupted')
        : code === 0
          ? t('launch.exited.zero')
          : t('launch.exited', { code: String(code) });
    return React.createElement(
      Box,
      {
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        width: w,
        height: h,
      },
      React.createElement(
        Box,
        { borderStyle: 'round', paddingX: 2, paddingY: 1 },
        React.createElement(Text, { bold: true, color: code === 0 ? 'green' : 'yellow' }, msg),
      ),
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { color: 'gray' }, t('keymap.esc')),
      ),
    );
  }

  return null;
}
