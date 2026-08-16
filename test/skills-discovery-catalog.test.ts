import { describe, expect, it } from 'vitest';

import {
  mergeCatalogs,
  SkillsDiscoverySession,
  type DiscoveredSkill,
  type DiscoveryCatalog,
} from '../src/core/skills-discovery';
import {
  apiRepo,
  apiTree,
  makeHttp,
  rawSkill,
  repoSearchJson,
  skillshubSearch,
  shubItem,
  FakeResponse,
} from './fixtures/discovery-http';

// Discovery catalog orchestrator (spec §7.4, issue #68).
//
// Merges the GitHub backbone with the default-on experimental skills.sh layer,
// deduplicates by repository + directory, and reports per-layer reachability so
// the UI says "catalog unavailable" for a failed layer — never "no results".
// Each layer covers the other's failure; offline shows cached data marked stale.

const FIXED_NOW = () => new Date('2026-08-01T12:00:00.000Z');

function backboneSkill(repository: string, directory: string, name = directory): DiscoveredSkill {
  return {
    id: `${repository}:${directory}`,
    name,
    description: `Description of ${name}.`,
    repository,
    directory,
    skillPath: `skills/${directory}`,
    ref: 'main',
    layers: ['backbone'],
    audit: { state: 'not audited', stale: false },
    fetchedAt: '2026-08-01T12:00:00.000Z',
    installSource: `https://github.com/${repository}/tree/main/skills/${directory}`,
  };
}

function shubSkill(repository: string, directory: string, opts: { installs?: number } = {}): DiscoveredSkill {
  return {
    id: `${repository}:${directory}`,
    name: directory,
    description: '',
    repository,
    directory,
    layers: ['skillshub'],
    audit: { state: 'not audited', stale: false },
    fetchedAt: '2026-08-01T12:00:00.000Z',
    installSource: repository,
    skill: directory,
    ...(opts.installs !== undefined ? { installs: opts.installs } : {}),
  };
}

// The canonical backbone browse route set for the curated repos in tests.
function browseRoutes(extra: Array<[string, unknown]> = []) {
  return makeHttp([
    ['/repos/vercel-labs/skills', apiRepo('vercel-labs', 'skills')],
    ['/git/trees/main', apiTree(['skills/find-skills/SKILL.md'])],
    ['raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md', rawSkill('find-skills', 'Finds skills.')],
    ...extra,
  ]);
}

function session(opts: {
  http?: ReturnType<typeof makeHttp>['http'];
  experimentalEnabled?: boolean;
  tokenProvider?: () => Promise<string | null>;
  backboneCache?: Map<string, { results: DiscoveredSkill[]; fetchedAt: string }>;
  skillshubCache?: Map<string, { results: DiscoveredSkill[]; fetchedAt: string }>;
}): SkillsDiscoverySession {
  return new SkillsDiscoverySession({
    http: opts.http,
    experimentalEnabled: opts.experimentalEnabled ?? true,
    now: FIXED_NOW,
    tokenProvider: opts.tokenProvider ?? (async () => null),
    backboneCache: opts.backboneCache,
    skillshubCache: opts.skillshubCache,
  });
}

