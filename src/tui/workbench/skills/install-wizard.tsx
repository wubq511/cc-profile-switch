import React, { useEffect, useReducer } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';

import { useI18n } from '../i18n/react';
import type { LocaleKey } from '../i18n/en';
import {
  initialInstallWizardState,
  installWizardReducer,
  type InstallWizardState,
} from './install-wizard-reducer';
import type {
  InstallPreview,
  LocalSkillSourceInfo,
} from '../../../core/skills-install';

// The wizard is an overlay driven by a pure reducer. Async core-service work
// runs in effects keyed on phase transitions; results come back as dispatches.

export type InstallWizardCallbacks = {
  onResolveSource: (sourceInput: string) => Promise<LocalSkillSourceInfo>;
  onComputePreview: (input: {
    sourcePath: string;
    mode: 'copy' | 'link';
    name: string;
  }) => Promise<InstallPreview>;
  onInstall: (input: {
    sourcePath: string;
    mode: 'copy' | 'link';
    name: string;
    collisionResolution?: 'rename' | 'replace';
  }) => Promise<{ name: string; mode: 'copy' | 'link' }>;
  onClose: () => void;
  onInstalled: () => void;
};

type InstallWizardProps = {
  profileName: string;
  callbacks: InstallWizardCallbacks;
  width: number;
  height: number;
  headless?: boolean;
};

