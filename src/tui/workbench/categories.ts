// Resource category definitions shared by sidebar-tree and main-pane.
// Extracted from main-pane.tsx to avoid Ink dependency in pure-function consumers.

import type { DiffCategory } from '../../core/resource/diff-all';
import type { ResourceCategory } from '../../core/resource/types';

// Every entry declares its cross-surface mappings so adding a category touches
// this file only: `resourceCategory` links the resource-content search hit
// type (null when the category is not content-searchable), `diffCategory` the
// pairwise diff presentation (null when the category has no diff, spec §12).
export const CATEGORIES = [
  { key: 'userMemory' as const, labelKey: 'main.category.userMemory' as const, drillable: true as const, resourceCategory: 'user-memory' as const, diffCategory: 'user-memory' as const },
  { key: 'autoMemory' as const, labelKey: 'main.category.autoMemory' as const, drillable: true as const, resourceCategory: null, diffCategory: null },
  { key: 'skills' as const, labelKey: 'main.category.skills' as const, drillable: true as const, resourceCategory: null, diffCategory: 'skills' as const },
  { key: 'agents' as const, labelKey: 'main.category.agents' as const, drillable: true as const, resourceCategory: 'agents' as const, diffCategory: 'agents' as const },
  { key: 'mcp' as const, labelKey: 'main.category.mcp' as const, drillable: true as const, resourceCategory: null, diffCategory: 'mcp' as const },
  { key: 'settings' as const, labelKey: 'main.category.settings' as const, drillable: false as const, resourceCategory: null, diffCategory: 'settings' as const },
  { key: 'launchConfig' as const, labelKey: 'main.category.launchConfig' as const, drillable: false as const, resourceCategory: null, diffCategory: 'launch-config' as const },
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
