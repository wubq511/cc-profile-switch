// Shared fake HTTP for skills-discovery tests (spec §7.4, issue #68).
//
// A minimal DiscoveryHttp responder routing by URL substring, so core tests
// never touch the real GitHub or skills.sh APIs.

import type { DiscoveryHttp, DiscoveryHttpResponse } from '../../src/core/skills-discovery';

export class FakeResponse implements DiscoveryHttpResponse {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    private readonly headerMap: Record<string, string> = {},
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  headers = {
    get: (name: string): string | null => this.headerMap[name.toLowerCase()] ?? null,
  };

  async json(): Promise<unknown> {
    return this.body;
  }

  async text(): Promise<string> {
    return typeof this.body === 'string' ? this.body : JSON.stringify(this.body);
  }
}

type Handler = (url: string) => DiscoveryHttpResponse | undefined;

/** Route a DiscoveryHttp by URL substring; unmatched URLs → 404. A tuple
 * route matches when the substring appears at a path boundary (followed by the
 * URL end, `?`, or `#`) so `/repos/o/r` does not also match
 * `/repos/o/r/git/trees/…`. Route strings must not include the `?`. */
export function makeHttp(handlers: Array<Handler | [string, DiscoveryHttpResponse]>): {
  http: DiscoveryHttp;
  calls: string[];
} {
  const calls: string[] = [];
  const compiled = handlers.map((h): Handler =>
    Array.isArray(h)
      ? (url) => {
          const idx = url.indexOf(h[0]);
          if (idx === -1) return undefined;
          const rest = url.slice(idx + h[0].length);
          const boundary = rest.length === 0 || rest.startsWith('?') || rest.startsWith('#');
          return boundary ? h[1] : undefined;
        }
      : h,
  );
  const http: DiscoveryHttp = async (url, init) => {
    calls.push(url);
    void init;
    for (const handler of compiled) {
      const res = handler(url);
      if (res) return res;
    }
    return new FakeResponse(404, { message: 'Not Found' });
  };
  return { http, calls };
}

export function apiRepo(owner: string, repo: string, branch = 'main'): FakeResponse {
  return new FakeResponse(200, { default_branch: branch });
}

export function apiTree(paths: string[]): FakeResponse {
  return new FakeResponse(200, { tree: paths.map((p) => ({ path: p, type: 'blob' })) });
}

export function rawSkill(name: string, description: string, body = '# body'): FakeResponse {
  return new FakeResponse(200, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
}

export function repoSearchJson(fullNames: string[]): FakeResponse {
  return new FakeResponse(200, {
    total_count: fullNames.length,
    items: fullNames.map((f) => ({ full_name: f })),
  });
}

export function codeSearchJson(items: Array<{ repo: string; path: string }>): FakeResponse {
  return new FakeResponse(200, {
    items: items.map((i) => ({ repository: { full_name: i.repo }, path: i.path })),
  });
}

export function skillshubSearch(items: unknown[]): FakeResponse {
  return new FakeResponse(200, {
    query: 'git',
    searchType: 'fuzzy',
    skills: items,
    count: items.length,
  });
}

/** A single skills.sh search result item. */
export function shubItem(opts: {
  id: string;
  skillId?: string;
  name?: string;
  source?: string;
  installs?: number;
  trending?: boolean;
}): Record<string, unknown> {
  const parts = opts.id.split('/');
  const source = opts.source ?? parts.slice(0, -1).join('/');
  const skillId = opts.skillId ?? parts[parts.length - 1];
  return {
    id: opts.id,
    skillId,
    name: opts.name ?? skillId,
    source,
    ...(opts.installs !== undefined ? { installs: opts.installs } : {}),
    ...(opts.trending !== undefined ? { trending: opts.trending } : {}),
  };
}
