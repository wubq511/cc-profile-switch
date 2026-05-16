---
issue: 4
title: App Config and Profile Templates
analyzed: 2026-05-16T11:09:37Z
estimated_hours: 6
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #4

## Overview

Implement the app-home configuration layer and reusable profile template materialization. This issue is sequential because the template writer depends on the path helpers and config schemas from issue #3, and the tests should verify the same public APIs that later commands will call.

## Parallel Streams

### Stream A: Core App Config and Profile Templates
**Scope**: App config CRUD helpers, profile template definitions, non-overwriting file materialization, and focused tests.
**Files**: `src/core/app-config.ts`, `src/core/profile-template.ts`, `test/app-config.test.ts`, `test/profile-template.test.ts`
**Can Start**: immediately
**Estimated Hours**: 6
**Dependencies**: issue #3

## Coordination Points

### Shared Files
No shared command files need to change for this issue. The new modules are consumed by future commands.

### Sequential Requirements
Create and validate app config helpers before using the same path and JSON-writing conventions in profile template materialization.

## Conflict Risk Assessment

Low. The work is isolated to new core modules and new tests.

## Parallelization Strategy

Single stream. Splitting tests and implementation would create unnecessary churn because the APIs are small and tightly coupled.

## Expected Timeline
- With parallel execution: 6h wall time
- Without: 6h
- Efficiency gain: 0%
