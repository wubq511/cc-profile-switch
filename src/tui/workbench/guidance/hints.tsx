// Contextual hint retirement (issue #76).
//
// Hints attach to a focused element (the selected Profile) and retire once the
// key they teach has been used HINT_RETIRE_AFTER times. Use counts persist in
// state.json (hintUsage), so retirement is permanent across sessions and
// steady state converges to near-minimal as the user learns. Persistence is
// wired from the outside: the Workbench entry (index.mts) seeds `initialUsage`
// from state.json and persists each use through `onMarkUsed`; without those
// props the provider degrades to session-only tracking (tests).

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

export const HINT_RETIRE_AFTER = 3;

export type HintsApi = {
  /** Record one use of a key; the hint for that key retires on the Nth use. */
  markUsed: (key: string) => void;
  /** True when the key's hint should no longer be shown. */
  isRetired: (key: string) => boolean;
  /** Filter a key list down to the ones that still have a live hint. */
  liveKeys: (keys: readonly string[]) => string[];
};

const HintsContext = createContext<HintsApi>({
  markUsed: () => {},
  isRetired: () => false,
  liveKeys: (keys) => [...keys],
});

type HintsProviderProps = {
  children: React.ReactNode;
  /** Persisted per-key use counts from state.json, seeded once at mount. */
  initialUsage?: Record<string, number>;
  /** Called after each local increment so the host can persist the use. */
  onMarkUsed?: (key: string) => void;
};

export function HintsProvider({ children, initialUsage, onMarkUsed }: HintsProviderProps): React.ReactElement {
  const [used, setUsed] = useState<Record<string, number>>(() => ({ ...(initialUsage ?? {}) }));
  // Ref so markUsed stays referentially stable when the host re-renders with
  // a fresh persistence closure.
  const onMarkUsedRef = useRef(onMarkUsed);
  onMarkUsedRef.current = onMarkUsed;

  const markUsed = useCallback((key: string) => {
    setUsed((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
    onMarkUsedRef.current?.(key);
  }, []);

  const isRetired = useCallback(
    (key: string) => (used[key] ?? 0) >= HINT_RETIRE_AFTER,
    [used],
  );

  const liveKeys = useCallback(
    (keys: readonly string[]) => keys.filter((key) => !isRetired(key)),
    [isRetired],
  );

  const value = useMemo(
    () => ({ markUsed, isRetired, liveKeys }),
    [markUsed, isRetired, liveKeys],
  );

  return React.createElement(HintsContext.Provider, { value }, children);
}

export function useHints(): HintsApi {
  return useContext(HintsContext);
}
