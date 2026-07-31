// PROTOTYPE (throwaway) — minimal diff helpers for the diff prototype.
// No dependency, no polish: just enough to render the three variants.

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

// Classic LCS line diff. Good enough for fixture-sized inputs.
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

export function countChanges(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === 'add') add++;
    if (l.type === 'del') del++;
  }
  return { add, del };
}

export type KeyVerdict = 'same' | 'changed' | 'only-a' | 'only-b';

// Key-level diff over flattened records. Values are compared but the verdict
// never carries them — callers render key names only (redaction contract).
export function keyDiff(a: Record<string, string>, b: Record<string, string>): [string, KeyVerdict][] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.map((k) => {
    if (!(k in a)) return [k, 'only-b'];
    if (!(k in b)) return [k, 'only-a'];
    return [k, a[k] === b[k] ? 'same' : 'changed'];
  });
}

export type FileVerdict = 'same' | 'changed' | 'only-profile' | 'only-source';

// Hash-tree diff for a Copied Skill vs its live source.
export function fileDiff(
  profile: { path: string; hash: string }[],
  source: { path: string; hash: string }[],
): [string, FileVerdict][] {
  const paths = [...new Set([...profile.map((f) => f.path), ...source.map((f) => f.path)])].sort();
  const ph = new Map(profile.map((f) => [f.path, f.hash]));
  const sh = new Map(source.map((f) => [f.path, f.hash]));
  return paths.map((p) => {
    if (!ph.has(p)) return [p, 'only-source'];
    if (!sh.has(p)) return [p, 'only-profile'];
    return [p, ph.get(p) === sh.get(p) ? 'same' : 'changed'];
  });
}
