import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import {
  editSettingsKey,
  previewSettings,
  removeSettingsKey,
} from '../../../core/settings-resource';
import {
  editLaunchConfigKey,
  inspectLaunchConfig,
} from '../../../core/launch-config-resource';
import type { WorkbenchProfile } from '../profile-data';
import { useI18n } from '../i18n/react';

// Settings / Launch Config drill view (issue #101 L1, spec §7): a flat
// key-level list with inline values, text-prompt edits, boolean toggles, and
// key removal — all backed by the core settings-resource / launch-config
// services so redaction, managed-field, and sensitive-field rules apply here
// exactly as they do in the CLI.

export type SettingsViewCategory = 'settings' | 'launchConfig';

export type SettingsViewProps = {
  profile: WorkbenchProfile;
  appHomePath: string;
  category: SettingsViewCategory;
  width: number;
  height: number;
  onBack: () => void;
  onDataChanged?: () => void;
  /** Key to preselect when drilling from a sidebar tree item row. */
  initialKey?: string;
  /** When true, keyboard input is disabled (headless/test rendering). */
  headless?: boolean;
};

type Row = {
  keyPath: string;
  displayValue: string;
  /** ccps-managed setting — read-only here. */
  readOnly: boolean;
  /** mcpServers.* — refused outright (MCP delegation contract). */
  refused: boolean;
  /** Credential-class value: never rendered, masked while editing. */
  secret: boolean;
  /** Launch field with a consequence-warning gate (skipPermissions, claudeArgs). */
  sensitive: boolean;
  isBoolean: boolean;
  boolValue: boolean;
};

type Mode = 'list' | 'edit' | 'confirmRemove' | 'confirmSensitive';

type PendingSensitive =
  | { key: string; openEdit: true }
  | { key: string; openEdit: false; value: unknown };

/** Text-prompt parsing: numbers/booleans/JSON where the shape says so, else a
 *  plain string (env values are strings almost always). */
function parseValueInput(raw: string, row: Row): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through — the service validates and reports the type error.
    }
  }
  if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && row.displayValue !== '' && !Number.isNaN(Number(row.displayValue))) {
    return Number(trimmed);
  }
  return raw;
}

