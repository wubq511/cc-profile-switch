---
issue: 21
title: TUI Terminal Adapter
analyzed: 2026-05-20T09:01:59Z
estimated_hours: 3
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #21

## Overview

This task wires `ccps tui` to the controller created in issue #20. The adapter should implement controller ports with Windows-friendly Node `readline` primitives, stay isolated from core services, and avoid starting real Claude Code processes because the controller only exposes launch dry-run for V0.2.

## Parallel Streams

### Stream A: Terminal Adapter and CLI Wiring
**Scope**: Add terminal adapter, wire `ccps tui` through Commander, and test command registration/adapter invocation without real interactive input.
**Files**:
- `src/tui/terminal.ts`
- `src/tui/index.ts`
- `src/commands/index.ts`
- `test/tui-terminal.test.ts`
- `test/profile-commands.test.ts`
- `test/cli-help.test.ts`
**Can Start**: immediately
**Estimated Hours**: 3
**Dependencies**: Issue #20 TUI controller

## Coordination Points

### Shared Files

`src/commands/index.ts` was changed by issues #18 and #19. This task should only add the `tui` command and an injected runner for tests.

### Sequential Requirements

1. Add failing tests for terminal ports and `ccps tui` command wiring.
2. Implement adapter using Node built-in `readline`.
3. Wire Commander to the adapter behind a runtime function.
4. Run focused tests and full `npm run check`.

## Conflict Risk Assessment

Medium. The terminal adapter is new, but command registration is shared. Keep changes localized.

## Parallelization Strategy

Use one stream. The adapter API and CLI wiring tests should evolve together.

## Expected Timeline
- With parallel execution: 3h wall time
- Without: 3h
- Efficiency gain: 0%
