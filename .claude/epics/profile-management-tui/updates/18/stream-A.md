---
issue: 18
stream: CLI Commands and Tests
started: 2026-05-20T08:27:50Z
status: completed
---
## Scope

Add profile management CLI commands and tests for issue #18.

## Progress
- Starting implementation
- Added failing CLI tests for `copy`, `rename`, `remove`, `default`, and help output.
- Implemented thin Commander handlers that delegate filesystem/config mutations to core profile management services.
- Added injected `readInput` support for exact-name remove confirmation.
- Verified with focused `npm run test -- profile-commands cli-help`.
- Verified with full `npm run check`.
