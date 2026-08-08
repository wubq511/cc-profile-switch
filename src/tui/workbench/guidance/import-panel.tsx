// Import preview panel (issue #95): the mandatory manifest gate before a
// bundle lands. Shows the source profile, import-as target, resource counts,
// MCP server names, and secret state, then the decision keys. On a name
// collision the panel becomes a new-name entry box — typing a free name and
// Enter IS the import confirmation (the core collision loop commits on
// proceed-as-new-name). Same bordered shell as the destructive panel.

import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';
import { GuidancePanel } from './panel';
import type { ImportPreview } from '../../../core/profile-import';

type ImportPreviewPanelProps = {
  preview: ImportPreview;
  /** Typed new-name draft shown when the import target collides. */
  newName: string;
  /** True when the last Enter was rejected as an unsafe profile name. */
  nameError: boolean;
};

export function ImportPreviewPanel({
  preview,
  newName,
  nameError,
}: ImportPreviewPanelProps): React.ReactElement {
  const { t } = useI18n();
  const m = preview.manifest;
  const r = m.resources;
  const strippedCount = m.strippedKeys.reduce((sum, entry) => sum + entry.keys.length, 0);

  const secretsLine = m.includeSecrets
    ? m.secretsPresent
      ? t('lifecycle.import.preview.secretsIncluded')
      : t('lifecycle.import.preview.secretsNone')
    : m.secretsStripped
      ? t('lifecycle.import.preview.secretsStripped', { count: String(strippedCount) })
      : t('lifecycle.import.preview.secretsNone');

  const children: React.ReactElement[] = [
    React.createElement(
      Box,
      { key: 'title' },
      React.createElement(Text, { bold: true }, t('lifecycle.import.preview.title')),
    ),
    React.createElement(
      Box,
      { key: 'bundle' },
      React.createElement(
        Text,
        { dimColor: true, wrap: 'wrap' },
        t('lifecycle.import.preview.bundle', {
          name: m.profileName,
          version: m.exporterVersion,
        }),
      ),
    ),
    React.createElement(
      Box,
      { key: 'resources' },
      React.createElement(
        Text,
        { dimColor: true, wrap: 'wrap' },
        t('lifecycle.import.preview.resources', {
          userMemory: String(r.userMemory),
          autoMemory: String(r.autoMemory),
          skills: String(r.skills),
          agents: String(r.agents),
          mcp: String(r.mcpServers),
        }),
      ),
    ),
  ];

  if (m.mcpServerNames.length > 0) {
    children.push(
      React.createElement(
        Box,
        { key: 'mcp' },
        React.createElement(
          Text,
          { dimColor: true, wrap: 'wrap' },
          t('lifecycle.import.preview.mcpServers', { names: m.mcpServerNames.join(', ') }),
        ),
      ),
    );
  }

  if (preview.collision) {
    children.push(
      React.createElement(
        Box,
        { key: 'collision' },
        React.createElement(
          Text,
          { wrap: 'wrap' },
          t('lifecycle.import.preview.collision', { name: preview.targetName }),
        ),
      ),
      React.createElement(
        Box,
        { key: 'name-input' },
        React.createElement(Text, { bold: true }, t('lifecycle.import.preview.newName')),
        React.createElement(Text, { color: 'cyan' }, `${newName}█`),
      ),
      React.createElement(
        Box,
        { key: 'name-hint' },
        React.createElement(
          Text,
          { dimColor: true, wrap: 'wrap' },
          t('lifecycle.import.preview.newNameHint'),
        ),
      ),
    );
    if (nameError) {
      children.push(
        React.createElement(
          Box,
          { key: 'name-error' },
          React.createElement(
            Text,
            { color: 'red', wrap: 'wrap' },
            t('lifecycle.import.preview.nameInvalid'),
          ),
        ),
      );
    }
  } else {
    children.push(
      React.createElement(
        Box,
        { key: 'import-as' },
        React.createElement(
          Text,
          { wrap: 'wrap' },
          t('lifecycle.import.preview.importAs', { name: preview.targetName }),
        ),
      ),
      React.createElement(
        Box,
        { key: 'secrets' },
        React.createElement(Text, { wrap: 'wrap' }, secretsLine),
      ),
      React.createElement(
        Box,
        { key: 'confirm' },
        React.createElement(
          Text,
          { dimColor: true, wrap: 'wrap' },
          t('lifecycle.import.preview.confirm'),
        ),
      ),
    );
  }

  return React.createElement(GuidancePanel, { borderColor: 'yellow' }, ...children);
}
