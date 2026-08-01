import type { AuditView } from '../../schemas/skills-provenance';
import {
  classifyNetworkError,
  DiscoveryCatalogError,
  defaultDiscoveryHttp,
  type DiscoveryHttp,
} from './github';
import { discoveryDedupeKey, dropLastSegment, isRecord, lastSegment, type DiscoveredSkill } from './types';
import type { Clock } from '../types';

// Experimental skills.sh layer (spec §7.4, issue #68).
//
// The undocumented `GET /api/search` catalog is queried directly (never via
// `skills find` human output, never scraping HTML). Results are honestly
// badged as experimental in the UI, merged with the GitHub backbone and
// deduplicated by repository + directory. Install counts and a trending flag
// are carried when available. Security audits ride with the layer: when a
// result carries no audit payload the state is `not audited` — absence is
// never rendered as safe. Failure wording is "catalog unavailable", never
// disguised as "no results".

export const SKILLSHUB_SEARCH_BASE = 'https://skills.sh/api/search';

export type SkillshubClientOptions = {
  http?: DiscoveryHttp;
  now?: Clock;
  /** Cap on results kept per search (the endpoint's default otherwise). */
  limit?: number;
};

/** A raw skills.sh search-result item as returned by `GET /api/search`. */
export type SkillshubSearchItem = {
  id?: unknown;
  skillId?: unknown;
  name?: unknown;
  description?: unknown;
  installs?: unknown;
  trending?: unknown;
  source?: unknown;
  /** Optional audit payload; mapped to the six-state audit view. */
  audit?: unknown;
};

export class SkillshubClient {
  private readonly http: DiscoveryHttp;
  private readonly now: Clock;
  private readonly limit: number | undefined;

  constructor(options: SkillshubClientOptions = {}) {
    this.http = options.http ?? defaultDiscoveryHttp;
    this.now = options.now ?? (() => new Date());
    this.limit = options.limit;
  }

  /** Search the skills.sh catalog and return the Skills found. A total failure
   * throws a classified error so the layer reads unavailable; the caller merges
   * whatever the backbone found. */
  async search(query: string): Promise<DiscoveredSkill[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const url = `${SKILLSHUB_SEARCH_BASE}?q=${encodeURIComponent(trimmed)}${
      this.limit !== undefined ? `&limit=${this.limit}` : ''
    }`;
    let res: Awaited<ReturnType<DiscoveryHttp>>;
    try {
      res = await this.http(url, {});
    } catch (error) {
      throw classifyNetworkError(error);
    }
    if (!res.ok) {
      throw new DiscoveryCatalogError('unavailable', `skills.sh search error (${res.status}).`, res.status);
    }

    const json = await res.json();
    const skills = isRecord(json) && Array.isArray(json.skills) ? json.skills : [];
    const results: DiscoveredSkill[] = [];
    for (const item of skills) {
      const parsed = parseSkillshubItem(item, this.now().toISOString());
      if (parsed) results.push(parsed);
    }
    return results;
  }
}

/** Parse one skills.sh result item into a DiscoveredSkill (install source =
 * owner/repo shorthand + `--skill` selection for the §7.3 adapter). */
export function parseSkillshubItem(item: unknown, fetchedAt: string): DiscoveredSkill | null {
  if (!isRecord(item)) return null;

  const id = typeof item.id === 'string' ? item.id : '';
  const skillId = typeof item.skillId === 'string' ? item.skillId : lastSegment(id);
  const source = typeof item.source === 'string' ? item.source : dropLastSegment(id);
  const name =
    typeof item.name === 'string' && item.name.length > 0
      ? item.name
      : skillId || lastSegment(id);
  const description =
    typeof item.description === 'string' ? item.description : '';

  const repository = source;
  const directory = skillId;
  if (repository.length === 0 || directory.length === 0) return null;

  const skill: DiscoveredSkill = {
    id: discoveryDedupeKey(repository, directory),
    name,
    description,
    repository,
    directory,
    layers: ['skillshub'],
    audit: mapAuditPayload(item.audit, fetchedAt),
    fetchedAt,
    installSource: repository,
    skill: directory,
  };

  if (typeof item.installs === 'number' && Number.isFinite(item.installs)) {
    skill.installs = item.installs;
  }
  if (typeof item.trending === 'boolean') {
    skill.trending = item.trending;
  }
  return skill;
}

/** Map a skills.sh audit payload to the six-state audit view. Absence or an
 * unrecognized payload maps to `not audited` — never to safe. */
export function mapAuditPayload(payload: unknown, fetchedAt: string): AuditView {
  if (payload === undefined || payload === null) {
    return { state: 'not audited', stale: false, fetchedAt };
  }
  if (typeof payload === 'string') {
    return { state: normalizeAuditState(payload), stale: false, fetchedAt };
  }
  if (isRecord(payload)) {
    const rawState =
      typeof payload.state === 'string'
        ? payload.state
        : typeof payload.status === 'string'
          ? payload.status
          : typeof payload.result === 'string'
            ? payload.result
            : undefined;
    const provider = typeof payload.provider === 'string' ? payload.provider : undefined;
    const providerFetchedAt =
      typeof payload.fetchedAt === 'string' ? payload.fetchedAt : fetchedAt;
    return {
      state: normalizeAuditState(rawState),
      provider,
      fetchedAt: providerFetchedAt,
      stale: false,
    };
  }
  return { state: 'not audited', stale: false, fetchedAt };
}

function normalizeAuditState(raw: string | undefined): AuditView['state'] {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'pass':
    case 'passed':
      return 'pass';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'fail':
    case 'failed':
      return 'fail';
    case 'cached-stale':
      return 'cached-stale';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'not audited';
  }
}

