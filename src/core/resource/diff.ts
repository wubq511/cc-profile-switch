import { readAgentContent, listAgents } from './agent';
import { readUserMemoryContent } from './user-memory';
import { validateProfileName } from '../../platform/path';
import { countChanges, lineDiff, type DiffLine } from '../diff';

// ─── Line diff (canonical implementation: ../diff) ──────────────────────
// Re-exported so resource consumers keep a single import surface.

export { countChanges, lineDiff };
export type { DiffLine };
export type DiffCounts = { add: number; del: number };

// ─── User Memory diff ───────────────────────────────────────────────────

export type UserMemoryDiff = {
  profileA: string;
  profileB: string;
  lines: DiffLine[];
  aLineCount: number;
  bLineCount: number;
};

export async function diffUserMemory(
  appHomePath: string,
  profileA: string,
  profileB: string,
): Promise<UserMemoryDiff> {
  const safeA = validateProfileName(profileA);
  const safeB = validateProfileName(profileB);
  const [contentA, contentB] = await Promise.all([
    readUserMemoryContent(appHomePath, safeA),
    readUserMemoryContent(appHomePath, safeB),
  ]);
  const aLines = contentA === null ? [] : contentA.split('\n');
  const bLines = contentB === null ? [] : contentB.split('\n');

  return {
    profileA: safeA,
    profileB: safeB,
    lines: lineDiff(aLines, bLines),
    aLineCount: aLines.length,
    bLineCount: bLines.length,
  };
}

// ─── Agents diff ────────────────────────────────────────────────────────

export type AgentFileDiff = {
  name: string;
  verdict: 'same' | 'added' | 'removed' | 'changed';
  lines?: DiffLine[];
};

export type AgentsDiff = {
  profileA: string;
  profileB: string;
  files: AgentFileDiff[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  sameCount: number;
};

export async function diffAgents(
  appHomePath: string,
  profileA: string,
  profileB: string,
): Promise<AgentsDiff> {
  const safeA = validateProfileName(profileA);
  const safeB = validateProfileName(profileB);
  const [agentsA, agentsB] = await Promise.all([
    listAgents(appHomePath, safeA),
    listAgents(appHomePath, safeB),
  ]);

  const namesA = new Set(agentsA.map((a) => a.name));
  const namesB = new Set(agentsB.map((a) => a.name));
  const allNames = [...new Set([...namesA, ...namesB])].sort();

  const files: AgentFileDiff[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let sameCount = 0;

  for (const name of allNames) {
    const inA = namesA.has(name);
    const inB = namesB.has(name);

    if (!inA && inB) {
      files.push({ name, verdict: 'added' });
      addedCount++;
      continue;
    }
    if (inA && !inB) {
      files.push({ name, verdict: 'removed' });
      removedCount++;
      continue;
    }

    const [contentA, contentB] = await Promise.all([
      readAgentContent(appHomePath, safeA, name),
      readAgentContent(appHomePath, safeB, name),
    ]);
    const aLines = (contentA ?? '').split('\n');
    const bLines = (contentB ?? '').split('\n');

    if (aLines.every((l, idx) => bLines[idx] === l) && aLines.length === bLines.length) {
      files.push({ name, verdict: 'same' });
      sameCount++;
    } else {
      files.push({ name, verdict: 'changed', lines: lineDiff(aLines, bLines) });
      changedCount++;
    }
  }

  return {
    profileA: safeA,
    profileB: safeB,
    files,
    addedCount,
    removedCount,
    changedCount,
    sameCount,
  };
}