export function SettingsView({
  profile,
  appHomePath,
  category,
  width,
  height,
  onBack,
  onDataChanged,
  initialKey,
  headless,
}: SettingsViewProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY === true;

  const [rows, setRows] = useState<Row[]>([]);
  const [malformed, setMalformed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [editDraft, setEditDraft] = useState('');
  const [pendingSensitive, setPendingSensitive] = useState<PendingSensitive | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (category === 'settings') {
      const res = await previewSettings(appHomePath, profile.name);
      setMalformed(res.malformed);
      setRows(
        res.entries.map((e) => ({
          keyPath: e.keyPath,
          displayValue: e.displayValue,
          readOnly: e.isManaged,
          refused: e.keyPath === 'mcpServers' || e.keyPath.startsWith('mcpServers.'),
          secret: e.isSecret,
          sensitive: false,
          isBoolean: e.displayValue === 'true' || e.displayValue === 'false',
          boolValue: e.displayValue === 'true',
        })),
      );
    } else {
      const res = await inspectLaunchConfig(appHomePath, profile.name);
      setMalformed(res.malformed);
      setRows(
        res.entries.map((e) => ({
          keyPath: e.key,
          displayValue:
            e.value === undefined ? '' : typeof e.value === 'string' ? e.value : JSON.stringify(e.value),
          readOnly: false,
          refused: false,
          secret: false,
          sensitive: e.sensitive,
          isBoolean: typeof e.value === 'boolean',
          boolValue: e.value === true,
        })),
      );
    }
  }, [category, appHomePath, profile.name]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tree-item drills carry the item name: preselect that key on the first
  // load only (later reloads after an edit keep the user's cursor).
  const appliedInitialKey = React.useRef(false);
  useEffect(() => {
    if (appliedInitialKey.current || !initialKey || rows.length === 0) return;
    const idx = rows.findIndex((r) => r.keyPath === initialKey || r.keyPath.startsWith(`${initialKey}.`));
    if (idx >= 0) setSelectedIndex(idx);
    appliedInitialKey.current = true;
  }, [rows, initialKey]);

  const applyValue = useCallback(
    async (keyPath: string, value: unknown): Promise<void> => {
      try {
        if (category === 'settings') {
          const res = await editSettingsKey({ appHomePath, profileName: profile.name, keyPath, value });
          if (res.refused) {
            setStatus(t(res.refused === 'managed' ? 'settings.view.managedReadOnly' : 'settings.view.mcpRefused'));
          } else {
            setStatus(t('settings.view.saved', { key: keyPath }));
          }
        } else {
          await editLaunchConfigKey({
            appHomePath,
            profileName: profile.name,
            key: keyPath,
            value,
            // The confirmSensitive gate has already been passed by the time a
            // sensitive field reaches applyValue.
            confirmed: true,
          });
          setStatus(t('settings.view.saved', { key: keyPath }));
        }
        onDataChanged?.();
      } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
        setStatus(`${t('settings.view.invalid', { key: keyPath })} — ${reason}`);
      }
      await load();
    },
    [category, appHomePath, profile.name, load, onDataChanged, t],
  );

  const selected = rows[selectedIndex];

  useInput(
    (input, key) => {
      if (mode === 'edit') {
        if (key.escape) {
          setMode('list');
          setEditDraft('');
          return;
        }
        if (key.return) {
          const row = selected;
          const draft = editDraft;
          setMode('list');
          setEditDraft('');
          if (row) void applyValue(row.keyPath, parseValueInput(draft, row));
          return;
        }
        if (key.backspace || key.delete) {
          setEditDraft((s) => s.slice(0, -1));
          return;
        }
        if (input) setEditDraft((s) => s + input);
        return;
      }

      if (mode === 'confirmRemove') {
        const row = selected;
        setMode('list');
        if (input === 'y' && row) {
          void (async () => {
            try {
              await removeSettingsKey({ appHomePath, profileName: profile.name, keyPath: row.keyPath });
              setStatus(t('settings.view.removed', { key: row.keyPath }));
              onDataChanged?.();
            } catch (error) {
              setStatus(error instanceof Error ? error.message.split('\n')[0] ?? null : String(error));
            }
            await load();
          })();
        }
        return;
      }

      if (mode === 'confirmSensitive') {
        const pending = pendingSensitive;
        if (input === 'y' && pending) {
          setPendingSensitive(null);
          if (pending.openEdit) {
            setEditDraft('');
            setMode('edit');
          } else {
            setMode('list');
            void applyValue(pending.key, pending.value);
          }
        } else if (key.escape || input === 'n' || input === 'N') {
          setPendingSensitive(null);
          setMode('list');
        }
        return;
      }

      // List mode.
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
        return;
      }
      if (input === 'x' && category === 'settings') {
        if (!selected || malformed) return;
        if (selected.readOnly) {
          setStatus(t('settings.view.managedReadOnly'));
          return;
        }
        if (selected.refused) {
          setStatus(t('settings.view.mcpRefused'));
          return;
        }
        setMode('confirmRemove');
        return;
      }
      if (input === 'e' || key.return) {
        if (!selected || malformed) return;
        if (selected.readOnly) {
          setStatus(t('settings.view.managedReadOnly'));
          return;
        }
        if (selected.refused) {
          setStatus(t('settings.view.mcpRefused'));
          return;
        }
        if (selected.sensitive) {
          setPendingSensitive(
            selected.isBoolean
              ? { key: selected.keyPath, openEdit: false, value: !selected.boolValue }
              : { key: selected.keyPath, openEdit: true },
          );
          setMode('confirmSensitive');
          return;
        }
        if (selected.isBoolean) {
          void applyValue(selected.keyPath, !selected.boolValue);
          return;
        }
        setEditDraft('');
        setMode('edit');
        return;
      }
    },
    { isActive: canUseInput },
  );

  const title = t(category === 'settings' ? 'main.category.settings' : 'main.category.launchConfig');
  const listHeight = Math.max(1, height - 6); // title + detail + status + hint

  const windowStart = Math.max(0, Math.min(selectedIndex - listHeight + 1, rows.length - listHeight));
  const visibleRows = rows.slice(windowStart, windowStart + listHeight);

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, overflow: 'hidden' },
    React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(Text, { bold: true }, `${title} — ${profile.name}`),
    ),
    malformed
      ? React.createElement(
          Box,
          { paddingX: 1 },
          React.createElement(
            Text,
            { color: 'red', wrap: 'wrap' },
            t(category === 'settings' ? 'settings.view.malformed.settings' : 'settings.view.malformed.launchConfig'),
          ),
        )
      : React.createElement(
          Box,
          { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
          rows.length === 0
            ? React.createElement(
                Box,
                { paddingX: 1 },
                React.createElement(Text, { color: 'gray' }, t('settings.view.empty')),
              )
            : visibleRows.map((row, i) => {
                const absolute = windowStart + i;
                const isSelected = absolute === selectedIndex;
                const markers =
                  (row.readOnly || row.refused ? ` ${t('settings.view.managed')}` : '') +
                  (row.sensitive ? ' ⚠' : '');
                return React.createElement(
                  Box,
                  { key: row.keyPath, paddingX: 1 },
                  React.createElement(
                    Text,
                    {
                      bold: isSelected,
                      color: isSelected ? 'cyan' : undefined,
                      inverse: isSelected,
                      wrap: 'truncate',
                    },
                    `${row.keyPath}${markers}`,
                  ),
                  React.createElement(
                    Text,
                    { color: row.secret ? 'yellow' : 'gray', wrap: 'truncate' },
                    `  ${row.displayValue}`,
                  ),
                );
              }),
        ),
    // Selected value in full (long values truncate in the list row).
    React.createElement(
      Box,
      { paddingX: 1, height: 1, overflow: 'hidden' },
      React.createElement(
        Text,
        { color: 'gray', wrap: 'truncate' },
        mode === 'list' && selected ? selected.displayValue : '',
      ),
    ),
    React.createElement(
      Box,
      { paddingX: 1, height: 1, overflow: 'hidden' },
      mode === 'edit' && selected
        ? React.createElement(
            Text,
            { color: 'cyan', wrap: 'truncate' },
            `${t('settings.view.edit.prompt', { key: selected.keyPath })}: ` +
              (selected.secret ? '•'.repeat(editDraft.length) : editDraft),
          )
        : mode === 'confirmRemove' && selected
          ? React.createElement(
              Text,
              { color: 'yellow', wrap: 'truncate' },
              t('settings.view.removeConfirm', { key: selected.keyPath }),
            )
          : mode === 'confirmSensitive' && pendingSensitive
            ? React.createElement(
                Text,
                { color: 'yellow', wrap: 'truncate' },
                `${t(pendingSensitive.key === 'skipPermissions' ? 'settings.view.warn.skipPermissions' : 'settings.view.warn.claudeArgs')} ${t('settings.view.confirmProceed')}`,
              )
            : React.createElement(Text, { color: 'green', wrap: 'truncate' }, status ?? ''),
    ),
    React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(
        Text,
        { color: 'gray', wrap: 'truncate' },
        mode === 'edit'
          ? t('settings.view.hint.edit')
          : t(category === 'settings' ? 'settings.view.hint.list' : 'settings.view.hint.list.noRemove'),
      ),
    ),
  );
}
