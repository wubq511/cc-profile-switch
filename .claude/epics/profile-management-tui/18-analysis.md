---
issue: 18
title: CLI Profile Management Commands
analyzed: 2026-05-20T08:27:50Z
estimated_hours: 4
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #18

## Overview

This task wires the V0.2 profile management core services into Commander commands. The handlers should stay thin: parse arguments, collect exact-name confirmation for removal, call shared services, and print compact next-step output.

## Parallel Streams

### Stream A: CLI Commands and Tests
**Scope**: Add `copy`, `rename`, `remove`, and `default` commands with injected prompt support and lifecycle tests.
**Files**:
- `src/commands/index.ts`
- `test/profile-commands.test.ts`
- `test/cli-help.test.ts`
**Can Start**: immediately
**Estimated Hours**: 4
**Dependencies**: Issue #17 core services

## Coordination Points

### Shared Files

`src/commands/index.ts` is also expected to change in issues #19 and #21. Keep this work scoped to lifecycle commands and do not change `launch <profile>` semantics here.

### Sequential Requirements

1. Add failing CLI tests for command success and failure paths.
2. Implement injectable prompt/input runtime support and command handlers.
3. Verify focused CLI tests and full `npm run check`.

## Conflict Risk Assessment

Medium. The command registration file is shared with later default-launch and TUI entry work, so edits should remain localized and avoid broad restructuring.

## Parallelization Strategy

Use one stream. Splitting this issue would create avoidable conflicts in the single command registration file.

## Expected Timeline
- With parallel execution: 4h wall time
- Without: 4h
- Efficiency gain: 0%
