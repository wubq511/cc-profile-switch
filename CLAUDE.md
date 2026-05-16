This file provides guidance to Coding Agents(claude code, codex...) when working with code in this repository.

## Project

CC-Profile-Switch (`ccps`) — Windows-only Node.js CLI that switches Claude Code user-level global configuration by profile (coding/study/work/research/general), while preserving project-level config.

## Core concept

```
cd D:\Projects\my-app
ccps launch coding
```

This starts Claude Code from `D:\Projects\my-app`, sets `CLAUDE_CONFIG_DIR` to the profile's `claude-home`, keeps project config active, and never touches the real `C:\Users\h\.claude`.

**Default launch mode: Global User Config Switch Mode** — switch user scope only, preserve project scope.

## Tech stack

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

## Source structure

```
src/
  index.ts          # CLI entry, commander setup
  commands/         # CLI command handlers (parse args → call core → output)
  core/             # Business logic: app-config, profile, validator, launcher
  platform/         # Windows-specific: paths, process spawn, editor
  schemas/          # Zod schemas for config.json, profile.json
  templates/        # Profile template files
  utils/            # Logger, error formatting
test/
```

## Profile data structure

```
%USERPROFILE%\.cc-profile-switch\
  config.json
  profiles\
    <name>\
      profile.json          # name, description, template, launch config
      claude-home\          # simulates ~/.claude for this profile
        CLAUDE.md
        settings.json
        skills\
        agents\
      mcp.json
      plugins\
  backups\
```

`claude-home` is the user-level config source per profile. It maps to `CLAUDE_CONFIG_DIR` at launch.

## MVP commands

| Command | Purpose |
|---|---|
| `ccps init` | Create app home + 5 default profiles (coding/study/work/research/general) |
| `ccps list` | List profiles with status (valid/warning/error) |
| `ccps create <name> --template <t>` | Create profile from template (coding/study/work/research/general/blank) |
| `ccps show <name>` | Display profile structure and file status |
| `ccps edit <name> [file]` | Open profile file with default editor |
| `ccps validate <name>` | Check JSON validity, required files, sensitive filenames |
| `ccps backup <name>` | Copy profile to backups/<name>-YYYYMMDD-HHmmss/ |
| `ccps launch <name>` | Start Claude Code from cwd with profile's CLAUDE_CONFIG_DIR |

## Launch behavior

```ts
spawn('claude', args, {
  cwd: process.cwd(),           // never change to tool runtime dir
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: profile.claudeHomePath
  }
})
```

MCP default: `mcpMode = "merge"` — pass `--mcp-config <profile>\mcp.json` without `--strict-mcp-config`, so project `.mcp.json` still loads. Strict mode is opt-in only.

## Safety rules (hard constraints)

**Never:**
- Copy or overwrite `C:\Users\h\.claude`
- Modify project `.claude` or project config files
- Read/migrate OAuth, session, token, history, cache
- Use `--strict-mcp-config` as default
- Change cwd to tool runtime directory
- Use `--add-dir` to access current project

**Always:**
- Resolve paths to absolute with Node `path` API
- Block path traversal
- Validate profile before launch
- Support `--dry-run` on launch
- Use args array for spawn, never shell string concatenation
- Scan for sensitive filenames (token, secret, credential, session, oauth)

## Implementation order (strict)

1. Project setup + path utilities
2. App config
3. Profile templates (claude-home structure)
4. `init`
5. `list`
6. `create`
7. `show`
8. `validate`
9. `backup`
10. `edit`
11. `launch --dry-run`
12. Claude Code behavior verification
13. Real `launch`
14. README

Do not implement real launch before dry-run and validation are stable.

## MVP exclusions

No TUI, GUI, cloud sync, multi-account switching, OAuth/session migration, plugin marketplace, macOS/Linux support, or runtime project isolation mode.
