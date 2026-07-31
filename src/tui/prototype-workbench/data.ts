// PROTOTYPE (throwaway) — mock data for the Workbench navigation prototype.
// Ticket: "Prototype the Profile Workbench navigation model" (issue #25).
// Domain language follows CONTEXT.md. No persistence, no real filesystem access.

export interface SkillEntry {
  name: string;
  kind: 'copied' | 'linked';
  source?: string;
}
export interface AgentEntry {
  name: string;
  description: string;
}
export interface McpEntry {
  name: string;
  transport: 'stdio' | 'http';
  status: 'connected' | 'failed';
}
export interface PluginEntry {
  name: string;
  enabled: boolean;
}

export interface ProfileResources {
  userMemory: { lines: number; excerpt: string };
  autoMemory: { files: number; lastUpdated: string };
  skills: SkillEntry[];
  agents: AgentEntry[];
  mcp: McpEntry[];
  settings: { model: string; envKeys: number };
  plugins: PluginEntry[];
}

export interface Profile {
  name: string;
  description: string;
  isDefault?: boolean;
  lastUsed: string;
  projects: number;
  resources: ProfileResources;
}

export const CATEGORIES = [
  'User Memory',
  'Auto Memory',
  'Skills',
  'Agents',
  'MCP',
  'Settings',
  'Plugins',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface ItemEntry {
  label: string;
  detail: string;
}

export function categoryCount(p: Profile, c: Category): string {
  const r = p.resources;
  switch (c) {
    case 'User Memory':
      return `${r.userMemory.lines} lines`;
    case 'Auto Memory':
      return `${r.autoMemory.files} files`;
    case 'Skills':
      return `${r.skills.length}`;
    case 'Agents':
      return `${r.agents.length}`;
    case 'MCP':
      return `${r.mcp.length}`;
    case 'Settings':
      return `${r.settings.envKeys} env keys`;
    case 'Plugins':
      return `${r.plugins.length}`;
  }
}

export function categoryItems(p: Profile, c: Category): ItemEntry[] {
  const r = p.resources;
  switch (c) {
    case 'User Memory':
      return [
        { label: 'CLAUDE.md', detail: `${r.userMemory.lines} lines — ${r.userMemory.excerpt}` },
      ];
    case 'Auto Memory':
      return [
        { label: 'MEMORY.md', detail: `auto memory index — updated ${r.autoMemory.lastUpdated}` },
        { label: `${r.autoMemory.files - 1} topic files`, detail: 'memory/auto/…' },
      ];
    case 'Skills':
      return r.skills.map((s) => ({
        label: s.name,
        detail:
          s.kind === 'linked' ? `linked → ${s.source ?? 'local source'}` : 'copied (profile-owned)',
      }));
    case 'Agents':
      return r.agents.map((a) => ({ label: a.name, detail: a.description }));
    case 'MCP':
      return r.mcp.map((m) => ({
        label: m.name,
        detail: `${m.transport} — ${m.status}`,
      }));
    case 'Settings':
      return [
        { label: 'model', detail: r.settings.model },
        { label: 'env', detail: `${r.settings.envKeys} keys` },
        { label: 'rules/ccps-profile.md', detail: 'managed boundary rule' },
      ];
    case 'Plugins':
      return r.plugins.map((pl) => ({
        label: pl.name,
        detail: pl.enabled ? 'enabled (Claude-managed)' : 'disabled (Claude-managed)',
      }));
  }
}

export function itemPreview(p: Profile, c: Category, itemIdx: number): string[] {
  const item = categoryItems(p, c)[itemIdx];
  if (!item) return ['(nothing selected)'];
  const lines = [
    `${c} › ${item.label}`,
    `profile: ${p.name}`,
    '',
    item.detail,
    '',
    ...(c === 'User Memory' ? ['excerpt:', `  ${p.resources.userMemory.excerpt}`] : []),
    ...(c === 'Skills' && p.resources.skills[itemIdx]
      ? [
          `kind: ${p.resources.skills[itemIdx].kind}`,
          p.resources.skills[itemIdx].source
            ? `source: ${p.resources.skills[itemIdx].source}`
            : 'source: (profile-owned copy)',
        ]
      : []),
  ];
  return lines;
}

function mkProfile(
  name: string,
  description: string,
  opts: {
    isDefault?: boolean;
    lastUsed?: string;
    projects?: number;
    skills?: SkillEntry[];
    agents?: AgentEntry[];
    mcp?: McpEntry[];
    plugins?: PluginEntry[];
    memoryLines?: number;
    autoFiles?: number;
    model?: string;
    envKeys?: number;
    excerpt?: string;
  } = {},
): Profile {
  return {
    name,
    description,
    isDefault: opts.isDefault,
    lastUsed: opts.lastUsed ?? '—',
    projects: opts.projects ?? 0,
    resources: {
      userMemory: {
        lines: opts.memoryLines ?? 12,
        excerpt: opts.excerpt ?? 'Prefer explicit answers. Keep diffs small.',
      },
      autoMemory: { files: opts.autoFiles ?? 3, lastUpdated: '2026-07-28' },
      skills: opts.skills ?? [],
      agents: opts.agents ?? [],
      mcp: opts.mcp ?? [],
      settings: { model: opts.model ?? 'claude-opus-4-7', envKeys: opts.envKeys ?? 2 },
      plugins: opts.plugins ?? [{ name: 'superpowers', enabled: true }],
    },
  };
}

const skill = (name: string, kind: 'copied' | 'linked' = 'copied', source?: string): SkillEntry => ({
  name,
  kind,
  source,
});

export const smallInventory: Profile[] = [
  mkProfile('coding', 'Daily Claude Code development', {
    isDefault: true,
    lastUsed: 'today 09:41',
    projects: 14,
    memoryLines: 46,
    autoFiles: 9,
    skills: [
      skill('wayfinder'),
      skill('grilling'),
      skill('tdd'),
      skill('diagnosing-bugs', 'linked', '~/oss/my-skills/diagnosing-bugs'),
      skill('code-review'),
    ],
    agents: [
      { name: 'explore', description: 'read-only codebase exploration' },
      { name: 'coder', description: 'general software engineering' },
    ],
    mcp: [
      { name: 'github', transport: 'http', status: 'connected' },
      { name: 'codegraph', transport: 'stdio', status: 'connected' },
    ],
    plugins: [
      { name: 'superpowers', enabled: true },
      { name: 'commit-commands', enabled: false },
    ],
    excerpt: '结论先行。不要谄媚。',
  }),
  mkProfile('writing', 'Long-form writing and research', {
    lastUsed: 'yesterday',
    projects: 3,
    memoryLines: 31,
    autoFiles: 5,
    skills: [skill('research'), skill('neat-freak')],
    agents: [{ name: 'editor', description: 'prose review passes' }],
    mcp: [{ name: 'fetch', transport: 'stdio', status: 'connected' }],
    excerpt: '中文写作，少用连接词。',
  }),
  mkProfile('experiments', 'Scratch profile for trying things', {
    lastUsed: '2026-07-02',
    projects: 1,
    skills: [skill('prototype', 'linked', '~/oss/my-skills/prototype')],
    mcp: [{ name: 'playwright', transport: 'stdio', status: 'failed' }],
    model: 'claude-sonnet-4-6',
  }),
];

const largeNames = [
  'coding',
  'writing',
  'personal',
  'client-acme',
  'client-acme-api',
  'client-nimbus',
  'oss-react',
  'oss-vite',
  'oss-kimi',
  'docs-site',
  'infra-terraform',
  'data-pipeline',
  'ml-training',
  'ml-eval',
  'mobile-ios',
  'mobile-android',
  'web-storefront',
  'web-admin',
  'api-gateway',
  'billing',
  'auth-service',
  'search-service',
  'notifications',
  'analytics',
  'design-system',
  'marketing-site',
  'blog',
  'newsletter',
  'freelance-a',
  'freelance-b',
  'interview-prep',
  'learning-rust',
  'learning-go',
  'home-lab',
  'dotfiles',
  'ci-experiments',
  'security-audits',
  'perf-lab',
  'archived-2024',
  'archived-2025',
  'scratch',
  'demo-talks',
];

const skillPool = [
  'wayfinder',
  'grilling',
  'tdd',
  'code-review',
  'research',
  'prototype',
  'domain-modeling',
  'diagnosing-bugs',
  'neat-freak',
  'health',
  'leader',
  'ui',
  'playwright',
  'skill-creator',
  'resolving-merge-conflicts',
];

export const largeInventory: Profile[] = largeNames.map((name, i) =>
  mkProfile(
    name,
    i === 0
      ? 'Daily Claude Code development'
      : `Profile for ${name.replace(/-/g, ' ')} work`,
    {
      isDefault: i === 0,
      lastUsed: i < 3 ? 'this week' : i < 12 ? 'last week' : `${(i % 9) + 1} months ago`,
      projects: (i * 7) % 23,
      memoryLines: 10 + ((i * 13) % 80),
      autoFiles: 2 + ((i * 5) % 14),
      skills: Array.from({ length: (i * 3) % 14 }, (_, k) =>
        skill(
          skillPool[(i + k) % skillPool.length],
          (i + k) % 4 === 0 ? 'linked' : 'copied',
          (i + k) % 4 === 0 ? `~/oss/my-skills/${skillPool[(i + k) % skillPool.length]}` : undefined,
        ),
      ),
      agents:
        i % 3 === 0
          ? [{ name: 'explore', description: 'read-only codebase exploration' }]
          : [],
      mcp:
        i % 4 === 0
          ? [
              { name: 'github', transport: 'http', status: 'connected' },
              { name: 'codegraph', transport: 'stdio', status: i % 8 === 0 ? 'failed' : 'connected' },
            ]
          : i % 4 === 1
            ? [{ name: 'fetch', transport: 'stdio', status: 'connected' }]
            : [],
      envKeys: 1 + (i % 4),
      model: i % 5 === 0 ? 'claude-sonnet-4-6' : 'claude-opus-4-7',
    },
  ),
);

// ---- cross-profile search ----

export interface SearchEntry {
  kind: 'profile' | 'item';
  label: string;
  detail: string;
  profileIdx: number;
  categoryIdx: number; // -1 for profile-level
  itemIdx: number; // -1 for profile/category-level
  profile: string;
  category: Category | null;
}

export function buildIndex(profiles: Profile[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  profiles.forEach((p, pi) => {
    out.push({
      kind: 'profile',
      label: p.name,
      detail: p.description,
      profileIdx: pi,
      categoryIdx: -1,
      itemIdx: -1,
      profile: p.name,
      category: null,
    });
    CATEGORIES.forEach((c, ci) => {
      categoryItems(p, c).forEach((it, ii) => {
        out.push({
          kind: 'item',
          label: it.label,
          detail: it.detail,
          profileIdx: pi,
          categoryIdx: ci,
          itemIdx: ii,
          profile: p.name,
          category: c,
        });
      });
    });
  });
  return out;
}

export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let qi = 0;
  let streak = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      qi++;
      streak++;
      score += 1 + streak;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

export function searchIndex(index: SearchEntry[], query: string, limit = 15): SearchEntry[] {
  if (!query.trim()) return [];
  return index
    .map((e) => ({
      e,
      s:
        fuzzyScore(query, e.label) * 2 +
        Math.max(0, fuzzyScore(query, e.profile)) +
        Math.max(0, fuzzyScore(query, e.detail) / 2) +
        (e.kind === 'profile' ? 3 : 0),
    }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.e);
}
