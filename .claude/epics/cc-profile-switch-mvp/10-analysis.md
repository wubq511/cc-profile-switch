---
issue: 10
title: Real Launch and README
analyzed: 2026-05-16T15:49:12Z
estimated_hours: 8
parallelization_factor: 1.0
---

# Parallel Work Analysis: Issue #10

## Overview

Issue #10 completes the MVP by enabling real Claude Code process spawning and adding the root README. The work is sequential because launch behavior, CLI wiring, tests, and README need to stay aligned.

## Parallel Streams

### Stream A: Real Launch and README
**Scope**: Implement process spawning, connect `ccps launch <profile>`, update last-used metadata, document the MVP, and verify.
**Files**: `src/core/launcher.ts`, `src/platform/process.ts`, `src/commands/index.ts`, `test/launcher.test.ts`, `test/profile-commands.test.ts`, `test/readme.test.ts`, `README.md`, `.claude/epics/cc-profile-switch-mvp/10.md`, `.claude/epics/cc-profile-switch-mvp/updates/10/*`
**Can Start**: immediately
**Estimated Hours**: 8
**Dependencies**: none

## Coordination Points

### Shared Files

`src/core/launcher.ts` is shared with issue #8 launch-plan logic, so real launch should reuse the existing plan rather than creating a second path.

### Sequential Requirements

Tests must cover the spawn options and last-used metadata before implementation. README should reflect the manual verification results from issue #9.

## Conflict Risk Assessment

Medium. The main risk is accidentally changing dry-run behavior or introducing shell-string process execution.

## Parallelization Strategy

Use a single stream. The code and README are tightly coupled for this final MVP task.

## Expected Timeline

- With parallel execution: 8h wall time
- Without: 8h
- Efficiency gain: 0%
