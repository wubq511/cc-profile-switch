export type ResourceCategory = 'user-memory' | 'agents';

export type UserMemoryEntry = {
  kind: 'user-memory';
  name: string;
  relativePath: string;
  exists: boolean;
  lineCount: number;
  excerpt: string;
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
