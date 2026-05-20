This file provides guidance to Coding Agents (Claude Code, Codex, and other coding agents) when working with this repository.

## Project

CC-Profile-Switch (`ccps`) is a Windows-only Node.js CLI that switches Claude Code user-level global configuration by profile while preserving project-level config.

## Core Concept

```powershell
cd D:\Projects\my-app
ccps launch coding
```

This starts Claude Code from `D:\Projects\my-app`, sets `CLAUDE_CONFIG_DIR` to the selected profile's `claude-home`, keeps project config active, and never touches the real `C:\Users\h\.claude`.

Default launch mode: **Global User Config Switch Mode**. Switch user scope only, preserve project scope.

## Tech Stack

TypeScript, Node.js LTS, Commander, Zod, Vitest, tsup, fs-extra, picocolors. Windows-only; PowerShell / Windows Terminal.

## Commands

```bash
npm run dev          # tsx src/index.ts
npm run build        # tsup src/index.ts --format cjs --dts false --clean
npm run start        # node dist/index.js
npm run test         # vitest run
npm run test:watch   # vitest
npm run lint         # eslint .
npm run format       # prettier --write .
npm run check        # lint + test + build
```

Binary entry: `"bin": { "ccps": "dist/index.js" }`. Use `npm link` for local dev.

## Source Structure

```text
src/
  index.ts          # CLI entry, commander setup
  commands/         # CLI command handlers (parse args -> call core -> output)
  core/             # app-config, profile, profile-management, validator, launcher
  platform/         # Windows-specific paths, process spawn, editor
  schemas/          # Zod schemas for config.json, profile.json
  templates/        # Profile template files
  tui/              # Lightweight terminal UI controller and readline adapter
  utils/            # Logger, error formatting
test/
```

## Profile Data Structure

```text
%USERPROFILE%\.cc-profile-switch\
  config.json
  api-settings.json          # optional common API env
  profiles\
    <name>\
      profile.json           # name, description, template, launch config
      claude-home\           # profile-scoped user config source
        CLAUDE.md            # profile-scoped user memory / instructions
        settings.json        # autoMemoryDirectory + env overrides
        memory\
          auto\
        skills\
        agents\
        plugins\             # Claude Code-managed user plugin state
        projects\            # Claude Code-created user/project state
        sessions\            # Claude Code-created session state
      mcp.json               # ccps-provided profile MCP config passed with --mcp-config
  backups\
```

`claude-home` maps to `CLAUDE_CONFIG_DIR` at launch. Project `CLAUDE.md`, `.claude/settings.json`, `.claude/agents`, `.claude/skills`, and `.mcp.json` still come from the launch cwd.

New profiles include `CLAUDE_CODE_ATTRIBUTION_HEADER=0` in `claude-home\settings.json` `env`. Re-running `ccps init` backfills this key for preserved default profiles when missing, without overwriting existing settings fields or env keys.

## Current CLI Surface

| Command | Purpose |
|---|---|
| `ccps init` | Create app home and default profiles. |
| `ccps list` | List profiles with launch-readiness status. |
| `ccps create <name> --template <t>` | Create a profile from a built-in template. |
| `ccps show <name>` | Display profile structure and file status. |
| `ccps edit <name> [file-or-folder]` | Open the profile folder or an existing safe target in VS Code. |
| `ccps validate <name>` | Check launch readiness: required files/dirs, JSON/schema, auto memory path, launch path safety. |
| `ccps backup <name>` | Copy profile to `backups\<name>-YYYYMMDD-HHmmss\`. |
| `ccps copy <from> <to>` | Copy a profile to a new name without overwriting existing profiles. |
| `ccps rename <old> <new>` | Rename a profile and update default/last-used references. |
| `ccps remove <name>` | Back up, exact-name confirm, then remove a profile; default/last-used references are cleared. |
| `ccps default [name]` | Show or set the default profile; `--clear` clears it. |
| `ccps launch [profile]` | Start Claude Code from cwd with the selected/default profile. |
| `ccps tui` | Lightweight terminal helper over the same core services; not a GUI or separate product mode. |

## Launch Behavior

```ts
spawn('claude', args, {
  cwd,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    ...apiEnv,
    CLAUDE_CONFIG_DIR: profileClaudeHome,
  },
});
```

MCP default: `mcpMode = "merge"` passes `--mcp-config <profile>\mcp.json` without `--strict-mcp-config`, so project `.mcp.json` still loads. Strict mode is opt-in only.

Launch defaults:

- Add `--dangerously-skip-permissions` unless `profile.json` sets `launch.skipPermissions` to `false`.
- Use `ccps default <profile>` when `ccps launch` omits `[profile]`.
- Common `%USERPROFILE%\.cc-profile-switch\api-settings.json` env merges with profile `claude-home\settings.json` env; profile wins.
- `autoMemoryDirectory` must point to `<profile>\claude-home\memory\auto`.

## Safety Rules

Never:

- Copy or overwrite `C:\Users\h\.claude`.
- Modify project `.claude` or project config files.
- Read/migrate OAuth, session, token, history, cache, or credential contents.
- Use `--strict-mcp-config` as default.
- Change cwd to the tool runtime directory.
- Use `--add-dir` for current-project access.

Always:

- Resolve paths to absolute paths with Node `path` APIs.
- Block path traversal.
- Validate profile launch readiness before launch.
- Keep dry-run and real launch plan behavior in parity.
- Use args arrays for spawn, never shell string concatenation.
- Keep CLI and TUI behavior routed through shared core services.

`ccps validate` is launch-readiness only. Runtime/cache/session filename matches do not block launch. `ccps edit` still blocks path traversal and credential-like target names; future export/import flows must handle sensitive filenames before packaging or exposing profile contents.

## Completed Baselines

MVP baseline is complete: init, list, create, show, validate, backup, edit, dry-run launch, real launch, README, and Claude Code behavior verification.

V0.2 profile-management-tui is complete:

- Core profile management services for copy, rename, remove, default, and launch default resolution.
- CLI commands for `copy`, `rename`, `remove`, `default`, optional-profile `launch`, and `tui`.
- TUI controller and terminal adapter share the same core services as CLI.
- V0.2 README and roadmap updates.
- Final regression verification recorded in `.claude/epics/profile-management-tui/updates/23/progress.md`.

## Still Excluded

No GUI, cloud sync, multi-account switching, OAuth/session migration, plugin marketplace, macOS/Linux support, or runtime project isolation mode. TUI exists only as a lightweight terminal helper over CLI/core behavior.
