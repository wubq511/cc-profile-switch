import type { AuditView } from '../../schemas/skills-provenance';

// Skills discovery catalog types (spec §7.4, issue #68).
//
// Two layers tiered by contract reliability:
//   - `backbone`  — the zero-config GitHub backbone (curated list + documented
//     search), browsed via contents/raw APIs with ccps-parsed frontmatter.
//   - `skillshub` — the default-on, honestly-badged experimental skills.sh
//     layer (undocumented `GET /api/search`), disabled by the
//     `workbench.skillsDiscoveryExperimental` config switch.
// Both layers merge into one catalog, deduplicated by repository + directory,
// and each layer covers the other's failure (spec §7.4).

export type DiscoveryLayer = 'backbone' | 'skillshub';

/** Layer reachability for one catalog fetch (spec §7.4 "each layer covers the
 * other's failure"). `unavailable` is the honest failure wording class — the
 * UI renders "catalog unavailable", never "no results". */
export type LayerStatus = {
  layer: DiscoveryLayer;
  /** 'ok' when the layer returned (possibly cached) results. */
  state: 'ok' | 'offline' | 'rate-limited' | 'unavailable';
  /** True when this layer could not be reached — the catalog-unavailable class. */
  unavailable: boolean;
  /** True when the layer returned results but some sources failed (partial). */
  degraded?: boolean;
  /** ISO timestamp of the last successful fetch (results or cache). */
  fetchedAt?: string;
  /** True when the layer's results came from cache (offline degradation). */
  stale?: boolean;
  /** Layer-specific error code, when a failure was classified. */
  errorCode?: string;
};

/** One Skill surfaced by discovery. Installing from any result routes through
 * the pinned acquisition adapter (§7.3) via `installSource` (and `skill` for a
 * multi-Skill source, e.g. a skills.sh owner/repo shorthand). */
export type DiscoveredSkill = {
  /** Stable catalog identity: `<repository>:<directory>` — the dedup key
   * (same repository + same directory = same Skill, spec §7.4). */
  id: string;
  /** Frontmatter name (backbone) / skillId (skills.sh). */
  name: string;
  /** Frontmatter description when available; otherwise empty. */
  description: string;
  /** Repository source slug, e.g. `vercel-labs/skills` or `github/awesome-copilot`. */
  repository: string;
  /** Directory name of the Skill within the repository (dedup key). */
  directory: string;
  /** Full Skill path within the repository, when known (backbone tree browse). */
  skillPath?: string;
  /** Git ref (branch/tag) for the install + provenance record. */
  ref?: string;
  /** Which layers surfaced this Skill (merged: ≥1). */
  layers: DiscoveryLayer[];
  /** skills.sh install count, when available. */
  installs?: number;
  /** skills.sh trending flag, when available. */
  trending?: boolean;
  /** Audit view — six states; absence is rendered as `not audited`, never safe. */
  audit: AuditView;
  /** ISO timestamp of when this result was fetched. */
  fetchedAt: string;
  /** Raw source handed to the acquisition adapter. */
  installSource: string;
  /** Optional `--skill` selection for a multi-Skill `installSource`. */
  skill?: string;
};

export type DiscoveryCatalog = {
  /** Merged, deduplicated results (backbone first, then skills.sh-only). */
  results: DiscoveredSkill[];
  /** Per-layer reachability — drives the "catalog unavailable" wording. */
  layers: LayerStatus[];
  /** ISO timestamp of this catalog fetch. */
  fetchedAt: string;
};

/** A classified catalog failure for one layer (offline / rate-limit / outage). */
export type CatalogFailureKind = 'offline' | 'rate-limited' | 'unavailable';

/** Stable key for a Skill across the two layers: repository + directory name. */
export function discoveryDedupeKey(repository: string, directory: string): string {
  return `${repository}:${directory}`;
}

/** Canonical implementation lives in utils; re-exported for discovery consumers. */
export { isRecord } from '../../utils/type-guards';

/** The final `/`-separated segment of a path/slug. */
export function lastSegment(value: string): string {
  const idx = value.lastIndexOf('/');
  return idx === -1 ? value : value.slice(idx + 1);
}

/** Everything before the final `/`-separated segment ('' when none). */
export function dropLastSegment(value: string): string {
  const idx = value.lastIndexOf('/');
  return idx === -1 ? '' : value.slice(0, idx);
}
