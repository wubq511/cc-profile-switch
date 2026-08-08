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
 * documented effect; the sheet itself only renders this data.
 */
export type KeymapContextId =
  | 'navigation'
  | 'profile'
  | 'categories'
  | 'resource'
  | 'discover'
  | 'bulk'
  | 'help';

export type KeymapBinding = {
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
    // Base/sidebar focus: Esc has no effect here (it closes overlays, which
    // own their own Esc bindings below), so it is not documented as a
    // navigation key — issue #92 keeps the sheet truthful about what each key
    // does in each context.
    id: 'navigation',
    titleKey: 'keymap.nav',
    bindings: [
      { key: '↑/↓', labelKey: 'keymap.up' },
      { key: '←/→', labelKey: 'keymap.tree' },
      { key: 'Enter', labelKey: 'keymap.enter' },
      { key: '/', labelKey: 'keymap.search' },
      { key: '?', labelKey: 'keymap.help' },
      { key: 'q/Ctrl+C', labelKey: 'keymap.quit' },
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
      { key: 'l', labelKey: 'keymap.launch' },
      { key: 'L', labelKey: 'lifecycle.launchDir' },
      { key: 'a', labelKey: 'skill.add' },
      { key: 'n', labelKey: 'lifecycle.create' },
      { key: 'c', labelKey: 'lifecycle.copy' },
      { key: 'r', labelKey: 'lifecycle.rename' },
      { key: 'd', labelKey: 'lifecycle.default' },
      { key: 'v', labelKey: 'lifecycle.validate' },
      { key: 'b', labelKey: 'lifecycle.backup' },
      { key: 's', labelKey: 'lifecycle.saveTemplate' },
      { key: 'x', labelKey: 'lifecycle.remove' },
      { key: 'e', labelKey: 'keymap.edit' },
      { key: 'D', labelKey: 'lifecycle.editDescription' },
      { key: 'u', labelKey: 'main.category.userMemory' },
      { key: 'Tab', labelKey: 'main.focusHint' },
    ],
  },
  {
    // Main-pane category grid focus: `a` drills into Agents (sidebar-focus
    // Add Skill is captured by the Sidebar), `u` drills User Memory, Enter
    // opens bulk ops for the focused category.
    id: 'categories',
    titleKey: 'keymap.categories',
    bindings: [
      { key: '↑/↓', labelKey: 'keymap.catNav' },
      { key: 'a', labelKey: 'main.category.agents' },
      { key: 'u', labelKey: 'main.category.userMemory' },
      { key: 'Enter', labelKey: 'keymap.enter' },
      { key: 'd', labelKey: 'resource.diff.title' },
      { key: 'Esc/←', labelKey: 'keymap.backToSidebar' },
    ],
  },
  {
    // User Memory / Agents resource rows (also preview / copy / diff phases).
    // `a` (create agent) and `n` (recreate a missing CLAUDE.md) are bound in
    // the list phase only — the app's own empty states advertise both.
    id: 'resource',
    titleKey: 'keymap.resources',
    bindings: [
      { key: '↑/↓', labelKey: 'keymap.up' },
      { key: 'Enter', labelKey: 'keymap.enter' },
      { key: '/', labelKey: 'keymap.searchResource' },
      { key: 'e', labelKey: 'resource.edit' },
      { key: 'a', labelKey: 'resource.agents.create' },
      { key: 'n', labelKey: 'resource.userMemory.recreate' },
      { key: 'x', labelKey: 'resource.remove' },
      { key: 'c', labelKey: 'resource.copy' },
      { key: 'd', labelKey: 'resource.diff.title' },
      { key: 'f', labelKey: 'resource.agent.frontmatter.edit' },
      { key: 'Esc', labelKey: 'keymap.esc' },
    ],
  },
  {
    // Skills discovery surface (spec §7.4).
    id: 'discover',
    titleKey: 'keymap.discover',
    bindings: [
      { key: '/', labelKey: 'keymap.discover.search' },
      { key: 'Enter', labelKey: 'keymap.discover.install' },
      { key: 's', labelKey: 'keymap.discover.source' },
      { key: 'b', labelKey: 'keymap.discover.browser' },
      { key: 'r', labelKey: 'keymap.discover.refresh' },
      { key: 'Esc', labelKey: 'keymap.esc' },
    ],
  },
  {
    // Bulk operations surface (spec §11.1).
    id: 'bulk',
    titleKey: 'keymap.bulk',
    bindings: [
      { key: 'space', labelKey: 'keymap.bulk.select' },
      { key: 'a', labelKey: 'keymap.bulk.selectAll' },
      { key: 'x', labelKey: 'keymap.bulk.remove' },
      { key: 'c', labelKey: 'keymap.bulk.copy' },
      { key: 'u', labelKey: 'keymap.bulk.update' },
      { key: 'd', labelKey: 'keymap.bulk.discover' },
      { key: 'Esc', labelKey: 'keymap.esc' },
    ],
  },
  {
    // Keys active while the help sheet itself is open: `l` is the language
    // switch here (spec §14.10) — the same letter means launch in the sidebar
    // context, which the group headings make unambiguous.
    id: 'help',
    titleKey: 'keymap.helpSheet',
    bindings: [
      { key: 'l', labelKey: 'keymap.language' },
      { key: 'Esc/?', labelKey: 'keymap.close' },
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
          { key: b.key, marginRight: 2 },
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
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { bold: true }, t('keymap.concepts')),
    ),
    ...CONCEPTS.map((concept) =>
      React.createElement(
        Box,
        { key: concept.term, paddingX: 2 },
        React.createElement(Text, { wrap: 'wrap' },
          React.createElement(Text, { bold: true }, t(concept.term)),
          React.createElement(Text, null, ' — '),
          React.createElement(Text, null, t(concept.definition)),
        ),
      ),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { dimColor: true, wrap: 'wrap' },
        `${t('guidance.hints.fade')} · [esc] ${t('keymap.esc')}`,
      ),
    ),
  );
}
