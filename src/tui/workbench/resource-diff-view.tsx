import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { LocaleKey } from './i18n/en';
import type { WorkbenchProfile } from './profile-data';
import type { UserMemoryDiff, AgentsDiff } from '../../core/resource';
import { countChanges } from '../../core/resource/diff';
import { verdictSymbol } from '../../core/diff';
import type { SettingsDiffEntry, LaunchConfigDiffEntry, KeyVerdict } from '../../core/diff';
import type {
  ResourceDiffResult,
  McpInventoryDiff,
  CopiedSkillsDiff,
  SkillDisabledReason,
  SkillVsSourceRow,
} from '../../core/resource/diff-all';

type ResourceDiffViewProps = {
  profile: WorkbenchProfile;
  diff: ResourceDiffResult | null;
  /** The selected counterpart profile name (header / presence labels). */
  counterpart: string | null;
  drilledAgent: string | null;
  profiles: WorkbenchProfile[];
  width: number;
  height: number;
  scrollOffset: number;
};

/** Reserve for the header + summary + hint lines. */
const HEADER_ROWS = 6;

/**
 * Renders the pairwise diff per spec §12 — format follows resource:
 *   User Memory / Agents → unified line diff (Agents per-file + drill-in)
 *   Settings             → redacted key table (key names + verdicts, values never)
 *   MCP                  → server inventory (name/transport/connection per Profile)
 *   Copied Skills        → hash-tree diff vs each Profile's own source
 *   Launch config        → key table with values + sensitive-field warnings
 */
