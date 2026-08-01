import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CURATED_BACKBONE_REPOS,
  DiscoveryCatalogError,
  GithubBackboneClient,
  loadBackboneRepositories,
  borrowGhToken,
  type DiscoveryHttp,
} from '../src/core/skills-discovery';
import { parseFrontmatter } from '../src/core/resource/frontmatter';
import {
  apiRepo,
  apiTree,
  codeSearchJson,
  makeHttp,
  rawSkill,
  repoSearchJson,
  FakeResponse,
} from './fixtures/discovery-http';

// GitHub backbone discovery (spec §7.4, issue #68).
//
// The backbone browses a curated repository list through the contents-tree +
// raw APIs, parses SKILL.md frontmatter with ccps's own parser, searches the
// documented repository API unauthenticated (10 req/min), and unlocks code
// search when a local `gh` token is borrowed. All network and process I/O is
// injected so tests never touch the real GitHub API.

const FIXED_NOW = () => new Date('2026-08-01T12:00:00.000Z');

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.map((r) => rm(r, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeAppHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ccps-backbone-'));
  tempRoots.push(root);
  const appHome = path.join(root, '.cc-profile-switch');
  await fs.ensureDir(appHome);
  return appHome;
}

// ─── Curated list ────────────────────────────────────────────────────────

describe('curated backbone repository list', () => {
  it('ships a built-in first-party/well-known list (sources only)', () => {
    expect(CURATED_BACKBONE_REPOS.length).toBeGreaterThanOrEqual(3);
    for (const repo of CURATED_BACKBONE_REPOS) {
      expect(repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    }
  });

  it('merges user extensions from skills-backbone.json (user-extensible)', async () => {
    const appHome = await makeAppHome();
    await fs.writeFile(
      path.join(appHome, 'skills-backbone.json'),
      JSON.stringify({ repositories: ['some-user/skill-repo', '  another/bad slug  ', 'some-user/skill-repo'] }),
      'utf8',
    );
    const list = await loadBackboneRepositories(appHome);
    expect(list).toContain('some-user/skill-repo');
    // Malformed slugs are filtered; duplicates are removed; built-ins remain.
    expect(list.filter((r) => r.includes('bad slug'))).toHaveLength(0);
    expect(list.filter((r) => r === 'some-user/skill-repo')).toHaveLength(1);
    for (const builtIn of CURATED_BACKBONE_REPOS) expect(list).toContain(builtIn);
  });

  it('falls back to the built-in list when the user file is malformed', async () => {
    const appHome = await makeAppHome();
    await fs.writeFile(path.join(appHome, 'skills-backbone.json'), 'not json{', 'utf8');
    const list = await loadBackboneRepositories(appHome);
    expect(list).toEqual([...CURATED_BACKBONE_REPOS]);
  });
});

// ─── Browse curated repositories ─────────────────────────────────────────

describe('browseRepositories (contents-tree + raw APIs)', () => {
  it('enumerates SKILL.md paths via the tree API and parses frontmatter via the raw API', async () => {
    const { http } = makeHttp([
      ['/repos/vercel-labs/skills', apiRepo('vercel-labs', 'skills')],
      ['/git/trees/main', apiTree(['skills/find-skills/SKILL.md', 'skills/prompts/SKILL.md'])],
      [
        'raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md',
        rawSkill('find-skills', 'Finds skills.'),
      ],
      [
        'raw.githubusercontent.com/vercel-labs/skills/main/skills/prompts/SKILL.md',
        rawSkill('prompts', 'Prompting skills.'),
      ],
    ]);
    const client = new GithubBackboneClient({ http, now: FIXED_NOW });

    const { results: skills } = await client.browseRepositories(['vercel-labs/skills']);

    expect(skills).toHaveLength(2);
    const findSkills = skills.find((s) => s.name === 'find-skills')!;
    expect(findSkills.repository).toBe('vercel-labs/skills');
    expect(findSkills.directory).toBe('find-skills');
    expect(findSkills.skillPath).toBe('skills/find-skills');
    expect(findSkills.ref).toBe('main');
    expect(findSkills.layers).toEqual(['backbone']);
    // Audit: backbone results carry no audit payload → never rendered as safe.
    expect(findSkills.audit.state).toBe('not audited');
    expect(findSkills.fetchedAt).toBe('2026-08-01T12:00:00.000Z');
    // Install routes through the §7.3 adapter via a precise tree URL.
    expect(findSkills.installSource).toBe(
      'https://github.com/vercel-labs/skills/tree/main/skills/find-skills',
    );
  });

  it('skips directories whose SKILL.md has unparseable or missing frontmatter', async () => {
    const { http } = makeHttp([
      ['/repos/o/r', apiRepo('o', 'r')],
      ['/git/trees/main', apiTree(['good/SKILL.md', 'bad/SKILL.md', 'missing/SKILL.md'])],
      ['raw.githubusercontent.com/o/r/main/good/SKILL.md', rawSkill('good', 'desc')],
      ['raw.githubusercontent.com/o/r/main/bad/SKILL.md', new FakeResponse(200, 'no frontmatter here')],
      ['raw.githubusercontent.com/o/r/main/missing/SKILL.md', new FakeResponse(404, { message: 'gone' })],
    ]);
    const client = new GithubBackboneClient({ http });

    const { results: skills } = await client.browseRepositories(['o/r']);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('good');
  });

  it('caches the tree so an interactive browse does not re-enumerate per repo', async () => {
    const { http, calls } = makeHttp([
      ['/repos/o/r', apiRepo('o', 'r')],
      ['/git/trees/main', apiTree(['a/SKILL.md'])],
      ['raw.githubusercontent.com/o/r/main/a/SKILL.md', rawSkill('a', 'desc')],
    ]);
    const client = new GithubBackboneClient({ http, now: FIXED_NOW });
    await client.browseRepositories(['o/r']);
    await client.browseRepositories(['o/r']);
    // The default-branch and tree calls happen once; the raw fetch is per skill.
    const branchCalls = calls.filter((u) => u === 'https://api.github.com/repos/o/r');
    expect(branchCalls).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/git/trees'))).toHaveLength(1);
  });

  it('throws a classified error only when every curated repo fails', async () => {
    const { http } = makeHttp([
      ['/repos/o/r', apiRepo('o', 'r')],
      ['/git/trees/main', new FakeResponse(403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0' })],
      ['/repos/o2/r2', apiRepo('o2', 'r2')],
      ['/repos/o2/r2/git/trees/main', new FakeResponse(403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0' })],
    ]);
    const client = new GithubBackboneClient({ http });

    await expect(client.browseRepositories(['o/r', 'o2/r2'])).rejects.toBeInstanceOf(
      DiscoveryCatalogError,
    );
  });
});

// ─── Search: unauthenticated repository search ───────────────────────────

describe('search unauthenticated (documented repository search, 10 req/min)', () => {
  it('searches repositories and browses the top hits for Skills', async () => {
    const { http } = makeHttp([
      ['/search/repositories', repoSearchJson(['o/skill-repo'])],
      ['/repos/o/skill-repo', apiRepo('o', 'skill-repo')],
      ['/git/trees/main', apiTree(['git/SKILL.md'])],
      ['raw.githubusercontent.com/o/skill-repo/main/git/SKILL.md', rawSkill('git', 'Git skill.')],
    ]);
    const client = new GithubBackboneClient({ http, now: FIXED_NOW });

    const { results: skills } = await client.search('git');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.repository).toBe('o/skill-repo');
    expect(skills[0]!.directory).toBe('git');
    expect(skills[0]!.installSource).toBe(
      'https://github.com/o/skill-repo/tree/main/git',
    );
  });

  it('throws the search failure when every browsed repo fails (not "no results")', async () => {
    const { http } = makeHttp([
      ['/search/repositories', repoSearchJson(['o/a'])],
      ['/repos/o/a', apiRepo('o', 'a')],
      ['/git/trees/main', new FakeResponse(403, { message: 'limited' }, { 'x-ratelimit-remaining': '0' })],
    ]);
    const client = new GithubBackboneClient({ http });

    await expect(client.search('git')).rejects.toMatchObject({ kind: 'rate-limited' });
  });

  it('returns empty for an empty query without any network call', async () => {
    const { http, calls } = makeHttp([]);
    const client = new GithubBackboneClient({ http });
    expect((await client.search('   ')).results).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ─── Search: code search with a borrowed token ───────────────────────────

describe('search with a borrowed gh token (code search unlocked)', () => {
  it('runs code search (filename:SKILL.md) and fetches matching Skills', async () => {
    const { http, calls } = makeHttp([
      ['/search/code', codeSearchJson([{ repo: 'o/repo', path: 'skills/git/SKILL.md' }])],
      ['/repos/o/repo', apiRepo('o', 'repo')],
      ['raw.githubusercontent.com/o/repo/main/skills/git/SKILL.md', rawSkill('git', 'Git skill.')],
    ]);
    const client = new GithubBackboneClient({ http, token: 'gho_test-token', now: FIXED_NOW });

    const { results: skills } = await client.search('git');

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('git');
    expect(skills[0]!.skillPath).toBe('skills/git');
    // The code-search request carried the borrowed token.
    const codeCall = calls.find((u) => u.includes('/search/code'))!;
    expect(codeCall).toContain('filename%3ASKILL.md');
  });

  it('sends the borrowed token as a Bearer header on API calls', async () => {
    const seen: string[] = [];
    const http: DiscoveryHttp = async (url, init) => {
      if (url.includes('/search/code')) {
        seen.push(init?.headers?.Authorization ?? '(none)');
        return new FakeResponse(200, { items: [] });
      }
      if (url.includes('/repos/')) {
        return apiRepo('o', 'r');
      }
      return new FakeResponse(404, {});
    };
    const client = new GithubBackboneClient({ http, token: 'gho_secret-token' });
    await client.search('git');
    expect(seen).toEqual(['Bearer gho_secret-token']);
  });
});

// ─── Rate-limit / offline classification ─────────────────────────────────

describe('failure classification', () => {
  it('classifies 403 with an exhausted rate limit as rate-limited', async () => {
    const { http } = makeHttp([
      ['/repos/o/r', new FakeResponse(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })],
    ]);
    const client = new GithubBackboneClient({ http });
    await expect(client.listRepositorySkills('o', 'r')).rejects.toMatchObject({
      kind: 'rate-limited',
      status: 403,
    });
  });

  it('classifies a network failure as offline', async () => {
    const http: DiscoveryHttp = async () => {
      throw new TypeError('fetch failed');
    };
    const client = new GithubBackboneClient({ http });
    await expect(client.listRepositorySkills('o', 'r')).rejects.toMatchObject({
      kind: 'offline',
    });
  });
});

// ─── gh token borrow ─────────────────────────────────────────────────────

describe('borrowGhToken', () => {
  it('borrows the token from `gh auth token`', async () => {
    const token = await borrowGhToken({
      captureProcess: async () => ({ exitCode: 0, stdout: 'gho_secret\n', stderr: '', timedOut: false }),
    });
    expect(token).toBe('gho_secret');
  });

  it('returns null when gh is unauthenticated', async () => {
    const token = await borrowGhToken({
      captureProcess: async () => ({ exitCode: 1, stdout: '', stderr: 'not logged in', timedOut: false }),
    });
    expect(token).toBeNull();
  });

  it('returns null when gh is unavailable', async () => {
    const token = await borrowGhToken({
      captureProcess: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(token).toBeNull();
  });

  it('never leaks the borrowed token into error output', async () => {
    const http: DiscoveryHttp = async () => new FakeResponse(500, {});
    const client = new GithubBackboneClient({ http, token: 'gho_leak-check-token' });
    try {
      await client.listRepositorySkills('o', 'r');
    } catch (error) {
      expect(String(error)).not.toContain('gho_leak-check-token');
    }
  });
});

// The frontmatter parser the backbone reuses (spec §7.4 "ccps-parsed").
describe('ccps frontmatter parsing feeds discovery', () => {
  it('parses the name/description pair the backbone requires', () => {
    const { frontmatter, parseError } = parseFrontmatter(
      '---\nname: find-skills\ndescription: Helps you discover skills.\n---\n# body',
    );
    expect(parseError).toBeNull();
    expect(frontmatter?.name).toBe('find-skills');
    expect(frontmatter?.description).toBe('Helps you discover skills.');
  });
});
