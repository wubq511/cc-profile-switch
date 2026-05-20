---
issue: 19
title: Default Launch Resolution
analyzed: 2026-05-20T08:39:03Z
estimated_hours: 3
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #19

## Overview

This task makes `ccps launch` accept an optional profile argument and resolve omitted launches through `config.json.defaultProfile`. It must preserve existing launch plan behavior, dry-run parity, cwd handling, MCP merge defaults, API env merging, plugin directories, skip-permissions behavior, and memory isolation.

## Parallel Streams

### Stream A: Launch Resolution and Tests
**Scope**: Update launcher core options, CLI launch command shape, and tests for default resolution and explicit profile precedence.
**Files**:
- `src/core/launcher.ts`
- `src/commands/index.ts`
- `test/launcher.test.ts`
- `test/profile-commands.test.ts`
- `test/cli-help.test.ts`
**Can Start**: immediately
**Estimated Hours**: 3
**Dependencies**: Issue #17 core `resolveLaunchProfile`

## Coordination Points

### Shared Files

`src/commands/index.ts` was also changed by issue #18. Keep this issue focused on launch command parsing and profile resolution only.

### Sequential Requirements

1. Add failing launcher and CLI tests for omitted profile behavior.
2. Wire launcher through the shared `resolveLaunchProfile` helper.
3. Change CLI command from required `<profile>` to optional `[profile]`.
4. Run focused tests and full `npm run check`.

## Conflict Risk Assessment

Medium. The command entry file is shared with adjacent tasks, but the launch command block is isolated enough for a single stream.

## Parallelization Strategy

Use one stream. Core launcher and CLI tests need a consistent API shape, so splitting would create unnecessary coordination overhead.

## Expected Timeline
- With parallel execution: 3h wall time
- Without: 3h
- Efficiency gain: 0%
