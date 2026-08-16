import path from 'node:path';
import fs from 'fs-extra';

import { captureProcess, type CaptureProcess } from '../../platform/process';
import { parseFrontmatter } from '../resource/frontmatter';
import { type Clock } from '../types';
import {
  discoveryDedupeKey,
  isRecord,
  lastSegment,
  type CatalogFailureKind,
  type DiscoveredSkill,
} from './types';

// GitHub backbone discovery (spec §7.4, issue #68).
//
// A small built-in curated source list (first-party / well-known repositories,
// user-extensible via `skills-backbone.json` in app home; sources only — no
// ratings or rankings) is browsed through the documented GitHub API family:
// the contents tree API enumerates `*/SKILL.md` paths in one call, and the raw
// endpoint fetches each SKILL.md whose frontmatter ccps parses. Documented
// repository search works unauthenticated (10 req/min); when a local `gh`
// token is detected it is borrowed automatically, raising search to 30 req/min
// and unlocking code search (`filename:SKILL.md`), which surfaces Skills
// directly. Install from any result hands a source string to the §7.3 pinned
// acquisition adapter (tree URL, or owner/repo shorthand + `--skill`).

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';

/** Built-in curated backbone repositories (first-party / well-known). */
export const CURATED_BACKBONE_REPOS: readonly string[] = [
  'vercel-labs/skills',
  'anthropics/skills',
  'obra/superpowers',
  'github/awesome-copilot',
];

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Minimal HTTP surface so tests inject a fake without constructing `Response`.
export type DiscoveryHttpResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

export type DiscoveryHttp = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<DiscoveryHttpResponse>;

export const defaultDiscoveryHttp: DiscoveryHttp = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    headers: { get: (name) => res.headers.get(name) },
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};

/** Classified GitHub catalog failure (offline / rate-limit / outage). */
export class DiscoveryCatalogError extends Error {
  readonly kind: CatalogFailureKind;
  readonly status?: number;

  constructor(kind: CatalogFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'DiscoveryCatalogError';
    this.kind = kind;
    this.status = status;
  }
}

export type BackboneClientOptions = {
  http?: DiscoveryHttp;
  /** A borrowed `gh` token (null = unauthenticated, search at 10 req/min). */
  token?: string | null;
  now?: Clock;
  /** Unauth repo search: how many top repo hits to browse for Skills. */
  repoBrowseLimit?: number;
  /** Per-repo cap on Skills enumerated (undefined = unbounded). */
  repoSkillLimit?: number;
};

/** One backbone pass (browse or search). `failedRepos` is > 0 when some
 * repositories could not be reached — the layer still returned the successes,
 * but the degradation is surfaced so the UI never reads as fully healthy. */
export type BackboneBrowseResult = {
  results: DiscoveredSkill[];
  failedRepos: number;
  /** Classified failure kind of the last failed repo, when any. */
  errorKind?: CatalogFailureKind;
};

export const DISCOVERY_OFFLINE_PATTERNS = [
  /fetch failed/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /failed to connect to/i,
  /connection refused/i,
  /network is unreachable/i,
  /no route to host/i,
  /getaddrinfo/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /ETIMEDOUT/,
  /timed out/i,
];

export class GithubBackboneClient {
  private readonly http: DiscoveryHttp;
  private readonly token: string | null;
  private readonly now: Clock;
  private readonly repoBrowseLimit: number;
  private readonly repoSkillLimit: number | undefined;
  /** Session caches: default branches + enumerated SKILL.md paths (rate-limit
   * friendly — an interactive browse hits the API once per repo, not per key). */
  private readonly branchCache = new Map<string, string>();
  private readonly treeCache = new Map<string, string[]>();

  constructor(options: BackboneClientOptions = {}) {
    this.http = options.http ?? defaultDiscoveryHttp;
    this.token = options.token ?? null;
    this.now = options.now ?? (() => new Date());
    this.repoBrowseLimit = options.repoBrowseLimit ?? 3;
    this.repoSkillLimit = options.repoSkillLimit;
  }

  /** Browse every curated repo and return the Skills found. Total failure (no
   * repo browsable) throws a classified error so the layer reads unavailable;
   * a partial failure keeps the successes but reports the degradation. */
  async browseRepositories(repos: readonly string[]): Promise<BackboneBrowseResult> {
    const results: DiscoveredSkill[] = [];
    let failures = 0;
    let lastError: unknown;
    for (const repo of repos) {
      const [owner, name] = repo.split('/');
      if (!owner || !name) continue;
      try {
        results.push(...(await this.listRepositorySkills(owner, name)));
      } catch (error) {
        failures += 1;
        lastError = error;
      }
    }
    if (results.length === 0 && failures > 0 && lastError) {
      throw lastError;
    }
    return { results, failedRepos: failures, errorKind: lastError ? classifyKind(lastError) : undefined };
  }

