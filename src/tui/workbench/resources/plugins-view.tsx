import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';

import type { PluginInventory } from '../../../core/plugins';
import type { WorkbenchProfile } from '../profile-data';
import { useI18n } from '../i18n/react';

// Plugins drill view (issue #101 L4, spec §7.6): read-only inventory status —
// names and enable state only, plus the delegation line. There are
// deliberately no mutation affordances: every change goes through
// `claude plugin`. The inventory itself is read by the app shell (fail-closed
// `readPluginInventory`) and passed in; this view never probes the CLI.

export type PluginsViewProps = {
  profile: WorkbenchProfile;
  /** Absent while the delegated read is still pending. */
  inventory: PluginInventory | undefined;
  width: number;
  height: number;
  onBack: () => void;
  /** When true, keyboard input is disabled (headless/test rendering). */
  headless?: boolean;
};

export function PluginsView({
  profile,
  inventory,
  width,
  height,
  onBack,
  headless,
}: PluginsViewProps): React.ReactElement {
  const { t } = useI18n();
  const { stdin: inkStdin } = useStdin();
  const canUseInput = !headless && inkStdin.isTTY === true;

  const plugins = inventory?.status === 'ok' ? inventory.plugins : [];
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(plugins.length - 1, i + 1));
        return;
      }
    },
    { isActive: canUseInput },
  );

  // title + delegation line + list window; rows beyond the window collapse
  // into a `+N more` line so the pane stays in budget (same rule the old
  // bottom strip followed).
  const listHeight = Math.max(1, height - 4);
  const windowStart = Math.max(0, Math.min(selectedIndex - listHeight + 1, plugins.length - listHeight));
  const visible = plugins.slice(windowStart, windowStart + listHeight);
  const overflow = plugins.length - (windowStart + visible.length);

  return React.createElement(
    Box,
    { flexDirection: 'column', width, height, overflow: 'hidden' },
    React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(Text, { bold: true }, `${t('main.category.plugins')} — ${profile.name}`),
    ),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      inventory === undefined || inventory.status === 'unavailable'
        ? React.createElement(
            Box,
            { paddingX: 1 },
            React.createElement(Text, { color: 'gray', wrap: 'wrap' }, t('plugins.unavailable')),
          )
        : plugins.length === 0
          ? React.createElement(
              Box,
              { paddingX: 1 },
              React.createElement(Text, { color: 'gray', wrap: 'wrap' }, t('plugins.empty')),
            )
          : React.createElement(
              React.Fragment,
              null,
              ...visible.map((plugin, i) => {
                const isSelected = windowStart + i === selectedIndex;
                return React.createElement(
                  Box,
                  { key: plugin.id, paddingX: 1 },
                  React.createElement(
                    Text,
                    {
                      bold: isSelected,
                      color: isSelected ? 'cyan' : undefined,
                      inverse: isSelected,
                      wrap: 'truncate',
                    },
                    `${plugin.id} — `,
                    React.createElement(
                      Text,
                      plugin.enabled ? { color: 'green' } : { color: 'gray' },
                      plugin.enabled ? t('plugins.enabled') : t('plugins.disabled'),
                    ),
                  ),
                );
              }),
              overflow > 0 &&
                React.createElement(
                  Box,
                  { paddingX: 1 },
                  React.createElement(Text, { color: 'gray', wrap: 'wrap' }, t('plugins.more', { count: String(overflow) })),
                ),
            ),
    ),
    React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(Text, { color: 'gray', wrap: 'wrap' }, t('plugins.managed')),
    ),
    React.createElement(
      Box,
      { paddingX: 1 },
      React.createElement(Text, { color: 'gray', wrap: 'truncate' }, `[Esc] ${t('keymap.esc')}`),
    ),
  );
}
