# Claude Code Behavior Verification

Status: real verification completed with API settings supplied explicitly.
Date: 2026-05-16
Observed Claude Code CLI: `2.1.143 (Claude Code)`

## Scope

This document verifies, or explicitly queues for manual verification, the behavior that `ccps`
depends on before real launch is implemented:

- `CLAUDE_CONFIG_DIR` should replace the user-level Claude Code config source with the selected profile `claude-home`.
- Project-level config should still load from the launch current working directory.
- Profile MCP config should be additive by default and strict only when explicitly requested.
- Auth, session, history, and cache behavior should be observed only as file locations or prompts, never by copying or reading sensitive contents.

`ccps launch <profile> --dry-run` exists today. Real `ccps launch <profile>` is intentionally not implemented yet, so real Claude Code behavior must be checked manually with an equivalent environment setup before issue #10 proceeds.

## Safety Rules

- Do not copy, migrate, or open OAuth, session, token, credential, cache, transcript, or history contents.
- Prefer an isolated temporary `USERPROFILE` for verification.
- If a real `%USERPROFILE%\.claude\CLAUDE.md` must be edited, back it up first and restore it after the check.
- Do not use real secrets as marker text.
- Record only file paths and high-level behavior, not sensitive file contents.

## Marker Strings

Use these exact marker values:

```text
GLOBAL_ORIGINAL_MARKER=CCPS_VERIFY_GLOBAL_ORIGINAL_MARKER
PROFILE_CODING_MARKER=CCPS_VERIFY_PROFILE_CODING_MARKER
PROJECT_MARKER=CCPS_VERIFY_PROJECT_MARKER
```

Expected marker visibility during a profile launch:

| Marker | Expected result |
|---|---|
| `GLOBAL_ORIGINAL_MARKER` | Not visible when `CLAUDE_CONFIG_DIR` points at the profile `claude-home` |
| `PROFILE_CODING_MARKER` | Visible from the selected profile `claude-home\CLAUDE.md` |
| `PROJECT_MARKER` | Visible from the launch cwd project `CLAUDE.md` |

## Automated Evidence Collected

The following checks were run without starting Claude Code:

```powershell
claude --version
claude --help
npm run dev -- init
npm run dev -- launch coding --dry-run --cwd <temp-project>
```

Observed:

- Claude Code CLI version was `2.1.143`.
- Claude Code supports `-p/--print`, `--no-session-persistence`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, and `--plugin-dir`.
- `ccps launch coding --dry-run` validated an isolated profile and printed:
  - selected profile name
  - profile root
  - `claude-home`
  - launch cwd
  - MCP mode `merge`
  - `--mcp-config <profile>\mcp.json`
  - `CLAUDE_CONFIG_DIR=<profile>\claude-home`
  - validation result `valid`
  - `Dry run: Claude Code was not started.`
- Dry-run did not create Claude Code session, history, or cache files.

## Isolated Manual Setup

Use this setup to avoid touching the real `C:\Users\h\.claude` during verification:

```powershell
$VerifyRoot = Join-Path $env:TEMP "ccps-claude-verify"
$TempUser = Join-Path $VerifyRoot "user"
$Project = Join-Path $VerifyRoot "project"

New-Item -ItemType Directory -Path $TempUser -Force | Out-Null
New-Item -ItemType Directory -Path $Project -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $TempUser ".claude") -Force | Out-Null

$OldUserProfile = $env:USERPROFILE
$env:USERPROFILE = $TempUser

npm run dev -- init

Set-Content -Path (Join-Path $TempUser ".claude\CLAUDE.md") -Value @"
# Original Global Claude Config
GLOBAL_ORIGINAL_MARKER=CCPS_VERIFY_GLOBAL_ORIGINAL_MARKER
"@

$ProfileClaudeHome = Join-Path $TempUser ".cc-profile-switch\profiles\coding\claude-home"
Add-Content -Path (Join-Path $ProfileClaudeHome "CLAUDE.md") -Value @"

PROFILE_CODING_MARKER=CCPS_VERIFY_PROFILE_CODING_MARKER
"@

Set-Content -Path (Join-Path $Project "CLAUDE.md") -Value @"
# Project Claude Config
PROJECT_MARKER=CCPS_VERIFY_PROJECT_MARKER
"@
```

Restore `$env:USERPROFILE` when verification is finished:

```powershell
$env:USERPROFILE = $OldUserProfile
```

## Dry-Run Verification

Command:

