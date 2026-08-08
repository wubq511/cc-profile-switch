import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import { useI18n } from '../i18n/react';
import type { LocaleKey } from '../i18n/en';
import {
  changeRetentionSetting,
  computeItemExpiresAt,
  emptyRecoveryBin,
  getRecoveryItemDisplayName,
  listRecoveryBinWithSizes,
  permanentlyDeleteItem,
  restoreRecoveryItem,
  type PluginRestoreHandler,
  type RecoveryBinItem,
} from '../../../core/recovery-bin';
import { listBackups, permanentlyDeleteBackup, type BackupEntry } from '../../../core/backup';
import { loadAppConfig } from '../../../core/app-config';
import { CcpsError } from '../../../utils/errors';
import { CollisionDialog, type CollisionResolutionChoice } from './collision-dialog';
import { suggestNewName } from './collision-dialog-reducer';
import { formatBytes, formatDate } from '../format';

/**
 * Workbench Recovery Bin surface (spec §9.5, issue #94). One pane browses
 * both sides of the durable/temporary boundary:
 *
 * - Recovery Items (temporary): what was removed without a backup, with the
 *   origin Profile and per-item expiry; Enter restores (refuse-by-default on
 *   collision, never a silent overwrite), x permanently deletes, E empties.
 * - Profile Backups (durable): what a backup captured; never auto-expires,
 *   restoring from a backup is a Profile-lifecycle action (not offered here),
 *   x permanently deletes — S116's confirm states it is unrecoverable.
 *
 * App-level access key `B`; the surface owns its input via the app's capture
 * flag, so it works even when zero Profiles remain (the Bin can still hold
 * items).
 */

type Row =
  | { key: string; source: 'bin'; item: RecoveryBinItem; sizeBytes: number }
  | { key: string; source: 'backup'; entry: BackupEntry };

type Phase = 'list' | 'collision' | 'retention' | 'confirm-delete' | 'confirm-empty';

type DeleteTarget = { source: 'bin'; id: string; name: string } | { source: 'backup'; id: string };

/** Recovery Bin retention options (spec §9.4): 7/30/90 days, or Never. */
const RETENTION_OPTIONS: ReadonlyArray<number | null> = [7, 30, 90, null];

export type RecoveryViewProps = {
  appHomePath: string;
  /** All profile names, for profile-kind restore-as-new-name suggestions. */
  profileNames: string[];
  width: number;
  height: number;
  onBack: () => void;
  /** Called after any mutation so the parent refreshes sidebar data. */
  onDataChanged?: () => void;
  /** Plugin items reinstall through a delegated handler (wired in app.tsx). */
  pluginRestore?: PluginRestoreHandler;
  /** When true, keyboard input is disabled (headless/test rendering). */
  headless?: boolean;
};

// Recovery Item kind enum → localized labels. The kind union is closed (all
// eight kinds are enumerated in the schema), so the map is total — there is no
// unmapped fallback.
const KIND_LABEL_KEYS: Record<RecoveryBinItem['kind'], LocaleKey> = {
  profile: 'recovery.kind.profile',
  skill: 'recovery.kind.skill',
  agent: 'recovery.kind.agent',
  'user-memory': 'recovery.kind.userMemory',
  'auto-memory': 'recovery.kind.autoMemory',
  'mcp-server': 'recovery.kind.mcpServer',
  'settings-field': 'recovery.kind.settingsField',
  plugin: 'recovery.kind.plugin',
};

