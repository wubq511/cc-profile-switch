// Skills discovery (spec §7.4, issue #68).
//
// Facade over the two-layer catalog: the zero-config GitHub backbone and the
// default-on, honestly-badged experimental skills.sh layer. Installing from
// any DiscoveredSkill routes through the §7.3 pinned acquisition adapter via
// `installSource` (+ optional `skill` selection).

export {
  SkillsDiscoverySession,
  mergeCatalogs,
  classifyFailure,
  type DiscoverySessionOptions,
  type CachedLayerResult,
} from './catalog';

export {
  GithubBackboneClient,
  CURATED_BACKBONE_REPOS,
  GITHUB_API_BASE,
  GITHUB_RAW_BASE,
  DiscoveryCatalogError,
  defaultDiscoveryHttp,
  borrowGhToken,
  loadBackboneRepositories,
  classifyNetworkError,
  DISCOVERY_OFFLINE_PATTERNS,
  type BackboneClientOptions,
  type DiscoveryHttp,
  type DiscoveryHttpResponse,
} from './github';

export { SkillshubClient, parseSkillshubItem, mapAuditPayload, SKILLSHUB_SEARCH_BASE } from './skillshub';

export {
  discoveryDedupeKey,
  type CatalogFailureKind,
  type DiscoveredSkill,
  type DiscoveryCatalog,
  type DiscoveryLayer,
  type LayerStatus,
} from './types';
