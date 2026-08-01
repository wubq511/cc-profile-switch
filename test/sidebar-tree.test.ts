import { describe, expect, it } from 'vitest';

import type { SearchResult } from '../src/core/resource/types';
import type { WorkbenchProfile } from '../src/tui/workbench/profile-data';
import {
  buildSidebarRows,
  SIDEBAR_CATEGORY_KEYS,
  type CategoryKey,
  type TreeRow,
} from '../src/tui/workbench/sidebar-tree';

const LABELS: Record<CategoryKey, string> = {
  userMemory: 'User Memory',
  autoMemory: 'Auto Memory',
  skills: 'Skills',
  agents: 'Agents',
  mcp: 'MCP',
  settings: 'Settings',
  launchConfig: 'Launch Config',
};

function makeProfile(overrides: Partial<WorkbenchProfile> = {}): WorkbenchProfile {
  return {
    name: 'alpha',
    description: 'coding profile',
    isDefault: false,
    isLastUsed: false,
    status: 'ready',
    resourceCounts: {
      userMemory: 1,
      autoMemory: 1,
      skills: 1,
      agents: 1,
      mcp: 1,
      settings: 2,
      launchConfig: 1,
    },
    resourceDetails: {
      userMemory: {
        kind: 'user-memory',
        name: 'CLAUDE.md',
        relativePath: 'CLAUDE.md',
        exists: true,
        lineCount: 10,
        excerpt: '',
      },
      agents: [
        {
          kind: 'agents',
          name: 'reviewer',
          relativePath: 'agents/reviewer.md',
          exists: true,
          frontmatter: null,
          frontmatterParseError: null,
          bodyExcerpt: '',
        },
      ],
      skills: ['pdf'],
      autoMemory: ['2026-08-01.md'],
      settings: ['model', 'env'],
    },
    mcpServers: ['github'],
    validation: null,
    ...overrides,
  };
}

function makeHit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    profileName: 'alpha',
    category: 'user-memory',
    itemName: 'CLAUDE.md',
    relativePath: 'CLAUDE.md',
    matchLine: 'remember the deployment runbook',
    lineNumber: 4,
    ...overrides,
  };
}

function rows(
  profiles: WorkbenchProfile[],
  opts: { expanded?: string[]; query?: string; contentHits?: SearchResult[] } = {},
): TreeRow[] {
  return buildSidebarRows({
    profiles,
    expanded: new Set(opts.expanded ?? []),
    query: opts.query ?? '',
    categoryLabels: LABELS,
    contentHits: opts.contentHits ?? [],
  });
}

function kinds(list: TreeRow[]): string[] {
  return list.map((r) => r.kind);
}

describe('SIDEBAR_CATEGORY_KEYS', () => {
  it('mirrors the main-pane card grid order', () => {
    expect(SIDEBAR_CATEGORY_KEYS).toEqual([
      'userMemory',
      'autoMemory',
      'skills',
      'agents',
      'mcp',
      'settings',
      'launchConfig',
    ]);
  });
});

describe('buildSidebarRows with an empty query', () => {
  it('lists only profile rows when nothing is expanded', () => {
    const result = rows([makeProfile(), makeProfile({ name: 'beta' })]);
    expect(kinds(result)).toEqual(['profile', 'profile']);
    expect(result[0]).toMatchObject({ profileName: 'alpha', depth: 0 });
  });

  it('expands a profile into category and item rows', () => {
    const result = rows([makeProfile()], { expanded: ['alpha'] });
    expect(kinds(result)).toEqual([
      'profile',
      'category', 'item', // userMemory → CLAUDE.md
      'category', 'item', // autoMemory
      'category', 'item', // skills
      'category', 'item', // agents
      'category', 'item', // mcp
      'category', 'item', 'item', // settings (2 keys)
      'category', // launchConfig has no items
    ]);
    expect(result[1]).toMatchObject({ kind: 'category', categoryKey: 'userMemory', depth: 1 });
    expect(result[2]).toMatchObject({ kind: 'item', categoryKey: 'userMemory', itemName: 'CLAUDE.md', depth: 2 });
  });

  it('keeps other profiles collapsed', () => {
    const result = rows([makeProfile(), makeProfile({ name: 'beta' })], { expanded: ['beta'] });
    expect(result[0]).toMatchObject({ kind: 'profile', profileName: 'alpha' });
    expect(result[result.length - 1]).toMatchObject({ profileName: 'beta' });
    expect(result.filter((r) => r.kind === 'category').every((r) => r.profileName === 'beta')).toBe(true);
  });
});

