---
issue: 5
title: Init and Create Commands
analyzed: 2026-05-16T11:32:03Z
estimated_hours: 6
parallelization_factor: 1.5
---

# Parallel Work Analysis: Issue #5

## Overview

Implement the first real profile lifecycle commands: `ccps init` and `ccps create <name> --template <template>`. The work is mostly sequential because the CLI wiring, core profile service, and integration tests share the same command surface.

## Parallel Streams

### Stream A: Profile Lifecycle Implementation
**Scope**: Add command handlers and core profile lifecycle functions for init/create.
**Files**: `src/cli.ts`, `src/commands/**`, `src/core/profile.ts`, `src/core/app-config.ts`, `test/**`
**Can Start**: immediately
**Estimated Hours**: 6
**Dependencies**: none

## Coordination Points

### Shared Files

- `src/commands/index.ts` currently owns all placeholder commands and will be replaced or split.
- `src/core/app-config.ts` already contains non-overwriting config primitives used by init.
- `src/core/profile-template.ts` already owns profile materialization and should stay the source of template structure.

### Sequential Requirements

- Tests must define the expected CLI behavior before production changes.
- `init` must preserve existing files, so it cannot call `createAppConfig` blindly on repeat.
- `create` must reuse the existing template materialization path and reject duplicate profile directories.

## Conflict Risk Assessment

Medium. Issue #6 and #7 will likely touch adjacent command registration and profile service code, so this issue should keep command APIs narrow and reusable.

## Parallelization Strategy

Use a single implementation stream. The surface is small and TDD requires tight red/green loops around CLI behavior, which would be slowed down by splitting files across agents.

## Expected Timeline

- With parallel execution: 6h wall time
- Without: 6h
- Efficiency gain: 0%
