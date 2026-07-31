# Plugin Lifecycle Profile Targeting Probe — Windows Re-run

Status: decision evidence
Probed: 2026-07-31
Upstream: `claude` CLI 2.1.220 (Claude Code), Windows (win32 x64), `windows-latest` GitHub Actions runner, Node 24
Wayfinder ticket: [#45](https://github.com/wubq511/cc-profile-switch/issues/45)
macOS original: [`plugin-lifecycle-profile-targeting-probe.md`](plugin-lifecycle-profile-targeting-probe.md) ([#42](https://github.com/wubq511/cc-profile-switch/issues/42))
Run: [actions/runs/30610956148](https://github.com/wubq511/cc-profile-switch/actions/runs/30610956148)

## Verdict

The Windows re-run **matches the macOS findings in full**. All 20 probed
`claude plugin` / `claude plugin marketplace` operations, run headless with
`CLAUDE_CONFIG_DIR=<temp-profile>/claude-home`, exited 0 and read and wrote
**only the selected Profile**. The real user Claude directory
(`C:\Users\runneradmin\.claude`) and the real `.claude.json` /
`.claude\settings.json` were **absent at baseline and were never created or
touched** by any of the 20 commands — not even the session-noise directories
that #42 excluded from its per-step watch on macOS.

The delegated Plugins lifecycle row resolved in
[#28](https://github.com/wubq511/cc-profile-switch/issues/28) therefore stands
on Windows with no Inspect-only fallback, and the Windows residual gap noted
in the macOS probe is closed.

## Method

Reusable harness (merged into `codex/terminal-profile-experience-wayfinding`):

- `scripts/probe-plugin-targeting-windows.ts` (`npm run probe:plugins-windows`)
  drives the full lifecycle and hashes the real home before and after **every
  command**; it exits non-zero if any guarded write escapes the Profile.
- `.github/workflows/plugin-targeting-probe.yml` installs the current
  `@anthropic-ai/claude-code` npm package on `windows-latest` and invokes the
  probe's native binary directly
  (`<npm-root>/@anthropic-ai/claude-code/bin/claude.exe`), so the run never
  depends on `.cmd`/`.ps1` shim resolution.
- Raw evidence uploaded as the `plugin-targeting-proof-windows` artifact
  (`probe-output/plugin-targeting-windows-{log.txt,evidence.json}`).

The marketplace fixtures mirror #42: a directory-source marketplace with one
plugin (real 0.1.0 → 0.2.0 update path) and the GitHub-source marketplace
`wubq511/agy-plugin-cc`.

## Evidence per operation

`CLHOME` = `<temp-profile>/claude-home` =
`C:\Users\RUNNER~1\AppData\Local\Temp\ccps-plugin-probe-win-*\profile\claude-home`.
Every step: exit 0, **zero** real-home writes (guarded and session-noise
alike), real dotfiles unchanged (absent throughout).

| # | Command | Profile writes |
|---|---------|----------------|
| 1 | `plugin list --json` (empty) | `CLHOME/.claude.json` (created), `CLHOME/backups/.claude.json.backup.*` |
| 2 | `plugin list --available --json` | `CLHOME/plugins/plugin-catalog-cache.json`, `CLHOME/.claude.json` |
| 3 | `plugin marketplace list` (empty) | — |
| 4 | `plugin marketplace add <local-dir>` | `CLHOME/settings.json`, `CLHOME/plugins/known_marketplaces.json` |
| 5 | `plugin marketplace list` | — |
| 6 | `plugin list --available --json` (after add) | — |
| 7 | `plugin install probe-plugin@probe-marketplace --scope user` | `CLHOME/settings.json`, `CLHOME/plugins/cache/probe-marketplace/probe-plugin/0.1.0/…`, `CLHOME/plugins/installed_plugins.json` |
| 8 | `plugin list --json` | — |
| 9 | `plugin disable probe-plugin@probe-marketplace` | `CLHOME/settings.json` |
| 10 | `plugin enable probe-plugin@probe-marketplace` | `CLHOME/settings.json` |
| 11 | `plugin update …` (no newer version) | — |
| 12 | `plugin marketplace update probe-marketplace` (source bumped to 0.2.0) | `CLHOME/plugins/known_marketplaces.json` |
| 13 | `plugin update …` (0.1.0 → 0.2.0) | cache: `0.1.0/.orphaned_at` + new `0.2.0/…`, `CLHOME/plugins/installed_plugins.json` |
| 14 | `plugin list --json` (shows 0.2.0) | — |
| 15 | `plugin uninstall …` (0.2.0) | `CLHOME/settings.json`, `0.2.0/.orphaned_at`, `installed_plugins.json` |
| 16 | `plugin marketplace remove probe-marketplace` | `CLHOME/settings.json`, `CLHOME/plugins/known_marketplaces.json` |
| 17 | `plugin marketplace list` (empty again) | — |
| 18 | `plugin marketplace add wubq511/agy-plugin-cc` (GitHub source) | `CLHOME/settings.json`, `CLHOME/plugins/known_marketplaces.json`, full clone under `CLHOME/plugins/marketplaces/agy-plugin-cc/` |
| 19 | `plugin marketplace update agy-plugin-cc` | `CLHOME/plugins/known_marketplaces.json` |
| 20 | `plugin marketplace remove agy-plugin-cc` | `CLHOME/settings.json`, `CLHOME/plugins/known_marketplaces.json`; clone directory deleted (52 files removed) |

Final Profile state after remove-all matches macOS byte-for-byte in shape:
`settings.json` = `{ "enabledPlugins": {}, "extraKnownMarketplaces": {} }`,
`installed_plugins.json` = `{ "version": 2, "plugins": {} }`,
`known_marketplaces.json` = `{}`.

## Persistence parity with macOS

Every persistence location from the macOS probe reproduced identically on
Windows:

| State | Location (inside the selected Profile) |
|-------|----------------------------------------|
| Marketplace declarations (user scope) | `claude-home/settings.json` → `extraKnownMarketplaces` |
| Marketplace resolved metadata cache | `claude-home/plugins/known_marketplaces.json` |
| GitHub-source marketplace clones | `claude-home/plugins/marketplaces/<name>/` (deleted on `marketplace remove`) |
| Installed plugin registry | `claude-home/plugins/installed_plugins.json` (schema `version: 2`) |
| Installed plugin payloads | `claude-home/plugins/cache/<marketplace>/<plugin>/<version>/` |
| Superseded versions | kept in cache, marked `.orphaned_at` |
| Enable/disable state | `claude-home/settings.json` → `enabledPlugins` |
| Available-plugin catalog cache | `claude-home/plugins/plugin-catalog-cache.json` |
| First-run Claude state | fresh `claude-home/.claude.json` created on first invocation; the real one is never read-modified |

## Notes

- The clean-runner baseline is *stronger* than the macOS baseline in one
  respect: the real home did not exist at all, so any escape — including
  session-noise creation — would have been detected as new files. None
  appeared.
- The macOS-only cosmetic leftover from #42 (an empty
  `plugins/marketplaces/probe-marketplace/` directory surviving
  directory-source removal) was not tracked file-by-file here (directory
  entries are not hashed); behavior is otherwise identical.
- The remaining bounded gap is unchanged from #42 and platform-independent:
  the `--config key=value` install flow is still unexercised (the probe plugin
  declares no `userConfig` schema). Verify when the first config-declaring
  plugin is adopted.
