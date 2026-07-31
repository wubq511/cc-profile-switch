# Plugin Lifecycle Profile Targeting Probe

Status: decision evidence
Probed: 2026-07-31
Upstream: `claude` CLI 2.1.220 (Claude Code), macOS (darwin)
Wayfinder ticket: [#42](https://github.com/wubq511/cc-profile-switch/issues/42)

## Verdict

Every tested `claude plugin` and `claude plugin marketplace` operation, run
headless with `CLAUDE_CONFIG_DIR=<temp-profile>/claude-home`, read and wrote
**only the selected Profile**. No operation escaped to the real `~/.claude`:
the full real `~/.claude/plugins` tree (894 files, including three configured
marketplaces and their clones) was byte-identical before and after the probe,
and the real `~/.claude.json` and `~/.claude/settings.json` hashes never
changed at any step.

The delegated Plugins lifecycle row resolved in
[#28](https://github.com/wubq511/cc-profile-switch/issues/28) therefore stands
in full — no operation falls back to Inspect-only.

## Method

In the style of the Skills staging probe in
[`skills-ecosystem-integration-contract.md`](skills-ecosystem-integration-contract.md):

1. Created an isolated probe root (`/tmp/ccps-plugin-probe.*`) containing
   `profile/claude-home` (the target `CLAUDE_CONFIG_DIR`) and two local
   marketplaces: a directory-source marketplace with one plugin, and a local
   git repository (to attempt a git-source variant).
2. Baseline snapshot of the real home before any command:
   `shasum -a 256` of all 894 files under the real `~/.claude/plugins`, plus
   the real `~/.claude.json` and `~/.claude/settings.json`.
3. Ran each command with `CLAUDE_CONFIG_DIR=$PROBE/profile/claude-home` and,
   after every step, recorded (a) new/modified files inside the Profile and
   (b) any new/modified files anywhere in the real `~/.claude` (session-noise
   directories `projects|todos|sessions|history|shell-snapshots|statsig|ide|
   __store|debug` excluded from the per-step watch but separately verified
   untouched over the whole probe window).
4. Re-verified the full real `~/.claude/plugins` tree hash listing at the end:
   identical.

## Evidence per operation

`CLHOME` = `<temp-profile>/claude-home`. "Real-home writes" counts writes to
the real `~/.claude` outside the excluded session-noise directories; the
excluded directories were also verified untouched.

| # | Command | Profile writes | Real-home writes |
|---|---------|----------------|------------------|
| 1 | `plugin list --json` (empty) | `CLHOME/.claude.json` (created), `CLHOME/backups/.claude.json.backup.*` | none |
| 2 | `plugin list --available --json` | `CLHOME/plugins/plugin-catalog-cache.json`, `CLHOME/.claude.json` | none |
| 3 | `plugin marketplace list` (empty) | — | none |
| 4 | `plugin marketplace add <local-dir>` | `CLHOME/settings.json`, `CLHOME/plugins/known_marketplaces.json` | none |
| 5 | `plugin marketplace list` | — | none |
| 6 | `plugin list --available --json` (after add) | — | none |
| 7 | `plugin install probe-plugin@probe-marketplace --scope user` | `CLHOME/settings.json`, `CLHOME/plugins/cache/probe-marketplace/probe-plugin/0.1.0/…`, `CLHOME/plugins/installed_plugins.json` | none |
| 8 | `plugin list --json` | — | none |
| 9 | `plugin disable probe-plugin@probe-marketplace` | `CLHOME/settings.json` | none |
| 10 | `plugin enable probe-plugin@probe-marketplace` | `CLHOME/settings.json` | none |
| 11 | `plugin update …` (no newer version) | — | none |
| 12 | `plugin uninstall probe-plugin@probe-marketplace` | `CLHOME/settings.json`, `CLHOME/plugins/cache/…/0.1.0/.orphaned_at`, `CLHOME/plugins/installed_plugins.json` | none |
| 13 | `plugin marketplace update probe-marketplace` (source bumped to 0.2.0) | `CLHOME/plugins/known_marketplaces.json` | none |
| 14 | `plugin update probe-plugin@probe-marketplace` | cache: `0.1.0/.orphaned_at` + new `0.2.0/…`, `CLHOME/plugins/installed_plugins.json` | none |
| 15 | `plugin list --json` (shows 0.2.0) | — | none |
| 16 | `plugin uninstall …` (0.2.0) | `CLHOME/settings.json`, `0.2.0/.orphaned_at`, `installed_plugins.json` | none |
| 17 | `plugin marketplace remove probe-marketplace` | `CLHOME/settings.json`, `CLHOME/plugins/known_marketplaces.json` | none |
| 18 | `plugin marketplace list` (empty again) | — | none |
| 23 | `plugin marketplace add wubq511/agy-plugin-cc` (GitHub source) | `CLHOME/settings.json`, `CLHOME/plugins/known_marketplaces.json`, full clone under `CLHOME/plugins/marketplaces/agy-plugin-cc/` | none |
| 24 | `plugin marketplace update agy-plugin-cc` | `CLHOME/plugins/known_marketplaces.json` | none |
| 25 | `plugin marketplace remove agy-plugin-cc` | `CLHOME/settings.json`, `CLHOME/plugins/known_marketplaces.json`; clone dir deleted | none |

The real `~/.claude.json` hash (`2f6f6f5d…`) and real
`~/.claude/settings.json` hash (`3b160ec7…`) were re-checked after every single
step and never changed. The real-home copies of `known_marketplaces.json`
(`d955b33a…`) and `installed_plugins.json` (`a033a704…`) were likewise
byte-identical at baseline and at the end.

## Where plugin state persists (all inside the selected Profile)

| State | Location |
|-------|----------|
| Marketplace declarations (user scope) | `claude-home/settings.json` → `extraKnownMarketplaces.<name>.source` |
| Marketplace resolved metadata cache | `claude-home/plugins/known_marketplaces.json` (`source`, `installLocation`, `lastUpdated`) |
| GitHub-source marketplace clones | `claude-home/plugins/marketplaces/<name>/` (deleted on `marketplace remove`) |
| Directory-source marketplaces | no clone; `installLocation` points at the user's source directory (read in place) |
| Installed plugin registry | `claude-home/plugins/installed_plugins.json` (schema `version: 2`; id, version, scope, enabled, installPath, timestamps) |
| Installed plugin payloads | `claude-home/plugins/cache/<marketplace>/<plugin>/<version>/` — copied even for directory sources |
| Uninstalled/superseded versions | kept in cache, marked with an `.orphaned_at` file (cleanup belongs to `plugin prune`) |
| Enable/disable state | `claude-home/settings.json` → `enabledPlugins` |
| Available-plugin catalog cache | `claude-home/plugins/plugin-catalog-cache.json` |
| First-run Claude state | a fresh `claude-home/.claude.json` (machineID/userID/migrations) is created on the first CLI invocation; the real `~/.claude.json` is never read-modified |

Final Profile state after remove-all: `settings.json` =
`{ "enabledPlugins": {}, "extraKnownMarketplaces": {} }`,
`installed_plugins.json` = `{ "version": 2, "plugins": {} }`,
`known_marketplaces.json` = `{}` — removals clean up both declaration and
cache. One cosmetic leftover: an empty `plugins/marketplaces/probe-marketplace/`
directory survived the directory-source removal.

## Behavioral notes for the Workbench

- `plugin install` defaults to `--scope user`; passing it explicitly is
  supported and lands in the Profile as shown.
- `plugin update` prints "Restart to apply changes." — the #28 resolution
  already requires surfacing this.
- `plugin update` against a directory-source marketplace re-validates the
  source and copies the new version into the Profile cache, orphaning the old
  version (verified 0.1.0 → 0.2.0).
- `marketplace add` accepts `owner/repo`, `https://…`, or a local path;
  `file://` URLs are rejected ("Invalid marketplace source format").
- `marketplace list` has no `--json`; machine-readable marketplace inventory
  comes from the Profile's own `settings.json` + `known_marketplaces.json`,
  which ccps can read directly.

## Residual gaps (bounded)

- **`--config key=value` install flow:** not exercised — the probe plugin
  declared no `userConfig` schema. Per CLI help, values are "stored via the
  same path as the interactive /plugin configure flow"; enable/disable already
  proves the `settings.json` write path is Profile-targeted, so the risk is
  limited to exactly which `settings.json` key receives `userConfig`. Verify
  when the first config-declaring plugin is adopted.
- **Windows:** this probe ran on macOS only. The targeting contract is
  upstream Claude Code behavior, presumably platform-independent, but a
  Windows re-run is the honest gate before claiming parity (consistent with
  the map's preserve-Windows note).
- `plugin details`, `plugin eval`, `plugin prune`, `plugin init/tag/validate`
  were out of the ticket's command list and unprobed.
