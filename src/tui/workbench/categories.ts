// Resource category definitions shared by sidebar-tree and main-pane.
// Extracted from main-pane.tsx to avoid Ink dependency in pure-function consumers.

import type { DiffCategory } from '../../core/resource/diff-all';
import type { ResourceCategory } from '../../core/resource/types';

// Every entry declares its cross-surface mappings so adding a category touches
// this file only: `resourceCategory` links the resource-content search hit
// type (null when the category is not content-searchable), `diffCategory` the
// pairwise diff presentation (null when the category has no diff, spec §12),
// and the two drill mappings below name the surface each entry point opens.
//
// The main-grid Enter and the sidebar-tree Enter intentionally land on
// different surfaces for some categories (issue #69/#101): grid Enter on
// agents/autoMemory opens the bulk-ops surface while tree Enter opens the
// resource browse / Auto Memory view. Both mappings stay declarative here so
// the two entry points never re-encode the table (issue #89).
//
// 'resource' is not a DrillDown kind: it routes to the resource-nav browse
// surface instead (the entry's `resourceCategory` names which one). The 'kv'
// tree variant adds `focusKey` at the call site from the tree row's item name.
export type CategoryDrill =
  | { kind: 'resource' }
  | { kind: 'autoMemory' }
  | { kind: 'bulk'; category: 'skills' | 'agents' | 'mcp' | 'autoMemory' }
  | { kind: 'kv'; category: 'settings' | 'launchConfig' }
  | { kind: 'plugins' };

export const CATEGORIES = [
  { key: 'userMemory' as const, labelKey: 'main.category.userMemory' as const, drillable: true as const, resourceCategory: 'user-memory' as const, diffCategory: 'user-memory' as const, drillEnter: { kind: 'resource' } as const, drillTree: { kind: 'resource' } as const },
  { key: 'autoMemory' as const, labelKey: 'main.category.autoMemory' as const, drillable: true as const, resourceCategory: null, diffCategory: null, drillEnter: { kind: 'bulk', category: 'autoMemory' } as const, drillTree: { kind: 'autoMemory' } as const },
  { key: 'skills' as const, labelKey: 'main.category.skills' as const, drillable: true as const, resourceCategory: null, diffCategory: 'skills' as const, drillEnter: { kind: 'bulk', category: 'skills' } as const, drillTree: { kind: 'bulk', category: 'skills' } as const },
  { key: 'agents' as const, labelKey: 'main.category.agents' as const, drillable: true as const, resourceCategory: 'agents' as const, diffCategory: 'agents' as const, drillEnter: { kind: 'bulk', category: 'agents' } as const, drillTree: { kind: 'resource' } as const },
  { key: 'mcp' as const, labelKey: 'main.category.mcp' as const, drillable: true as const, resourceCategory: null, diffCategory: 'mcp' as const, drillEnter: { kind: 'bulk', category: 'mcp' } as const, drillTree: { kind: 'bulk', category: 'mcp' } as const },
  { key: 'settings' as const, labelKey: 'main.category.settings' as const, drillable: true as const, resourceCategory: null, diffCategory: 'settings' as const, drillEnter: { kind: 'kv', category: 'settings' } as const, drillTree: { kind: 'kv', category: 'settings' } as const },
  { key: 'launchConfig' as const, labelKey: 'main.category.launchConfig' as const, drillable: true as const, resourceCategory: null, diffCategory: 'launch-config' as const, drillEnter: { kind: 'kv', category: 'launchConfig' } as const, drillTree: { kind: 'kv', category: 'launchConfig' } as const },
  // Plugins join the grid as a regular category (issue #101 L4) — the separate
  // bottom strip is gone; the drill view keeps the §7.6 read-only boundary.
  { key: 'plugins' as const, labelKey: 'main.category.plugins' as const, drillable: true as const, resourceCategory: null, diffCategory: null, drillEnter: { kind: 'plugins' } as const, drillTree: { kind: 'plugins' } as const },
] as const;

export const CATEGORY_COUNT = CATEGORIES.length;

export type CategoryKey = (typeof CATEGORIES)[number]['key'];

/** Category key at a given cursor index (mirrors the card grid order). */
export function categoryKeyAt(index: number): CategoryKey | undefined {
  return CATEGORIES[index]?.key;
}

/** Map a category card key to its diff presentation (spec §12); entries with
 *  `diffCategory: null` (Auto Memory) have no diff. */
export function diffCategoryFor(key: CategoryKey): DiffCategory | undefined {
  return CATEGORIES.find((c) => c.key === key)?.diffCategory ?? undefined;
}

/** Map a resource-content search hit category to its tree category (derived
 *  from the entries that declare a `resourceCategory`). */
export function contentHitCategoryFor(category: ResourceCategory): CategoryKey | undefined {
  return CATEGORIES.find((c) => c.resourceCategory === category)?.key;
}

/** The drill payload the main-grid Enter opens for a category (issue #89).
 *  Every category declares one, so the lookup is total. */
export function enterDrillFor(key: CategoryKey): CategoryDrill {
  return CATEGORIES.find((c) => c.key === key)!.drillEnter;
}

/** The drill payload the sidebar-tree Enter opens for a category (issue #89). */
export function treeDrillFor(key: CategoryKey): CategoryDrill {
  return CATEGORIES.find((c) => c.key === key)!.drillTree;
}

/** The resource-nav category behind a 'resource' drill (entries whose
 *  resourceCategory is non-null). */
export function resourceCategoryFor(key: CategoryKey): ResourceCategory | undefined {
  return CATEGORIES.find((c) => c.key === key)?.resourceCategory ?? undefined;
}
