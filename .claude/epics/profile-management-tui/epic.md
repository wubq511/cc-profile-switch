---
name: profile-management-tui
status: in-progress
created: 2026-05-20T07:54:16Z
updated: 2026-05-20T08:37:11Z
progress: 28%
prd: .claude/prds/profile-management-tui.md
github: https://github.com/wubq511/cc-profile-switch/issues/16
---

# Epic: profile-management-tui

## Overview

V0.2 adds safe profile lifecycle management and a lightweight TUI assistant entry to CC-Profile-Switch. The implementation should keep the CLI as the primary interface while making `ccps tui` a compact interactive wrapper over the same core services.

The work extends the current MVP architecture rather than replacing it. Existing modules already separate Commander handlers, profile core logic, app config, templates, validation, launch planning, and Windows path safety. V0.2 should add profile management services beside the existing core logic, update command handlers to stay thin, and introduce a testable TUI flow layer that delegates all filesystem and config mutations to core functions.

## Architecture Decisions

- Core services own profile mutations. `copy`, `rename`, `remove`, `default`, and default launch resolution must live in `src/core`, not in Commander action handlers or TUI rendering code.
- CLI and TUI share the same service contracts. Any rule about validation, backup, metadata updates, default clearing, or strong delete confirmation should be implemented once.
- Removal is allowed for default profiles and for the last profile, but it must leave app config valid. Removing a default profile clears `defaultProfile`; removing a last-used profile clears `lastUsedProfile`.
- Removal is a two-step operation at the interface boundary: the interface collects an exact-name confirmation, and the core service refuses deletion unless the confirmation equals the target profile name.
- The TUI is a helper surface, not a separate product shell. It should list profiles, choose actions, collect input, and show results; it should not add separate state or hidden behavior.
- Empty profile state is valid. `list`, `tui`, and `launch` must treat zero profiles as a normal explicit state with clear guidance.
- Launch behavior stays Global User Config Switch Mode. V0.2 must not change cwd handling, MCP merge defaults, skip-permissions defaults, API env merge semantics, plugin directory rules, or memory isolation.
- TUI dependency choice should be conservative. Prefer a small adapter around Node prompt/readline primitives unless the implementation plan proves a Windows-compatible prompt dependency is needed for reliable keyboard selection.

## Technical Approach

### Frontend Components

There is no browser frontend. The user-facing layer consists of CLI output and TUI terminal screens.

CLI changes:

- Add Commander commands for `copy`, `rename`, `remove`, and `default`.
- Change `launch` from requiring `<profile>` to accepting an optional `[profile]`, then resolving to `defaultProfile` when omitted.
- Add `tui` as a command entry.
- Extend `CommandRuntime` with small injectable prompt/confirm functions so tests can exercise `remove` and TUI flows without real terminal input.
- Keep output compact and action-oriented, matching existing command style.

TUI changes:

- Add a `src/tui` module with a flow/controller layer and an I/O adapter.
- The controller should operate on abstract prompt methods such as select, input, confirm-by-name, and output.
- The first TUI version should expose profile list, copy, rename, remove, set default, clear default, show, validate, and launch dry-run.
- Launch from TUI should default to dry-run for V0.2 so the TUI does not need to manage inherited stdio for a long-running Claude Code process.

### Backend Services

No backend service is introduced. Core Node services should cover:

- `listProfilesForDisplay(appHomePath)` or equivalent summary builder returning names, validation status, default marker, last-used marker, and description.
- `copyProfile({ appHomePath, from, to, clock })`.
- `renameProfile({ appHomePath, oldName, newName, clock })`.
- `removeProfile({ appHomePath, name, confirmation, clock })`.
- `getDefaultProfile({ appHomePath })`.
- `setDefaultProfile({ appHomePath, name, clock })`.
- `clearDefaultProfile({ appHomePath, clock })`.
- `resolveLaunchProfile({ appHomePath, requestedProfile })`, used by launch planning and real launch.

Supporting helpers:

- A manifest update helper for `profile.json` that uses `profileConfigSchema`.
- A settings repair helper that updates only `autoMemoryDirectory` when profile paths change.
- A config reference helper that updates or clears `defaultProfile` and `lastUsedProfile`.
- A reusable backup helper so `removeProfile` can guarantee backup-before-delete without duplicating logic.

