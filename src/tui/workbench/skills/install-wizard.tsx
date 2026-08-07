import React, { useEffect, useReducer, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';

import { useI18n } from '../i18n/react';
import type { LocaleKey } from '../i18n/en';
import {
  initialInstallWizardState,
  installWizardReducer,
  type InstallSourceRef,
  type InstallWizardState,
} from './install-wizard-reducer';
import type {
  CatalogedLocalSkillSource,
  InstallPreview,
  LocalSkillSourceInfo,
} from '../../../core/skills-install';
import type { RemoteInstallPreview } from '../../../core/skills-remote-install';

// The wizard is an overlay driven by a pure reducer. Async core-service work
// runs in effects keyed on phase transitions; results come back as dispatches.

export type InstallWizardCallbacks = {
  /** Catalog the pickable local sources for step 1 (§7.2). Optional: the
   * source list falls back to the manual-entry row alone when absent. */
  onListLocalSources?: () => Promise<CatalogedLocalSkillSource[]>;
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
  onAcquireRemote: (input: {
    rawSource: string;
    /** Optional `--skill` selection for a multi-Skill source (skills.sh result). */
    skill?: string;
  }) => Promise<RemoteInstallPreview>;
  onInstallRemote: (input: {
    stagingRoot: string;
    stagedName: string;
    name: string;
    provenanceSource: RemoteInstallPreview['provenanceSource'];
    collisionResolution?: 'rename' | 'replace';
  }) => Promise<{ name: string; mode: 'copy' }>;
  onCleanupStaging?: (stagingRoot: string) => void;
  onClose: () => void;
  onInstalled: () => void;
};

type InstallWizardProps = {
  profileName: string;
  profileRootPath: string;
  callbacks: InstallWizardCallbacks;
  width: number;
  height: number;
  headless?: boolean;
  /** Discover-surface entry (spec §7.4): stage a known remote source directly,
   * skipping the kind picker. */
  initialRemote?: InstallSourceRef;
};

export function InstallWizard({
  profileName,
  profileRootPath,
  callbacks,
  width,
  height,
  headless,
  initialRemote,
}: InstallWizardProps): React.ReactElement {
  const { t } = useI18n();
  const { exit } = useApp();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY;
  const cleanedStagingRef = useRef<string | null>(null);

  const [state, dispatch] = useReducer(installWizardReducer, initialInstallWizardState());

  // Open on mount. A pre-seeded remote source (Discover) skips the kind picker.
  useEffect(() => {
    if (initialRemote) {
      dispatch({
        type: 'START_REMOTE',
        profileName,
        profileRootPath,
        source: initialRemote.source,
        skill: initialRemote.skill,
      });
    } else {
      dispatch({ type: 'START', profileName, profileRootPath });
    }
  }, [profileName, profileRootPath, initialRemote]);

  // Drive async work from phase transitions.
  useEffect(() => {
    let cancelled = false;
    if (state.phase === 'source-list' && !state.sourcesLoaded) {
      // Catalog the pickable local sources (§7.2 step 1). A listing failure
      // degrades to the manual-entry row alone — never blocks the wizard.
      (callbacks.onListLocalSources?.() ?? Promise.resolve([]))
        .then((sources) => {
          if (cancelled) return;
          dispatch({ type: 'SOURCES_LOADED', sources });
        })
        .catch(() => {
          if (cancelled) return;
          dispatch({ type: 'SOURCES_LOADED', sources: [] });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.sourcesLoaded, callbacks]);

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
    if (state.phase === 'confirming' && state.kind === 'local' && state.sourceInfo) {
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
  }, [state.phase, state.kind, state.sourceInfo, state.mode, state.name, callbacks]);

  // Remote: acquire into staging via the pinned adapter, verify identity, preview.
  useEffect(() => {
    let cancelled = false;
    if (state.phase === 'staging' && state.kind === 'remote') {
      callbacks
        .onAcquireRemote({
          rawSource: state.remoteSourceInput,
          skill: state.remoteSkill ?? undefined,
        })
        .then((preview) => {
          if (cancelled) return;
          dispatch({ type: 'REMOTE_STAGED', preview });
        })
        .catch((error) => {
          if (cancelled) return;
          dispatch({
            type: 'REMOTE_STAGING_FAILED',
            message: formatWizardError(error),
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.kind, state.remoteSourceInput, state.remoteSkill, callbacks]);

  useEffect(() => {
    let cancelled = false;
    if (state.phase === 'installing') {
      if (state.kind === 'remote' && state.remotePreview && state.stagingRoot && state.stagedName) {
        callbacks
          .onInstallRemote({
            stagingRoot: state.stagingRoot,
            stagedName: state.stagedName,
            name: state.name,
            provenanceSource: state.remotePreview.provenanceSource,
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
              message: formatWizardError(error),
            });
          });
      } else if (state.kind === 'local' && state.sourceInfo) {
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
              message: formatWizardError(error),
            });
          });
      }
    }
    return () => {
      cancelled = true;
    };
  }, [
    state.phase,
    state.kind,
    state.sourceInfo,
    state.mode,
    state.name,
    state.collisionResolution,
    state.remotePreview,
    state.stagingRoot,
    state.stagedName,
    callbacks,
    t,
  ]);

  // Clean up an orphaned remote staging root when the remote flow is abandoned
  // (esc back to source-remote/kind) or the wizard closes. A successful install
  // already removed its staging root and nulled the reference. Idempotent.
  useEffect(() => {
    const abandoned =
      !state.open || ['source-remote', 'kind', 'success', 'error'].includes(state.phase);
    if (abandoned && state.stagingRoot && state.stagingRoot !== cleanedStagingRef.current) {
      cleanedStagingRef.current = state.stagingRoot;
      callbacks.onCleanupStaging?.(state.stagingRoot);
    }
  }, [state.phase, state.stagingRoot, state.open, callbacks]);

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
        if (state.phase === 'kind' || state.phase === 'source-list') {
          dispatch({ type: 'CANCEL' });
          callbacks.onClose();
        } else {
          dispatch({ type: 'CANCEL' });
        }
        return;
      }

      switch (state.phase) {
        case 'kind': {
          if (key.leftArrow || input === 'l') {
            dispatch({ type: 'KIND_SELECT_LOCAL' });
            return;
          }
          if (key.rightArrow || input === 'r') {
            dispatch({ type: 'KIND_SELECT_REMOTE' });
            return;
          }
          if (key.return) {
            // Enter confirms the highlighted kind.
            dispatch(
              state.kind === 'remote'
                ? { type: 'KIND_SELECT_REMOTE' }
                : { type: 'KIND_SELECT_LOCAL' },
            );
          }
          return;
        }
        case 'source-list': {
          if (key.upArrow) {
            dispatch({ type: 'SOURCE_LIST_MOVE', delta: -1 });
            return;
          }
          if (key.downArrow) {
            dispatch({ type: 'SOURCE_LIST_MOVE', delta: 1 });
            return;
          }
          if (key.return) {
            dispatch({ type: 'SOURCE_LIST_PICK' });
            return;
          }
          return;
        }
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
        case 'source-remote': {
          if (key.return) {
            dispatch({ type: 'REMOTE_SOURCE_SUBMIT' });
            return;
          }
          if (key.backspace || key.delete) {
            dispatch({ type: 'REMOTE_SOURCE_BACKSPACE' });
            return;
          }
          if (!key.ctrl && !key.meta && input.length === 1) {
            dispatch({ type: 'REMOTE_SOURCE_CHAR', char: input });
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
          if (input === 'c' && state.kind === 'local' && linkIncapable(state)) {
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
          // validating / confirming / staging / installing: no input except esc (handled above)
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
      React.createElement(
        Text,
        { bold: true },
        `${t('skill.install.breadcrumb')} · ${profileName}`,
      ),
    ),
    renderStep(state, width, t),
  );
}

function linkIncapable(state: InstallWizardState): boolean {
  if (!state.preview || state.mode !== 'link') return false;
  return state.preview.checks.some((c) => c.code === 'platform-can-link' && !c.ok);
}

// Render a CcpsError's numbered guidance across multiple lines; fall back to the
// raw message for non-CcpsError throws.
function formatWizardError(error: unknown): string {
  const maybe = error as { code?: string; guidance?: string; message?: string };
  if (maybe && typeof maybe.code === 'string' && typeof maybe.message === 'string') {
    const guidance = typeof maybe.guidance === 'string' ? `\n${maybe.guidance}` : '';
    return `${maybe.code}: ${maybe.message}${guidance}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function renderStep(
  state: InstallWizardState,
  width: number,
  t: (key: LocaleKey) => string,
): React.ReactElement {
  const innerWidth = Math.max(40, width - 4);

  switch (state.phase) {
    case 'kind':
      return renderKind(state, innerWidth, t);

    case 'source-list':
      return renderSourceList(state, innerWidth, t);

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

    case 'source-remote':
    case 'staging':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { bold: true }, t('skill.install.remote.source.prompt')),
        React.createElement(
          Box,
          null,
          React.createElement(Text, { color: 'cyan' }, `${state.remoteSourceInput}█`),
        ),
        state.remoteSourceError.length > 0 ? renderErrorPanel(state.remoteSourceError) : null,
        state.phase === 'staging'
          ? React.createElement(Text, { color: 'yellow' }, t('skill.install.remote.staging'))
          : React.createElement(Text, { dimColor: true }, t('skill.install.remote.source.hint')),
      );

    case 'mode':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { bold: true }, t('skill.install.step.mode')),
        React.createElement(
          Box,
          { flexDirection: 'row', gap: 2, marginTop: 1 },
          renderModeCard(
            'copy',
            state.mode === 'copy',
            t('skill.install.mode.copy'),
            t('skill.install.mode.copy.desc'),
            Math.floor(innerWidth / 2),
          ),
          renderModeCard(
            'link',
            state.mode === 'link',
            t('skill.install.mode.link'),
            t('skill.install.mode.link.desc'),
            Math.floor(innerWidth / 2),
          ),
        ),
        React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(Text, { dimColor: true }, t('skill.install.mode.hint')),
        ),
      );

    case 'confirming':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(Text, { bold: true }, t('skill.install.step.confirm')),
        React.createElement(Text, { color: 'yellow' }, t('skill.install.source.validating')),
      );

    case 'confirm':
      return state.kind === 'remote'
        ? renderRemoteConfirm(state, innerWidth, t)
        : renderConfirm(state, innerWidth, t);

    case 'collision':
      return React.createElement(
        Box,
        { flexDirection: 'column', width: innerWidth },
        React.createElement(
          Text,
          { bold: true, color: 'yellow' },
          t('skill.install.collision.title'),
        ),
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
        React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(Text, { dimColor: true }, t('skill.install.collision.hint')),
        ),
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
        renderErrorPanel(state.message),
        React.createElement(Text, { dimColor: true }, t('keymap.esc')),
      );

    default:
      return React.createElement(Text, null, '');
  }
}

// The §7.2 step-1 pick list: discovered local sources plus the manual-entry
// fallback row. Invalid sources (unreadable / no SKILL.md) are marked in place.
function renderSourceList(
  state: InstallWizardState,
  innerWidth: number,
  t: (key: LocaleKey) => string,
): React.ReactElement {
  const rows: React.ReactElement[] = state.localSources.map((source, i) => {
    const selected = i === state.sourceListIndex;
    const tag = !source.readable
      ? t('skill.install.source.list.tag.unreadable')
      : !source.skillMdPresent
        ? t('skill.install.source.list.tag.noSkillMd')
        : null;
    return React.createElement(
      Box,
      { key: `src-${i}` },
      React.createElement(
        Text,
        { bold: selected, color: selected ? 'cyan' : undefined },
        `${selected ? '▸ ' : '  '}${source.suggestedName}`,
      ),
      React.createElement(Text, { dimColor: true }, `  ${source.sourcePath}`),
      tag ? React.createElement(Text, { color: 'yellow' }, `  ⚠ ${tag}`) : null,
    );
  });

  // Manual-entry fallback row (arbitrary local paths must remain possible).
  const manualIndex = state.localSources.length;
  const manualSelected = state.sourceListIndex === manualIndex;
  rows.push(
    React.createElement(
      Box,
      { key: 'manual' },
      React.createElement(
        Text,
        { bold: manualSelected, color: manualSelected ? 'cyan' : undefined },
        `${manualSelected ? '▸ ' : '  '}${t('skill.install.source.list.manual')}`,
      ),
    ),
  );

  return React.createElement(
    Box,
    { flexDirection: 'column', width: innerWidth },
    React.createElement(Text, { bold: true }, t('skill.install.source.list.title')),
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      !state.sourcesLoaded
        ? React.createElement(Text, { color: 'yellow' }, t('skill.install.source.list.loading'))
        : state.localSources.length === 0
          ? React.createElement(Text, { dimColor: true }, t('skill.install.source.list.empty'))
          : null,
      ...rows,
    ),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, t('skill.install.source.list.hint')),
    ),
  );
}

function renderKind(
  state: InstallWizardState,
  innerWidth: number,
  t: (key: LocaleKey) => string,
): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: 'column', width: innerWidth },
    React.createElement(Text, { bold: true }, t('skill.install.kind.title')),
    React.createElement(
      Box,
      { flexDirection: 'row', gap: 2, marginTop: 1 },
      renderModeCard(
        'local',
        state.kind === 'local',
        t('skill.install.kind.local'),
        t('skill.install.kind.local.desc'),
        Math.floor(innerWidth / 2),
      ),
      renderModeCard(
        'remote',
        state.kind === 'remote',
        t('skill.install.kind.remote'),
        t('skill.install.kind.remote.desc'),
        Math.floor(innerWidth / 2),
      ),
    ),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, t('skill.install.kind.hint')),
    ),
  );
}

function renderModeCard(
  _mode: string,
  selected: boolean,
  title: string,
  desc: string,
  colW: number,
): React.ReactElement {
  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      width: colW,
      borderStyle: selected ? 'double' : 'round',
      paddingX: 1,
    },
    React.createElement(
      Text,
      { bold: true, color: selected ? 'cyan' : undefined },
      `${selected ? '▸ ' : '  '}${title}`,
    ),
    React.createElement(Box, { marginTop: 1 }, React.createElement(Text, { dimColor: true }, desc)),
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
                React.createElement(
                  Text,
                  { color: 'yellow' },
                  t('skill.install.confirm.linkIncapable'),
                ),
                React.createElement(
                  Text,
                  { color: 'cyan' },
                  ` ${t('skill.install.confirm.fallbackCopy')}`,
                ),
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

function renderRemoteConfirm(
  state: InstallWizardState,
  innerWidth: number,
  t: (key: LocaleKey) => string,
): React.ReactElement {
  const preview = state.remotePreview;
  if (!preview) {
    return React.createElement(Text, { color: 'yellow' }, t('skill.install.remote.staging'));
  }

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
      React.createElement(
        Text,
        { dimColor: true, bold: true },
        t('skill.install.remote.confirm.identity'),
      ),
      React.createElement(Text, null, `  name: ${preview.identity.name}`),
      React.createElement(Text, null, `  description: ${preview.identity.description}`),
    ),
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(
        Text,
        { dimColor: true, bold: true },
        t('skill.install.remote.confirm.provenance'),
      ),
      React.createElement(Text, null, `  source: ${preview.provenanceSource.kind}`),
      preview.provenanceSource.url
        ? React.createElement(Text, null, `  url: ${preview.provenanceSource.url}`)
        : null,
      preview.provenanceSource.ref
        ? React.createElement(Text, null, `  ref: ${preview.provenanceSource.ref}`)
        : null,
      preview.provenanceSource.skillPath
        ? React.createElement(Text, null, `  path: ${preview.provenanceSource.skillPath}`)
        : null,
    ),
    preview.collides
      ? React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(Text, { color: 'yellow' }, t('skill.install.collision.title')),
        )
      : React.createElement(
          Box,
          { marginTop: 1 },
          React.createElement(Text, { color: 'green' }, t('skill.install.confirm.install')),
        ),
  );
}

// Render a message that may carry a CcpsError's numbered guidance as subsequent
// lines (the formatWizardError helper joins code+message+guidance with newlines).
function renderErrorPanel(message: string): React.ReactElement {
  const lines = message.split('\n');
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, i) =>
      React.createElement(
        Text,
        { key: `er-${i}`, color: i === 0 ? 'red' : 'yellow' },
        i === 0 ? `✗ ${line}` : line,
      ),
    ),
  );
}
