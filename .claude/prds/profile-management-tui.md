---
name: profile-management-tui
description: V0.2 profile management commands with a lightweight TUI assistant entry
status: backlog
created: 2026-05-20T07:50:37Z
---

# PRD: profile-management-tui

## Executive Summary

V0.2 extends CC-Profile-Switch from an MVP launcher into a safer local profile manager. It adds four core profile management commands: `copy`, `rename`, `remove`, and `default`. It also adds a lightweight TUI entry, `ccps tui`, as an assistant surface over the same core capabilities.

The CLI remains the primary and scriptable interface. The TUI is not a separate product mode and must not duplicate business rules. It should call the same core services used by CLI commands so validation, path safety, backup behavior, and config updates remain consistent.

## Problem Statement

The MVP can initialize, create, inspect, edit, validate, back up, and launch profiles, but profile lifecycle management still requires manual filesystem work for common tasks. That creates avoidable risk:

- Creating a variant from an existing profile requires copying folders and editing `profile.json` by hand.
- Renaming a profile requires moving directories and keeping manifest/config references in sync.
- Removing an unused profile risks deleting data without a backup or leaving stale `defaultProfile` config.
- Launching the preferred profile requires typing a name every time unless the user remembers shortcuts outside ccps.

These tasks should be first-class, validated, reversible where practical, and testable. The next version should also provide a simple guided interaction for users who prefer choosing from a list, but without changing the product into a TUI-first application.

## User Stories

### Copy an existing profile into a variant

As a user, I want to run `ccps copy study study-math` so I can create a new profile based on a known working profile.

Acceptance criteria:

- The source profile must exist and pass validation before copying.
- The target profile name must be safe and must not already exist.
- The copied profile keeps user-authored files under `claude-home`.
- The copied `profile.json` updates `name`, `createdAt`, and `updatedAt` to the target profile.
- Profile-local memory settings are repaired so `autoMemoryDirectory` points at the target profile's `claude-home\memory\auto`.
- The command never reads from, copies from, or writes to the real `C:\Users\h\.claude`.

### Rename a profile

As a user, I want to run `ccps rename study study-general` so the profile name matches how I actually use it.

Acceptance criteria:

- The old profile must exist and pass validation before rename.
- The new profile name must be safe and must not already exist.
- The profile directory is moved under `profiles\<new>`.
- `profile.json.name` and `updatedAt` are updated.
- Profile-local memory settings are repaired so `autoMemoryDirectory` points at the new path.
- If `config.json.defaultProfile` or `lastUsedProfile` points to the old name, the reference is updated to the new name.
- No files inside `claude-home` are rewritten except the settings fields required for path correctness.

### Remove a profile safely

As a user, I want to run `ccps remove old-study` so I can clean up profiles I no longer need without accidental data loss.

Acceptance criteria:

- The profile must exist before removal.
- The command creates a timestamped backup before deleting the profile.
- The user must strongly confirm by typing the exact profile name.
- There is no `--force` or `--yes` bypass in V0.2.
- Deleting the current default profile is allowed, but `config.json.defaultProfile` must be cleared in the same operation.
- Deleting the last remaining profile is allowed, leaving an empty profile list.
- If `lastUsedProfile` points to the removed profile, it is cleared.
- After deletion, `ccps list` and `ccps tui` must handle the empty state and show the next action to create or initialize profiles.

### Set and use a default profile

As a user, I want to run `ccps default coding` so `ccps launch` can start Claude Code with my default profile.

Acceptance criteria:

- `ccps default <name>` validates that the profile exists before saving it as default.
- `ccps default` shows the current default profile when one is set.
- `ccps default --clear` clears the default profile.
- `ccps launch` without a profile uses `config.json.defaultProfile` when it is set.
- `ccps launch` without a profile fails with a clear next step when no default exists.
- Removing a default profile clears the default reference rather than leaving a dangling config value.

### Manage profiles through a lightweight TUI

As a user, I want to run `ccps tui` and choose profile actions from a guided menu, especially for delete confirmation and setting defaults.

Acceptance criteria:

- The TUI lists profiles with validation status, default marker, and last-used marker.
- The TUI supports copy, rename, remove, set default, clear default, show details, validate, and launch dry-run.
- The TUI calls the same core services as CLI commands.
- The TUI uses the same strong confirmation for removal.
- The TUI handles zero profiles by offering create/init guidance instead of crashing.
- TUI screens stay compact and operational; they should not become explanatory documentation pages.

## Functional Requirements

