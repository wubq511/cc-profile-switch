import { readAgentContent, listAgents } from './agent';
import { readUserMemoryContent } from './user-memory';
import { validateProfileName } from '../../platform/path';

// ─── DiffLine (from prototype-diff/diffUtil.ts, promoted to production) ─

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };
export type DiffCounts = { add: number; del: number };

/**
 * Classic LCS line diff. Returns an array of lines tagged as same/add/del.
 */
export function lineDiff(a: string[], b: string[]): DiffLine[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
}

export function countChanges(lines: DiffLine[]): DiffCounts {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === 'add') add++;
    if (l.type === 'del') del++;
  }
  return { add, del };
}

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
