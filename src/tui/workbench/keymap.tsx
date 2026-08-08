import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from './i18n/react';
import type { LocaleKey } from './i18n/en';

/**
 * The `?` help sheet is the keymap reference (spec §4.3). Bindings are grouped
 * by the UI context in which they apply — sidebar profile focus, main-pane
 * category focus, resource rows, the Discover and Bulk surfaces, and the help
 * sheet itself — so a key that means different things in different states
 * (e.g. `l` = launch from the sidebar, `l` = switch language inside the help
 * sheet; `a` = add skill / Agents drill / select-all) is documented once per
 * context instead of appearing as a self-contradiction. Within a group each
 * key appears at most once.
 *
 * `KEYMAP_GROUPS` is exported so the keymap/handler consistency test can send
 * every documented keypress in its documented context and assert the
 * documented effect; the sheet itself only renders this data. Each binding
 * carries a stable `id` — the scenario identity the test keys on
 * (`${group.id}:${binding.id}`) — decoupled from the display `key`, so a
 * cosmetic change to the chip text never renames or breaks test scenarios.
 */
export type KeymapContextId =
  | 'navigation'
  | 'profile'
  | 'categories'
  | 'resource'
  | 'discover'
  | 'bulk'
  | 'recovery'
  | 'help';

export type KeymapBinding = {
  /** Stable action id; the consistency test's scenario identity within the group. */
  id: string;
  /** Display form of the key, e.g. `↑/↓`, `q/Ctrl+C`, `Esc/?`. */
  key: string;
  labelKey: LocaleKey;
};

export type KeymapGroup = {
  id: KeymapContextId;
  titleKey: LocaleKey;
  bindings: KeymapBinding[];
};