export function InstallWizard({
  profileName,
  callbacks,
  width,
  height,
  headless,
}: InstallWizardProps): React.ReactElement {
  const { t } = useI18n();
  const { exit } = useApp();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY;

  const [state, dispatch] = useReducer(installWizardReducer, initialInstallWizardState());

  // Open on mount.
  useEffect(() => {
    dispatch({ type: 'START', profileName });
  }, [profileName]);

  // Drive async work from phase transitions.
  useEffect(() => {
    let cancelled = false;
    if (state.phase === 'validating') {
      callbacks
        .onResolveSource(state.sourceInput)
        .then((info) => {
          if (cancelled) return;
          // Health gate: source must be readable AND have a SKILL.md to proceed.
          if (info.readable && info.skillMdPresent) {
            dispatch({ type: 'SOURCE_RESOLVED', info });
          } else {
            const reason = !info.readable
              ? t('skill.install.source.notReadable')
              : t('skill.install.source.noSkillMd');
            dispatch({ type: 'SOURCE_INVALID', message: reason });
          }
        })
        .catch((error) => {
          if (cancelled) return;
          dispatch({
            type: 'SOURCE_INVALID',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.sourceInput, callbacks, t]);

  useEffect(() => {
    let cancelled = false;
    if (state.phase === 'confirming' && state.sourceInfo) {
      callbacks
        .onComputePreview({
          sourcePath: state.sourceInfo.sourcePath,
          mode: state.mode,
          name: state.name,
        })
        .then((preview) => {
          if (cancelled) return;
          dispatch({ type: 'PREVIEW_READY', preview });
        })
        .catch((error) => {
          if (cancelled) return;
          dispatch({
            type: 'PREVIEW_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.sourceInfo, state.mode, state.name, callbacks]);

  useEffect(() => {
    let cancelled = false;
    if (state.phase === 'installing' && state.sourceInfo) {
      callbacks
        .onInstall({
          sourcePath: state.sourceInfo.sourcePath,
          mode: state.mode,
          name: state.name,
          collisionResolution: state.collisionResolution ?? undefined,
        })
        .then((result) => {
          if (cancelled) return;
          dispatch({
            type: 'INSTALL_SUCCESS',
            message: `${t('skill.install.success')}: ${result.name}`,
          });
        })
        .catch((error) => {
          if (cancelled) return;
          dispatch({
            type: 'INSTALL_ERROR',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.sourceInfo, state.mode, state.name, state.collisionResolution, callbacks, t]);

  // Notify parent on success dismissal and on close.
  useEffect(() => {
    if (state.phase === 'success') {
      callbacks.onInstalled();
    }
  }, [state.phase, callbacks]);

  useInput(
    (input: string, key: Record<string, boolean>) => {
      if (key.ctrl && input === 'c') {
        exit();
        return;
      }

      if (state.phase === 'success' || state.phase === 'error') {
        if (key.escape || key.return || input === ' ') {
          dispatch({ type: 'DISMISS' });
          callbacks.onClose();
        }
        return;
      }

      if (key.escape) {
        if (state.phase === 'source') {
          dispatch({ type: 'CANCEL' });
          callbacks.onClose();
        } else {
          dispatch({ type: 'CANCEL' });
        }
        return;
      }

      switch (state.phase) {
        case 'source': {
          if (key.return) {
            dispatch({ type: 'SOURCE_SUBMIT' });
            return;
          }
          if (key.backspace || key.delete) {
            dispatch({ type: 'SOURCE_BACKSPACE' });
            return;
          }
          if (!key.ctrl && !key.meta && input.length === 1) {
            dispatch({ type: 'SOURCE_CHAR', char: input });
          }
          return;
        }
        case 'mode': {
          if (key.leftArrow || input === 'c') {
            dispatch({ type: 'SELECT_MODE', mode: 'copy' });
            return;
          }
          if (key.rightArrow || input === 'l') {
            dispatch({ type: 'SELECT_MODE', mode: 'link' });
            return;
          }
          if (key.return) {
            dispatch({ type: 'MODE_CONFIRM' });
            return;
          }
          return;
        }
        case 'confirm': {
          if (key.return) {
            dispatch({ type: 'CONFIRM_INSTALL' });
            return;
          }
          // Link-incapable fallback: [c] switches to Copy with the same source.
          if (input === 'c' && linkIncapable(state)) {
            dispatch({ type: 'FALLBACK_TO_COPY' });
            return;
          }
          return;
        }
        case 'collision': {
          if (key.return) {
            dispatch({ type: 'COLLISION_RENAME' });
            return;
          }
          if (input === 'p') {
            dispatch({ type: 'COLLISION_REPLACE' });
            return;
          }
          if (key.backspace || key.delete) {
            dispatch({ type: 'COLLISION_BACKSPACE' });
            return;
          }
          if (!key.ctrl && !key.meta && input.length === 1) {
            dispatch({ type: 'COLLISION_CHAR', char: input });
          }
          return;
        }
        default:
          // validating / confirming / installing: no input except esc (handled above)
          return;
      }
    },
    { isActive: canUseInput },
  );

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { bold: true }, `${t('skill.install.breadcrumb')} · ${profileName}`),
    ),
    renderStep(state, width, t),
  );
}

function linkIncapable(state: InstallWizardState): boolean {
  if (!state.preview || state.mode !== 'link') return false;
  return state.preview.checks.some((c) => c.code === 'platform-can-link' && !c.ok);
}

function renderStep(
  state: InstallWizardState,
  width: number,
  t: (key: LocaleKey) => string,
): React.ReactElement {
  const innerWidth = Math.max(40, width - 4);

  switch (state.phase) {
    case 'source':
    case 'validating':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { bold: true }, t('skill.install.source.prompt')),
        React.createElement(
          Box,
          null,
          React.createElement(Text, { color: 'cyan' }, `${state.sourceInput}█`),
        ),
        state.sourceError.length > 0
          ? React.createElement(Text, { color: 'red' }, `✗ ${state.sourceError}`)
          : null,
        state.phase === 'validating'
          ? React.createElement(Text, { color: 'yellow' }, t('skill.install.source.validating'))
          : React.createElement(Text, { dimColor: true }, t('skill.install.source.hint')),
      );

    case 'mode':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { bold: true }, t('skill.install.step.mode')),
        React.createElement(
          Box,
          { flexDirection: 'row', gap: 2, marginTop: 1 },
          renderModeCard('copy', state.mode === 'copy', t('skill.install.mode.copy'), t('skill.install.mode.copy.desc'), Math.floor(innerWidth / 2)),
          renderModeCard('link', state.mode === 'link', t('skill.install.mode.link'), t('skill.install.mode.link.desc'), Math.floor(innerWidth / 2)),
        ),
        React.createElement(Box, { marginTop: 1 }, React.createElement(Text, { dimColor: true }, t('skill.install.mode.hint'))),
      );

    case 'confirming':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { bold: true }, t('skill.install.step.confirm')),
        React.createElement(Text, { color: 'yellow' }, t('skill.install.source.validating')),
      );

    case 'confirm':
      return renderConfirm(state, innerWidth, t);

    case 'collision':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { bold: true, color: 'yellow' }, t('skill.install.collision.title')),
        React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(Text, null, t('skill.install.collision.rename')),
          React.createElement(Text, { color: 'cyan' }, ` ${state.collisionInput}█`),
        ),
        state.collisionError.length > 0
          ? React.createElement(Text, { color: 'red' }, `✗ ${state.collisionError}`)
          : null,
        React.createElement(Text, { dimColor: true }, t('skill.install.collision.replace')),
        React.createElement(Box, { marginTop: 1 }, React.createElement(Text, { dimColor: true }, t('skill.install.collision.hint'))),
      );

    case 'installing':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { color: 'yellow' }, t('skill.install.installing')),
      );

    case 'success':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { color: 'green', bold: true }, `${t('skill.install.success')}`),
        React.createElement(Text, null, state.message),
        React.createElement(Text, { dimColor: true }, t('keymap.esc')),
      );

    case 'error':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { color: 'red', bold: true }, t('skill.install.error')),
        React.createElement(Text, null, state.message),
        React.createElement(Text, { dimColor: true }, t('keymap.esc')),
      );

    default:
      return React.createElement(Text, null, '');
  }
}

