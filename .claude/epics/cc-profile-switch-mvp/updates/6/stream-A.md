---
issue: 6
stream: Profile Inspection and Validation Commands
started: 2026-05-16T14:03:40Z
status: completed
---

## Scope

Implement profile inspection commands and reusable validation logic for the MVP safety gate.

## Progress

- Added `validateProfile` with required file/directory checks, JSON parsing, profile manifest validation, plugin path traversal blocking, and sensitive filename scanning.
- Added `list`, `show`, and `validate` command handlers.
- Added focused unit and command tests.

## Verification

- `npm run check`