export const KEYMAP_GROUPS: readonly KeymapGroup[] = [
  {
    // Sidebar context: at plain profile-list focus Esc is a no-op (overlays
    // own their Esc bindings in their own groups below), but within sidebar
    // sub-states it cancels lifecycle prompts, clears the active search box
    // (§4.2), and dismisses the success/error bar — documented once here as
    // the sidebar-context Esc behavior (issue #92).
    id: 'navigation',
    titleKey: 'keymap.nav',
    bindings: [
      { id: 'move', key: '↑/↓', labelKey: 'keymap.up' },
      { id: 'tree', key: '←/→', labelKey: 'keymap.tree' },
      { id: 'enter', key: 'Enter', labelKey: 'keymap.enter' },
      { id: 'search', key: '/', labelKey: 'keymap.search' },
      { id: 'help', key: '?', labelKey: 'keymap.help' },
      { id: 'quit', key: 'q/Ctrl+C', labelKey: 'keymap.quit' },
      { id: 'escSidebar', key: 'Esc', labelKey: 'keymap.escSidebar' },
    ],
  },
  {
    // Sidebar profile-list focus (issue #91): ownership of each contextual
    // letter is decided by this focus region, so `l` is launch and `a` is Add
    // Skill here — not language switch / Agents drill (those live in the help
    // sheet and the main-pane context respectively).
    id: 'profile',
    titleKey: 'keymap.actions',
    bindings: [
      { id: 'launch', key: 'l', labelKey: 'keymap.launch' },
      { id: 'launchDir', key: 'L', labelKey: 'lifecycle.launchDir' },
      { id: 'addSkill', key: 'a', labelKey: 'skill.add' },
      { id: 'create', key: 'n', labelKey: 'lifecycle.create' },
      { id: 'copy', key: 'c', labelKey: 'lifecycle.copy' },
      { id: 'rename', key: 'r', labelKey: 'lifecycle.rename' },
      { id: 'default', key: 'd', labelKey: 'lifecycle.default' },
      { id: 'validate', key: 'v', labelKey: 'lifecycle.validate' },
      { id: 'backup', key: 'b', labelKey: 'lifecycle.backup' },
      { id: 'saveTemplate', key: 's', labelKey: 'lifecycle.saveTemplate' },
      { id: 'remove', key: 'x', labelKey: 'lifecycle.remove' },
      { id: 'edit', key: 'e', labelKey: 'keymap.edit' },
      { id: 'editDescription', key: 'D', labelKey: 'lifecycle.editDescription' },
      { id: 'userMemory', key: 'u', labelKey: 'main.category.userMemory' },
      { id: 'recoveryOpen', key: 'B', labelKey: 'keymap.recovery.open' },
      { id: 'focusCategories', key: 'Tab', labelKey: 'main.focusHint' },
    ],
  },
  {
    // Main-pane category grid focus: `a` drills into Agents (sidebar-focus
    // Add Skill is captured by the Sidebar), `u` drills User Memory, Enter
    // opens the bulk-ops surface for the focused category (spec §11.1).
    id: 'categories',
    titleKey: 'keymap.categories',
    bindings: [
      { id: 'move', key: '↑/↓', labelKey: 'keymap.catNav' },
      { id: 'agents', key: 'a', labelKey: 'main.category.agents' },
      { id: 'userMemory', key: 'u', labelKey: 'main.category.userMemory' },
      { id: 'openBulk', key: 'Enter', labelKey: 'keymap.openBulkOps' },
      { id: 'diff', key: 'd', labelKey: 'resource.diff.title' },
      { id: 'back', key: 'Esc/←', labelKey: 'keymap.backToSidebar' },
    ],
  },
  {
    // User Memory / Agents resource rows (also preview / copy / diff phases).
    // `a` (create agent) and `n` (recreate a missing CLAUDE.md) are bound in
    // the list phase only — the app's own empty states advertise both.
    id: 'resource',
    titleKey: 'keymap.resources',
    bindings: [
      { id: 'move', key: '↑/↓', labelKey: 'keymap.up' },
      { id: 'preview', key: 'Enter', labelKey: 'keymap.enter' },
      { id: 'search', key: '/', labelKey: 'keymap.searchResource' },
      { id: 'edit', key: 'e', labelKey: 'resource.edit' },
      { id: 'createAgent', key: 'a', labelKey: 'resource.agents.create' },
      { id: 'recreateMemory', key: 'n', labelKey: 'resource.userMemory.recreate' },
      { id: 'remove', key: 'x', labelKey: 'resource.remove' },
      { id: 'copy', key: 'c', labelKey: 'resource.copy' },
      { id: 'diff', key: 'd', labelKey: 'resource.diff.title' },
      { id: 'frontmatter', key: 'f', labelKey: 'resource.agent.frontmatter.edit' },
      { id: 'esc', key: 'Esc', labelKey: 'keymap.esc' },
    ],
  },
  {
    // Skills discovery surface (spec §7.4).
    id: 'discover',
    titleKey: 'keymap.discover',
    bindings: [
      { id: 'search', key: '/', labelKey: 'keymap.discover.search' },
      { id: 'install', key: 'Enter', labelKey: 'keymap.discover.install' },
      { id: 'source', key: 's', labelKey: 'keymap.discover.source' },
      { id: 'browser', key: 'b', labelKey: 'keymap.discover.browser' },
      { id: 'refresh', key: 'r', labelKey: 'keymap.discover.refresh' },
      { id: 'esc', key: 'Esc', labelKey: 'keymap.esc' },
    ],
  },
  {
    // Bulk operations surface (spec §11.1).
    id: 'bulk',
    titleKey: 'keymap.bulk',
    bindings: [
      { id: 'select', key: 'space', labelKey: 'keymap.bulk.select' },
      { id: 'selectAll', key: 'a', labelKey: 'keymap.bulk.selectAll' },
      { id: 'remove', key: 'x', labelKey: 'keymap.bulk.remove' },
      { id: 'copy', key: 'c', labelKey: 'keymap.bulk.copy' },
      { id: 'update', key: 'u', labelKey: 'keymap.bulk.update' },
      { id: 'discover', key: 'd', labelKey: 'keymap.bulk.discover' },
      { id: 'esc', key: 'Esc', labelKey: 'keymap.esc' },
    ],
  },
  {
    // Recovery Bin surface (issue #94, spec §9.5): browse the temporary
    // items and durable Profile Backups; Enter restores a Bin item, x
    // permanently deletes the focused item/backup, E empties the Bin.
    id: 'recovery',
    titleKey: 'keymap.recovery',
    bindings: [
      { id: 'move', key: '↑/↓', labelKey: 'keymap.up' },
      { id: 'restore', key: 'Enter', labelKey: 'keymap.recovery.restore' },
      { id: 'delete', key: 'x', labelKey: 'keymap.recovery.delete' },
      { id: 'emptyBin', key: 'E', labelKey: 'keymap.recovery.emptyBin' },
      { id: 'esc', key: 'Esc', labelKey: 'keymap.esc' },
    ],
  },
  {
    // Keys active while the help sheet itself is open: `l` is the language
    // switch here (spec §14.10) — the same letter means launch in the sidebar
    // context, which the group headings make unambiguous.
    id: 'help',
    titleKey: 'keymap.helpSheet',
    bindings: [
      { id: 'language', key: 'l', labelKey: 'keymap.language' },
      { id: 'close', key: 'Esc/?', labelKey: 'keymap.close' },
    ],
  },
];

