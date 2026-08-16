import { defineConfig } from 'vitest/config';

/**
 * Vitest's 5s per-test default is too tight for this suite: the heavy cases
 * (git remote re-acquisition, skill transaction trees, Ink interactive
 * journeys, fixture generation) do real fs + spawn work and are routinely
 * ~0.5–3s on a quiet machine but inflate 5–20× on a loaded shared Windows
 * runner (observed 12.7s for one fixture test, 8.4s for a bulk-ops journey).
 * On top of that, event-loop stalls from parallel workers delay the timeout
 * timer itself, so a test that finishes at 8s wall time can still be failed by
 * a 5s timer that only fires after the loop frees. A single generous ceiling
 * absorbs that load variance while still catching genuine hangs.
 */
export default defineConfig({
  test: {
    testTimeout: 30000,
  },
});