```powershell
$env:USERPROFILE = $TempUser
npm run dev -- launch coding --dry-run --cwd $Project
```

Expected result:

- `Profile path` points inside `$TempUser\.cc-profile-switch\profiles\coding`.
- `Claude home` points to `$TempUser\.cc-profile-switch\profiles\coding\claude-home`.
- `Cwd` equals `$Project`.
- `Args` include `--mcp-config` and the profile `mcp.json`.
- `Args` do not include `--strict-mcp-config` for default merge mode.
- `CLAUDE_CONFIG_DIR` equals the profile `claude-home`.
- Output says Claude Code was not started.

Current result: pass in isolated dry-run.

## Real Claude Code Verification

Run this only when manual Claude Code execution is acceptable. It may use existing Claude Code authentication and may call the model.

Until real `ccps launch` exists, use an equivalent environment:

```powershell
$env:USERPROFILE = $TempUser
$env:CLAUDE_CONFIG_DIR = $ProfileClaudeHome
Push-Location $Project

claude -p --no-session-persistence --settings C:\Users\h\.claude\settings.json --max-budget-usd 0.20 @"
Reply with only a JSON object showing whether these marker strings are present in your loaded instructions:
GLOBAL_ORIGINAL_MARKER
PROFILE_CODING_MARKER
PROJECT_MARKER
"@

Pop-Location
```

Expected JSON meaning:

- `GLOBAL_ORIGINAL_MARKER`: `false`
- `PROFILE_CODING_MARKER`: `true`
- `PROJECT_MARKER`: `true`

If Claude Code requires authentication for the isolated profile without explicit API settings, record the prompt as:

```text
auth_required: true
profile: coding
```

Do not copy tokens, session files, or credential contents into this repository.

Observed on 2026-05-16 without explicit API settings:

```text
Not logged in · Please run /login
```

This occurred with:

- isolated `USERPROFILE`
- isolated `CLAUDE_CONFIG_DIR`
- `claude -p --no-session-persistence --max-budget-usd 0.05`

It also occurred when `USERPROFILE` was restored to the real user but `CLAUDE_CONFIG_DIR` still pointed at the isolated profile `claude-home`. That is evidence that Claude Code OAuth/keychain-style authentication is profile-specific under `CLAUDE_CONFIG_DIR`.

Observed on 2026-05-16 with the existing API settings passed explicitly via `--settings C:\Users\h\.claude\settings.json`:

```json
{
  "GLOBAL_ORIGINAL_MARKER": false,
  "PROFILE_CODING_MARKER": true,
  "PROJECT_MARKER": true
}
```

The real user settings file was not copied into the profile, committed, or printed. It was passed to Claude Code as an existing local settings file so Claude Code could load the configured API environment itself.

## Settings, Agents, Skills, Plugins, and MCP

Use the same isolated `$TempUser` and `$Project`.

| Area | Planned check | Expected result | Current result |
|---|---|---|---|
| User settings | Add a benign observable `env` marker to `$ProfileClaudeHome\settings.json`; ask Claude Code to run `node -e` and report the environment. | User setting from profile is active. | Pass: `CCPS_PROFILE_SETTINGS_MARKER=profile-settings-visible` reached the tool subprocess |
| Project settings | Add a benign project `env` marker to `$Project\.claude\settings.json`; ask Claude Code to run `node -e` and report the environment. | Project setting remains active with profile user config. | Pass: `CCPS_PROJECT_SETTINGS_MARKER=project-settings-visible` reached the tool subprocess |
| Agents | Add `ccps-marker-agent` under `$ProfileClaudeHome\agents`; ask whether it is visible in the loaded context. | Profile user-level agent is available. | Pass: Claude Code reported `ccps-marker-agent: true` |
| Skills | Add `ccps-marker-skill` under `$ProfileClaudeHome\skills`; ask whether it is visible in the loaded context. | Profile user-level skill is available. | Pass: Claude Code reported `ccps-marker-skill: true` |
| Plugins | Run `claude --plugin-dir=<profile>\plugins plugin list --json`. | Explicit plugin dir is recognized for the session. | Pass: plugin list included `plugins@inline` with `scope: session` and the profile plugins path |
| MCP project discovery | Add one harmless project MCP server in `$Project\.mcp.json`; run `claude mcp list` from `$Project`. | Project MCP config is visible to Claude Code. | Pass: project MCP server was listed |
| MCP merge | Add one harmless profile MCP server in profile `mcp.json` and one harmless project MCP server in `$Project\.mcp.json`; run with profile `--mcp-config`. | Both profile and project MCP configs are available. | Pass: `claude -p` returned both `CCPS_PROFILE_MCP_MARKER` and `CCPS_PROJECT_MCP_MARKER` |
| MCP strict | Repeat with `--strict-mcp-config`. | Project MCP config is not loaded in strict mode. | Pass: `claude -p` returned profile MCP marker and `projectAvailable: false` |

