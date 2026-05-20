---
issue: 21
stream: Terminal Adapter and CLI Wiring
started: 2026-05-20T09:01:59Z
status: completed
---
## Scope

Implement the TUI terminal adapter, `ccps tui` command wiring, and tests for issue #21.

## Progress
- Starting implementation
- Added failing tests for terminal ports and `ccps tui` command wiring.
- Implemented `src/tui/terminal.ts` using Node built-in `readline` primitives; no TUI dependency was added.
- Wired Commander `tui` command through an injectable runtime runner.
- Verified focused `npm run test -- tui-terminal profile-commands cli-help`.
- Verified full `npm run check`.
