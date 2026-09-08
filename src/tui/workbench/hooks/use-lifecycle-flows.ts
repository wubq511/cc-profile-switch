import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Key } from 'ink';

import { getAppHomePaths } from '../../../core/app-config';
import { backupProfile, createProfile } from '../../../core/profile';
import { exportProfile } from '../../../core/profile-export';
import {
  importProfile,
  type ImportConfirmDecision,
  type ImportMcpServerResult,
  type ImportPreview,
} from '../../../core/profile-import';
import {
  clearDefaultProfile,
  copyProfile,
  removeProfile,
  renameProfile,
  setDefaultProfile,
} from '../../../core/profile-management';
import { validateProfile } from '../../../core/validator';
import { type ProfileTemplateName } from '../../../core/profile-template';
import {
  createProfileFromCustomTemplate,
  previewSaveProfileAsTemplate,
  removeCustomTemplate,
  saveProfileAsTemplate,
} from '../../../core/custom-template';
import { countStrippedKeys } from '../../../schemas/profile-bundle';
import { validateProfileName } from '../../../platform/path';
import { CcpsError } from '../../../utils/errors';
import type { CaptureProcess } from '../../../platform/process';
import {
  getTemplateList,
  initialLifecycleState,
  initialLaunchState,
  lifecycleReducer,
  type LifecycleAction,
  type LifecyclePromptKind,
  type LifecycleState,
} from '../lifecycle';
import type { I18nParams, LocaleKey } from '../i18n/react';
import { loadWorkbenchData, type WorkbenchData } from '../profile-data';
import type { LaunchResumeState } from '../launch/launch-resume';

/** Post-mutation re-entry report shared by create-from-custom-template (§11.3)
 *  and import (§11.2): both land with the same two follow-ups — which secret
 *  keys the user must re-enter (values never travel) and which MCP servers
 *  failed to re-register through delegation, with the core's reason. MCP HTTP
 *  header key names are reported separately (issue #105): header values are
 *  stripped under the same rules as env values and never reach the delegated
 *  CLI, so the user must re-enter them by hand. */
