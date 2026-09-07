import type { Clock } from '../../src/core/app-config';

/**
 * Shared test clock for Recovery Bin / Backup CLI tests (issue #104).
 *
 * Every date a test touches — fixture item creation, runtime sweeps, listings,
 * restores — must come from the SAME injected clock so fixed calendar dates
 * never mix with the real system date (the date-dependence this eliminates:
 * an item fixed at 2026-07-31 aged out under the real clock while the runtime
 * steps stayed on it, so the CLI reported an empty Bin).
 *
 * `fixedClockAt` freezes one instant; `steppedClock` advances a fixed step per
 * read so multi-command runs (init → create → sweep on next launch) produce
 * strictly increasing timestamps while staying fully deterministic. Both
 * return the injected `Clock` shape the production services accept.
 */

/** A clock frozen at the given instant — every read returns the same date. */
export function fixedClockAt(isoDate: string): Clock {
  return () => new Date(isoDate);
}

/**
 * A deterministic clock that starts at `startIso` and advances `stepMs` on
 * every read. The first read returns exactly `startIso`.
 */
export function steppedClock(startIso: string, stepMs = 1000): Clock {
  let current = new Date(startIso).getTime();
  return () => {
    const now = new Date(current);
    current += stepMs;
    return now;
  };
}

/** The canonical fixture date used across the Recovery Bin test suite. */
export const FIXTURE_REMOVED_AT = '2026-07-31T10:00:00Z';

/** A date comfortably beyond the default 30-day retention from FIXTURE_REMOVED_AT. */
export const EXPIRED_SWEEP_DATE = '2026-09-30T10:00:00Z';

/**
 * Two test dates more than the default retention (30 days) apart, for proving
 * consistent verdicts at both ends of the retention window without waiting
 * for real time (issue #104 acceptance).
 */
export const RETENTION_PROBE_DATES = {
  withinRetention: '2026-08-14T10:00:00Z',
  beyondRetention: '2026-11-15T10:00:00Z',
} as const;