# CC-Profile-Switch Agent Guide

`AGENTS.md` is a symlink to this canonical file. Keep rules here concise and behavior-changing.

## Product Contract

CC-Profile-Switch (`ccps`) is a Node.js CLI for Windows, macOS, and Linux. It switches Claude Code user-level configuration by profile while preserving the launch directory and its project-level configuration.

```bash
cd /path/to/project
ccps launch coding
```

Launch sets `CLAUDE_CONFIG_DIR=<profile>/claude-home`, keeps `cwd` unchanged, and never copies or overwrites the real user Claude directory.

Tech stack: TypeScript, Node.js LTS, Commander, Zod, Vitest, tsup, fs-extra, picocolors.

## Commands

```bash
npm run dev          # tsx src/index.ts
npm run build        # build dist/
npm run start        # run dist/index.js
npm run test         # Vitest once
npm run probe:skills # pinned Skills acquisition proof harness (issue #39)
npm run test:watch
npm run lint
npm run format
npm run check        # lint + test + build
```

Binary entry: `"bin": { "ccps": "dist/index.js" }`. Use `npm link` for local development.

## Code Navigation

Prefer the committed project-local CodeGraph index before broad searches:

```bash
npm run codegraph:status
npm run codegraph:query -- <symbol>
npm run codegraph:explore -- "<question>"
```

Do not require or modify global Codex MCP configuration.

```text
src/
  commands/   CLI parsing and output
  core/       shared application services
  platform/   Windows/macOS/Linux path, process, and editor adapters
  schemas/    Zod schemas
  templates/  profile and skill templates
  tui/        terminal UI over shared core services
  utils/
test/
```

Keep CLI and TUI behavior routed through the same core services.

## Profile Contract

App home is `%USERPROFILE%\.cc-profile-switch` on Windows and `$HOME/.cc-profile-switch` on macOS/Linux.

```text
.cc-profile-switch/
  config.json
  api-settings.json
  profiles/<name>/
    profile.json
    claude-home/
      .claude.json          # Claude-managed state; native user MCP lives here
      CLAUDE.md
      settings.json
      rules/ccps-profile.md
      memory/auto/
      skills/
      agents/
      plugins/
      projects/
      sessions/
    mcp.json                # optional legacy ccps input; never create for new profiles
  backups/
```

New profiles:

- set `launch.mcpMode` to `none`;
- set `CLAUDE_CODE_ATTRIBUTION_HEADER=0`;
- set `autoMemoryDirectory` inside that profile;
- exclude the real user `CLAUDE.md` through `claudeMdExcludes`;
- include the managed `rules/ccps-profile.md` boundary rule.

`ccps init` and `ccps launch` backfill managed settings/rules without overwriting unrelated fields. `ccps init` may import missing string `env.ANTHROPIC_*` keys from the real user `settings.json` into common `api-settings.json`; preserve existing common keys and print names only, never values.

## MCP Contract

Profile-wide MCP is Claude Code native user scope:

```bash
claude mcp add --scope user ...
```

With `CLAUDE_CONFIG_DIR` set, Claude stores this in the selected profile's `claude-home/.claude.json`. Project `.mcp.json` remains project scope. Never put `mcpServers` in `settings.json` or `claude-home/.mcp.json`.

Only older profiles with a non-empty root `mcp.json` may receive legacy `--mcp-config`; `strict` remains explicit opt-in. Do not run `claude mcp get` in an agent-visible terminal because it may print stored secrets. Verify with `claude mcp list` and a restarted session's `/mcp`, reporting names and connection state only.

## Platform Contract

- Windows: resolve home from `USERPROFILE` or `HOMEDRIVE`/`HOMEPATH`; account for `.cmd`/`.bat` shims; open VS Code through PowerShell.
- macOS: resolve home from `HOME`; use `open -a "Visual Studio Code"`; keep the PTY wrapper required by interactive Claude launch.
- Linux: resolve home from `HOME`; use the `code` CLI; launch Claude directly.
- Use Node `path` APIs and argument arrays. Never concatenate shell command strings.
- Platform-specific changes need explicit `win32`, `darwin`, and `linux` tests when the behavior differs.

## Safety

Never:

- copy or overwrite the real `~/.claude`, `~/.claude.json`, or Windows equivalents;
- modify project `.claude`, `CLAUDE.md`, or `.mcp.json`;
- read or migrate OAuth, sessions, tokens, history, caches, or credentials;
- default to `--strict-mcp-config`;
- change launch `cwd` to the tool directory or use `--add-dir` for project access.

Always:

- resolve absolute paths and block traversal;
- validate launch readiness before spawning;
- keep dry-run and real launch plans equivalent;
- use `spawn(command, args, { shell: false })`;
- treat `ccps validate` as launch readiness, not a runtime/cache audit;
- block credential-like targets in `ccps edit`.

## Change and CI Gates

Before every commit or push:

1. run `npm run check`;
2. review the diff for secrets, generated residue, stale platform claims, and unintended files;
3. when templates change, rebuild and confirm committed template output is synchronized;
4. when CodeGraph-tracked source changes, refresh the committed index and confirm it is current.

`.github/workflows/ci.yml` runs the full check on Ubuntu, macOS, and Windows with supported Node.js LTS versions for every pull request and push. A local macOS run does not prove Windows or Linux compatibility. After pushing, wait for every relevant matrix job to pass before merging, releasing, or claiming cross-platform compatibility; skipped, cancelled, or failing jobs are not a pass.

Do not commit, push, merge, release, or publish unless the user requested that action.

## Scope

Current CLI includes init, list, create, show, validate, backup, copy, rename, remove, default, launch, create-profile, edit, and TUI. GUI, cloud sync, multi-account/OAuth migration, plugin marketplace, and runtime project isolation remain out of scope.