export function ResourceDiffView({
  profile,
  diff,
  counterpart,
  drilledAgent,
  profiles,
  width,
  height,
  scrollOffset,
}: ResourceDiffViewProps): React.ReactElement {
  const { t } = useI18n();

  if (diff === null) {
    const counterpartNames = profiles
      .map((p) => p.name)
      .filter((name) => name !== profile.name);
    return React.createElement(
      Box,
      { flexDirection: 'column', width, height, paddingX: 1 },
      React.createElement(Text, { bold: true }, t('resource.diff.title')),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, { dimColor: true }, t('resource.diff.selectProfile')),
      ),
      React.createElement(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        ...counterpartNames.map((name) =>
          React.createElement(
            Text,
            { key: name, color: 'cyan' },
            `  ${name}`,
          ),
        ),
      ),
    );
  }

  const counterpartName = counterpart ?? profile.name;
  const visibleRows = Math.max(1, height - HEADER_ROWS);
  const { summary, rows } = renderByCategory();
  const windowed = rows.slice(scrollOffset, scrollOffset + visibleRows);

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `${profile.name} → ${counterpartName}`,
    ),
    summary &&
      React.createElement(Text, { dimColor: true, wrap: 'truncate' }, summary),
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      ...windowed,
      rows.length === 0 &&
        React.createElement(Text, { dimColor: true }, t('resource.diff.noChange')),
    ),
  );

  function renderByCategory(): { summary: string | null; rows: React.ReactElement[] } {
    switch (diff.category) {
      case 'user-memory':
        return renderMemoryRows(diff.diff);
      case 'agents':
        return renderAgentsRows(diff.diff);
      case 'settings':
        return renderSettingsRows(diff.diff);
      case 'mcp':
        return renderMcpRows(diff.diff);
      case 'skills':
        return renderSkillsRows(diff.diff);
      case 'launch-config':
        return renderLaunchRows(diff.diff);
    }
  }

  function renderMemoryRows(memoryDiff: UserMemoryDiff): { summary: string | null; rows: React.ReactElement[] } {
    const { add, del } = countChanges(memoryDiff.lines);
    return {
      summary: `${t('resource.diff.added')} ${add} · ${t('resource.diff.removed')} ${del}`,
      rows: memoryDiff.lines.map((line, i) =>
        React.createElement(
          Text,
          { key: i, color: line.type === 'add' ? 'green' : line.type === 'del' ? 'red' : undefined, wrap: 'truncate' },
          `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} ${line.text}`,
        ),
      ),
    };
  }

  function renderAgentsRows(agentsDiff: AgentsDiff): { summary: string | null; rows: React.ReactElement[] } {
    const rows: React.ReactElement[] = [];
    for (const file of agentsDiff.files) {
      const marker =
        file.verdict === 'added' ? '+' :
        file.verdict === 'removed' ? '-' :
        file.verdict === 'changed' ? '≠' : '=';
      const color =
        file.verdict === 'added' ? 'green' :
        file.verdict === 'removed' ? 'red' :
        file.verdict === 'changed' ? 'yellow' : undefined;
      const label =
        file.verdict === 'added' ? t('resource.diff.added') :
        file.verdict === 'removed' ? t('resource.diff.removed') :
        file.verdict === 'changed' ? t('resource.diff.changed') :
        t('resource.diff.same');

      rows.push(
        React.createElement(
          Box,
          { key: file.name, gap: 1 },
          React.createElement(Text, { color, wrap: 'truncate' }, `${marker} ${file.name} (${label})`),
          file.verdict === 'changed' &&
            React.createElement(Text, { dimColor: true }, t('resource.diff.drillIn')),
        ),
      );
      if (drilledAgent === file.name && file.lines) {
        rows.push(
          ...file.lines.map((line, i) =>
            React.createElement(
              Text,
              { key: `${file.name}:${i}`, color: line.type === 'add' ? 'green' : line.type === 'del' ? 'red' : undefined, wrap: 'truncate' },
              `    ${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} ${line.text}`,
            ),
          ),
        );
      }
    }

    return {
      summary: `${t('resource.diff.added')} ${agentsDiff.addedCount} · ${t('resource.diff.removed')} ${agentsDiff.removedCount} · ${t('resource.diff.changed')} ${agentsDiff.changedCount}`,
      rows,
    };
  }

  function renderSettingsRows(entries: SettingsDiffEntry[]): { summary: string | null; rows: React.ReactElement[] } {
    return {
      summary: t('resource.diff.settingsRedacted'),
      rows: entries.map((entry) => {
        const mark = verdictSymbol(entry.verdict);
        const color = verdictColor(entry.verdict);
        let suffix = '';
        if (entry.verdict === 'changed') suffix = `  ${t('resource.diff.valueHidden')}`;
        else if (entry.verdict === 'only-a') suffix = `  ${onlyIn(profile.name)}`;
        else if (entry.verdict === 'only-b') suffix = `  ${onlyIn(counterpartName)}`;
        return React.createElement(
          Text,
          { key: entry.key, color, wrap: 'truncate' },
          `${mark} ${entry.key}${suffix}`,
        );
      }),
    };
  }

  function renderMcpRows(mcpDiff: McpInventoryDiff): { summary: string | null; rows: React.ReactElement[] } {
    return {
      summary: t('resource.diff.mcpInventory'),
      rows: mcpDiff.rows.map((row) => {
        const cellA = row.inA ? `${row.transportA}·${row.connectionA}` : '—';
        const cellB = row.inB ? `${row.transportB}·${row.connectionB}` : '—';
        const differs =
          row.inA && row.inB &&
          (row.transportA !== row.transportB || row.connectionA !== row.connectionB);
        const mark = differs ? '≠' : row.inA && row.inB ? ' ' : row.inA ? '-' : '+';
        const color =
          differs ? 'yellow' :
          row.inA && !row.inB ? 'red' :
          !row.inA && row.inB ? 'green' : undefined;
        let suffix = '';
        if (!row.inA) suffix = `  ${onlyIn(counterpartName)}`;
        else if (!row.inB) suffix = `  ${onlyIn(profile.name)}`;
        return React.createElement(
          Text,
          { key: row.name, color, wrap: 'truncate' },
          `${mark} ${row.name.padEnd(16)} ${cellA.padEnd(18)} ${cellB}${suffix}`,
        );
      }),
    };
  }

  function renderSkillsRows(skillsDiff: CopiedSkillsDiff): { summary: string | null; rows: React.ReactElement[] } {
    const rows: React.ReactElement[] = [];
    for (const row of skillsDiff.skills) {
      if (!row.inB) {
        rows.push(
          React.createElement(
            Text,
            { key: row.name, color: 'red', wrap: 'truncate' },
            `- ${row.name}  ${onlyIn(profile.name)}`,
          ),
        );
        rows.push(...perSideSkillRows(`${row.name}:a`, profile.name, row.aVsSource, row.aDisabledReason));
        continue;
      }
      if (!row.inA) {
        rows.push(
          React.createElement(
            Text,
            { key: row.name, color: 'green', wrap: 'truncate' },
            `+ ${row.name}  ${onlyIn(counterpartName)}`,
          ),
        );
        rows.push(...perSideSkillRows(`${row.name}:b`, counterpartName, row.bVsSource, row.bDisabledReason));
        continue;
      }

      const a = row.aVsSource;
      const b = row.bVsSource;
      const hasTree = (a !== null && a.entries.length > 0) || (b !== null && b.entries.length > 0);
      if (!hasTree) {
        const unavailable = a === null || b === null;
        rows.push(
          React.createElement(
            Text,
            { key: row.name, color: unavailable ? 'yellow' : undefined, wrap: 'truncate' },
            `${unavailable ? '≠' : ' '} ${row.name}  (${unavailable ? t('resource.diff.diffUnavailable') : t('resource.diff.inSync')})`,
          ),
        );
        rows.push(...perSideSkillRows(`${row.name}:a`, profile.name, row.aVsSource, row.aDisabledReason));
        rows.push(...perSideSkillRows(`${row.name}:b`, counterpartName, row.bVsSource, row.bDisabledReason));
        continue;
      }

      rows.push(
        React.createElement(
          Text,
          { key: row.name, color: 'yellow', wrap: 'truncate' },
          `≠ ${row.name}`,
        ),
      );
      rows.push(...perSideSkillRows(`${row.name}:a`, profile.name, row.aVsSource, row.aDisabledReason));
      rows.push(...perSideSkillRows(`${row.name}:b`, counterpartName, row.bVsSource, row.bDisabledReason));
    }
    return { summary: null, rows };
  }

  /** One Profile's contribution to a Skill row: the vs-source tree, or a note
   *  when the tree is absent (disabled capability / unexpected failure). */
  function perSideSkillRows(
    keyPrefix: string,
    profileName: string,
    vsSource: CopiedSkillsDiff['skills'][number]['aVsSource'],
    disabledReason: CopiedSkillsDiff['skills'][number]['aDisabledReason'],
  ): React.ReactElement[] {
    if (vsSource !== null) {
      return skillTreeRows(keyPrefix, profileName, vsSource, t);
    }
    if (disabledReason !== null) {
      return [disabledNote(keyPrefix, profileName, disabledReason, t)];
    }
    return [];
  }

  function renderLaunchRows(entries: LaunchConfigDiffEntry[]): { summary: string | null; rows: React.ReactElement[] } {
    return {
      summary: null,
      rows: entries.map((entry) => {
        const mark = verdictSymbol(entry.verdict);
        const color = verdictColor(entry.verdict);
        const warn = entry.sensitive ? `  ⚠ ${t('resource.diff.sensitive')}` : '';
        let content: string;
        if (entry.verdict === 'changed') {
          content = `${mark} ${entry.key}: ${formatValue(entry.valueA)} → ${formatValue(entry.valueB)}${warn}`;
        } else if (entry.verdict === 'same') {
          content = `${mark} ${entry.key}: ${formatValue(entry.valueA)}`;
        } else if (entry.verdict === 'only-a') {
          content = `${mark} ${entry.key}: ${formatValue(entry.valueA)}  ${onlyIn(profile.name)}${warn}`;
        } else {
          content = `${mark} ${entry.key}: ${formatValue(entry.valueB)}  ${onlyIn(counterpartName)}${warn}`;
        }
        return React.createElement(
          Text,
          { key: entry.key, color, wrap: 'truncate' },
          content,
        );
      }),
    };
  }

  function onlyIn(name: string): string {
    return t('resource.diff.onlyIn').replace('{profile}', name);
  }
}

