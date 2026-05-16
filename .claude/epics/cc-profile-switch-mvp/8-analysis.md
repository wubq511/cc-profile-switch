---
issue: 8
title: Launch Plan and Dry Run
analyzed: 2026-05-16T14:53:45Z
estimated_hours: 8
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #8

## Overview

Implement launch plan construction and `ccps launch <name> --dry-run` without starting Claude Code. The work crosses CLI command registration, launcher business logic, validation integration, and tests, so it should remain a single coordinated stream.

## Parallel Streams

### Stream A: Launch Plan and Dry Run
**Scope**: Build the launch planning API, dry-run formatting, and CLI integration.
**Files**: `src/core/launcher.ts`, `src/commands/index.ts`, `test/launcher.test.ts`, `test/profile-commands.test.ts`
**Can Start**: immediately
**Estimated Hours**: 8
**Dependencies**: none

## Coordination Points

### Shared Files

- `src/commands/index.ts` is the CLI command surface and should be modified by only this stream.
- Validator behavior is reused, not rewritten.

### Sequential Requirements

1. Write failing launcher tests for env, cwd, MCP modes, plugin dirs, and validation blocking.
2. Implement `buildLaunchPlan()` and dry-run formatting.
3. Write failing CLI tests for `launch --dry-run` output and non-spawn behavior.
4. Wire the CLI command to the launcher.
5. Run the issue-specific tests, then full validation.

## Conflict Risk Assessment

Low. Issue #10 will later add real launch behavior and may touch the same launcher surface, but it depends on this issue and should wait for this API to stabilize.

## Parallelization Strategy

Use one stream. Splitting tests and implementation would create unnecessary churn because the public API is still being shaped by TDD.

## Expected Timeline

- With parallel execution: 8h wall time
- Without: 8h
- Efficiency gain: 0%
