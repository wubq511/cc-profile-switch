import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { WorkbenchProfile } from './profile-data';
import type {
  UserMemoryDiff,
  AgentsDiff,
} from '../../core/resource';
import { countChanges } from '../../core/resource/diff';

type ResourceDiffViewProps = {
  profile: WorkbenchProfile;
  category: 'user-memory' | 'agents';
  diff: UserMemoryDiff | AgentsDiff | null;
  drilledAgent: string | null;
  profiles: WorkbenchProfile[];
  width: number;
  height: number;
};

const DIFF_AREA_LINES = 10;

/**
 * Renders the diff per spec §12.
 *
 * - User Memory: unified line diff (`+`/`-`/` ` prefixes).
 * - Agents: a per-file layer (added/removed/changed), with drill-in to the
 *   line diff for the currently drilled changed file.
 */
export function ResourceDiffView({
  profile,
  category,
  diff,
  drilledAgent,
  profiles,
  width,
  height,
}: ResourceDiffViewProps): React.ReactElement {
  const { t } = useI18n();

  const counterpartNames = profiles
    .map((p) => p.name)
    .filter((name) => name !== profile.name);

  if (diff === null) {
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

  if (category === 'user-memory') {
    const memoryDiff = diff as UserMemoryDiff;
    const lines = memoryDiff.lines.slice(0, DIFF_AREA_LINES);
    const { add, del } = countChanges(memoryDiff.lines);

    return React.createElement(
      Box,
      { flexDirection: 'column', width, height, paddingX: 1 },
      React.createElement(
        Text,
        { bold: true, wrap: 'truncate' },
        `${profile.name} → ${memoryDiff.profileB}`,
      ),
      React.createElement(
        Text,
        { dimColor: true },
        `${t('resource.diff.added')} ${add} · ${t('resource.diff.removed')} ${del}`,
      ),
      React.createElement(
        Box,
        { marginTop: 1, flexDirection: 'column' },
        ...lines.map((line, i) => {
          const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          const color = line.type === 'add' ? 'green' : line.type === 'del' ? 'red' : undefined;
          return React.createElement(
            Text,
            { key: i, color, wrap: 'truncate' },
            `${marker} ${line.text}`,
          );
        }),
      ),
      lines.length === 0 &&
        React.createElement(Text, { dimColor: true }, t('resource.diff.noChange')),
    );
  }

  // Agents per-file layer
  const agentsDiff = diff as AgentsDiff;
  const drilled = drilledAgent !== null ? agentsDiff.files.find((f) => f.name === drilledAgent) : undefined;

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(
      Text,
      { bold: true, wrap: 'truncate' },
      `${profile.name} → ${agentsDiff.profileB}`,
    ),
    React.createElement(
      Text,
      { dimColor: true },
      `${t('resource.diff.added')} ${agentsDiff.addedCount} · ${t('resource.diff.removed')} ${agentsDiff.removedCount} · ${t('resource.diff.changed')} ${agentsDiff.changedCount}`,
    ),
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      ...agentsDiff.files.map((file) => {
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

        return React.createElement(
          Box,
          { key: file.name, flexDirection: 'column' },
          React.createElement(
            Box,
            { gap: 1 },
            React.createElement(
              Text,
              { color },
              `${marker} ${file.name} (${label})`,
            ),
            file.verdict === 'changed' &&
              React.createElement(Text, { dimColor: true }, t('resource.diff.drillIn')),
          ),
          drilled === file &&
            file.lines &&
            React.createElement(
              Box,
              { marginTop: 1, flexDirection: 'column', paddingX: 2 },
              ...file.lines.slice(0, DIFF_AREA_LINES).map((line, i) => {
                const m = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
                const c = line.type === 'add' ? 'green' : line.type === 'del' ? 'red' : undefined;
                return React.createElement(
                  Text,
                  { key: i, color: c, wrap: 'truncate' },
                  `${m} ${line.text}`,
                );
              }),
            ),
        );
      }),
    ),
  );
}
