import type { Clock } from '../types';
import {
  borrowGhToken,
  CURATED_BACKBONE_REPOS,
  DiscoveryCatalogError,
  GithubBackboneClient,
  loadBackboneRepositories,
  type DiscoveryHttp,
} from './github';
import { SkillshubClient } from './skillshub';
import {
  discoveryDedupeKey,
  type CatalogFailureKind,
  type DiscoveredSkill,
  type DiscoveryCatalog,
  type DiscoveryLayer,
  type LayerStatus,
} from './types';

// Discovery catalog orchestrator (spec §7.4, issue #68).
//
// Runs the GitHub backbone and the experimental skills.sh layer for one
// query/browse, merges and deduplicates results by repository + directory, and
// reports per-layer reachability so the UI can say "catalog unavailable" for a
// failed layer — never disguise it as "no results". Each layer covers the
// other's failure: a skills.sh outage keeps backbone results plus stale-marked
// cache; a backbone rate-limit keeps skills.sh. Results carry fetch timestamps;
// when a layer fails and a previous successful fetch exists for the same key,
// the cached results are returned marked stale.

export type DiscoverySessionOptions = {
  appHomePath?: string;
  http?: DiscoveryHttp;
  /** Overrides the `gh auth token` borrow (tests). Defaults to the real one. */
  tokenProvider?: () => Promise<string | null>;
  now?: Clock;
  /** skills.sh layer gate — mirrors `workbench.skillsDiscoveryExperimental`. */
  experimentalEnabled: boolean;
  repoBrowseLimit?: number;
  repoSkillLimit?: number;
  skillshubLimit?: number;
  /** Pre-seeded per-layer caches (tests can simulate an earlier offline fetch). */
  backboneCache?: Map<string, CachedLayerResult>;
  skillshubCache?: Map<string, CachedLayerResult>;
};

export type CachedLayerResult = {
  results: DiscoveredSkill[];
  fetchedAt: string;
};

export class SkillsDiscoverySession {
  /** The skills.sh layer gate (spec §7.4 `workbench.skillsDiscoveryExperimental`).
   * Exposed so the Discover surface can render the persistent badge. */
  readonly experimentalEnabled: boolean;
  private readonly appHomePath: string | undefined;
  private readonly http: DiscoveryHttp | undefined;
  private readonly tokenProvider: (() => Promise<string | null>) | undefined;
  private readonly now: Clock;
  private readonly repoBrowseLimit: number | undefined;
  private readonly repoSkillLimit: number | undefined;
  private readonly skillshubLimit: number | undefined;
  private readonly backboneCache: Map<string, CachedLayerResult>;
  private readonly skillshubCache: Map<string, CachedLayerResult>;

  private backbone: GithubBackboneClient | null = null;
  private skillshub: SkillshubClient | null = null;
  private repos: string[] | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(options: DiscoverySessionOptions) {
    this.experimentalEnabled = options.experimentalEnabled;
    this.appHomePath = options.appHomePath;
    this.http = options.http;
    this.tokenProvider = options.tokenProvider;
    this.now = options.now ?? (() => new Date());
    this.repoBrowseLimit = options.repoBrowseLimit;
    this.repoSkillLimit = options.repoSkillLimit;
    this.skillshubLimit = options.skillshubLimit;
    this.backboneCache = options.backboneCache ?? new Map();
    this.skillshubCache = options.skillshubCache ?? new Map();
  }

