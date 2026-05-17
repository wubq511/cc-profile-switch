# CC-Profile-Switch

`ccps` is a Windows-only Node.js CLI for launching Claude Code with a selected user-level profile while preserving the current project context.

```powershell
cd D:\Projects\my-app
ccps launch coding
```

The launch keeps the Current working directory as the project directory and sets `CLAUDE_CONFIG_DIR` to the selected profile's `claude-home`.

## Install

```powershell
npm install
npm run build
npm link
```

For local development without linking:

```powershell
npm run dev -- --help
npm run dev -- init
npm run dev -- launch coding --dry-run
```

## Commands

```powershell
ccps init
ccps list
ccps create <name> --template <coding|study|work|research|general|blank>
ccps show <name>
ccps validate <name>
ccps backup <name>
ccps edit <name> [CLAUDE.md|settings.json|mcp.json|profile.json]
ccps launch <profile> --dry-run
ccps launch <profile>
```

Use `ccps launch <profile> --dry-run` before real launch to inspect the plan.

## Profile Layout

Profiles live under:

```text
%USERPROFILE%\.cc-profile-switch\
  config.json
  profiles\
    <name>\
      profile.json
      claude-home\
        CLAUDE.md
        settings.json
        skills\
        agents\
      mcp.json
      plugins\
  backups\
```

`claude-home` is passed to Claude Code as `CLAUDE_CONFIG_DIR`. Project-level `CLAUDE.md`, `.claude/settings.json`, `.claude/agents`, `.claude/skills`, and `.mcp.json` remain controlled by the launch cwd.

## Launch Behavior

`ccps launch <profile>` validates the profile, builds the same plan shown by dry-run, then starts Claude Code with:

```ts
spawn('claude', args, {
  cwd,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: profileClaudeHome
  }
})
```

Default MCP mode is `merge`: `ccps` passes `--mcp-config <profile>\mcp.json` and does not pass `--strict-mcp-config`. Strict mode is opt-in through the profile launch config. Profile plugin directories are passed as `--plugin-dir` arguments.

`ccps` never uses `--add-dir` for the current project and never changes cwd to `.cc-profile-switch`.

## Safety Boundaries

`ccps` does not copy, read, migrate, or manage OAuth, session, token, history, cache, or credential contents from the real `C:\Users\<you>\.claude`.

API-based Claude Code users can keep API auth outside the profile and pass it through the process environment or an explicit Claude Code settings mechanism. The verification notes are in `VERIFY-CLAUDE-CODE-BEHAVIOR.md`.

## Verification

```powershell
npm run lint
npm run test
npm run build
npm run check
```

`npm run check` runs lint, tests, and build.