/** One Copied-Skill per-Profile hash-tree section (changed / new / gone at source). */
function skillTreeRows(
  keyPrefix: string,
  profileName: string,
  vsSource: NonNullable<SkillVsSourceRow['aVsSource']>,
  t: (key: LocaleKey) => string,
): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  if (vsSource.sourceMissing) {
    rows.push(
      React.createElement(
        Text,
        { key: `${keyPrefix}:missing`, dimColor: true, wrap: 'truncate' },
        `  ${profileName}: ${t('resource.diff.sourceMissing')}`,
      ),
    );
    return rows;
  }
  rows.push(
    React.createElement(
      Text,
      { key: `${keyPrefix}:head`, dimColor: true, wrap: 'truncate' },
      `  ${t('resource.diff.skillsSection').replace('{profile}', profileName).replace('{source}', vsSource.sourceDescription)}`,
    ),
  );
  for (const entry of vsSource.entries) {
    const mark = entry.verdict === 'changed' ? '≠' : entry.verdict === 'new-at-source' ? '+' : '-';
    const color = entry.verdict === 'changed' ? 'yellow' : entry.verdict === 'new-at-source' ? 'green' : 'red';
    const label =
      entry.verdict === 'changed' ? t('resource.diff.sourceMovedOn') :
      entry.verdict === 'new-at-source' ? t('resource.diff.newAtSource') :
      t('resource.diff.goneAtSource');
    rows.push(
      React.createElement(
        Text,
        { key: `${keyPrefix}:${entry.relPath}`, color, wrap: 'truncate' },
        `    ${mark} ${entry.relPath}  (${label})`,
      ),
    );
  }
  return rows;
}

function disabledNote(
  key: string,
  profileName: string,
  reason: SkillDisabledReason,
  t: (key: LocaleKey) => string,
): React.ReactElement {
  const label =
    reason === 'link-mode' ? t('resource.diff.linkedSource') :
    reason === 'no-source' ? t('resource.diff.noSource') :
    t('resource.diff.diffUnavailable');
  return React.createElement(
    Text,
    { key, dimColor: true, wrap: 'truncate' },
    `  ${profileName}: ${label}`,
  );
}

/** Shared verdict→color mapping for key tables (Settings / Launch config). */
function verdictColor(verdict: KeyVerdict): string | undefined {
  switch (verdict) {
    case 'changed':
      return 'yellow';
    case 'only-a':
      return 'red';
    case 'only-b':
      return 'green';
    case 'same':
      return undefined;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}
