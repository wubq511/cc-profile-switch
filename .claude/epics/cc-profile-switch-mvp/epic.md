---
name: cc-profile-switch-mvp
status: completed
created: 2026-05-16T09:33:18Z
updated: 2026-05-17T05:02:46Z
progress: 100%
prd: .claude/prds/cc-profile-switch-mvp.md
github: https://github.com/wubq511/cc-profile-switch/issues/1
---

# Epic: cc-profile-switch-mvp

## Overview

Build the CC-Profile-Switch MVP as a Windows-only TypeScript CLI named `ccps`. The CLI manages local Claude Code user-level configuration profiles and launches Claude Code from the user's current project directory with `CLAUDE_CONFIG_DIR` pointing at the selected profile's `claude-home`.

The core product behavior is Global User Config Switch Mode:

- switch user-level Claude Code config by profile
- preserve current project cwd
- preserve project-level Claude Code config
- never copy, overwrite, or mutate the real `C:\Users\h\.claude`
- validate before real launch
- provide dry-run before process execution

## Architecture Decisions

### CLI runtime

Use Node.js LTS with TypeScript. Commander owns CLI parsing. Command handlers stay thin and delegate to core modules.

### Platform boundary

The MVP is Windows-only. Windows path resolution, process spawning, command lookup, and editor opening live under `src/platform/`.

### Data root

All ccps-managed data lives under:

```text
%USERPROFILE%\.cc-profile-switch\
```

The real Claude Code user directory is explicitly out of bounds:

```text
C:\Users\h\.claude
```

### Profile shape

Each profile uses:

```text
profiles\<name>\
  profile.json
  claude-home\
    CLAUDE.md
    settings.json
    skills\
    agents\
  mcp.json
  plugins\
```

`claude-home` is the exact directory passed to `CLAUDE_CONFIG_DIR`.

### Launch model

Launch from the user's current working directory:

```ts
spawn('claude', args, {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: profile.claudeHomePath
  }
})
```

Do not use runtime project isolation. Do not use `--add-dir` for the current project. Do not change cwd to a tool-managed directory.

### MCP default

Default MCP mode is `merge`: pass `--mcp-config <profile>\mcp.json` when present, without `--strict-mcp-config`. Strict MCP is opt-in only.

### Safety model

Every path must resolve to an absolute path and remain inside the expected base directory. Launch is blocked by invalid manifests, invalid JSON, missing required files, path traversal, or high-risk sensitive filenames.

### Verification-first launch

Real launch is implemented only after `launch --dry-run`, profile validation, and a manual verification document are in place.

## Technical Approach

### Frontend Components

Not applicable. MVP has no GUI, TUI, web UI, or mobile UI.

### Backend Services

No backend service. The implementation is a local CLI with these internal modules:

- `src/index.ts`: binary entry and Commander setup
- `src/commands/*`: command handlers
- `src/core/app-config.ts`: app home and `config.json`
- `src/core/profile.ts`: profile discovery, creation, path resolution, manifest loading
- `src/core/profile-template.ts`: default profile templates
- `src/core/validator.ts`: JSON, structure, sensitive filename, and path safety validation
- `src/core/launcher.ts`: launch-plan construction, dry-run printing, real launch execution
- `src/platform/windows-path.ts`: Windows path helpers and containment checks
- `src/platform/process.ts`: command lookup and `spawn`
- `src/platform/editor.ts`: editor/default opener integration
- `src/schemas/*`: Zod schemas for app config and profile manifests
- `src/utils/*`: logger and error formatting

### Infrastructure

No remote infrastructure. Storage is local filesystem only. Tests use temporary directories and must not touch real Claude Code config.

## Implementation Strategy

1. Establish project skeleton and CLI entry before implementing business behavior.
2. Implement Windows path helpers and structured error handling early, because every profile operation depends on path safety.
3. Implement app config and profile templates using the final `claude-home` structure.
4. Implement profile lifecycle commands before launch: `init`, `list`, `create`, `show`, `validate`, `backup`, and `edit`.
5. Implement `launch --dry-run` and launch-plan tests before real process spawning.
6. Create `VERIFY-CLAUDE-CODE-BEHAVIOR.md` and run manual checks against the installed Claude Code CLI.
7. Implement real `launch` only after validation and dry-run are stable.
8. Finish README with install, local dev, command usage, safety boundaries, and verification steps.

