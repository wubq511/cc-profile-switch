import type { ResourceReadFailure } from './read-state';

export type ResourceCategory = 'user-memory' | 'agents';

export type UserMemoryEntry = {
  kind: 'user-memory';
  name: string;
  relativePath: string;
  exists: boolean;
  lineCount: number;
  excerpt: string;
};

/**
 * Explicit read outcome for one resource category of one Profile (issue #110,
 * spec §7): `ok` carries the loaded details, `missing` an absent resource, and
 * `unreadable` a diagnostic for EISDIR/EACCES/format errors — a failed read
 * must never surface as a successful empty list. */
export type ResourceCategoryState =
  | { status: 'ok' }
  | ResourceReadFailure;

export type ResourceStates = {
  userMemory: ResourceCategoryState;
  agents: ResourceCategoryState;
};

export type AgentFrontmatter = {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  [key: string]: unknown;
};

export type AgentEntry = {
  kind: 'agents';
  name: string;
  relativePath: string;
  exists: true;
  frontmatter: AgentFrontmatter | null;
  frontmatterParseError: string | null;
  bodyExcerpt: string;
};

export type ResourceEntry = UserMemoryEntry | AgentEntry;

export type SearchResult = {
  profileName: string;
  category: ResourceCategory;
  itemName: string;
  relativePath: string;
  matchLine: string;
  lineNumber: number;
};
