import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { useI18n } from './i18n/react';
import type { AgentFrontmatter } from '../../core/resource';
import { useCapture } from './capture-context';

type AgentFrontmatterEditorProps = {
  agentName: string;
  frontmatter: AgentFrontmatter | null;
  /** True when a VS Code edit session is active on this file (dual-channel block). */
  isBlocked: boolean;
  /** Called when the user saves a field; the parent performs the write. */
  onSave: (updates: Partial<AgentFrontmatter>) => void;
  onBack: () => void;
  width: number;
  height: number;
};

// `name` is the file identity and is not editable in-Workbench (renaming an
// agent is a separate lifecycle operation); only metadata fields are editable.
const FIELDS = ['description', 'model'] as const;
type FieldName = (typeof FIELDS)[number];

/**
 * Structured frontmatter editing inside the Workbench.
 *
 * Spec §8: while a VS Code session is active on the file, structured-field
 * writes are refused ("finish in VS Code first") — see isBlocked.
 *
 * Interaction: ↑/↓ select a field, Enter starts editing, type to edit,
 * Enter saves, Esc cancels the current field.
 */
export function AgentFrontmatterEditor({
  agentName,
  frontmatter,
  isBlocked,
  onSave,
  onBack,
  width,
  height,
}: AgentFrontmatterEditorProps): React.ReactElement {
  const { t } = useI18n();
  const setCapture = useCapture();
  const [selectedField, setSelectedField] = useState<FieldName>('description');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const editingActive = !isBlocked && editing;

  // Claim input while an editing field is active so sidebar/app handlers skip.
  useEffect(() => {
    setCapture(editingActive);
    return () => setCapture(false);
  }, [editingActive, setCapture]);

  useInput((input, key) => {
    if (isBlocked) {
      if (key.escape || key.return) onBack();
      return;
    }

    if (editing) {
      if (key.escape) {
        setEditing(false);
        setDraft('');
        return;
      }
      if (key.return) {
        onSave({ [selectedField]: draft });
        setEditing(false);
        setDraft('');
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1) {
        setDraft((d) => d + input);
      }
      return;
    }

    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setSelectedField((f) => FIELDS[Math.max(0, FIELDS.indexOf(f) - 1)]);
      return;
    }
    if (key.downArrow) {
      setSelectedField((f) => FIELDS[Math.min(FIELDS.length - 1, FIELDS.indexOf(f) + 1)]);
      return;
    }
    if (key.return) {
      const current = frontmatter ?? {};
      setDraft(String(current[selectedField] ?? ''));
      setEditing(true);
    }
  });

  if (isBlocked) {
    return React.createElement(
      Box,
      { flexDirection: 'column', width, height, paddingX: 1 },
      React.createElement(Text, { bold: true }, `${agentName} › ${t('resource.agent.frontmatter.title')}`),
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { color: 'yellow' }, `⚠ ${t('resource.agent.frontmatter.blocked')}`),
      ),
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(Text, { dimColor: true }, `${t('resource.preview.back')} · Esc`),
    );
  }

  const display = frontmatter ?? {};

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, paddingX: 1 },
    React.createElement(Text, { bold: true }, `${agentName} › ${t('resource.agent.frontmatter.title')}`),
    React.createElement(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      ...FIELDS.map((field) => {
        const isSelected = field === selectedField;
        const isEditing = editing && isSelected;
        const value = isEditing ? draft : String(display[field] ?? '');

        return React.createElement(
          Box,
          { key: field, flexDirection: 'column', marginBottom: 1 },
          React.createElement(
            Box,
            { gap: 1 },
            React.createElement(
              Text,
              { inverse: isSelected && !editing, bold: isSelected && !editing },
              `${isSelected && !editing ? '▸ ' : '  '}${field}`,
            ),
            React.createElement(Text, { color: isEditing ? 'cyan' : undefined }, isEditing ? `${value}█` : value),
          ),
        );
      }),
    ),
    React.createElement(Box, { flexGrow: 1 }),
    React.createElement(
      Text,
      { dimColor: true },
      editing
        ? `${t('keymap.enter')} ${t('resource.agent.frontmatter.saved')} · ${t('resource.agent.frontmatter.cancel')}`
        : `${t('keymap.enter')} ${t('resource.agent.frontmatter.edit')} · Esc ${t('resource.preview.back')}`,
    ),
  );
}
