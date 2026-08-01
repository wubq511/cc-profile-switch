// Resource category definitions shared by sidebar-tree and main-pane.
// Extracted from main-pane.tsx to avoid Ink dependency in pure-function consumers.

export const CATEGORIES = [
  { key: 'userMemory' as const, labelKey: 'main.category.userMemory' as const, drillable: true as const, resourceCategory: 'user-memory' as const },
  { key: 'autoMemory' as const, labelKey: 'main.category.autoMemory' as const, drillable: true as const },
  { key: 'skills' as const, labelKey: 'main.category.skills' as const, drillable: true as const },
  { key: 'agents' as const, labelKey: 'main.category.agents' as const, drillable: true as const, resourceCategory: 'agents' as const },
  { key: 'mcp' as const, labelKey: 'main.category.mcp' as const, drillable: true as const },
  { key: 'settings' as const, labelKey: 'main.category.settings' as const, drillable: false as const },
  { key: 'launchConfig' as const, labelKey: 'main.category.launchConfig' as const, drillable: false as const },
] as const;

export const CATEGORY_COUNT = CATEGORIES.length;

/** Category key at a given cursor index (mirrors the card grid order). */
export function categoryKeyAt(index: number): (typeof CATEGORIES)[number]['key'] | undefined {
  return CATEGORIES[index]?.key;
}