function renderModeCard(
  _mode: 'copy' | 'link',
  selected: boolean,
  title: string,
  desc: string,
  colW: number,
): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: 'column', width: colW, borderStyle: selected ? 'double' : 'round', paddingX: 1 },
    React.createElement(
      Text,
      { bold: true, color: selected ? 'cyan' : undefined },
      `${selected ? '▸ ' : '  '}${title}`,
    ),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, desc),
    ),
  );
}

function renderConfirm(
  state: InstallWizardState,
  innerWidth: number,
  t: (key: LocaleKey) => string,
): React.ReactElement {
  const preview = state.preview;
  if (!preview) {
    return React.createElement(Text, { color: 'yellow' }, t('skill.install.source.validating'));
  }

  const blocked = !preview.canInstall;
  const linkIncapableFlag = linkIncapable(state);

  return React.createElement(
    Box,
    { flexDirection: 'column', width: innerWidth },
    React.createElement(Text, { bold: true }, t('skill.install.step.confirm')),
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(Text, { dimColor: true, bold: true }, t('skill.install.confirm.preview')),
      ...preview.previewLines.map((line, i) =>
        React.createElement(Text, { key: `pv-${i}` }, `  ${line}`),
      ),
    ),
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(Text, { dimColor: true, bold: true }, t('skill.install.confirm.checks')),
      ...preview.checks.map((check, i) =>
        React.createElement(
          Text,
          { key: `ck-${i}`, color: check.ok ? 'green' : 'red' },
          `  ${check.ok ? '✓' : '✗'} ${check.message}`,
        ),
      ),
    ),
    blocked
      ? React.createElement(
          Box,
          { marginTop: 1, flexDirection: 'column' },
          React.createElement(Text, { color: 'red' }, t('skill.install.confirm.blocked')),
          linkIncapableFlag
            ? React.createElement(
                Box,
                null,
                React.createElement(Text, { color: 'yellow' }, t('skill.install.confirm.linkIncapable')),
                React.createElement(Text, { color: 'cyan' }, ` ${t('skill.install.confirm.fallbackCopy')}`),
              )
            : null,
        )
      : React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(Text, { color: 'green' }, t('skill.install.confirm.install')),
        ),
  );
}
