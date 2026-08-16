// Deterministic helpers for the Profile fixture generator (issue #77).
//
// The generator must produce byte-identical fixture trees across Windows,
// macOS, and Linux from the same seed + size parameters. Everything that feeds
// the materialized tree flows through a seeded PRNG and a canonical serializer
// declared here, so no platform-specific or time-based source can leak in.

// mulberry32: a small, fast, deterministic 32-bit PRNG. Same seed -> same
// sequence on every platform and Node version. Good enough distribution for
// fixture content; not cryptographic.
export function createPrng(seed: number): () => number {
  let state = seed >>> 0;

  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = {
  next(): number;
  nextInt(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  nextString(length: number, alphabet: string): string;
};

export function createRng(seed: number): Rng {
  const next = createPrng(seed);

  const nextInt = (minInclusive: number, maxExclusive: number): number => {
    if (maxExclusive <= minInclusive) {
      return minInclusive;
    }
    const span = maxExclusive - minInclusive;
    return minInclusive + Math.floor(next() * span);
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new Error('pick() called on an empty array');
    }
    return items[nextInt(0, items.length)]!;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = nextInt(0, i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };

  const nextString = (length: number, alphabet: string): string => {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += alphabet[nextInt(0, alphabet.length)];
    }
    return out;
  };

  return { next, nextInt, pick, shuffle, nextString };
}

// Canonical JSON serializer: object keys are sorted recursively, arrays keep
// their order, output uses 2-space indentation and a trailing newline. This
// makes a serialized plan byte-identical regardless of insertion order or the
// platform producing it. It is used both to write fixture JSON files (so the
// materialized tree is byte-identical across platforms) and to serialize the
// plan itself for the golden cross-platform check.
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

// Zero-pad an index to a fixed width so directory/file names sort
// lexicographically in the same order as numeric order across all platforms.
export function padIndex(index: number, width: number): string {
  return index.toString().padStart(width, '0');
}

// Width required to zero-pad the largest 1-based index of a count.
export function widthFor(count: number): number {
  return Math.max(3, String(count).length);
}
