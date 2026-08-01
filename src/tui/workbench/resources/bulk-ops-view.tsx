import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import { useI18n } from '../i18n/react';
import type { WorkbenchProfile } from '../profile-data';
import {
  getSkillsDirectoryPath,
  inspectSkills,
} from '../../../core/skills-provenance';
import { binExistingSkillEntry, copySkillToProfile, removeLinkedSkill } from '../../../core/skills-install';
import { previewSkillUpdate, applySkillUpdate } from '../../../core/skills-update';
import { listAutoMemoryEntries, removeAutoMemoryEntry } from '../../../core/auto-memory';
import { previewMcpServer, removeMcpServer } from '../../../core/mcp-servers';
import { copyAgentToProfile, removeAgent } from '../../../core/resource';
import { resolveInside } from '../../../platform/path';
import { type CaptureProcess } from '../../../platform/process';
import { CcpsError } from '../../../utils/errors';
import { formatBytes, formatDate } from '../format';

/** Resource category a BulkOpsView instance manages. */
export type BulkCategory = 'skills' | 'agents' | 'mcp' | 'autoMemory';

export type BulkOpsViewProps = {
  profile: WorkbenchProfile;
  appHomePath: string;
  /** Absolute path to profiles/<name> (getProfileTemplatePaths(...).profileRootPath). */
  profileRootPath: string;
  /** All profile names (fan-out target list). */
  profileNames: string[];
  category: BulkCategory;
  width: number;
  height: number;
  onBack: () => void;
  /** Called after any mutation so the parent refreshes sidebar counts. */
  onDataChanged?: () => void;
  /** Skills category only: opens the Discover surface (§7.4). */
  onDiscover?: () => void;
  /** Injected process capture for MCP remove / skill update (hermetic tests). */
  captureProcess?: CaptureProcess;
  /** When true, keyboard input is disabled (headless/test rendering). */
  headless?: boolean;
};

type BulkItem = {
  name: string;
  detail: string;
  /** Skills only: install mode (drives the remove + update paths). */
  mode?: 'copy' | 'link';
  /** Skills only: whether an update is possible without user confirmation. */
  updateEnabled?: boolean;
};

type Phase = 'list' | 'targets';

const CATEGORY_LABEL_KEY = {
  skills: 'bulk.category.skills',
  agents: 'bulk.category.agents',
  mcp: 'bulk.category.mcp',
  autoMemory: 'bulk.category.autoMemory',
} as const;

/**
 * Multi-select bulk operations for a single resource type (spec §11.1):
 * - Remove: multi-select → one action lands each item in the Recovery Bin
 *   (zero confirmation; every core remove fn auto-Bins).
 * - Update (Skills only): each selected Skill updates per its mode; failures
 *   and drift-requiring-confirmation are listed without stopping the rest.
 * - Copy (Skills/Agents only): fan out the selection to multiple target
 *   Profiles in one action.
 */