- Add CLI commands:
  - `ccps copy <from> <to>`
  - `ccps rename <old> <new>`
  - `ccps remove <name>`
  - `ccps default [name]`
  - `ccps default --clear`
  - `ccps tui`
- Allow `ccps launch` to omit `<profile>` when a default profile exists.
- Keep `copy`, `rename`, `remove`, and `default` business logic in core modules, not inside Commander action handlers or TUI screen code.
- Reuse existing validation, profile path, app config, backup, and JSON writing utilities where possible.
- Ensure every profile name passes the existing safe profile name validation.
- Ensure all filesystem paths resolve through Node `path` APIs and existing inside-base checks.
- For `copy`, repair copied metadata and profile-local settings after copying.
- For `rename`, update app config references from old name to new name.
- For `remove`, create backup before deletion, require strong confirmation, then update app config references.
- For `default`, validate existence before setting and support clearing.
- For TUI, add an interaction layer that can be tested independently from terminal rendering where practical.
- Update README with V0.2 command usage, delete safety behavior, default launch behavior, and TUI scope.
- Update roadmap or appendix status to reflect that V0.2 includes only `copy`, `rename`, `remove`, `default`, and a lightweight TUI; `recent`, `alias`, `export`, `import`, `doctor`, and `diff` remain future work.

## Non-Functional Requirements

- Windows-only behavior remains unchanged.
- CLI output must stay short, explicit, and actionable.
- TUI must be keyboard-first and suitable for Windows Terminal / PowerShell.
- TUI must not require a backend, database, browser, or GUI runtime.
- The implementation should minimize new dependencies. If a TUI dependency is needed, it must be actively maintained, work on Windows, and be justified in the implementation plan.
- No command may print secrets, token values, or environment variable values.
- Errors must include next-step guidance.
- Automated tests must cover both successful paths and safety failures.
- `npm run check` must pass before the version is considered complete.

## Success Criteria

- `ccps copy coding coding-test` creates a valid independent profile and preserves the source unchanged.
- `ccps rename coding coding-main` moves the profile, updates manifest metadata, and updates matching config references.
- `ccps remove coding-main` creates a backup, requires exact-name confirmation, deletes only the selected profile, and clears matching config references.
- Removing the default profile and removing the last profile are both supported and leave `config.json` valid.
- `ccps default study` sets the default, `ccps default` displays it, and `ccps default --clear` removes it.
- `ccps launch --dry-run` uses the default profile when no profile argument is provided.
- `ccps launch --dry-run` fails clearly when no profile argument and no default profile exist.
- `ccps tui` can perform the same profile management actions without implementing separate business rules.
- The README documents the new workflows and safety rules.
- Unit and integration tests cover the new CLI commands, core services, and TUI interaction boundaries.

## Constraints & Assumptions

- The current MVP architecture remains the baseline: Commander for CLI, TypeScript, Node.js LTS, Zod, fs-extra, Vitest, tsup, and picocolors.
- The app data root remains `%USERPROFILE%\.cc-profile-switch`.
- The profile structure remains `profiles\<name>\profile.json`, `profiles\<name>\claude-home`, and `profiles\<name>\mcp.json`.
- `config.json.defaultProfile` is optional and may be absent or cleared.
- An empty `profiles` directory is a valid app state after explicit removals.
- Backup creation is the rollback path for `remove`.
- TUI is an auxiliary entry and does not replace the CLI.
- V0.2 should not change launch isolation, MCP merge behavior, skip-permissions defaults, API env resolution, or profile memory isolation semantics.

## Out of Scope

- `recent` command.
- `alias` command or PowerShell profile writing.
- `export` and `import`.
- `doctor`, `repair`, `diff`, `verify-behavior`, and `validate --deep`.
- GUI or browser-based management.
- Cloud sync, account switching, OAuth/session migration, token migration, history migration, or cache migration.
- Reading from, copying from, overwriting, or managing the real `C:\Users\h\.claude`.
- Modifying project `.claude`, project `CLAUDE.md`, project `.mcp.json`, or project-level Claude Code config.
- Publishing an npm package or creating a public release.

## Dependencies

- Existing MVP profile structure and validation logic.
- Existing `backupProfile` behavior or a shared backup utility derived from it.
- Existing app config schema with optional `defaultProfile` and `lastUsedProfile`.
- A Windows-compatible TUI/prompt library, only if the implementation plan proves the existing dependency set is insufficient.
- Node.js LTS and npm.
- Vitest for automated tests.