  /** Lazily borrow the `gh` token once, load curated repos, and build the
   * layer clients. Idempotent — safe to call on every browse/search. */
  private ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize();
    }
    return this.readyPromise;
  }

  private async initialize(): Promise<void> {
    const token = this.tokenProvider ? await this.tokenProvider() : await borrowGhToken();
    this.repos = this.appHomePath
      ? await loadBackboneRepositories(this.appHomePath)
      : [...CURATED_BACKBONE_REPOS];
    this.backbone = new GithubBackboneClient({
      http: this.http,
      token,
      now: this.now,
      repoBrowseLimit: this.repoBrowseLimit,
      repoSkillLimit: this.repoSkillLimit,
    });
    this.skillshub = new SkillshubClient({ http: this.http, now: this.now, limit: this.skillshubLimit });
  }

  /** Browse the curated backbone (the zero-query Discover floor). */
  async browse(): Promise<DiscoveryCatalog> {
    await this.ready();
    const layer = await this.fetchLayer('backbone', '', async () => {
      const r = await this.backbone!.browseRepositories(this.repos!);
      return { results: r.results, degraded: r.failedRepos > 0, errorCode: r.errorKind };
    });
    return { results: layer.results, layers: [layer.status], fetchedAt: this.now().toISOString() };
  }

  /** Search the merged catalog: backbone search (or curated browse when the
   * query is empty) + the experimental skills.sh layer when enabled. */
  async search(query: string): Promise<DiscoveryCatalog> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return this.browse();

    await this.ready();
    // Both layers run concurrently; each covers the other's failure.
    const skillshubPromise = this.experimentalEnabled
      ? this.fetchLayer('skillshub', `q:${trimmed}`, async () => ({
          results: await this.skillshub!.search(trimmed),
        }))
      : null;
    const backboneLayer = await this.fetchLayer('backbone', `q:${trimmed}`, async () => {
      const r = await this.backbone!.search(trimmed);
      return { results: r.results, degraded: r.failedRepos > 0, errorCode: r.errorKind };
    });
    const layers: LayerStatus[] = [backboneLayer.status];

    let skillshubResults: DiscoveredSkill[] = [];
    if (skillshubPromise) {
      const skillshubLayer = await skillshubPromise;
      skillshubResults = skillshubLayer.results;
      layers.push(skillshubLayer.status);
    }

    return {
      results: mergeCatalogs(backboneLayer.results, skillshubResults),
      layers,
      fetchedAt: this.now().toISOString(),
    };
  }

  private async fetchLayer(
    layer: DiscoveryLayer,
    key: string,
    run: () => Promise<LayerRunResult>,
  ): Promise<{ results: DiscoveredSkill[]; status: LayerStatus }> {
    const cache = layer === 'backbone' ? this.backboneCache : this.skillshubCache;
    const fetchedAt = this.now().toISOString();
    try {
      const { results, degraded, errorCode } = await run();
      cache.set(key, { results, fetchedAt });
      return {
        results,
        status: {
          layer,
          state: 'ok',
          unavailable: false,
          degraded: degraded ?? false,
          errorCode,
          fetchedAt,
        },
      };
    } catch (error) {
      const kind = classifyFailure(error);
      const cached = cache.get(key);
      if (cached) {
        return {
          // Cached data is served marked stale: the six-state audit view
          // degrades pass/warn/fail → cached-stale (spec §7.4).
          results: degradeAudits(cached.results),
          status: {
            layer,
            state: kind,
            unavailable: true,
            fetchedAt: cached.fetchedAt,
            stale: true,
            errorCode: kind,
          },
        };
      }
      return {
        results: [],
        status: { layer, state: kind, unavailable: true, errorCode: kind },
      };
    }
  }
}

type LayerRunResult = {
  results: DiscoveredSkill[];
  degraded?: boolean;
  errorCode?: string;
};

/** Degrade a cached result's audit to `cached-stale` when it had a provider
 * verdict — absence (`not audited`) is unchanged because there is no audit to
 * be stale. The six-state audit view (§7.4) is computed, never left implicit. */
function degradeAudits(results: DiscoveredSkill[]): DiscoveredSkill[] {
  return results.map((skill) => {
    if (skill.audit.state !== 'pass' && skill.audit.state !== 'warn' && skill.audit.state !== 'fail') {
      return skill;
    }
    return {
      ...skill,
      audit: {
        state: 'cached-stale',
        provider: skill.audit.provider,
        fetchedAt: skill.audit.fetchedAt,
        stale: true,
      },
    };
  });
}

/** Merge the two layers, deduplicating by repository + directory (spec §7.4).
 * Backbone results come first, so a Skill surfaced by both layers keeps the
 * backbone's precise tree-URL install source; the skills.sh result adds install
 * counts, trending, an audit state (when not already set), and a description. */
export function mergeCatalogs(
  backbone: DiscoveredSkill[],
  skillshub: DiscoveredSkill[],
): DiscoveredSkill[] {
  const keyed = new Map<string, DiscoveredSkill>();
  for (const skill of backbone) {
    keyed.set(discoveryDedupeKey(skill.repository, skill.directory), {
      ...skill,
      layers: [...skill.layers],
    });
  }
  for (const skill of skillshub) {
    const key = discoveryDedupeKey(skill.repository, skill.directory);
    const existing = keyed.get(key);
    if (!existing) {
      keyed.set(key, { ...skill, layers: [...skill.layers] });
      continue;
    }
    const merged: DiscoveredSkill = { ...existing };
    merged.layers = [...new Set([...existing.layers, ...skill.layers])];
    if (merged.installs === undefined && skill.installs !== undefined) {
      merged.installs = skill.installs;
    }
    if (!merged.description && skill.description) merged.description = skill.description;
    if (!merged.skillPath && skill.skillPath) merged.skillPath = skill.skillPath;
    if (merged.audit.state === 'not audited' && skill.audit.state !== 'not audited') {
      merged.audit = skill.audit;
    }
    if (skill.fetchedAt > merged.fetchedAt) merged.fetchedAt = skill.fetchedAt;
    // Backbone's tree URL scopes the Skill already; the skills.sh `--skill`
    // selection is only meaningful for a skills.sh-only result.
    if (!merged.skill && skill.skill && !existing.layers.includes('backbone')) {
      merged.skill = skill.skill;
    }
    keyed.set(key, merged);
  }
  return [...keyed.values()];
}

export function classifyFailure(error: unknown): CatalogFailureKind {
  if (error instanceof DiscoveryCatalogError) return error.kind;
  return 'unavailable';
}