export function BulkOpsView({
  profile,
  appHomePath,
  profileRootPath,
  profileNames,
  category,
  width,
  height,
  onBack,
  onDataChanged,
  onDiscover,
  captureProcess,
  headless,
}: BulkOpsViewProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY === true;

  const [items, setItems] = useState<BulkItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>('list');
  const [targetCursor, setTargetCursor] = useState(0);
  const [targetSelected, setTargetSelected] = useState<Set<string>>(new Set());
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const targetProfiles = profileNames.filter((n) => n !== profile.name);
  const labelKey = CATEGORY_LABEL_KEY[category];

  const reload = useCallback(async () => {
    let next: BulkItem[] = [];
    if (category === 'skills') {
      try {
        const { skills } = await inspectSkills(profileRootPath);
        next = skills.map((s) => ({
          name: s.name,
          mode: s.record.mode,
          updateEnabled: s.update.enabled,
          detail: `${s.record.mode} · ${s.drift}${s.update.enabled ? '' : ` · update off: ${s.update.reason ?? ''}`}`,
        }));
      } catch (error) {
        setStatusLines([error instanceof Error ? error.message : String(error)]);
      }
    } else if (category === 'agents') {
      next = profile.resourceDetails.agents.map((a) => ({
        name: a.name,
        detail: a.frontmatter?.description ? String(a.frontmatter.description) : a.bodyExcerpt,
      }));
    } else if (category === 'mcp') {
      const rows: BulkItem[] = [];
      for (const name of profile.mcpServers) {
        try {
          const preview = await previewMcpServer(profileRootPath, name);
          rows.push({ name, detail: `transport ${preview.transport}` });
        } catch {
          rows.push({ name, detail: '' });
        }
      }
      next = rows;
    } else {
      try {
        const entries = await listAutoMemoryEntries({ appHomePath, profileName: profile.name });
        next = entries.map((e) => ({
          name: e.name,
          detail: `${formatBytes(e.sizeBytes)} · ${formatDate(e.modifiedAt)}`,
        }));
      } catch (error) {
        setStatusLines([error instanceof Error ? error.message : String(error)]);
      }
    }
    setItems(next);
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, next.length - 1)));
  }, [appHomePath, category, profile.name, profile.resourceDetails.agents, profile.mcpServers, profileRootPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setStatus = (line: string): void => setStatusLines((prev) => [...prev.slice(-8), line]);

  async function bulkRemove(): Promise<void> {
    if (busy || selected.size === 0) {
      if (selected.size === 0) setStatus(t('bulk.noSelection'));
      return;
    }
    setBusy(true);
    let okCount = 0;
    const removedNames: string[] = [];
    const failures: string[] = [];
    for (const name of [...selected].sort()) {
      try {
        const item = items.find((i) => i.name === name);
        if (category === 'skills') {
          if (item?.mode === 'link') {
            await removeLinkedSkill({ appHomePath, profileName: profile.name, profileRootPath, name });
          } else {
            await binExistingSkillEntry({
              appHomePath,
              profileName: profile.name,
              profileRootPath,
              name,
              targetPath: resolveInside(getSkillsDirectoryPath(profileRootPath), name),
              clock: () => new Date(),
            });
          }
        } else if (category === 'agents') {
          await removeAgent(appHomePath, profile.name, name);
        } else if (category === 'mcp') {
          await removeMcpServer(profileRootPath, name, { appHomePath, captureProcess });
        } else {
          await removeAutoMemoryEntry({ appHomePath, profileName: profile.name, entryName: name });
        }
        okCount += 1;
        removedNames.push(name);
      } catch (error) {
        failures.push(t('bulk.remove.failed').replace('{name}', name).replace('{message}', error instanceof Error ? error.message : String(error)));
      }
    }
    if (okCount > 0) setStatus(t('bulk.remove.done').replace('{count}', String(okCount)));
    for (const f of failures) setStatus(f);
    if (removedNames.length > 0) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const n of removedNames) next.delete(n);
        return next;
      });
    }
    setBusy(false);
    await reload();
    onDataChanged?.();
  }

  async function bulkUpdate(): Promise<void> {
    if (category !== 'skills' || busy || selected.size === 0) return;
    setBusy(true);
    for (const name of [...selected].sort()) {
      try {
        const preview = await previewSkillUpdate({
          appHomePath,
          profileRootPath,
          profileName: profile.name,
          name,
          captureProcess,
        });
        const applyOptions = {
          appHomePath,
          profileRootPath,
          profileName: profile.name,
          name,
          captureProcess,
          ...(preview.stagedPath ? { stagedPath: preview.stagedPath } : {}),
        };
        const result = await applySkillUpdate(applyOptions);
        const primary = result.applied[0];
        if (primary?.noop) {
          setStatus(t('bulk.update.noop').replace('{name}', name));
        } else {
          setStatus(t('bulk.update.ok').replace('{name}', name));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof CcpsError && error.code === 'SKILL_UPDATE_DRIFT_CONFIRM_REQUIRED') {
          setStatus(t('bulk.update.drift').replace('{name}', name));
        } else if (error instanceof CcpsError && error.code === 'SKILL_UPDATE_DISABLED') {
          setStatus(t('bulk.update.disabled').replace('{name}', name).replace('{reason}', message));
        } else {
          setStatus(t('bulk.update.failed').replace('{name}', name).replace('{message}', message));
        }
      }
    }
    setBusy(false);
    await reload();
    onDataChanged?.();
  }

  async function fanOutCopy(): Promise<void> {
    if (busy || targetSelected.size === 0) {
      if (targetSelected.size === 0) setStatus(t('bulk.copy.noTargets'));
      return;
    }
    setBusy(true);
    const targets = [...targetSelected].sort();
    const failures: string[] = [];
    for (const name of [...selected].sort()) {
      for (const target of targets) {
        try {
          if (category === 'skills') {
            await copySkillToProfile({
              appHomePath,
              fromProfile: profile.name,
              toProfile: target,
              skillName: name,
            });
          } else if (category === 'agents') {
            await copyAgentToProfile(appHomePath, profile.name, target, name);
          }
          setStatus(t('bulk.copy.result').replace('{item}', name).replace('{profile}', target));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isCollision =
            error instanceof CcpsError &&
            (error.code === 'RESOURCE_COPY_COLLISION' || error.code === 'SKILL_INSTALL_COLLISION');
          if (isCollision) {
            setStatus(t('bulk.copy.collision').replace('{item}', name).replace('{profile}', target));
          } else {
            failures.push(t('bulk.copy.failed').replace('{item}', name).replace('{profile}', target).replace('{message}', message));
          }
        }
      }
    }
    for (const f of failures) setStatus(f);
    setPhase('list');
    setTargetSelected(new Set());
    setBusy(false);
    await reload();
    onDataChanged?.();
  }

  useInput(
    (input, key) => {
      if (phase === 'targets') {
        if (key.escape) {
          setPhase('list');
          return;
        }
        if (targetProfiles.length === 0) return;
        if (key.upArrow) {
          setTargetCursor((i) => (i > 0 ? i - 1 : targetProfiles.length - 1));
          return;
        }
        if (key.downArrow) {
          setTargetCursor((i) => (i < targetProfiles.length - 1 ? i + 1 : 0));
          return;
        }
        if (input === ' ') {
          const name = targetProfiles[targetCursor];
          setTargetSelected((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
          });
          return;
        }
        if (input === 'a') {
          setTargetSelected((prev) => (prev.size === targetProfiles.length ? new Set() : new Set(targetProfiles)));
          return;
        }
        if (key.return) {
          void fanOutCopy();
        }
        return;
      }

      // list phase
      if (key.escape) {
        onBack();
        return;
      }
      if (input === 'd' && category === 'skills') {
        // Discover stays reachable even with no installed Skills.
        onDiscover?.();
        return;
      }
      if (items.length === 0) return;
      if (key.upArrow) {
        setSelectedIndex((i) => (i > 0 ? i - 1 : items.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => (i < items.length - 1 ? i + 1 : 0));
        return;
      }
      if (input === ' ') {
        const name = items[selectedIndex].name;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
        return;
      }
      if (input === 'a') {
        setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.name))));
        return;
      }
      if (input === 'x') {
        void bulkRemove();
        return;
      }
      if (input === 'c' && (category === 'skills' || category === 'agents')) {
        if (selected.size === 0) {
          setStatus(t('bulk.noSelection'));
        } else {
          setPhase('targets');
          setTargetSelected(new Set());
          setTargetCursor(0);
        }
        return;
      }
      if (input === 'u' && category === 'skills') {
        void bulkUpdate();
        return;
      }
    },
    { isActive: canUseInput },
  );

  const selectedCount = selected.size;
  // Copy applies to Skills and Agents only (spec §11.1 fan-out); update and
  // discover are Skills-only — the hint reflects which actions are live.
  const hintKey =
    category === 'skills'
      ? 'bulk.list.hint.skills'
      : category === 'agents'
        ? 'bulk.list.hint'
        : 'bulk.list.hint.removeOnly';

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(
      Box,
      { marginBottom: 1 },
      React.createElement(Text, { bold: true }, t('bulk.title')),
      React.createElement(Text, { dimColor: true }, ` · ${profile.name} · ${t(labelKey)}`),
    ),
    phase === 'targets'
      ? renderTargets()
      : renderList(),
  );

  function renderList(): React.ReactElement {
    return React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      items.length === 0
        ? React.createElement(Text, { dimColor: true }, t('bulk.empty'))
        : React.createElement(
            Box,
            { flexDirection: 'column' },
            ...items.map((item, i) => {
              const isCursor = i === selectedIndex;
              const isSel = selected.has(item.name);
              return React.createElement(
                Box,
                { key: item.name },
                React.createElement(
                  Text,
                  { bold: isCursor, color: isCursor ? 'cyan' : undefined, inverse: isCursor },
                  `${isCursor ? '▸ ' : '  '}${isSel ? '[x]' : '[ ]'} ${item.name}`,
                ),
                React.createElement(
                  Text,
                  { dimColor: true, wrap: 'truncate' },
                  `  ${item.detail}`,
                ),
              );
            }),
          ),
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { dimColor: true }, t('bulk.selected').replace('{count}', String(selectedCount))),
      ),
      statusLines.length > 0 &&
        React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          ...statusLines.map((line, i) =>
            React.createElement(Text, { key: i, color: 'yellow', wrap: 'wrap' }, line),
          ),
        ),
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(Text, { dimColor: true, wrap: 'truncate' }, t(hintKey)),
    );
  }

  function renderTargets(): React.ReactElement {
    return React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      React.createElement(Text, { bold: true }, t('bulk.copy.targets')),
      targetProfiles.length === 0
        ? React.createElement(Text, { dimColor: true }, t('bulk.empty'))
        : React.createElement(
            Box,
            { flexDirection: 'column', marginTop: 1 },
            ...targetProfiles.map((name, i) => {
              const isCursor = i === targetCursor;
              const isSel = targetSelected.has(name);
              return React.createElement(
                Text,
                { key: name, bold: isCursor, color: isCursor ? 'cyan' : undefined, inverse: isCursor },
                `${isCursor ? '▸ ' : '  '}${isSel ? '[x]' : '[ ]'} ${name}`,
              );
            }),
          ),
      statusLines.length > 0 &&
        React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          ...statusLines.map((line, i) =>
            React.createElement(Text, { key: i, color: 'yellow', wrap: 'wrap' }, line),
          ),
        ),
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(Text, { dimColor: true, wrap: 'truncate' }, t('bulk.copy.targets.hint')),
    );
  }
}
