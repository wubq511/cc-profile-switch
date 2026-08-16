import fs from 'fs-extra';

import { getAppHomePaths } from '../app-config';
import { validateProfileName } from '../../platform/path';
import { readUserMemoryContent } from './user-memory';
import { listAgents, readAgentContent } from './agent';
import type { SearchResult } from './types';

export type SearchOptions = {
  appHomePath?: string;
  query: string;
  profileNames?: string[];
  limit?: number;
};

const DEFAULT_LIMIT = 50;

export async function searchUserMemory(
  options: SearchOptions,
): Promise<SearchResult[]> {
  const { appHomePath, query, profileNames, limit } = resolveOptions(options);
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const names = await resolveProfileNames(appHomePath, profileNames);
  const hits: SearchResult[] = [];

  for (const name of names) {
    const content = await readUserMemoryContent(appHomePath, name);
    if (content === null) continue;
    collectLineHits(content, 'user-memory', 'CLAUDE.md', 'claude-home/CLAUDE.md', name, q, hits, limit);
    if (hits.length >= limit) break;
  }

  return hits.slice(0, limit);
}

export async function searchAgents(options: SearchOptions): Promise<SearchResult[]> {
  const { appHomePath, query, profileNames, limit } = resolveOptions(options);
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const names = await resolveProfileNames(appHomePath, profileNames);
  const hits: SearchResult[] = [];

  for (const name of names) {
    const agents = await listAgents(appHomePath, name);
    for (const agent of agents) {
      const content = await readAgentContent(appHomePath, name, agent.name);
      if (content === null) continue;
      collectLineHits(
        content,
        'agents',
        agent.name,
        agent.relativePath,
        name,
        q,
        hits,
        limit,
      );
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }

  return hits.slice(0, limit);
}

export async function searchAllResources(options: SearchOptions): Promise<SearchResult[]> {
  const [memoryHits, agentHits] = await Promise.all([
    searchUserMemory(options),
    searchAgents(options),
  ]);

  // Deduplicate by profile+category+item+line, prefer user-memory first
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const hit of [...memoryHits, ...agentHits]) {
    const key = `${hit.profileName}:${hit.category}:${hit.relativePath}:${hit.lineNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged;
}

// ─── Internal helpers ───────────────────────────────────────────────────

function resolveOptions(options: SearchOptions): Required<
  Pick<SearchOptions, 'appHomePath' | 'query' | 'limit'>
> & { profileNames: string[] | undefined } {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  return {
    appHomePath,
    query: options.query,
    profileNames: options.profileNames,
    limit: options.limit ?? DEFAULT_LIMIT,
  };
}

async function resolveProfileNames(
  appHomePath: string,
  requested: string[] | undefined,
): Promise<string[]> {
  if (requested !== undefined) {
    return requested.map((n) => validateProfileName(n));
  }

  const { profilesPath } = getAppHomePaths(appHomePath);
  if (!(await fs.pathExists(profilesPath))) {
    return [];
  }

  const entries = await fs.readdir(profilesPath, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function collectLineHits(
  content: string,
  category: 'user-memory' | 'agents',
  itemName: string,
  relativePath: string,
  profileName: string,
  query: string,
  hits: SearchResult[],
  limit: number,
): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i];
    if (line.toLowerCase().includes(query)) {
      hits.push({
        profileName,
        category,
        itemName,
        relativePath,
        matchLine: line.trim(),
        lineNumber: i + 1,
      });
    }
  }
}
