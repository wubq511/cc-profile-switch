---
issue: 17
title: Core Profile Management Services
analyzed: 2026-05-20T08:10:24Z
estimated_hours: 6
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #17

## Overview

This task creates the shared profile lifecycle service layer that later CLI and TUI work must call. The work is intentionally serial because it defines the service contracts, writes filesystem mutation behavior, and adds tests that establish safety boundaries.

## Parallel Streams

### Stream A: Core Services and Tests
**Scope**: Add profile management service functions and unit tests for copy, rename, remove, default profile management, list summaries, and launch profile resolution.
**Files**:
- `src/core/profile-management.ts`
- `src/core/profile.ts`
- `src/core/app-config.ts`
- `src/core/launcher.ts`
- `test/profile-management.test.ts`
**Can Start**: immediately
**Estimated Hours**: 6
**Dependencies**: none

## Coordination Points

### Shared Files

The service module will likely reuse existing profile, app config, validator, launcher, and path helpers. If helper exports need to change, keep them small and compatible with existing callers.

### Sequential Requirements

1. Write failing service-level tests first.
2. Implement the minimum core service layer to pass those tests.
3. Run focused tests, then full `npm run check`.

## Conflict Risk Assessment

Low to medium. This task is foundational, but it should avoid CLI/TUI command wiring except where a launch resolver must be exported for later tasks.

## Parallelization Strategy

Do this as a single stream. Splitting tests and implementation would create churn because the service API is being discovered through tests.

## Expected Timeline
- With parallel execution: 6h wall time
- Without: 6h
- Efficiency gain: 0%