function reentryFlashParts(
  result: {
    settingsSecretKeysToReenter: string[];
    mcpServers: ImportMcpServerResult[];
    legacyMcpEnvKeysToReenter: { server: string; keys: string[] }[];
    mcpHeaderKeysToReenter: { server: string; keys: string[] }[];
  },
  t: (key: LocaleKey, params?: I18nParams) => string,
): string[] {
  const reenterKeys = [
    ...new Set([
      ...result.settingsSecretKeysToReenter,
      ...result.mcpServers.flatMap((s) => s.envKeysToReenter),
      ...result.legacyMcpEnvKeysToReenter.flatMap((s) => s.keys),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const headerKeys = [
    ...new Set([
      ...result.mcpServers.flatMap((s) => s.headerKeysToReenter),
      ...result.mcpHeaderKeysToReenter.flatMap((s) => s.keys),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  const failedServers = result.mcpServers
    .filter((s) => !s.reRegistered)
    .map((s) => (s.failureMessage ? `${s.name} (${s.failureMessage})` : s.name));
  const parts: string[] = [];
  if (reenterKeys.length > 0) {
    parts.push(
      t('lifecycle.reenterSecrets', {
        count: String(reenterKeys.length),
        keys: reenterKeys.join(', '),
      }),
    );
  }
  if (headerKeys.length > 0) {
    parts.push(
      t('lifecycle.reenterHeaders', {
        count: String(headerKeys.length),
        keys: headerKeys.join(', '),
      }),
    );
  }
  if (failedServers.length > 0) {
    parts.push(t('lifecycle.mcpFailed', { names: failedServers.join(', ') }));
  }
  return parts;
}

type UseLifecycleFlowsOptions = {
  workbenchData: WorkbenchData;
  setWorkbenchData: Dispatch<SetStateAction<WorkbenchData>>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  t: (key: LocaleKey, params?: I18nParams) => string;
  coreTranslator: (key: string, params?: Record<string, string | number>) => string;
  /** Injected process capture for MCP remove / Skill update (hermetic tests). */
  captureProcess?: CaptureProcess;
  /** Resume state handed back by the entry's render loop after a launch
   *  remount (spec §10): restores selection and shows the exit flash. */
  resumeState?: LaunchResumeState | null;
  flash: (message: string) => void;
  refreshData: () => Promise<void>;
  appHomePath: string;
};

/** Profile lifecycle + dialog flows (create/copy/rename/remove/default/
 *  validate/backup/export/import/save-template), the import manifest gate
 *  (issue #95), and the destructive-action confirm panel (§9.1). Extracted
 *  from app.tsx (issue #89). */
export function useLifecycleFlows({
  workbenchData,
  setWorkbenchData,
  setSelectedIndex,
  t,
  coreTranslator,
  captureProcess,
  resumeState,
  flash,
  refreshData,
  appHomePath,
}: UseLifecycleFlowsOptions): {
  lifecycle: LifecycleState;
  setLifecycle: Dispatch<SetStateAction<LifecycleState>>;
  importPreview: ImportPreview | null;
  importCollisionName: string;
  importNameError: boolean;
  guidanceRows: number;
  onLifecycleAction: (action: LifecycleAction) => void;
  handleLifecycleAction: (
    action: LifecycleAction,
    profileName: string,
    input: string,
    selectedTemplate: string | null,
  ) => Promise<void>;
  handleConfirmInput: (input: string, key: Key) => void;
  handleRemoveCustomTemplate: (templateName: string) => Promise<void>;
} {
  const [lifecycle, setLifecycle] = useState<LifecycleState>(() => {
    if (resumeState) {
      // Resumed after a launch: come up in the 'exited' phase so the
      // "Claude exited (N)" flash shows (spec §10.4).
      return {
        ...initialLifecycleState(),
        profileName: resumeState.profileName,
        launch: {
          ...initialLaunchState(),
          phase: 'exited' as const,
          dir: resumeState.dir,
          exitCode: resumeState.exitCode,
        },
      };
    }
    return initialLifecycleState();
  });
  // Import preview (issue #95): the manifest gate surfaced by importProfile's
  // mandatory confirm callback. The panel renders during lifecycle 'confirm';
  // importDecisionRef holds the pending promise resolver that resolves when the
  // user presses a decision key, resuming the core import's remaining fs work.
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importCollisionName, setImportCollisionName] = useState('');
  const [importNameError, setImportNameError] = useState(false);
  const importDecisionRef = useRef<{ resolve: (decision: ImportConfirmDecision) => void } | null>(
    null,
  );

  const onLifecycleAction = useCallback((action: LifecycleAction) => {
    setLifecycle((prev) => lifecycleReducer(prev, action));
  }, []);

  // Import manifest gate (issue #95): importProfile's mandatory confirm
  // callback. Shows the preview panel (moving the lifecycle to 'confirm' so the
  // panel owns the keys) and parks a promise resolver the panel's decision keys
  // wake up — the core import stays suspended until the user commits.
  const confirmImport = useCallback(
    async (preview: ImportPreview): Promise<ImportConfirmDecision> => {
      setImportPreview(preview);
      setImportCollisionName('');
      setImportNameError(false);
      setLifecycle((prev) => lifecycleReducer(prev, { type: 'SHOW_IMPORT_PREVIEW' }));
      return new Promise<ImportConfirmDecision>((resolve) => {
        importDecisionRef.current = { resolve };
      });
    },
    [],
  );

  // Resolve a pending import decision and move the lifecycle back to
  // 'executing' so the resumed import's EXECUTE_SUCCESS (or the abort path's
  // CANCEL) lands in a matching phase.
  const resolveImportDecision = useCallback((decision: ImportConfirmDecision) => {
    const pending = importDecisionRef.current;
    if (!pending) return;
    importDecisionRef.current = null;
    pending.resolve(decision);
    setLifecycle((prev) => lifecycleReducer(prev, { type: 'CONFIRM_CHOICE' }));
  }, []);

  const handleLifecycleAction = useCallback(
    async (
      action: LifecycleAction,
      profileName: string,
      input: string,
      selectedTemplate: string | null,
    ) => {
      if (
        action.type !== 'SUBMIT' &&
        action.type !== 'START_IMMEDIATE' &&
        action.type !== 'CONFIRM_CHOICE'
      )
        return;

      const appHomePath = getAppHomePaths().appHomePath;
      // For SUBMIT actions, kind comes from the current lifecycle state
      const kind = (
        action.type === 'START_IMMEDIATE' ? action.kind : lifecycle.kind
      ) as LifecyclePromptKind;

      try {
        if (kind === 'create') {
          const customTemplate = workbenchData.customTemplates.find(
            (c) => c.name === selectedTemplate,
          );
          if (customTemplate) {
            // Create from a custom template (§11.3): stripped tree lands, MCP
            // servers re-register via delegation, secret keys need re-entry.
            const result = await createProfileFromCustomTemplate({
              appHomePath,
              templateName: customTemplate.name,
              name: input,
            });
            const parts = [
              t('lifecycle.success.createdFromTemplate', {
                name: input,
                template: customTemplate.name,
              }),
              ...reentryFlashParts(result, t),
            ];
            setLifecycle((prev) =>
              lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: parts.join('. ') }),
            );
          } else {
            // A stale picker selection that matches nothing falls back to the
            // default built-in rather than crashing the create.
            const template = (getTemplateList() as readonly string[]).includes(
              selectedTemplate ?? '',
            )
              ? (selectedTemplate as ProfileTemplateName)
              : 'general';
            await createProfile({
              appHomePath,
              name: input,
              template,
            });
            setLifecycle((prev) =>
              lifecycleReducer(prev, {
                type: 'EXECUTE_SUCCESS',
                message: `"${input}" ${t('lifecycle.success.created')}`,
              }),
            );
          }
        } else if (kind === 'save-template') {
          if (action.type === 'SUBMIT') {
            // Preview only — nothing is saved until the confirm panel's [y].
            const preview = await previewSaveProfileAsTemplate({ appHomePath, profileName });
            setLifecycle((prev) =>
              lifecycleReducer(prev, {
                type: 'SHOW_TEMPLATE_SUMMARY',
                summary: {
                  strippedCount: preview.strippedCount,
                  autoMemoryExcluded: preview.autoMemoryExcluded,
                },
              }),
            );
            return;
          }
          // CONFIRM_CHOICE: the user accepted the stripping summary — save now.
          const { manifest } = await saveProfileAsTemplate({
            appHomePath,
            profileName,
            templateName: input,
          });
          setLifecycle((prev) =>
            lifecycleReducer(prev, {
              type: 'EXECUTE_SUCCESS',
              message: t('lifecycle.success.templateSaved', { name: manifest.name }),
            }),
          );
        } else if (kind === 'copy') {
          await copyProfile({ appHomePath, from: profileName, to: input });
          setLifecycle((prev) =>
            lifecycleReducer(prev, {
              type: 'EXECUTE_SUCCESS',
              message: `${t('lifecycle.success.copiedTo')} "${input}"`,
            }),
          );
        } else if (kind === 'rename') {
          await renameProfile({ appHomePath, oldName: profileName, newName: input });
          setLifecycle((prev) =>
            lifecycleReducer(prev, {
              type: 'EXECUTE_SUCCESS',
              message: `${t('lifecycle.success.renamedTo')} "${input}"`,
            }),
          );
        } else if (kind === 'remove') {
          // Workbench removal follows §9.1 (graduated options, no exact-name
          // typing): [y] backup default, [u] no-backup → Recovery Bin.
          const noBackup = input === 'u';
          await removeProfile({
            appHomePath,
            name: profileName,
            confirmation: profileName,
            noBackup,
          });
          setLifecycle((prev) =>
            lifecycleReducer(prev, {
              type: 'EXECUTE_SUCCESS',
              message: `"${profileName}" ${t('lifecycle.success.removed')}`,
            }),
          );
        } else if (kind === 'default') {
          const profile = workbenchData.profiles.find((p) => p.name === profileName);
          if (profile?.isDefault) {
            await clearDefaultProfile({ appHomePath });
            setLifecycle((prev) =>
              lifecycleReducer(prev, {
                type: 'EXECUTE_SUCCESS',
                message: t('lifecycle.default.cleared'),
              }),
            );
          } else {
            await setDefaultProfile({ appHomePath, name: profileName });
            setLifecycle((prev) =>
              lifecycleReducer(prev, {
                type: 'EXECUTE_SUCCESS',
                message: t('lifecycle.default.set'),
              }),
            );
          }
        } else if (kind === 'validate') {
          const result = await validateProfile({ appHomePath, name: profileName }, coreTranslator);
          const findings = result.findings.map((f) => ({
            severity: f.severity,
            code: f.code,
            message: f.message,
          }));
          setLifecycle((prev) => lifecycleReducer(prev, { type: 'SET_FINDINGS', findings }));
          if (findings.length === 0) {
            setLifecycle((prev) =>
              lifecycleReducer(prev, {
                type: 'EXECUTE_SUCCESS',
                message: t('lifecycle.success.valid'),
              }),
            );
          } else {
            const errorCount = findings.filter((f) => f.severity === 'error').length;
            const warningCount = findings.filter((f) => f.severity === 'warning').length;
            setLifecycle((prev) =>
              lifecycleReducer(prev, {
                type: 'EXECUTE_SUCCESS',
                message: `${errorCount} ${t('lifecycle.findings.errors')}, ${warningCount} ${t('lifecycle.findings.warnings')}`,
              }),
            );
          }
        } else if (kind === 'backup') {
          await backupProfile({ appHomePath, name: profileName });
          setLifecycle((prev) =>
            lifecycleReducer(prev, {
              type: 'EXECUTE_SUCCESS',
              message: `"${profileName}" ${t('lifecycle.success.backedUp')}`,
            }),
          );
        } else if (kind === 'export') {
          // Profile export (issue #95, scenario S98): reuses the core
          // exportProfile service, which always strips credential-class values
          // (env.ANTHROPIC_* and MCP env) unless includeSecrets is explicitly
          // set — the Workbench never passes it, so a bundle made here can never
          // leak secrets. (S99's include-secrets opt-in is intentionally not
          // offered in the Workbench.)
          const result = await exportProfile({ appHomePath, name: profileName, outputPath: input });
          const strippedKeys = result.strippedKeys;
          const strippedCount = countStrippedKeys(strippedKeys);
          const exported = t('lifecycle.success.exported', { name: result.profileName });
          let message = exported;
          if (strippedCount > 0) {
            // S98: list the key names, not just a count — the audit trail is
            // the only visible trace of what the bundle redacted. The names
            // lead and the path trails (issue #98, V12): the success flash is
            // one truncated footer row, so the security-critical segment must
            // survive the cut; the user just typed the path themselves.
            const keyNames = [
              ...new Set(strippedKeys.flatMap((entry) => entry.keys)),
            ].sort((a, b) => a.localeCompare(b));
            message += ` · ${t('lifecycle.export.stripped', {
              count: String(strippedCount),
              keys: keyNames.join(', '),
            })}`;
          }
          message += ` → ${result.bundlePath}`;
          setLifecycle((prev) =>
            lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message }),
          );
        } else if (kind === 'import') {
          const result = await importProfile({
            appHomePath,
            bundlePath: input,
            confirm: confirmImport,
            captureProcess,
          });
          if ('aborted' in result) {
            setImportPreview(null);
            setLifecycle((prev) => lifecycleReducer(prev, { type: 'CANCEL' }));
            return;
          }
          const parts = [
            t('lifecycle.success.imported', { name: result.profileName }),
            ...reentryFlashParts(result, t),
          ];
          // S100's final step: importProfile auto-runs validateProfile — surface
          // the outcome rather than reporting a clean success for a broken profile.
          if (result.validation.status !== 'valid') {
            parts.push(t('lifecycle.import.validation', { status: result.validation.status }));
          }
          setImportPreview(null);
          setLifecycle((prev) =>
            lifecycleReducer(prev, { type: 'EXECUTE_SUCCESS', message: parts.join(' · ') }),
          );
          // Land on the imported Profile (S101) so its card shows immediately.
          try {
            const freshData = await loadWorkbenchData(appHomePath);
            setWorkbenchData(freshData);
            const idx = freshData.profiles.findIndex((p) => p.name === result.profileName);
            setSelectedIndex(Math.max(0, idx));
          } catch {
            // refresh failure is non-fatal
          }
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof CcpsError ? error.code : undefined;
        const guidance = error instanceof CcpsError ? error.guidance : undefined;
        if (kind === 'import') setImportPreview(null);
        setLifecycle((prev) =>
          lifecycleReducer(prev, { type: 'EXECUTE_ERROR', message, code, guidance }),
        );
        return;
      }

      // Refresh data after any mutation
      if (kind !== 'validate') {
        try {
          const freshData = await loadWorkbenchData(appHomePath);
          setWorkbenchData(freshData);
          // Clamp selectedIndex if profiles were removed
          setSelectedIndex((prev) => Math.min(prev, Math.max(0, freshData.profiles.length - 1)));
        } catch {
          // refresh failure is non-fatal
        }
      }
    },
    [workbenchData, t, lifecycle.kind, coreTranslator, confirmImport, captureProcess],
  );

  const confirmSaveTemplate = useCallback(() => {
    setLifecycle((prev) => lifecycleReducer(prev, { type: 'CONFIRM_CHOICE' }));
    // lifecycle.input still holds the template name typed in the prompt.
    void handleLifecycleAction(
      { type: 'CONFIRM_CHOICE' },
      lifecycle.profileName,
      lifecycle.input,
      null,
    );
  }, [lifecycle, handleLifecycleAction]);

  const confirmRemove = useCallback(
    (noBackup: boolean) => {
      setLifecycle((prev) => lifecycleReducer(prev, { type: 'CONFIRM_CHOICE' }));
      void handleLifecycleAction(
        { type: 'CONFIRM_CHOICE' },
        lifecycle.profileName,
        noBackup ? 'u' : 'y',
        null,
      );
    },
    [lifecycle, handleLifecycleAction],
  );

  const handleConfirmInput = useCallback(
    (input: string, key: Key) => {
      if (key.escape) {
        if (lifecycle.kind === 'import' && importPreview) {
          // Esc on the import preview resolves the parked decision as abort; the
          // resumed core import unwinds to its aborted branch, which dispatches
          // CANCEL exactly once — firing it here too would double-dispatch.
          resolveImportDecision({ action: 'abort' });
        } else {
          // Esc aborts whatever other confirm phase holds.
          setLifecycle((prev) => lifecycleReducer(prev, { type: 'CANCEL' }));
        }
        return;
      }
      if (lifecycle.kind === 'import' && importPreview) {
        if (importPreview.collision) {
          // New-name entry: typing a free name and Enter IS the confirmation
          // (the core collision loop commits on proceed-as-new-name).
          if (key.backspace || key.delete) {
            setImportCollisionName((name) => name.slice(0, -1));
            return;
          }
          if (key.return) {
            const targetName = importCollisionName.trim();
            if (targetName === '') return;
            try {
              validateProfileName(targetName);
            } catch {
              setImportNameError(true);
              return;
            }
            resolveImportDecision({ action: 'proceed-as-new-name', targetName });
            return;
          }
          if (!key.ctrl && !key.meta && input.length === 1) {
            setImportNameError(false);
            setImportCollisionName((name) => name + input);
          }
          return;
        }
        if (input === 'y') {
          resolveImportDecision({ action: 'proceed' });
        }
        return;
      }
      if (lifecycle.kind === 'save-template') {
        // Light confirm (§11.3): [y] saves the template; [u] has no meaning here.
        if (input === 'y') {
          confirmSaveTemplate();
        }
        return;
      }
      if (input === 'y') {
        confirmRemove(false);
        return;
      }
      if (input === 'u') {
        confirmRemove(true);
        return;
      }
    },
    [
      lifecycle,
      handleLifecycleAction,
      importPreview,
      importCollisionName,
      resolveImportDecision,
    ],
  );

  // Zero-confirm removal of a user-created template (S104), same flash pattern
  // as the other zero-confirm resource removals.
  const handleRemoveCustomTemplate = useCallback(
    async (templateName: string) => {
      try {
        await removeCustomTemplate({ appHomePath, templateName });
        flash(t('lifecycle.success.templateRemoved', { name: templateName }));
        await refreshData();
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error));
      }
    },
    [appHomePath, flash, refreshData, t],
  );

  // Reserved bottom-band rows for the active guidance dialog (issue #98,
  // V6/V7/V12): the panes shrink by exactly this many rows so a dialog never
  // overlaps pane content. The success flash lives in the footer row instead,
  // so it reserves nothing. Constants are worst-case panel heights at the
  // 80-col floor (the band itself clips overflow, so a miscount can never
  // tear the layout).
  const guidanceRows =
    lifecycle.phase === 'confirm'
      ? lifecycle.kind === 'import'
        ? 12
        : lifecycle.kind === 'save-template'
          ? 7
          : 8
      : lifecycle.phase === 'error'
        ? 10
        : 0;

  return {
    lifecycle,
    setLifecycle,
    importPreview,
    importCollisionName,
    importNameError,
    guidanceRows,
    onLifecycleAction,
    handleLifecycleAction,
    handleConfirmInput,
    handleRemoveCustomTemplate,
  };
}