If a behavior depends on Claude Code version or cannot be checked safely, mark it as `unknown` with the Claude Code version.

## Auth, Session, History, and Cache Locations

After a real manual run, record path names only:

```powershell
Get-ChildItem -Force -Recurse $ProfileClaudeHome |
  Where-Object { $_.Name -match 'session|history|cache|oauth|token|credential' } |
  Select-Object FullName

Get-ChildItem -Force -Recurse (Join-Path $TempUser ".claude") |
  Where-Object { $_.Name -match 'session|history|cache|oauth|token|credential' } |
  Select-Object FullName
```

Do not run `Get-Content` on any matching file.

Current result:

- Dry-run created no Claude Code session, history, or cache files.
- Real Claude Code run without explicit API settings stopped at `Not logged in · Please run /login`.
- Real Claude Code run with explicit API settings completed marker, settings, agents, skills, plugin-dir, and MCP checks.
- The profile `claude-home` gained session-related directories:
  `C:\Users\h\AppData\Local\Temp\ccps-claude-verify-1f8bd5ceaefc4bbeb11c79d4deddc844\user\.cc-profile-switch\profiles\coding\claude-home\session-env`
  `C:\Users\h\AppData\Local\Temp\ccps-claude-verify-1f8bd5ceaefc4bbeb11c79d4deddc844\user\.cc-profile-switch\profiles\coding\claude-home\sessions`
- The isolated original global config directory had no matching auth/session/history/cache paths.
- The isolated `USERPROFILE\AppData\Roaming` directory was created, with no sensitive file contents inspected.

## Result Matrix

| Behavior | Status | Evidence |
|---|---|---|
| `ccps launch --dry-run` validates profile before planning | Pass | Isolated dry-run printed `Validation: valid` |
| Dry-run sets `CLAUDE_CONFIG_DIR` to profile `claude-home` | Pass | Isolated dry-run printed the expected env change |
| Dry-run keeps launch cwd as project cwd | Pass | Isolated dry-run printed the explicit temp project path |
| Default MCP mode avoids `--strict-mcp-config` | Pass | Isolated dry-run args included only `--mcp-config` |
| Dry-run never starts Claude Code | Pass | Output included `Dry run: Claude Code was not started.` |
| Profile `CLAUDE.md` replaces real global `CLAUDE.md` | Pass | Marker result: global false, profile true |
| Project `CLAUDE.md` still loads from cwd | Pass | Marker result: project true |
| User settings behavior | Pass | Profile settings env marker reached tool subprocess |
| Project settings behavior | Pass | Project settings env marker reached tool subprocess |
| Agents behavior | Pass | Profile agent marker fixture was visible |
| Skills behavior | Pass | Profile skill marker fixture was visible |
| Plugins behavior | Pass | Explicit `--plugin-dir=<profile>\plugins` appeared as session plugin path |
| MCP project discovery | Pass | `claude mcp list` listed project `.mcp.json` server without auth |
| MCP merge/strict behavior | Pass | Merge exposed profile and project MCP markers; strict exposed profile only |
| Separate auth per profile | Pass | Isolated `CLAUDE_CONFIG_DIR` returned `Not logged in` without explicit API settings, even with real `USERPROFILE` |
| API settings can be supplied explicitly | Pass | `--settings C:\Users\h\.claude\settings.json` enabled model execution without copying credentials |
| Session/history/cache locations | Partial | Runs created profile `session-env` and `sessions` directories; no sensitive contents inspected |

## Gate for Issue #10

Issue #10 can implement real launch with these constraints:

1. Keep `CLAUDE_CONFIG_DIR=<profile>\claude-home`.
2. Keep cwd as the project directory.
3. Use merge MCP by default and strict MCP only when explicitly configured.
4. Do not copy or migrate credentials into profiles.
5. Document that OAuth/keychain-style auth appears profile-specific under `CLAUDE_CONFIG_DIR`.
6. Document that API-based users can keep API auth outside the profile and pass it through the process environment or an explicit settings mechanism.
7. Treat `session-env` and `sessions` as Claude Code-created profile state, and do not inspect or migrate their contents.
