---
issue: 3
title: Windows Path, Errors, and Schemas
analyzed: 2026-05-16T10:48:50Z
estimated_hours: 5
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #3

## Overview

Implement shared foundations for later profile commands: Windows path helpers, profile name validation, structured user-facing errors, and Zod schemas for app/profile configuration.

This issue is marked `parallel: false` because the files define baseline contracts that later modules depend on. Keep it as one coordinated stream.

## Parallel Streams

### Stream A: Foundation Utilities and Schemas
**Scope**: Add path safety helpers, structured error type, config/profile schemas, and focused unit tests.
**Files**: `src/platform/windows-path.ts`, `src/utils/errors.ts`, `src/schemas/config.ts`, `src/schemas/profile.ts`, `test/windows-path.test.ts`, `test/errors.test.ts`, `test/schemas.test.ts`
**Can Start**: immediately
**Estimated Hours**: 5
**Dependencies**: issue #2

## Coordination Points

### Shared Files

All files are owned by Stream A for this issue.

### Sequential Requirements

1. Write failing tests for path containment, profile name validation, structured errors, and schema parsing.
2. Implement the smallest production modules that satisfy those tests.
3. Run lint, tests, and build through `npm run check`.

## Conflict Risk Assessment

Low. The current codebase only contains the CLI skeleton. The main risk is over-expanding into profile lifecycle command behavior that belongs to later issues.

## Parallelization Strategy

Use a single stream. Do not launch parallel agents for this issue.

## Expected Timeline

- With parallel execution: 5h wall time
- Without: 5h
- Efficiency gain: 0%
