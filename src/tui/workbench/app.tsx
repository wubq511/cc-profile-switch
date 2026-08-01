import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';

import { getAppHomePaths } from '../../core/app-config';
import { backupProfile, createProfile } from '../../core/profile';
import {
  clearDefaultProfile,
  copyProfile,
  removeProfile,
  renameProfile,
  setDefaultProfile,
} from '../../core/profile-management';
import { validateProfile } from '../../core/validator';
import { I18nProvider, useI18n } from './i18n/react';
import type { Locale } from './i18n/react';
import { initialLifecycleState, lifecycleReducer, type LifecycleAction } from './lifecycle';
import { KeymapOverlay } from './keymap';
import { MainPane } from './main-pane';
import type { WorkbenchProfile, WorkbenchData } from './profile-data';
import { loadWorkbenchData } from './profile-data';
import { ResizeGuard } from './resize-guard';
import { Sidebar } from './sidebar';
import { type ProfileTemplateName } from '../../core/profile-template';

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
  const [workbenchData, setWorkbenchData] = useState(data);
  const [lifecycle, setLifecycle] = useState(initialLifecycleState);

  const width = stdout.columns ?? 80;
  const height = stdout.rows ?? 24;

  useEffect(() => {
    const onResize = () => forceRerender((n: number) => n + 1);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

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

  const handleLifecycleAction = useCallback(async (
    action: LifecycleAction,
    profileName: string,
    input: string,
    selectedTemplate: string | null,
  ) => {
    if (action.type !== 'SUBMIT' && action.type !== 'START_IMMEDIATE') return;

    const appHomePath = getAppHomePaths().appHomePath;

    try {
      if (lifecycle.kind === 'create') {
        await createProfile({
          appHomePath,
          name: input,
          template: (selectedTemplate ?? 'general') as ProfileTemplateName,
        });
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `"${input}" created` }));
      } else if (lifecycle.kind === 'copy') {
        await copyProfile({ appHomePath, from: profileName, to: input });
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `Copied to "${input}"` }));
      } else if (lifecycle.kind === 'rename') {
        await renameProfile({ appHomePath, oldName: profileName, newName: input });
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `Renamed to "${input}"` }));
      } else if (lifecycle.kind === 'remove') {
        await removeProfile({ appHomePath, name: profileName, confirmation: input });
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `"${profileName}" removed` }));
      } else if (lifecycle.kind === 'default') {
        const profile = workbenchData.profiles.find((p) => p.name === profileName);
        if (profile?.isDefault) {
          await clearDefaultProfile({ appHomePath });
          setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: t('lifecycle.default.cleared') }));
        } else {
          await setDefaultProfile({ appHomePath, name: profileName });
          setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: t('lifecycle.default.set') }));
        }
      } else if (lifecycle.kind === 'validate') {
        const result = await validateProfile({ appHomePath, name: profileName });
        const findings = result.findings.map((f) => ({
          severity: f.severity,
          code: f.code,
          message: f.message,
        }));
        setLifecycle(lifecycleReducer(lifecycle, { type: 'SET_FINDINGS', findings }));
        if (findings.length === 0) {
          setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: 'Valid' }));
        } else {
          const errorCount = findings.filter((f) => f.severity === 'error').length;
          const warningCount = findings.filter((f) => f.severity === 'warning').length;
          setLifecycle(lifecycleReducer(lifecycle, {
            type: 'EXECUTE_SUCCESS',
            message: `${errorCount} ${t('lifecycle.findings.errors')}, ${warningCount} ${t('lifecycle.findings.warnings')}`,
          }));
        }
      } else if (lifecycle.kind === 'backup') {
        await backupProfile({ appHomePath, name: profileName });
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `"${profileName}" backed up` }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_ERROR', message }));
      return;
    }

    // Refresh data after any mutation
    if (lifecycle.kind !== 'validate') {
      try {
        const freshData = await loadWorkbenchData(appHomePath);
        setWorkbenchData(freshData);
      } catch {
        // refresh failure is non-fatal
      }
    }
  }, [lifecycle, workbenchData, t]);

  const sidebarWidth = Math.max(26, Math.floor(width * 0.3));
  const mainWidth = width - sidebarWidth - 2;
  const selectedProfile: WorkbenchProfile | undefined = workbenchData.profiles[selectedIndex] ?? undefined;

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
              profiles: workbenchData.profiles,
              selectedIndex,
              onSelect: setSelectedIndex,
              width: sidebarWidth,
              height: height - 1,
              capture,
              headless,
              onAction: handleLifecycleAction,
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
