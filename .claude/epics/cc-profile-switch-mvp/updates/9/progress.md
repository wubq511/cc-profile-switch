---
issue: 9
started: 2026-05-16T15:16:52Z
last_sync: 2026-05-16T15:42:29Z
completion: 100%
---

# Issue #9 Progress

## Completed Work

- Confirmed issue #8 is closed locally and on GitHub.
- Confirmed Claude Code CLI is available as version `2.1.143`.
- Confirmed `claude --help` exposes `--print`, `--no-session-persistence`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, and `--plugin-dir`.
- Ran isolated `ccps launch coding --dry-run --cwd <temp-project>` without touching the real ccps app home.
- Added `VERIFY-CLAUDE-CODE-BEHAVIOR.md` at the repository root.
- Ran `npm run check`: lint, 61 tests, and build passed.
- Ran real `claude -p --no-session-persistence` marker verification against an isolated profile.
- Observed `Not logged in · Please run /login` before model execution when no explicit API settings were supplied.
- Re-ran auth check with real `USERPROFILE` but isolated `CLAUDE_CONFIG_DIR`; observed the same `Not logged in` result, which indicates OAuth/keychain-style auth is profile-specific under `CLAUDE_CONFIG_DIR`.
- Passed the existing real API settings via `--settings C:\Users\h\.claude\settings.json` without copying or printing secrets.
- Verified marker behavior: real global marker false, profile marker true, project marker true.
- Verified profile and project settings `env` markers reach tool subprocesses.
- Verified profile agents and skills are visible to Claude Code.
- Verified explicit `--plugin-dir=<profile>\plugins` appears as a session plugin path.
- Verified MCP behavior: merge exposes profile and project MCP tools; strict exposes profile only.
- Checked path names only after real runs; `session-env` and `sessions` appeared under the isolated profile `claude-home`.

## In Progress

- Issue #9 complete. Issue #10 should document API auth pass-through and avoid credential migration.

## Blockers

- None.
