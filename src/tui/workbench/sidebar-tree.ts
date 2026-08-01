import type { ResourceCategory, SearchResult } from '../../core/resource/types';
import { CATEGORIES } from './main-pane';
import type { WorkbenchProfile } from './profile-data';

/**
 * Sidebar card-tree model (spec §4.1/§4.2, issue #83): Profile cards with
 * indented category and item rows. `buildSidebarRows` is a pure function so
 * filtering, expansion, and search auto-expansion are testable without Ink.
 */

export type CategoryKey = (typeof CATEGORIES)[number]['key'];

/** Tree category order — derived from the main-pane card grid (main-pane.tsx). */
export const SIDEBAR_CATEGORY_KEYS: readonly CategoryKey[] = CATEGORIES.map((c) => c.key);

export type TreeRow =
  | { kind: 'profile'; profileName: string; depth: 0 }
  | { kind: 'category'; profileName: string; categoryKey: CategoryKey; depth: 1 }
  | { kind: 'item'; profileName: string; categoryKey: CategoryKey; itemName: string; depth: 2 }
  | {
      kind: 'content-hit';
      profileName: string;
      categoryKey: CategoryKey;
      hit: SearchResult;
      depth: 2;
    };

/** Resource-content search categories map onto these tree categories. */
const CONTENT_HIT_CATEGORY: Record<ResourceCategory, CategoryKey> = {
  'user-memory': 'userMemory',
  agents: 'agents',
};

/** Item names shown under each category of a profile. */
export function categoryItems(profile: WorkbenchProfile, categoryKey: CategoryKey): string[] {
  switch (categoryKey) {
    case 'userMemory':
      return profile.resourceDetails.userMemory.exists ? [profile.resourceDetails.userMemory.name] : [];
    case 'autoMemory':
      return profile.resourceDetails.autoMemory;
    case 'skills':
      return profile.resourceDetails.skills;
    case 'agents':
      return profile.resourceDetails.agents.map((a) => a.name);
    case 'mcp':
      return profile.mcpServers;
    case 'settings':
      return profile.resourceDetails.settings;
    case 'launchConfig':
      return [];
  }
}

export type BuildSidebarRowsOptions = {
  profiles: WorkbenchProfile[];
  /** Profiles expanded by the user (ignored while a query is active). */
  expanded: ReadonlySet<string>;
  query: string;
  categoryLabels: Record<CategoryKey, string>;
  /** Cross-profile content matches from searchAllResources for the query. */
  contentHits: SearchResult[];
};

export function buildSidebarRows(opts: BuildSidebarRowsOptions): TreeRow[] {
  const { profiles, expanded, categoryLabels, contentHits } = opts;
  const query = opts.query.trim().toLowerCase();
  const rows: TreeRow[] = [];

  for (const profile of profiles) {
    if (!query) {
      rows.push({ kind: 'profile', profileName: profile.name, depth: 0 });
      if (expanded.has(profile.name)) {
        pushSubtree(rows, profile, SIDEBAR_CATEGORY_KEYS, null, categoryLabels);
      }
      continue;
    }

    const profileMatch =
      profile.name.toLowerCase().includes(query) ||
      profile.description.toLowerCase().includes(query);
    const profileHits = contentHits.filter((h) => h.profileName === profile.name);

    if (profileMatch) {
      // A matched profile path auto-expands in full (§4.2); content hits in
      // that Profile still surface as hit rows beneath their category.
      rows.push({ kind: 'profile', profileName: profile.name, depth: 0 });
      pushSubtree(rows, profile, SIDEBAR_CATEGORY_KEYS, null, categoryLabels, profileHits);
      continue;
    }

    const matchedCategories = SIDEBAR_CATEGORY_KEYS.filter((key) => {
      if (categoryLabels[key].toLowerCase().includes(query)) return true;
      if (categoryItems(profile, key).some((item) => item.toLowerCase().includes(query))) return true;
      return profileHits.some((h) => CONTENT_HIT_CATEGORY[h.category] === key);
    });

    if (matchedCategories.length === 0) continue;

    rows.push({ kind: 'profile', profileName: profile.name, depth: 0 });
    pushSubtree(rows, profile, matchedCategories, query, categoryLabels, profileHits);
  }

  return rows;
}

function pushSubtree(
  rows: TreeRow[],
  profile: WorkbenchProfile,
  categories: readonly CategoryKey[],
  query: string | null,
  categoryLabels: Record<CategoryKey, string>,
  profileHits: SearchResult[] = [],
): void {
  for (const categoryKey of categories) {
    rows.push({ kind: 'category', profileName: profile.name, categoryKey, depth: 1 });
    const items = categoryItems(profile, categoryKey);
    // When the query matched the category label itself, all items stay visible.
    const labelMatched = query !== null && categoryLabels[categoryKey].toLowerCase().includes(query);
    const visibleItems = query && !labelMatched
      ? items.filter((item) => item.toLowerCase().includes(query))
      : items;
    for (const itemName of visibleItems) {
      rows.push({ kind: 'item', profileName: profile.name, categoryKey, itemName, depth: 2 });
    }
    for (const hit of profileHits) {
      if (CONTENT_HIT_CATEGORY[hit.category] === categoryKey) {
        rows.push({ kind: 'content-hit', profileName: profile.name, categoryKey, hit, depth: 2 });
      }
    }
  }
}