const CONCEPTS: Array<{ term: LocaleKey; definition: LocaleKey }> = [
  { term: 'keymap.concept.profile.term', definition: 'keymap.concept.profile.def' },
  { term: 'keymap.concept.copied.term', definition: 'keymap.concept.copied.def' },
  { term: 'keymap.concept.linked.term', definition: 'keymap.concept.linked.def' },
  { term: 'keymap.concept.backup.term', definition: 'keymap.concept.backup.def' },
  { term: 'keymap.concept.bin.term', definition: 'keymap.concept.bin.def' },
  { term: 'keymap.concept.plugins.term', definition: 'keymap.concept.plugins.def' },
];

type KeymapOverlayProps = {
  visible: boolean;
};

export function KeymapOverlay({ visible }: KeymapOverlayProps): React.ReactElement | null {
  const { t } = useI18n();

  if (!visible) return null;

  // One binding layout for every group: a wrapping row of `[key] label` chips.
  // The sheet is the keymap reference, so each documented key stays a single
  // inline chip no matter which context group it belongs to.
  const renderBindings = (bindings: readonly KeymapBinding[]): React.ReactElement =>
    React.createElement(
      Box,
      { paddingX: 2, flexWrap: 'wrap' },
      ...bindings.map((b) =>
        React.createElement(
          Box,
          { key: b.id, marginRight: 2 },
          React.createElement(Text, { color: 'cyan' }, `[${b.key}]`),
          React.createElement(Text, { dimColor: true }, ` ${t(b.labelKey)}`),
        ),
      ),
    );

  const renderGroup = (group: KeymapGroup): React.ReactElement =>
    React.createElement(
      React.Fragment,
      { key: group.id },
      React.createElement(
        Box,
        { marginTop: 1 },
        React.createElement(Text, { bold: true }, t(group.titleKey)),
      ),
      renderBindings(group.bindings),
    );

  return React.createElement(
    Box,
    { flexDirection: 'column', flexGrow: 1, paddingX: 1 },
    React.createElement(Text, { bold: true }, t('keymap.title')),
    ...KEYMAP_GROUPS.map(renderGroup),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.concepts')),
    ),
    ...CONCEPTS.map((concept) =>
      React.createElement(
        Box,
        { key: concept.term, paddingX: 2 },
        React.createElement(
          Text,
          { wrap: 'wrap' },
          React.createElement(Text, { bold: true }, t(concept.term)),
          React.createElement(Text, null, ' — '),
          React.createElement(Text, null, t(concept.definition)),
        ),
      ),
    ),
    React.createElement(
      Box,
      { marginTop: 1 },
      React.createElement(
        Text,
        { dimColor: true, wrap: 'wrap' },
        `${t('guidance.hints.fade')} · [esc] ${t('keymap.esc')}`,
      ),
    ),
  );
}
