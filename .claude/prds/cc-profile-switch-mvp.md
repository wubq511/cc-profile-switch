---
name: cc-profile-switch-mvp
description: Windows-only Node.js CLI for switching Claude Code user-level config profiles while preserving project config
status: completed
created: 2026-05-16T09:33:18Z
---

# PRD: cc-profile-switch-mvp

## Executive Summary

CC-Profile-Switch (`ccps`) is a Windows-only Node.js CLI that launches Claude Code with a selected user-level configuration profile. It switches the Claude Code user config source through `CLAUDE_CONFIG_DIR`, while preserving the current project directory and project-level Claude Code configuration.

Source documents:

- `docs/PRD-cc-profile-switch-MVP.md`
- `docs/TechDesign-cc-profile-switch-MVP.md`

## Problem Statement

Claude Code has a single user-level global configuration under `C:\Users\h\.claude`. When that global configuration is tuned for coding, it pollutes other workflows such as study, work, research, and general use. Manual replacement of global files is error-prone and risks overwriting or leaking sensitive state.

The product must solve this by making profile switching explicit, repeatable, reversible, and safe. It must not modify the real `C:\Users\h\.claude`, and it must not replace or hide project-level configuration.

## User Stories

### Use a coding profile in a project

As a Claude Code heavy user, I want to run `ccps launch coding` from a project directory so Claude Code starts in that project with the coding user profile active.

Acceptance criteria:

- The spawned Claude process keeps `cwd` equal to the user's current project directory.
- `CLAUDE_CONFIG_DIR` points to the selected profile's `claude-home`.
- The real `C:\Users\h\.claude` is not copied, overwritten, or modified.
- Project-level `CLAUDE.md`, `.claude`, and `.mcp.json` remain discoverable by Claude Code.

### Initialize default profiles

As a user, I want `ccps init` to create default profiles for `coding`, `study`, `work`, `research`, and `general`.

Acceptance criteria:

- The command creates `%USERPROFILE%\.cc-profile-switch`.
- Each default profile contains `profile.json`, `claude-home\CLAUDE.md`, `claude-home\settings.json`, `claude-home\skills`, `claude-home\agents`, `mcp.json`, and `plugins`.
- Re-running `ccps init` does not overwrite user-edited files.
- The command never reads from or copies `C:\Users\h\.claude`.

### Manage profiles

As a user, I want to list, create, show, edit, validate, and back up profiles from the CLI.

Acceptance criteria:

- `ccps list` shows profiles with validation status and last-used information when available.
- `ccps create <name> --template <template>` supports `coding`, `study`, `work`, `research`, `general`, and `blank`.
- `ccps show <name>` displays absolute paths, core file status, JSON validation status, and that project config is preserved.
- `ccps edit <name> [file]` only opens approved files or the selected profile directory.
- `ccps validate <name>` detects invalid JSON, missing required files, unsafe profile names, path traversal, and sensitive filenames.
- `ccps backup <name>` copies the selected profile into a timestamped backup directory without modifying the source.

### Preview launch safely

As a user, I want `ccps launch <profile> --dry-run` to show the exact launch plan before any real process starts.

Acceptance criteria:

- The dry-run output includes cwd, profile path, `claude-home`, environment changes, command, args, MCP mode, plugin dirs, warnings, and validation result.
- The dry-run does not spawn Claude Code.
- The dry-run clearly states that project config is preserved.

## Functional Requirements

- Provide CLI commands: `init`, `list`, `create`, `show`, `edit`, `validate`, `backup`, and `launch`.
- Store app data under `%USERPROFILE%\.cc-profile-switch`.
- Store each profile under `profiles\<name>` with a nested `claude-home` directory.
- Use `CLAUDE_CONFIG_DIR=<profile>\claude-home` for launch.
- Default MCP mode is merge: pass `--mcp-config <profile>\mcp.json` when present, without `--strict-mcp-config`.
- `--strict-mcp-config` is opt-in only.
- Launch must validate the profile before spawning Claude Code.
- Launch must use `child_process.spawn` with command and args array, `shell: false`, and `stdio: inherit`.
- Profile names must be safe: lowercase or mixed-case letters, numbers, hyphen, and underscore, with no traversal.
- All paths must resolve to absolute paths with Node `path` APIs.
- Validation must scan for high-risk sensitive names such as `token`, `secret`, `credential`, `credentials`, `session`, `oauth`, and `.claude.json`.

## Non-Functional Requirements

- Windows-only for MVP.
- No backend service, database, cloud sync, or paid dependency.
- CLI output should be short, readable, explicit, and developer-friendly.
- Errors should include clear next-step suggestions.
- The codebase should be modular: commands call core services; core services own business logic; platform modules own Windows-specific behavior.
- Automated tests should cover path safety, schemas, templates, validation, backup, and launch-plan generation.
- Manual verification must document real Claude Code behavior for `CLAUDE_CONFIG_DIR`, project config preservation, MCP behavior, auth/session behavior, and memory behavior.

## Success Criteria

- `ccps init` creates five valid default profiles.
- `ccps list`, `create`, `show`, `edit`, `validate`, and `backup` work against the profile directory structure.
- `ccps launch <name> --dry-run` shows the correct launch plan without starting Claude Code.
- `ccps launch <name>` starts Claude Code from the current working directory.
- The launched process receives `CLAUDE_CONFIG_DIR` pointing to the selected profile's `claude-home`.
- The real `C:\Users\h\.claude` is not copied, overwritten, or modified.
- Project-level config remains active.
- The marker verification proves Claude sees `PROFILE_CODING_MARKER` and `PROJECT_MARKER`, and does not see `GLOBAL_ORIGINAL_MARKER`.
- README documents installation, usage, safety boundaries, and verification steps.

## Constraints & Assumptions

- MVP supports Windows, PowerShell, and Windows Terminal only.
- The runtime is Node.js LTS with TypeScript.
- Recommended libraries are Commander, Zod, Vitest, tsup, fs-extra, and picocolors.
- Claude Code supports `CLAUDE_CONFIG_DIR` for switching user-level config.
- Whether each profile needs separate Claude authentication must be verified manually.
- Whether profile MCP and project MCP merge as expected must be verified manually.
- Whether auto memory reads from the profile or real global directory must be verified manually.

## Out of Scope

- TUI or GUI.
- Cloud sync.
- Multi-account switching.
- OAuth, session, token, history, or cache migration.
- Plugin marketplace or automatic plugin downloads.
- macOS or Linux support.
- Runtime project isolation mode.
- Project config switching, replacement, deletion, or isolation.
- `settings.local.json` management.
- Output styles management.
- Complex settings visual editing.

## Dependencies

- Node.js LTS and npm.
- Claude Code CLI installed on the user's machine for real launch verification.
- Windows filesystem and process APIs.
- Local editor or Windows default opener for `ccps edit`.
- Existing source documents in `docs/`.
