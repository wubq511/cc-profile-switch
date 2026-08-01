import React, { createContext, useContext, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';

import { I18nProvider, useI18n } from './i18n/react';
import type { Locale } from './i18n/react';
import { KeymapOverlay } from './keymap';
import { MainPane } from './main-pane';
import type { WorkbenchProfile, WorkbenchData } from './profile-data';
import { ResizeGuard } from './resize-guard';
import { Sidebar } from './sidebar';

type CaptureSetter = (on: boolean) => void;
const CaptureContext = createContext<CaptureSetter>(() => {});
export function useCapture(): CaptureSetter {
  return useContext(CaptureContext);
}

type WorkbenchAppProps = {
  data: WorkbenchData;
  onLocaleChange?: (locale: Locale) => void;
  initialLocale?: Locale;
  headless?: boolean;
};

export function WorkbenchApp({ data, onLocaleChange, initialLocale, headless }: WorkbenchAppProps): React.ReactElement {
  return React.createElement(
    I18nProvider,
    { initialLocale, onLocaleChange },
    React.createElement(WorkbenchInner, { data, headless }),
  );
}

function WorkbenchInner({ data, headless }: { data: WorkbenchData; headless?: boolean }): React.ReactElement {
  const { t, locale } = useI18n();
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin: inkStdin } = useStdin();

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [helpVisible, setHelpVisible] = useState(false);
  const [capture, setCapture] = useState(false);
  const [welcomeVisible, setWelcomeVisible] = useState(true);
  const [, forceRerender] = useState(0);

  const width = stdout.columns ?? 80;
  const height = stdout.rows ?? 24;

  useEffect(() => {
    const onResize = () => forceRerender((n: number) => n + 1);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // useInput requires a TTY stdin. In headless/CI mode, skip it.
  const canUseInput = !headless && inkStdin.isTTY;

  useInput((input: string, key: Record<string, boolean>) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (welcomeVisible) {
      setWelcomeVisible(false);
      return;
    }

    if (helpVisible) {
      if (key.escape || input === '?') {
        setHelpVisible(false);
      }
      return;
    }

    if (capture) return;

    if (input === 'q') {
      exit();
      return;
    }
    if (input === '?') {
      setHelpVisible(true);
      return;
    }
  }, { isActive: canUseInput });

  const sidebarWidth = Math.max(26, Math.floor(width * 0.3));
  const mainWidth = width - sidebarWidth - 2;
  const selectedProfile: WorkbenchProfile | undefined = data.profiles[selectedIndex] ?? undefined;

  const inner = React.createElement(
    CaptureContext.Provider,
    { value: setCapture },
    React.createElement(
      Box,
      { flexDirection: 'column', width, height },
      welcomeVisible
        ? React.createElement(WelcomeCard, { width, height })
        : React.createElement(
            Box,
            { flexDirection: 'row', flexGrow: 1 },
            React.createElement(Sidebar, {
              profiles: data.profiles,
              selectedIndex,
              onSelect: setSelectedIndex,
              width: sidebarWidth,
              height: height - 1,
              capture,
              headless,
            }),
            React.createElement(MainPane, {
              profile: selectedProfile,
              width: mainWidth,
              height: height - 1,
            }),
          ),
      React.createElement(
        Box,
        { width, justifyContent: 'space-between' },
        React.createElement(
          Text,
          { dimColor: true },
          ` ${locale === 'zh' ? 'zh' : 'en'} │ ? ${t('keymap.help')} │ q ${t('app.quit')}`,
        ),
        React.createElement(Text, { dimColor: true }, `${width}×${height} `),
      ),
    ),
    helpVisible && React.createElement(KeymapOverlay, { visible: true }),
  );

  return React.createElement(ResizeGuard, { width, height, children: inner });
}

function WelcomeCard({ width, height }: { width: number; height: number }): React.ReactElement {
  const { t } = useI18n();

  return React.createElement(
    Box,
    { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width, height },
    React.createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'round', paddingX: 2, paddingY: 1 },
      React.createElement(Text, { bold: true }, t('welcome.title')),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, null, t('welcome.line1')),
      ),
      React.createElement(Text, null, t('welcome.line2')),
      React.createElement(Text, null, t('welcome.line3')),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { dimColor: true }, t('welcome.dismiss')),
      ),
    ),
  );
}