describe('mergeCatalogs (dedupe by repository + directory)', () => {
  it('keeps one entry when both layers surface the same Skill', () => {
    const merged = mergeCatalogs(
      [backboneSkill('o/r', 'git')],
      [shubSkill('o/r', 'git', { installs: 41003 })],
    );
    expect(merged).toHaveLength(1);
    const skill = merged[0]!;
    expect(skill.layers.sort()).toEqual(['backbone', 'skillshub']);
    // The backbone tree URL is the install source (precise); the skills.sh
    // install count rides along.
    expect(skill.installSource).toBe('https://github.com/o/r/tree/main/skills/git');
    expect(skill.installs).toBe(41003);
    expect(skill.skill).toBeUndefined(); // tree URL already scopes the Skill
  });

  it('keeps skills.sh-only results with their install counts', () => {
    const merged = mergeCatalogs([], [shubSkill('o/r', 'git', { installs: 99 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.layers).toEqual(['skillshub']);
    expect(merged[0]!.skill).toBe('git');
    expect(merged[0]!.installs).toBe(99);
  });

  it('merges an audit state that the other layer lacked', () => {
    const audited = shubSkill('o/r', 'git');
    audited.audit = { state: 'pass', provider: 'skills.sh', fetchedAt: 't0', stale: false };
    const merged = mergeCatalogs([backboneSkill('o/r', 'git')], [audited]);
    expect(merged[0]!.audit.state).toBe('pass');
  });
});

describe('SkillsDiscoverySession.search', () => {
  it('merges backbone + skills.sh results for a query', async () => {
    const { http } = makeHttp([
      ['/search/repositories', repoSearchJson(['o/skill-repo'])],
      ['/repos/o/skill-repo', apiRepo('o', 'skill-repo')],
      ['/git/trees/main', apiTree(['git/SKILL.md'])],
      ['raw.githubusercontent.com/o/skill-repo/main/git/SKILL.md', rawSkill('git', 'Git skill.')],
      ['https://skills.sh/api/search', skillshubSearch([shubItem({ id: 'o/skill-repo/git' })])],
    ]);
    const s = session({ http });
    const catalog = await s.search('git');

    expect(catalog.results).toHaveLength(1);
    expect(catalog.results[0]!.layers.sort()).toEqual(['backbone', 'skillshub']);
    expect(catalog.fetchedAt).toBe('2026-08-01T12:00:00.000Z');
    // Both layers are reachable.
    expect(catalog.layers.map((l) => l.state)).toEqual(['ok', 'ok']);
  });

  it('respects the experimental off switch: no skills.sh layer, no network call', async () => {
    const { http, calls } = makeHttp([
      ['/search/repositories', repoSearchJson(['o/skill-repo'])],
      ['/repos/o/skill-repo', apiRepo('o', 'skill-repo')],
      ['/git/trees/main', apiTree(['git/SKILL.md'])],
      ['raw.githubusercontent.com/o/skill-repo/main/git/SKILL.md', rawSkill('git', 'Git skill.')],
    ]);
    const s = session({ http, experimentalEnabled: false });
    const catalog = await s.search('git');

    expect(catalog.layers).toHaveLength(1); // backbone only
    expect(catalog.layers[0]!.layer).toBe('backbone');
    expect(calls.some((u) => u.includes('skills.sh'))).toBe(false);
  });

  it('keeps backbone results when skills.sh is down (skills.sh outage → backbone + stale cache)', async () => {
    const { http } = makeHttp([
      ['/search/repositories', repoSearchJson(['o/skill-repo'])],
      ['/repos/o/skill-repo', apiRepo('o', 'skill-repo')],
      ['/git/trees/main', apiTree(['git/SKILL.md'])],
      ['raw.githubusercontent.com/o/skill-repo/main/git/SKILL.md', rawSkill('git', 'Git skill.')],
      ['https://skills.sh/api/search', new FakeResponse(500, {})],
    ]);
    const s = session({ http });
    const catalog = await s.search('git');

    // Backbone results survive; the failed layer is reported unavailable —
    // never disguised as "no results".
    expect(catalog.results).toHaveLength(1);
    expect(catalog.results[0]!.layers).toEqual(['backbone']);
    expect(catalog.layers.find((l) => l.layer === 'skillshub')).toMatchObject({
      state: 'unavailable',
      unavailable: true,
    });
  });

  it('keeps skills.sh results when the backbone is rate-limited (backbone rate-limit → skills.sh)', async () => {
    const { http } = makeHttp([
      ['/search/repositories', new FakeResponse(403, { message: 'limit' }, { 'x-ratelimit-remaining': '0' })],
      ['https://skills.sh/api/search', skillshubSearch([shubItem({ id: 'mattpocock/skills/git-guardrails' })])],
    ]);
    const s = session({ http });
    const catalog = await s.search('git');

    expect(catalog.results).toHaveLength(1);
    expect(catalog.results[0]!.layers).toEqual(['skillshub']);
    expect(catalog.layers.find((l) => l.layer === 'backbone')).toMatchObject({
      state: 'rate-limited',
      unavailable: true,
    });
  });

  it('offline shows cached data marked stale', async () => {
    // Seed the cache as if an earlier online search had populated it: the
    // cached result carries its own fetch timestamp (11:00), and the cache
    // entry records when the layer fetch succeeded.
    const cachedSkill = { ...backboneSkill('o/r', 'git'), fetchedAt: '2026-08-01T11:00:00.000Z' };
    const backboneCache = new Map([
      ['q:git', { results: [cachedSkill], fetchedAt: '2026-08-01T11:00:00.000Z' }],
    ]);
    const s = session({ http: async () => { throw new TypeError('fetch failed'); }, backboneCache });
    const catalog = await s.search('git');

    expect(catalog.results).toHaveLength(1);
    // The cached result's own fetch timestamp is preserved.
    expect(catalog.results[0]!.fetchedAt).toBe('2026-08-01T11:00:00.000Z');
    expect(catalog.layers[0]).toMatchObject({
      state: 'offline',
      unavailable: true,
      stale: true,
      fetchedAt: '2026-08-01T11:00:00.000Z',
    });
  });

  it('a cold offline fetch yields no results but an unavailable layer (not "no results")', async () => {
    const s = session({ http: async () => { throw new TypeError('fetch failed'); } });
    const catalog = await s.search('git');
    expect(catalog.results).toHaveLength(0);
    expect(catalog.layers[0]!.unavailable).toBe(true);
  });

  it('an empty query falls back to the curated browse', async () => {
    const { http } = browseRoutes();
    const s = session({ http });
    const catalog = await s.search('   ');
    expect(catalog.results.some((r) => r.name === 'find-skills')).toBe(true);
    expect(catalog.layers[0]!.layer).toBe('backbone');
  });
});

describe('SkillsDiscoverySession.browse (curated backbone floor)', () => {
  it('browses the curated repositories and returns their Skills', async () => {
    const { http } = browseRoutes();
    const s = session({ http });
    const catalog = await s.browse();
    expect(catalog.results.some((r) => r.repository === 'vercel-labs/skills')).toBe(true);
  });

  it('marks the layer unavailable when every curated repo fails', async () => {
    const s = session({ http: async () => new FakeResponse(500, {}) });
    const catalog = await s.browse();
    expect(catalog.results).toHaveLength(0);
    expect(catalog.layers[0]!.unavailable).toBe(true);
  });

  it('reports the backbone layer degraded when only some curated repos fail', async () => {
    // Only vercel-labs/skills is served; the other curated repos 404 → partial.
    const { http } = browseRoutes();
    const s = session({ http });
    const catalog = await s.browse();
    expect(catalog.results.some((r) => r.repository === 'vercel-labs/skills')).toBe(true);
    expect(catalog.layers[0]).toMatchObject({ state: 'ok', degraded: true });
  });
});

describe('SkillsDiscoverySession offline degradation', () => {
  it('serves cached data marked stale and degrades its audit to cached-stale', async () => {
    const audited = shubSkill('o/r', 'git');
    audited.audit = { state: 'pass', provider: 'skills.sh', fetchedAt: '2026-08-01T10:00:00.000Z', stale: false };
    const skillshubCache = new Map([
      ['q:git', { results: [audited], fetchedAt: '2026-08-01T11:00:00.000Z' }],
    ]);
    const s = session({
      http: async () => {
        throw new TypeError('fetch failed');
      },
      skillshubCache,
    });
    const catalog = await s.search('git');

    // The skillshub layer is down; its cached result is served with the audit
    // view computed to cached-stale (six-state audit, spec §7.4).
    const shubResult = catalog.results.find((r) => r.layers.includes('skillshub'));
    expect(shubResult).toBeDefined();
    expect(shubResult!.audit).toMatchObject({
      state: 'cached-stale',
      provider: 'skills.sh',
      stale: true,
    });
    expect(catalog.layers.find((l) => l.layer === 'skillshub')).toMatchObject({
      stale: true,
      unavailable: true,
    });
  });
});

// The returned catalog drives the Discover surface's wording directly.
function expectCatalogShape(catalog: DiscoveryCatalog): void {
  expect(typeof catalog.fetchedAt).toBe('string');
  expect(Array.isArray(catalog.results)).toBe(true);
  expect(Array.isArray(catalog.layers)).toBe(true);
}

describe('catalog shape', () => {
  it('carries fetch timestamps and per-layer status', async () => {
    const { http } = makeHttp([
      ['/search/repositories', repoSearchJson(['o/r'])],
      ['/repos/o/r', apiRepo('o', 'r')],
      ['/git/trees/main', apiTree(['git/SKILL.md'])],
      ['raw.githubusercontent.com/o/r/main/git/SKILL.md', rawSkill('git', 'Git skill.')],
      ['https://skills.sh/api/search', skillshubSearch([shubItem({ id: 'o/r/git' })])],
    ]);
    const catalog = await session({ http }).search('git');
    expectCatalogShape(catalog);
    for (const skill of catalog.results) {
      expect(skill.fetchedAt.length).toBeGreaterThan(0);
      expect(skill.audit).toBeDefined();
    }
  });
});
