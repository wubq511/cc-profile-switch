---
issue: 20
title: TUI Flow Controller
analyzed: 2026-05-20T08:48:53Z
estimated_hours: 4
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #20

## Overview

This task adds a testable TUI flow controller independent from terminal rendering. It should define narrow prompt/output ports, call shared core services for all mutations, and support a compact action loop that can later be wired by the terminal adapter in issue #21.

## Parallel Streams

### Stream A: Controller and Tests
**Scope**: Add `src/tui` controller module plus tests for list, zero-profile state, copy, rename, remove, default actions, show, validate, and launch dry-run.
**Files**:
- `src/tui/controller.ts`
- `src/tui/index.ts`
- `test/tui-controller.test.ts`
**Can Start**: immediately
**Estimated Hours**: 4
**Dependencies**: Issue #17 core services

## Coordination Points

### Shared Files

This issue should not wire `ccps tui` into Commander; issue #21 owns the terminal adapter and CLI entry.

### Sequential Requirements

1. Write failing controller tests with mocked ports and injected services.
2. Implement the controller with dependency injection and no direct filesystem mutation rules.
3. Verify focused controller tests and full `npm run check`.

## Conflict Risk Assessment

Low. New files should avoid conflicts with completed CLI work and future terminal adapter work.

## Parallelization Strategy

Use one stream. The controller API and tests need to evolve together.

## Expected Timeline
- With parallel execution: 4h wall time
- Without: 4h
- Efficiency gain: 0%