describe('buildSidebarRows with a query', () => {
  it('matches profile names case-insensitively and auto-expands the full subtree', () => {
    const result = rows([makeProfile(), makeProfile({ name: 'beta' })], { query: 'ALP' });
    expect(result[0]).toMatchObject({ kind: 'profile', profileName: 'alpha' });
    expect(result.some((r) => r.kind === 'category' && r.profileName === 'alpha')).toBe(true);
    expect(result.some((r) => r.kind === 'item' && r.profileName === 'alpha')).toBe(true);
    expect(result.every((r) => r.profileName === 'alpha')).toBe(true);
  });

  it('matches profile descriptions', () => {
    const result = rows([makeProfile(), makeProfile({ name: 'beta', description: 'docs' })], { query: 'coding' });
    expect(result.every((r) => r.profileName === 'alpha')).toBe(true);
  });

  it('matches category labels and shows only the matched category subtree', () => {
    const result = rows([makeProfile()], { query: 'skills' });
    expect(kinds(result)).toEqual(['profile', 'category', 'item']);
    expect(result[1]).toMatchObject({ categoryKey: 'skills' });
    expect(result[2]).toMatchObject({ itemName: 'pdf' });
  });

  it('matches item names and shows only matched items under their category', () => {
    const profile = makeProfile({
      resourceDetails: {
        ...makeProfile().resourceDetails,
        agents: [
          { kind: 'agents', name: 'reviewer', relativePath: 'agents/reviewer.md', exists: true, frontmatter: null, frontmatterParseError: null, bodyExcerpt: '' },
          { kind: 'agents', name: 'planner', relativePath: 'agents/planner.md', exists: true, frontmatter: null, frontmatterParseError: null, bodyExcerpt: '' },
        ],
      },
    });
    const result = rows([profile], { query: 'review' });
    expect(kinds(result)).toEqual(['profile', 'category', 'item']);
    expect(result[2]).toMatchObject({ itemName: 'reviewer' });
  });

  it('matches MCP server names as items', () => {
    const result = rows([makeProfile()], { query: 'github' });
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ categoryKey: 'mcp' });
    expect(result[2]).toMatchObject({ itemName: 'github' });
  });

  it('matches settings keys as items', () => {
    const result = rows([makeProfile()], { query: 'model' });
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ categoryKey: 'settings' });
    expect(result[2]).toMatchObject({ itemName: 'model' });
  });

  it('surfaces cross-profile content hits as auto-expanded hit rows', () => {
    const hit = makeHit({ profileName: 'beta' });
    const result = rows([makeProfile(), makeProfile({ name: 'beta' })], {
      query: 'runbook',
      contentHits: [hit],
    });
    expect(kinds(result)).toEqual(['profile', 'category', 'content-hit']);
    expect(result[0]).toMatchObject({ profileName: 'beta' });
    expect(result[1]).toMatchObject({ categoryKey: 'userMemory' });
    expect(result[2]).toMatchObject({ kind: 'content-hit', hit, depth: 2 });
  });

  it('maps agents content hits to the agents category row', () => {
    const hit = makeHit({ category: 'agents', itemName: 'reviewer' });
    const result = rows([makeProfile()], { query: 'runbook', contentHits: [hit] });
    expect(result[1]).toMatchObject({ categoryKey: 'agents' });
  });

  it('shows name-matched items alongside content hits in the same category', () => {
    const hit = makeHit({ matchLine: 'note about the pdf skill' });
    const result = rows([makeProfile()], { query: 'pdf', contentHits: [hit] });
    // skills item 'pdf' matches by name; userMemory contributes a content hit.
    expect(result.some((r) => r.kind === 'item' && r.categoryKey === 'skills')).toBe(true);
    expect(result.some((r) => r.kind === 'content-hit' && r.categoryKey === 'userMemory')).toBe(true);
  });

  it('keeps content hits visible when the profile name itself matches', () => {
    const hit = makeHit();
    const result = rows([makeProfile()], { query: 'alpha', contentHits: [hit] });
    expect(result[0]).toMatchObject({ kind: 'profile', profileName: 'alpha' });
    expect(result.some((r) => r.kind === 'content-hit' && r.categoryKey === 'userMemory')).toBe(true);
  });

  it('returns no rows when nothing matches', () => {
    expect(rows([makeProfile()], { query: 'zzz-nothing' })).toEqual([]);
  });

  it('treats a whitespace-only query as empty', () => {
    const result = rows([makeProfile()], { query: '   ', expanded: ['alpha'] });
    expect(result[0]).toMatchObject({ kind: 'profile' });
    expect(result.length).toBeGreaterThan(1);
  });
});
