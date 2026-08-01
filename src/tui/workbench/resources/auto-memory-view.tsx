import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import { useI18n } from '../i18n/react';
import type { WorkbenchProfile } from '../profile-data';
import type { EditSession, EditSessionManager } from '../../../core/edit-session';
import {
  copyAutoMemoryEntry,
  getAutoMemoryEntryPath,
  getEntryNameFromBinItem,
  listAutoMemoryEntries,
  readAutoMemoryEntry,
  removeAutoMemoryEntry,
  searchAutoMemory,
  type AutoMemoryEntry,
} from '../../../core/auto-memory';
import { listRecoveryBinItems, restoreRecoveryItem } from '../../../core/recovery-bin';

type Mode = 'list' | 'copy' | 'restore';

export type AutoMemoryViewProps = {
  profile: WorkbenchProfile;
  appHomePath: string;
  /** All profile names, for copy-target validation. */
  profileNames: string[];
  width: number;
  height: number;
  editSessionManager: EditSessionManager;
  onBack: () => void;
  /** When true, keyboard input is disabled (headless/test rendering). */
  headless?: boolean;
};

export function AutoMemoryView({
  profile,
  appHomePath,
  profileNames,
  width,
  height,
  editSessionManager,
  onBack,
  headless,
}: AutoMemoryViewProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY === true;

  const [entries, setEntries] = useState<AutoMemoryEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preview, setPreview] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchMatches, setSearchMatches] = useState<Set<string> | null>(null);
  const [mode, setMode] = useState<Mode>('list');
  const [copyInput, setCopyInput] = useState('');
  const [restoreItems, setRestoreItems] = useState<{ id: string; entryName: string }[]>([]);
  const [restoreIndex, setRestoreIndex] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  // Content search: when a query is active, `searchAutoMemory` reads entry
  // contents and returns matching entry names. Falls back to name matches so a
  // query that appears only in a file name still surfaces the entry.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q === '') {
      setSearchMatches(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const matches = await searchAutoMemory({ appHomePath, profileName: profile.name, query: q });
        if (!cancelled) setSearchMatches(new Set(matches.map((m) => m.entryName)));
      } catch {
        if (!cancelled) setSearchMatches(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appHomePath, profile.name, searchQuery]);

  const needle = searchQuery.trim().toLowerCase();
  const filtered = searchMatches
    ? entries.filter(
        (e) => searchMatches.has(e.name) || (needle !== '' && e.name.toLowerCase().includes(needle)),
      )
    : entries;

  const selectedEntry = filtered[selectedIndex] ?? undefined;
  const selectedPath = selectedEntry
    ? getAutoMemoryEntryPath({ appHomePath, profileName: profile.name, entryName: selectedEntry.name })
    : null;
  const session: EditSession | undefined = selectedPath
    ? editSessionManager.getSession(selectedPath)
    : undefined;
  const editActive = session !== undefined && session.phase !== 'idle';
  // Bump when VS Code reports an external save so the preview effect re-reads.
  const sessionChangeCount = session?.changeCount ?? 0;

  const reload = useCallback(async () => {
    try {
      const list = await listAutoMemoryEntries({ appHomePath, profileName: profile.name });
      setEntries(list);
      setSelectedIndex((prev) => Math.min(prev, Math.max(0, list.length - 1)));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [appHomePath, profile.name]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Load preview for the selected entry. `sessionChangeCount` is a dependency
  // so external saves in VS Code refresh the preview without a manual reload.
  useEffect(() => {
    let cancelled = false;
    const selected = filtered[selectedIndex];
    if (!selected) {
      setPreview('');
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const result = await readAutoMemoryEntry({
          appHomePath,
          profileName: profile.name,
          entryName: selected.name,
        });
        if (!cancelled) setPreview(result.content);
      } catch {
        if (!cancelled) setPreview('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appHomePath, profile.name, selectedIndex, entries, searchQuery, sessionChangeCount]);

  useInput((input: string, key: Record<string, boolean>) => {
    if (key.ctrl && input === 'c') return; // app-level exit handles this

    // Search mode
    if (searchFocused) {
      if (key.escape) {
        setSearchFocused(false);
        setSearchQuery('');
        return;
      }
      if (key.return) {
        setSearchFocused(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        setSelectedIndex(0);
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        setSearchQuery((q) => q + input);
        setSelectedIndex(0);
      }
      return;
    }

    // Copy prompt mode
    if (mode === 'copy') {
      if (key.escape) {
        setMode('list');
        setCopyInput('');
        return;
      }
      if (key.return) {
        void confirmCopy();
        return;
      }
      if (key.backspace || key.delete) {
        setCopyInput((s) => s.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        setCopyInput((s) => s + input);
      }
      return;
    }

    // Restore picker mode
    if (mode === 'restore') {
      if (key.escape) {
        setMode('list');
        return;
      }
      if (restoreItems.length === 0) return;
      if (key.upArrow) {
        setRestoreIndex((i) => (i > 0 ? i - 1 : restoreItems.length - 1));
        return;
      }
      if (key.downArrow) {
        setRestoreIndex((i) => (i < restoreItems.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        void confirmRestore();
      }
      return;
    }

    // List mode
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : filtered.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => (i < filtered.length - 1 ? i + 1 : 0));
      return;
    }
    if (input === '/') {
      setSearchFocused(true);
      return;
    }
    if (input === 'e') {
      void openEditor();
      return;
    }
    if (input === 'c') {
      setMode('copy');
      setCopyInput('');
      setStatus(null);
      return;
    }
    if (input === 'x') {
      void removeSelected();
      return;
    }
    if (input === 'u') {
      void openRestorePicker();
      return;
    }
  }, { isActive: canUseInput });

  async function openEditor(): Promise<void> {
    if (!selectedEntry || !selectedPath) return;
    setStatus(t('autoMemory.edit.opening').replace('{entry}', selectedEntry.name));
    try {
      await editSessionManager.open(selectedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(t('autoMemory.edit.failed').replace('{message}', message));
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selectedEntry) return;
    const entryName = selectedEntry.name;
    try {
      await removeAutoMemoryEntry({
        appHomePath,
        profileName: profile.name,
        entryName,
      });
      setStatus(t('autoMemory.remove.done').replace('{entry}', entryName));
      await reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmCopy(): Promise<void> {
    const target = copyInput.trim();
    setMode('list');
    setCopyInput('');
    if (!selectedEntry) return;
    if (target === profile.name) {
      setStatus(t('autoMemory.copy.sameProfile'));
      return;
    }
    if (!profileNames.includes(target)) {
      setStatus(t('autoMemory.copy.badName'));
      return;
    }
    try {
      await copyAutoMemoryEntry({
        appHomePath,
        fromProfile: profile.name,
        toProfile: target,
        entryName: selectedEntry.name,
      });
      setStatus(
        t('autoMemory.copy.success')
          .replace('{entry}', selectedEntry.name)
          .replace('{profile}', target),
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function openRestorePicker(): Promise<void> {
    try {
      const items = await listRecoveryBinItems(appHomePath);
      const autoItems = items
        .filter((i) => i.kind === 'auto-memory' && i.profile === profile.name)
        .map((i) => ({ id: i.id, entryName: getEntryNameFromBinItem(i) }));
      setRestoreItems(autoItems);
      setRestoreIndex(0);
      setMode('restore');
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmRestore(): Promise<void> {
    const item = restoreItems[restoreIndex];
    if (!item) return;
    try {
      await restoreRecoveryItem({ appHomePath, itemId: item.id });
      setStatus(t('autoMemory.restore.success').replace('{entry}', item.entryName));
      setMode('list');
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/collision|already exists/i.test(message)) {
        setStatus(t('autoMemory.restore.collision'));
      } else {
        setStatus(t('autoMemory.restore.failed').replace('{message}', message));
      }
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  const listHeight = Math.max(3, Math.floor((height - 6) * 0.4));
  const previewHeight = Math.max(3, height - listHeight - 6);

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>{t('autoMemory.title')}</Text>
        <Text dimColor> · {profile.name}</Text>
        {editActive && (
          <Text color="green"> · ✎ {t('autoMemory.edit.banner')}</Text>
        )}
      </Box>

      {mode === 'copy' ? (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>
            {t('autoMemory.copy.prompt')}
            <Text color="cyan">{copyInput}█</Text>
          </Text>
          <Text dimColor>{t('keymap.esc')}</Text>
        </Box>
      ) : mode === 'restore' ? (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold>{t('autoMemory.restore.title')}</Text>
          {restoreItems.length === 0 ? (
            <Text dimColor>{t('autoMemory.restore.empty')}</Text>
          ) : (
            restoreItems.map((item, i) => (
              <Text key={item.id} bold={i === restoreIndex} color={i === restoreIndex ? 'cyan' : undefined}>
                {i === restoreIndex ? '▸ ' : '  '}
                {item.entryName}
              </Text>
            ))
          )}
          <Text dimColor>{t('keymap.esc')}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          {/* Search line */}
          <Box marginBottom={1}>
            {searchFocused ? (
              <Text color="cyan">/{searchQuery}█</Text>
            ) : (
              <Text dimColor>{t('autoMemory.search.placeholder')}</Text>
            )}
          </Box>

          {/* Entry list */}
          <Box flexDirection="column" height={listHeight}>
            {filtered.length === 0 ? (
              searchQuery ? (
                <Text dimColor>{t('autoMemory.search.noMatch')}</Text>
              ) : (
                <Box flexDirection="column">
                  <Text dimColor>{t('autoMemory.empty')}</Text>
                </Box>
              )
            ) : (
              renderEntryWindow().map((row) => row)
            )}
          </Box>

          {/* Preview */}
          <Box flexDirection="column" marginTop={1} height={previewHeight}>
            <Text bold dimColor>
              {t('autoMemory.preview')}
              {selectedEntry ? ` · ${selectedEntry.name}` : ''}
            </Text>
            {selectedEntry ? (
              <Text>{truncatePreview(preview, previewHeight - 1, width - 2)}</Text>
            ) : (
              <Text dimColor>{t('autoMemory.preview.empty')}</Text>
            )}
          </Box>
        </Box>
      )}

      {/* Boundary note + status */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{t('autoMemory.noCreate')}</Text>
        <Text dimColor>{t('autoMemory.noDiff')}</Text>
        <Text dimColor>{t('autoMemory.actions')}</Text>
        {status && <Text color="yellow">{status}</Text>}
      </Box>
    </Box>
  );

  function renderEntryWindow(): React.ReactElement[] {
    const windowSize = Math.max(1, listHeight);
    const start = Math.max(0, selectedIndex - Math.floor(windowSize / 2));
    const end = Math.min(filtered.length, start + windowSize);
    const rows: React.ReactElement[] = [];
    for (let i = start; i < end; i++) {
      const entry = filtered[i]!;
      const isSel = i === selectedIndex;
      rows.push(
        <Box key={entry.name}>
          <Text bold={isSel} color={isSel ? 'cyan' : undefined} inverse={isSel}>
            {isSel ? '▸ ' : '  '}
            {entry.name} ({formatBytes(entry.sizeBytes)}, {formatDate(entry.modifiedAt)})
          </Text>
        </Box>,
      );
    }
    return rows;
  }
}

function truncatePreview(content: string, maxLines: number, maxWidth: number): string {
  if (!content) return '';
  const lines = content.split('\n');
  const slice = lines.slice(0, Math.max(1, maxLines));
  return slice.map((line) => (line.length > maxWidth ? line.slice(0, maxWidth - 1) + '…' : line)).join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  // ISO 8601 → compact YYYY-MM-DD for the list row.
  return iso.slice(0, 10);
}