## Task Breakdown Preview

1. Project setup and CLI skeleton
   - Configure `package.json`, TypeScript, tsup, Vitest, ESLint/Prettier scripts, `bin`, and `src/index.ts`.
   - Implement `ccps --help` with no profile side effects.
   - Parallel: documentation placeholders can be drafted while CLI skeleton is built.

2. Windows path, error, and schema foundations
   - Implement path containment, safe absolute resolution, profile name validation, structured errors, and Zod schemas.
   - Parallel: unit tests for schemas and path traversal can run independently from command handlers.

3. App config and profile template system
   - Implement `%USERPROFILE%\.cc-profile-switch` resolution, `config.json`, default templates, and non-overwriting file creation.
   - Parallel: template content review can happen separately from filesystem tests.

4. `init` and `create`
   - Create default profiles and user-created profiles with the final `claude-home` layout.
   - Ensure repeated init and duplicate create never overwrite user files.

5. `list`, `show`, and `validate`
   - List profiles with status, show profile structure, and validate required files, directories, JSON, path safety, and sensitive filenames.
   - Parallel: validator tests can be split by missing files, invalid JSON, and sensitive scan cases.

6. `backup` and `edit`
   - Implement timestamped profile backup and approved file/directory opening.
   - Keep edit path mapping constrained to `CLAUDE.md`, `settings.json`, `mcp.json`, `profile.json`, or the profile directory.

7. Launch plan and `launch --dry-run`
   - Build launch plan with cwd, env diff, MCP args, plugin dirs, warnings, and validation result.
   - Print dry-run without spawning any process.

8. Claude Code behavior verification
   - Add `VERIFY-CLAUDE-CODE-BEHAVIOR.md`.
   - Verify marker behavior, settings source, project config preservation, MCP merge behavior, plugin behavior, auth/session behavior, and auto memory behavior.

9. Real launch and README
   - Implement `spawn('claude', args, { cwd, stdio: 'inherit', shell: false, env })`.
   - Update last-used metadata when launch succeeds.
   - Document install, local development, usage examples, safety rules, troubleshooting, and verification results.

## Dependencies

- The project skeleton must exist before command modules can be wired.
- Path utilities and schemas must land before profile file operations.
- App config and template generation must land before `init` and `create`.
- Validation must land before real launch.
- `launch --dry-run` must land before real launch.
- Manual verification requires Claude Code CLI available on the local Windows machine.

## Success Criteria (Technical)

- `npm run check` passes after implementation.
- Unit tests cover profile name validation, path traversal blocking, JSON validation, sensitive filename scanning, template creation, backup copy behavior, MCP launch args, plugin dir args, and dry-run launch-plan generation.
- Integration tests cover `init`, `create`, `list`, `show`, `validate`, `backup`, and `launch --dry-run` using a temporary app home.
- Real launch uses current cwd and `CLAUDE_CONFIG_DIR=<profile>\claude-home`.
- No test or implementation reads from, copies, writes, or deletes `C:\Users\h\.claude`.
- `VERIFY-CLAUDE-CODE-BEHAVIOR.md` records the marker verification and any observed Claude Code limitations.
- README lets a Windows user run the full MVP flow locally.

## Estimated Effort

Medium. The CLI surface is small, but correctness depends on path safety, non-overwriting filesystem operations, launch-plan clarity, and manual Claude Code behavior verification.

Expected implementation shape:

- 2-3 focused passes for skeleton, core profile management, and validation
- 1 focused pass for launch dry-run and real launch
- 1 verification/documentation pass

## Tasks Created

- [x] #2 - Project Setup and CLI Skeleton (parallel: false)
- [x] #3 - Windows Path, Errors, and Schemas (parallel: false)
- [x] #4 - App Config and Profile Templates (parallel: false)
- [x] #5 - Init and Create Commands (parallel: true)
- [x] #6 - List, Show, and Validate Commands (parallel: true)
- [x] #7 - Backup and Edit Commands (parallel: true)
- [x] #8 - Launch Plan and Dry Run (parallel: false)
- [x] #9 - Claude Code Behavior Verification Document (parallel: true)
- [x] #10 - Real Launch and README (parallel: false)

Total tasks: 9
Parallel tasks: 4
Sequential tasks: 5
Estimated total effort: 52 hours
