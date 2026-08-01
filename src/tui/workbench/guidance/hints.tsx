// Contextual hint retirement (issue #76).
//
// Hints attach to a focused element (the selected Profile) and retire once the
// key they teach has been used HINT_RETIRE_AFTER times. Usage is tracked in
// session memory; a retired hint stays retired for the rest of the session, so
// steady state converges to near-minimal as the user learns. No persistence —
// the Welcome card is also per-session, and hints are guidance, not state.

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

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
  /** Retirement threshold; defaults to HINT_RETIRE_AFTER. */
  retireAfter?: number;
};

export function HintsProvider({ children, retireAfter = HINT_RETIRE_AFTER }: HintsProviderProps): React.ReactElement {
  const [used, setUsed] = useState<Record<string, number>>({});

  const markUsed = useCallback((key: string) => {
    setUsed((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  }, []);

  const isRetired = useCallback(
    (key: string) => (used[key] ?? 0) >= retireAfter,
    [used, retireAfter],
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