export function RecoveryView({
  appHomePath,
  profileNames,
  width,
  height,
  onBack,
  onDataChanged,
  pluginRestore,
  headless,
}: RecoveryViewProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY === true;

  const [binList, setBinList] = useState<{
    entries: { item: RecoveryBinItem; sizeBytes: number }[];
    totalSizeBytes: number;
  }>({
    entries: [],
    totalSizeBytes: 0,
  });
  const [backupList, setBackupList] = useState<{ entries: BackupEntry[]; totalSizeBytes: number }>({
    entries: [],
    totalSizeBytes: 0,
  });
  const [retentionDays, setRetentionDays] = useState<number | null>(30);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('list');
  const [collisionItem, setCollisionItem] = useState<(Row & { source: 'bin' }) | null>(null);
  const [collisionSuggestedName, setCollisionSuggestedName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [bin, backups, config] = await Promise.all([
        listRecoveryBinWithSizes(appHomePath),
        listBackups(appHomePath),
        loadAppConfig(appHomePath).catch(() => null),
      ]);
      setBinList(bin);
      setBackupList(backups);
      setRetentionDays(config?.recovery.retentionDays ?? 30);
      const total = bin.entries.length + backups.entries.length;
      setSelectedIndex((prev) => Math.min(prev, Math.max(0, total - 1)));
    } catch (error) {
      setStatusLines([error instanceof Error ? error.message : String(error)]);
    }
  }, [appHomePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // One combined cursor across both sections: Recovery Items first, then
  // Profile Backups, each with its per-section header and totals (S115).
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const entry of binList.entries) {
      out.push({
        key: `bin:${entry.item.id}`,
        source: 'bin',
        item: entry.item,
        sizeBytes: entry.sizeBytes,
      });
    }
    for (const entry of backupList.entries) {
      out.push({ key: `backup:${entry.id}`, source: 'backup', entry });
    }
    return out;
  }, [binList, backupList]);

  const setStatus = (line: string): void => setStatusLines((prev) => [...prev.slice(-8), line]);

  function retentionLabel(days: number | null): string {
    return days === null
      ? t('recovery.retention.never')
      : t('recovery.retention.option', { days: String(days) });
  }

  function expiryLabel(item: RecoveryBinItem): string {
    const expiresAt = computeItemExpiresAt(item, retentionDays);
    if (expiresAt === null) return t('recovery.never');
    return t('recovery.expires', { date: formatDate(expiresAt.toISOString()) });
  }

  function kindLabel(item: RecoveryBinItem): string {
    return t(KIND_LABEL_KEYS[item.kind]);
  }

  /** Open the shared collision dialog, prefilled with a non-colliding name. */
  function enterCollision(row: Row & { source: 'bin' }, baseName?: string): void {
    const base = baseName ?? getRecoveryItemDisplayName(row.item);
    // Profile-kind items suggest against the live Profile names; other kinds
    // cannot be enumerated here, so a colliding new name is re-suggested on
    // re-entry (the core rejects it first).
    const existing = row.item.kind === 'profile' ? new Set(profileNames) : new Set<string>();
    setCollisionItem(row);
    setCollisionSuggestedName(suggestNewName(base, existing));
    setPhase('collision');
  }

  async function restoreRow(): Promise<void> {
    if (busy) return;
    const row = rows[selectedIndex];
    if (!row) return;
    if (row.source === 'backup') {
      // Restore-from-backup is a Profile-lifecycle action (spec §2 note), not
      // a resource action of this surface — say so instead of pretending.
      setStatus(t('recovery.backup.restoreUnavailable'));
      return;
    }
    const name = getRecoveryItemDisplayName(row.item);
    if (row.item.shape === 'plugin' && !pluginRestore) {
      // No delegated reinstall handler wired (e.g. plugin uninstall records
      // without a configured marketplace): refuse with a clear status.
      setStatus(t('recovery.plugin.restoreUnavailable'));
      return;
    }
    setBusy(true);
    try {
      await restoreRecoveryItem({ appHomePath, itemId: row.item.id, pluginRestore });
      setStatus(t('recovery.restore.success', { name }));
      await reload();
      onDataChanged?.();
    } catch (error) {
      if (error instanceof CcpsError && error.code === 'RESTORE_COLLISION') {
        enterCollision(row);
      } else {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function resolveCollision(choice: CollisionResolutionChoice): Promise<void> {
    const row = collisionItem;
    if (!row) return;
    const name = getRecoveryItemDisplayName(row.item);
    if (choice.resolution === 'refuse') {
      setCollisionItem(null);
      setPhase('list');
      return;
    }
    try {
      await restoreRecoveryItem({
        appHomePath,
        itemId: row.item.id,
        collisionResolution: choice.resolution,
        newName: choice.resolution === 'restore-as-new-name' ? choice.newName : undefined,
        pluginRestore,
      });
      setStatus(
        choice.resolution === 'restore-as-new-name'
          ? t('recovery.restore.renamed', { name, newName: choice.newName })
          : t('recovery.restore.replaced', { name }),
      );
      setCollisionItem(null);
      setPhase('list');
      await reload();
      onDataChanged?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CcpsError && error.code === 'RESTORE_COLLISION') {
        // The chosen new name also collides — re-suggest and stay in the dialog.
        const base = choice.resolution === 'restore-as-new-name' ? choice.newName : name;
        enterCollision(row, base);
      } else {
        setStatus(message);
        setCollisionItem(null);
        setPhase('list');
      }
    }
  }

  function startDelete(): void {
    const row = rows[selectedIndex];
    if (!row) return;
    if (row.source === 'bin') {
      setDeleteTarget({
        source: 'bin',
        id: row.item.id,
        name: getRecoveryItemDisplayName(row.item),
      });
    } else {
      setDeleteTarget({ source: 'backup', id: row.entry.id });
    }
    setPhase('confirm-delete');
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (!target) return;
    setPhase('list');
    setDeleteTarget(null);
    try {
      if (target.source === 'bin') {
        await permanentlyDeleteItem(target.id, appHomePath);
        setStatus(t('recovery.deleted.item', { name: target.name }));
      } else {
        await permanentlyDeleteBackup(target.id, appHomePath);
        setStatus(t('recovery.deleted.backup', { id: target.id }));
      }
      await reload();
      onDataChanged?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function confirmEmptyBin(): Promise<void> {
    setPhase('list');
    try {
      await emptyRecoveryBin(appHomePath);
      setStatus(t('recovery.emptied'));
      await reload();
      onDataChanged?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  /** S114: apply a retention change and report how many items would expire. */
  async function applyRetention(days: number | null): Promise<void> {
    setPhase('list');
    try {
      const impact = await changeRetentionSetting(days, appHomePath);
      setStatus(
        t('recovery.retention.result', {
          label: retentionLabel(days),
          count: String(impact.wouldExpireCount),
        }),
      );
      await reload();
      onDataChanged?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  useInput(
    (input: string, key: Record<string, boolean>) => {
      if (key.ctrl && input === 'c') return; // app-level exit handles this

      // The collision dialog owns its own input while it is open.
      if (phase === 'collision') return;

      if (phase === 'confirm-delete') {
        if (input === 'y' || input === 'Y') {
          void confirmDelete();
          return;
        }
        if (input === 'n' || input === 'N' || key.escape) {
          setPhase('list');
          setDeleteTarget(null);
        }
        return;
      }

      if (phase === 'confirm-empty') {
        if (input === 'y' || input === 'Y') {
          void confirmEmptyBin();
          return;
        }
        if (input === 'n' || input === 'N' || key.escape) {
          setPhase('list');
        }
        return;
      }

      if (phase === 'retention') {
        if (key.escape) {
          setPhase('list');
          return;
        }
        const choice = parseInt(input, 10);
        if (choice >= 1 && choice <= RETENTION_OPTIONS.length) {
          void applyRetention(RETENTION_OPTIONS[choice - 1]!);
        }
        return;
      }

      // List phase
      if (key.escape) {
        onBack();
        return;
      }
      // Retention is a Bin-wide setting, so `r` stays reachable even when the
      // Bin and Backups are both empty.
      if (input === 'r') {
        setPhase('retention');
        return;
      }
      if (rows.length === 0) return;
      if (key.upArrow) {
        setSelectedIndex((i) => (i > 0 ? i - 1 : rows.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => (i < rows.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        void restoreRow();
        return;
      }
      if (input === 'x') {
        startDelete();
        return;
      }
      if (input === 'E') {
        if (binList.entries.length === 0) {
          setStatus(t('recovery.empty.bin'));
        } else {
          setPhase('confirm-empty');
        }
      }
    },
    { isActive: canUseInput },
  );

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>{t('recovery.title')}</Text>
        <Text dimColor> · {t('recovery.subtitle')}</Text>
      </Box>

      {phase === 'collision' && collisionItem ? (
        <CollisionDialog
          key={collisionSuggestedName}
          resourceName={getRecoveryItemDisplayName(collisionItem.item)}
          suggestedName={collisionSuggestedName}
          onResolve={(choice) => void resolveCollision(choice)}
          headless={headless}
        />
      ) : phase === 'confirm-delete' && deleteTarget ? (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="yellow" wrap="wrap">
            {deleteTarget.source === 'bin'
              ? t('recovery.delete.confirm.item', { name: deleteTarget.name })
              : t('recovery.delete.confirm.backup', { id: deleteTarget.id })}
          </Text>
          <Text dimColor>{t('recovery.delete.detail')}</Text>
          <Text dimColor>{t('recovery.delete.hint')}</Text>
        </Box>
      ) : phase === 'confirm-empty' ? (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="yellow" wrap="wrap">
            {t('recovery.empty.confirm', {
              count: String(binList.entries.length),
              size: formatBytes(binList.totalSizeBytes),
            })}
          </Text>
          <Text dimColor>{t('recovery.empty.detail')}</Text>
          <Text dimColor>{t('recovery.empty.hint')}</Text>
        </Box>
      ) : phase === 'retention' ? (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="cyan" wrap="wrap">
            {t('recovery.retention.title')}
          </Text>
          <Text dimColor wrap="wrap">
            {t('recovery.retention.detail')}
          </Text>
          <Text dimColor>
            {t('recovery.retention.current', { label: retentionLabel(retentionDays) })}
          </Text>
          {RETENTION_OPTIONS.map((days, i) => (
            <Text key={i}>
              {i + 1}) {retentionLabel(days)}
            </Text>
          ))}
          <Text dimColor>{t('recovery.retention.hint')}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          {rows.length === 0 ? (
            <Box flexDirection="column">
              <Text dimColor>{t('recovery.empty.bin')}</Text>
              <Text dimColor>{t('recovery.empty.backups')}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {binList.entries.length > 0 && (
                <Text bold dimColor wrap="truncate">
                  {t('recovery.section.items')} ·{' '}
                  {t('recovery.itemCount', { count: String(binList.entries.length) })} ·{' '}
                  {t('recovery.total', { size: formatBytes(binList.totalSizeBytes) })}
                </Text>
              )}
              {renderRows()}
              {backupList.entries.length > 0 && (
                <Box marginTop={1}>
                  <Text bold dimColor wrap="truncate">
                    {t('recovery.section.backups')} ·{' '}
                    {t('recovery.backupCount', { count: String(backupList.entries.length) })} ·{' '}
                    {t('recovery.total', { size: formatBytes(backupList.totalSizeBytes) })}
                  </Text>
                </Box>
              )}
            </Box>
          )}
          {statusLines.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {statusLines.map((line, i) => (
                <Text key={i} color="yellow" wrap="wrap">
                  {line}
                </Text>
              ))}
            </Box>
          )}
          <Box flexGrow={1} />
          <Text dimColor wrap="truncate">
            {t('recovery.hint')}
          </Text>
        </Box>
      )}
    </Box>
  );

  function renderRows(): React.ReactElement[] {
    // One pass over the combined rows: Bin rows first (cyan), then Backup rows
    // (green ◆), so the single cursor walks both sections in order (S115).
    return rows.map((row, i) => {
      const isSel = i === selectedIndex;
      if (row.source === 'bin') {
        return (
          <Text
            key={row.key}
            bold={isSel}
            color={isSel ? 'cyan' : undefined}
            inverse={isSel}
            wrap="truncate"
          >
            {isSel ? '▸ ' : '  '}
            {getRecoveryItemDisplayName(row.item)} · {kindLabel(row.item)} ·{' '}
            {t('recovery.from', { profile: row.item.profile })} · {expiryLabel(row.item)} ·{' '}
            {formatBytes(row.sizeBytes)}
          </Text>
        );
      }
      return (
        <Text key={row.key} bold={isSel} color="green" inverse={isSel} wrap="truncate">
          {isSel ? '▸ ' : '  '}◆ {row.entry.id} · {t('recovery.backup.tag')} ·{' '}
          {formatBytes(row.entry.sizeBytes)}
        </Text>
      );
    });
  }
}
