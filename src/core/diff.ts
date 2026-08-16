/**
 * Production diff infrastructure for Settings and Launch Configuration resources.
 *
 * Settings diff: key-level table with ≠/+/- verdicts, values never rendered (redaction contract).
 * Launch config diff: key-level table with values shown, inline warnings on sensitive fields.
 *
 * Promoted from prototype-diff/diffUtil.ts; that file remains for the prototype UI.
 */

// ─── Line diff (User Memory / Agents) ────────────────────────────────────

export type DiffLine = {
  type: 'same' | 'add' | 'del';
  text: string;
};

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

// ─── Key-level diff ──────────────────────────────────────────────────────

export type KeyVerdict = 'same' | 'changed' | 'only-a' | 'only-b';

/** Verdict symbol for display: ≠ changed, + only in B, - only in A, (blank) same. */
export function verdictSymbol(verdict: KeyVerdict): string {
  switch (verdict) {
    case 'changed':
      return '≠';
    case 'only-a':
      return '-';
    case 'only-b':
      return '+';
    case 'same':
      return ' ';
  }
}

/**
 * Key-level diff over flattened records.
 * Values are compared (deep) but the verdict never carries them — callers render key names only
 * (redaction contract for Settings).
 */
export function keyDiff(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): KeyDiffEntry[] {
  return walkKeyedRecords(a, b).map(({ key, verdict }) => ({ key, verdict }));
}

/** Shared key-verdict walk over two flat records (deep value comparison). */
function walkKeyedRecords(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): { key: string; verdict: KeyVerdict; inA: boolean; valueA?: unknown; valueB?: unknown }[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.map((k) => {
    const inA = k in a;
    const inB = k in b;
    let verdict: KeyVerdict;
    if (!inA) verdict = 'only-b';
    else if (!inB) verdict = 'only-a';
    else verdict = deepEqual(a[k], b[k]) ? 'same' : 'changed';
    return { key: k, verdict, inA, valueA: inA ? a[k] : undefined, valueB: inB ? b[k] : undefined };
  });
}

export type KeyDiffEntry = {
  key: string;
  verdict: KeyVerdict;
};

// ─── Settings diff ───────────────────────────────────────────────────────

export type SettingsDiffEntry = {
  key: string;
  verdict: KeyVerdict;
};

/**
 * Diff two settings.json objects as flattened key paths.
 * Returns key-level entries with verdicts only — values are never included (redaction contract).
 */
export function diffSettings(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): SettingsDiffEntry[] {
  const flatA = flattenToKeyPaths(a);
  const flatB = flattenToKeyPaths(b);
  return keyDiff(flatA, flatB);
}

// ─── Launch config diff ──────────────────────────────────────────────────

/** Fields that carry security implications when changed. */
export const SENSITIVE_LAUNCH_FIELDS = new Set(['skipPermissions', 'claudeArgs']);

export type LaunchConfigDiffEntry = {
  key: string;
  verdict: KeyVerdict;
  /** Value from profile A (undefined if only in B). Shown for launch config (not secret). */
  valueA?: unknown;
  /** Value from profile B (undefined if only in A). Shown for launch config (not secret). */
  valueB?: unknown;
  /** True if this field is security-sensitive and the value changed. */
  sensitive: boolean;
};

/**
 * Diff two launch configuration objects.
 * Unlike Settings diff, values are included (launch config is not secret-class).
 * Security-sensitive fields (skipPermissions, claudeArgs) are flagged.
 */
export function diffLaunchConfig(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): LaunchConfigDiffEntry[] {
  return walkKeyedRecords(a, b).map(({ key, verdict, valueA, valueB }) => ({
    key,
    verdict,
    valueA,
    valueB,
    // Add/remove counts as a change for security-sensitive fields (spec §12).
    sensitive: SENSITIVE_LAUNCH_FIELDS.has(key) && verdict !== 'same',
  }));
}

// ─── File-tree diff (Skills vs source) ───────────────────────────────────

export type FileVerdict = 'same' | 'changed' | 'only-profile' | 'only-source';

export type FileDiffEntry = {
  path: string;
  verdict: FileVerdict;
};

export function fileDiff(
  profile: { path: string; hash: string }[],
  source: { path: string; hash: string }[],
): FileDiffEntry[] {
  const paths = [...new Set([...profile.map((f) => f.path), ...source.map((f) => f.path)])].sort();
  const ph = new Map(profile.map((f) => [f.path, f.hash]));
  const sh = new Map(source.map((f) => [f.path, f.hash]));
  return paths.map((p) => {
    if (!ph.has(p)) return { path: p, verdict: 'only-source' as const };
    if (!sh.has(p)) return { path: p, verdict: 'only-profile' as const };
    return { path: p, verdict: ph.get(p) === sh.get(p) ? ('same' as const) : ('changed' as const) };
  });
}

// ─── Flatten helpers ─────────────────────────────────────────────────────

/** Deep structural equality for diff value comparison (arrays, nested objects). */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }

  if (Array.isArray(left) !== Array.isArray(right)) return false;

  if (Array.isArray(left)) {
    const a = left as unknown[];
    const b = right as unknown[];
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aKeys = Object.keys(left as Record<string, unknown>);
  const bKeys = Object.keys(right as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(right as Record<string, unknown>, key) &&
      deepEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

/**
 * Flatten a nested object into dot-separated key paths.
 * Example: { env: { ANTHROPIC_API_KEY: "x" } } → { "env.ANTHROPIC_API_KEY": "x" }
 * Non-object leaf values are kept as-is; arrays are kept as-is (not recursed).
 */
export function flattenToKeyPaths(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenToKeyPaths(value as Record<string, unknown>, path));
    } else {
      result[path] = value;
    }
  }
  return result;
}

// ─── Nested value helpers (clone semantics) ──────────────────────────────
// Shared by the Settings resource service for atomic edits: the read object is
// never mutated in place; each helper returns a shallow-cloned copy along the
// touched path so the caller can write the result atomically.

export function getNestedValue(obj: unknown, keyPath: string): unknown {
  const keys = keyPath.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): Record<string, unknown> {
  const result = { ...obj };
  const keys = keyPath.split('.');
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = current[keys[i]];
    if (next === null || next === undefined || typeof next !== 'object') {
      current[keys[i]] = {};
    } else {
      current[keys[i]] = { ...(next as Record<string, unknown>) };
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return result;
}

export function deleteNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
): Record<string, unknown> {
  const result = { ...obj };
  const keys = keyPath.split('.');
  let current: unknown = result;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return result;
    }
    const key = keys[i];
    const next = (current as Record<string, unknown>)[key];
    if (typeof next === 'object' && next !== null) {
      (current as Record<string, unknown>)[key] = { ...(next as Record<string, unknown>) };
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (current !== null && current !== undefined && typeof current === 'object') {
    delete (current as Record<string, unknown>)[keys[keys.length - 1]];
  }
  return result;
}