### Infrastructure

- No database, service, browser runtime, or GUI runtime.
- Existing `fs-extra`, Zod schemas, Windows path helpers, Vitest, tsup, and Commander remain the base stack.
- If a TUI/prompt package is added, it must be recorded in `package.json`, justified in docs or implementation notes, and covered by tests through an adapter boundary.
- Existing verification remains `npm run check`.

## Implementation Strategy

1. Build the core service layer first with tests against temporary `%USERPROFILE%` homes.
2. Update CLI commands as thin wrappers over the new services.
3. Update launch profile resolution and dry-run coverage for default profile behavior.
4. Implement the TUI controller against an abstract prompt/output adapter.
5. Add the terminal adapter for `ccps tui`.
6. Update README and roadmap appendix for V0.2 behavior and future exclusions.
7. Run the full verification suite.

This order keeps risky filesystem behavior under test before any interactive surface depends on it.

## Task Breakdown Preview

1. Core profile management services: implement copy, rename, remove, default, metadata repair, settings repair, config reference updates, and service-level tests.
2. CLI command integration: add `copy`, `rename`, `remove`, `default`, prompt injection for removal, help text, and CLI lifecycle tests.
3. Default launch resolution: make `launch [profile]` use `defaultProfile` when omitted, fail clearly when absent, and preserve dry-run parity.
4. TUI flow/controller: add a testable TUI action controller with abstract prompt/output ports and coverage for normal and empty states.
5. TUI terminal adapter: wire `ccps tui` to the controller using the chosen prompt implementation, with Windows-friendly behavior.
6. Documentation updates: update README and `docs/APPENDIX-Roadmap.md` to describe V0.2 scope, delete safety, default launch, TUI scope, and deferred features.
7. Regression verification: run `npm run check`, add any missing tests discovered during implementation, and record verification results.

Parallelization opportunities:

- Task 1 blocks all mutation-facing tasks.
- Tasks 2 and 3 can proceed in parallel after the relevant core functions exist, but they both touch CLI command wiring and should be coordinated.
- Task 4 can proceed after core service contracts are stable.
- Task 6 can start from the PRD/epic while implementation continues, then be finalized after command names and outputs settle.

## Dependencies

- `.claude/prds/profile-management-tui.md`.
- Existing MVP commands, core profile/template/app-config modules, schemas, validator, launcher, and tests.
- Existing Windows path safety utilities.
- Existing backup behavior.
- A final decision during implementation on whether Node prompt/readline primitives are sufficient for the TUI adapter.

## Success Criteria (Technical)

- Core service tests prove copy preserves source, updates target metadata, repairs target memory path, and refuses invalid targets.
- Rename tests prove directory move, manifest update, settings repair, and `defaultProfile` / `lastUsedProfile` reference updates.
- Remove tests prove backup-before-delete, exact-name confirmation, default clearing, last-used clearing, default profile deletion, and last profile deletion.
- Default tests prove show, set, clear, missing profile handling, and config validity.
- Launch tests prove optional profile resolution from default and clear failure when no requested/default profile exists.
- TUI controller tests prove actions call shared services and handle zero profiles without crashing.
- CLI help and README tests are updated for new commands.
- `npm run check` passes.

## Estimated Effort

Medium. The filesystem and config mutations are straightforward, but the work touches shared profile lifecycle behavior, command parsing, launch semantics, tests, and docs. The main risk is letting TUI behavior diverge from CLI behavior; the adapter boundary and core-first sequencing are meant to control that risk.

## Tasks Created

- [x] 17.md - Core Profile Management Services (parallel: false)
- [x] 18.md - CLI Profile Management Commands (parallel: true)
- [ ] 19.md - Default Launch Resolution (parallel: true)
- [ ] 20.md - TUI Flow Controller (parallel: true)
- [ ] 21.md - TUI Terminal Adapter (parallel: true)
- [ ] 22.md - V0.2 Documentation Updates (parallel: true)
- [ ] 23.md - V0.2 Regression Verification (parallel: false)

Total tasks: 7
Parallel tasks: 5
Sequential tasks: 2
Estimated total effort: 24 hours