  /** Enumerate the Skills in one repository via the contents tree + raw APIs. */
  async listRepositorySkills(owner: string, repo: string): Promise<DiscoveredSkill[]> {
    const branch = await this.getDefaultBranch(owner, repo);
    const skillMdPaths = await this.getSkillMdPaths(owner, repo, branch);

    const results: DiscoveredSkill[] = [];
    for (const skillMdPath of skillMdPaths) {
      const skillDir =
        skillMdPath === 'SKILL.md' ? '' : skillMdPath.slice(0, -'/SKILL.md'.length);
      const skill = await this.fetchSkillFrontmatter(owner, repo, branch, skillDir);
      if (skill) results.push(skill);
      if (this.repoSkillLimit !== undefined && results.length >= this.repoSkillLimit) {
        break;
      }
    }
    return results;
  }

  /** Search the backbone. Unauthenticated: documented repository search (10
   * req/min) then browse the top repo hits for Skills. With a borrowed token:
   * code search (`filename:SKILL.md`) unlocks direct Skill discovery. */
  async search(query: string): Promise<BackboneBrowseResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { results: [], failedRepos: 0 };
    return this.token ? this.codeSearch(trimmed) : this.repoSearch(trimmed);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async codeSearch(query: string): Promise<BackboneBrowseResult> {
    const json = await this.getJson(
      `${GITHUB_API_BASE}/search/code?q=${encodeURIComponent(`filename:SKILL.md ${query}`)}&per_page=20`,
    );
    const items = isRecord(json) && Array.isArray(json.items) ? json.items : [];
    const results: DiscoveredSkill[] = [];
    let failures = 0;
    let lastError: unknown;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const fullName = isRecord(item.repository) ? item.repository.full_name : undefined;
      const itemPath = item.path;
      if (
        typeof fullName !== 'string' ||
        typeof itemPath !== 'string' ||
        !itemPath.endsWith('/SKILL.md')
      ) {
        continue;
      }
      const [owner, repo] = fullName.split('/');
      const skillDir = itemPath.slice(0, -'/SKILL.md'.length);
      try {
        const branch = await this.getDefaultBranch(owner, repo);
        const skill = await this.fetchSkillFrontmatter(owner, repo, branch, skillDir);
        if (skill) results.push(skill);
      } catch (error) {
        // A repo we cannot browse must not fail the whole search.
        failures += 1;
        lastError = error;
      }
    }
    return { results, failedRepos: failures, errorKind: lastError ? classifyKind(lastError) : undefined };
  }

  private async repoSearch(query: string): Promise<BackboneBrowseResult> {
    const json = await this.getJson(
      `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(query)}&per_page=5`,
    );
    const items = isRecord(json) && Array.isArray(json.items) ? json.items : [];
    const top = items.slice(0, this.repoBrowseLimit);
    if (top.length === 0) return { results: [], failedRepos: 0 };

    const results: DiscoveredSkill[] = [];
    let attempted = 0;
    let failures = 0;
    let lastError: unknown;
    for (const item of top) {
      if (!isRecord(item) || typeof item.full_name !== 'string') continue;
      attempted += 1;
      const [owner, repo] = item.full_name.split('/');
      try {
        results.push(...(await this.listRepositorySkills(owner, repo)));
      } catch (error) {
        failures += 1;
        lastError = error;
      }
    }
    // Every browsed repo failed → the layer failed, not "no results".
    if (results.length === 0 && attempted > 0 && failures === attempted && lastError) {
      throw lastError;
    }
    return { results, failedRepos: failures, errorKind: lastError ? classifyKind(lastError) : undefined };
  }

  private async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`;
    const cached = this.branchCache.get(key);
    if (cached) return cached;

    const json = await this.getJson(`${GITHUB_API_BASE}/repos/${owner}/${repo}`);
    const branch = isRecord(json) ? json.default_branch : undefined;
    if (typeof branch !== 'string' || branch.length === 0) {
      throw new DiscoveryCatalogError('unavailable', `No default branch for ${key}.`);
    }
    this.branchCache.set(key, branch);
    return branch;
  }

  private async getSkillMdPaths(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string[]> {
    const cacheKey = `${owner}/${repo}@${branch}`;
    const cached = this.treeCache.get(cacheKey);
    if (cached) return cached;

    const json = await this.getJson(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const tree = isRecord(json) && Array.isArray(json.tree) ? json.tree : [];
    const paths = tree
      .filter(
        (entry) =>
          isRecord(entry) &&
          entry.type === 'blob' &&
          typeof entry.path === 'string' &&
          entry.path.endsWith('/SKILL.md'),
      )
      .map((entry) => entry.path as string)
      .sort();
    this.treeCache.set(cacheKey, paths);
    return paths;
  }

  /** Fetch one SKILL.md via the raw API and parse its frontmatter into a
   * DiscoveredSkill. Returns null when the file is gone or not a valid Skill. */
  private async fetchSkillFrontmatter(
    owner: string,
    repo: string,
    branch: string,
    skillDir: string,
  ): Promise<DiscoveredSkill | null> {
    const segments = [owner, repo, branch, ...(skillDir ? skillDir.split('/') : [])]
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    let res: DiscoveryHttpResponse;
    try {
      res = await this.http(`${GITHUB_RAW_BASE}/${segments}/SKILL.md`, {});
    } catch (error) {
      throw classifyNetworkError(error);
    }
    if (res.status === 404) return null; // SKILL.md vanished — skip
    if (!res.ok) {
      throw new DiscoveryCatalogError('unavailable', `raw.githubusercontent.com error (${res.status}).`, res.status);
    }

    const { frontmatter, parseError } = parseFrontmatter(await res.text());
    if (parseError || !frontmatter) return null;
    const rawName = frontmatter.name;
    const rawDescription = frontmatter.description;
    if (
      typeof rawName !== 'string' ||
      rawName.trim().length === 0 ||
      typeof rawDescription !== 'string' ||
      rawDescription.trim().length === 0
    ) {
      return null;
    }

    const name = rawName.trim();
    const directory = skillDir.length > 0 ? lastSegment(skillDir) : name;
    const fetchedAt = this.now().toISOString();
    return {
      id: discoveryDedupeKey(`${owner}/${repo}`, directory),
      name,
      description: rawDescription.trim(),
      repository: `${owner}/${repo}`,
      directory,
      skillPath: skillDir.length > 0 ? skillDir : undefined,
      ref: branch,
      layers: ['backbone'],
      audit: { state: 'not audited', stale: false },
      fetchedAt,
      installSource: buildTreeSourceUrl(owner, repo, branch, skillDir),
    };
  }

  private async getJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    let res: DiscoveryHttpResponse;
    try {
      res = await this.http(url, { headers });
    } catch (error) {
      throw classifyNetworkError(error);
    }
    if (res.ok) {
      return res.json();
    }
    if (isRateLimited(res)) {
      throw new DiscoveryCatalogError('rate-limited', 'GitHub API rate limit reached.', res.status);
    }
    if (res.status === 404) {
      throw new DiscoveryCatalogError('unavailable', `GitHub resource not found (${res.status}).`, res.status);
    }
    throw new DiscoveryCatalogError('unavailable', `GitHub API error (${res.status}).`, res.status);
  }
}

// ─── Curated list loading ────────────────────────────────────────────────

/** Merge the built-in curated list with user extensions from app-home
 * `skills-backbone.json` (`{ "repositories": ["owner/repo", …] }`). The user
 * file is best-effort: malformed input must not break discovery. */
export async function loadBackboneRepositories(appHomePath: string): Promise<string[]> {
  const merged = [...CURATED_BACKBONE_REPOS];
  try {
    const filePath = path.join(appHomePath, 'skills-backbone.json');
    if (await fs.pathExists(filePath)) {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { repositories?: unknown };
      if (parsed && Array.isArray(parsed.repositories)) {
        for (const entry of parsed.repositories) {
          if (typeof entry === 'string') {
            const slug = entry.trim();
            if (slug.length > 0 && REPO_SLUG.test(slug)) {
              merged.push(slug);
            }
          }
        }
      }
    }
  } catch {
    // best-effort — an unreadable user list never fails the backbone layer
  }
  return [...new Set(merged)];
}

/** Borrow a local `gh` token for automatic auth on GitHub API calls (spec
 * §7.4). Returns null when gh is absent/unauthenticated. The token is held in
 * process memory only — never logged, never written. */
export async function borrowGhToken(
  options: { captureProcess?: CaptureProcess } = {},
): Promise<string | null> {
  const run = options.captureProcess ?? captureProcess;
  try {
    const result = await run('gh', ['auth', 'token'], {
      cwd: process.cwd(),
      shell: false,
      env: process.env,
      timeoutMs: 5000,
    });
    if (result.exitCode !== 0) return null;
    const token = result.stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null; // gh missing or errored — stay unauthenticated
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** A GitHub tree URL install source: the §7.3 adapter clones at `ref` and
 * selects `skillPath` (classifyRemoteSkillSource handles tree URLs). */
function buildTreeSourceUrl(
  owner: string,
  repo: string,
  branch: string,
  skillDir: string,
): string {
  const encodedDir = skillDir
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(branch)}${skillDir ? `/${encodedDir}` : ''}`;
}

function isRateLimited(res: DiscoveryHttpResponse): boolean {
  if (res.status !== 403 && res.status !== 429) return false;
  return res.headers.get('x-ratelimit-remaining') === '0';
}

export function classifyNetworkError(error: unknown): DiscoveryCatalogError {
  const message = error instanceof Error ? error.message : String(error);
  const kind: CatalogFailureKind = DISCOVERY_OFFLINE_PATTERNS.some((pattern) => pattern.test(message))
    ? 'offline'
    : 'unavailable';
  return new DiscoveryCatalogError(kind, message);
}

function classifyKind(error: unknown): CatalogFailureKind {
  return error instanceof DiscoveryCatalogError ? error.kind : 'unavailable';
}

