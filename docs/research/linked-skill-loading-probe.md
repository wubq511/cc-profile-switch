# Linked Skill Loading Probe

Status: decision evidence (macOS complete; Windows junction verdict landed in `linked-skill-loading-probe-windows.md`)
Probed: 2026-07-31
Upstream: `claude` CLI 2.1.220 (Claude Code), macOS (darwin arm64), Node 26
Wayfinder ticket: [#49](https://github.com/wubq511/cc-profile-switch/issues/49)
Gates: Linked Skill installation under the provenance and transaction contract
resolved in [#38](https://github.com/wubq511/cc-profile-switch/issues/38)

## Verdict

Claude Code **discovers, loads, and serves a Skill whose directory under
`claude-home/skills/` is a symlink pointing outside `CLAUDE_CONFIG_DIR`**.
Absolute and relative symlinks both work; the linked Skill is listed in the
session's `skills`/`slash_commands` and a `/skill-name` invocation reads
`SKILL.md` through the link and serves the **current** source content — an
edit made at the source between runs was reflected with no copy step.
Malformed links (broken target, link to a plain file) are silently ignored
and never fail startup. The real `~/.claude` was untouched throughout.

The physical realization of Linked Skill installation resolved in
[#38](https://github.com/wubq511/cc-profile-switch/issues/38) is therefore
viable on macOS: install = create one symlink in `claude-home/skills/<name>`
pointing at the Local Skill Source; removal = delete the symlink (the source
is never touched, matching the Recovery Bin semantics of
[#33](https://github.com/wubq511/cc-profile-switch/issues/33)).

Windows matches: the hosted junction run landed in
[`linked-skill-loading-probe-windows.md`](linked-skill-loading-probe-windows.md)
with identical findings, so Linked Skill installation is viable on both
contracted platforms.

## Method

Two evidence layers, both against an isolated probe root
(`/var/folders/.../ccps-link-skill-probe.*`) containing
`claude-home/skills/`, a `source-skills/` directory **outside**
`claude-home`, and an empty `project/` launch cwd.

### Layer 1 — credential-free discovery signal

`claude -p "hi" --output-format stream-json --verbose` with
`CLAUDE_CONFIG_DIR=<probe>/claude-home` and a **dummy** `ANTHROPIC_API_KEY`.
The session init message is emitted before any API call; the model turn then
fails with 401 (expected, zero cost). The init line carries a structured
`skills` array plus `slash_commands` — a parseable, CI-friendly discovery
signal that needs no credentials and never reads the real user's OAuth or
keychain state. Automated harness:
[`scripts/probe-linked-skill.ts`](../../scripts/probe-linked-skill.ts)
(`npm run probe:linked-skill`), evidence in
`probe-output/linked-skill-proof-<platform>-node<major>.json`.

### Layer 2 — real invocation (macOS only)

`/skill-name` prompts in print mode with
`--settings ~/.claude/settings.json` (the user's existing API settings file
is passed by path only, never read or copied — the established precedent from
`VERIFY-CLAUDE-CODE-BEHAVIOR.md`), `--no-session-persistence`,
`--max-budget-usd 0.10`, `--model sonnet`. Each fixture Skill's body
instructs the model to reply with a unique marker.

## Evidence

| #   | Scenario                                                                                | Result                                                                                        |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Absolute symlink `skills/ccps-linked-marker-skill` → source outside `CLAUDE_CONFIG_DIR` | **Discovered** in init `skills` and `slash_commands`                                          |
| 2   | Relative symlink (`../../source-skills/...`) escaping `claude-home`                     | **Discovered**                                                                                |
| 3   | Real-directory control skill                                                            | **Discovered** (control)                                                                      |
| 4   | Broken symlink (target does not exist)                                                  | Silently ignored; init emitted normally; other Skills unaffected                              |
| 5   | Symlink to a plain file (not a Skill directory)                                         | Silently ignored                                                                              |
| 6   | Invocation `/ccps-linked-marker-skill` (real model turn)                                | Replied `CCPS_LINK_PROBE_SKILL_INVOKED_V2` — `SKILL.md` read through the link                 |
| 7   | Invocation `/ccps-rel-linked-skill`                                                     | Replied `CCPS_LINK_PROBE_REL_INVOKED_V2`                                                      |
| 8   | Invocation `/ccps-direct-marker-skill` (control)                                        | Replied `CCPS_LINK_PROBE_DIRECT_INVOKED_V2`                                                   |
| 9   | Source edited between runs (marker V1 → V2 in the source only)                          | Invocation served the **V2** content — source changes appear in the Profile with no copy step |
| 10  | Real-home isolation                                                                     | `~/.claude/skills` and `~/.agents` hash-identical before/after (harness guard)                |

Observations that shape the implementation contract:

- **Security boundary**: Claude Code follows links that escape
  `CLAUDE_CONFIG_DIR` without complaint. There is no confinement of Skill
  loading to the config directory — exactly what Linked Skill installation
  needs, and equally a reason ccps must own link-target validation itself
  (absolute-path resolution and traversal blocking are already ccps safety
  rules).
- **Path resolution**: the Skill's discovered name comes from frontmatter
  read through the link; the install directory name and the frontmatter
  `name` may differ, matching the provenance key choice in #38 (keyed by
  install directory name).
- **`--bare` caveat**: under `--bare` the init `skills` array contains only
  bundled Skills — user Skills from `CLAUDE_CONFIG_DIR` are not listed
  (bare mode skips user configuration). Probes and any future ccps
  verification must run without `--bare`.
- **File-watching / mid-session reload**: not probed — a print-mode session
  is one-shot, so hot reload of a changed source mid-session cannot be
  exercised headless. The session exposes a `/reload-skills` slash command,
  so interactive refresh exists; per-launch freshness (scenario 9) is the
  guarantee Linked Skill installation relies on.

## Windows junction run

Junctions (`mklink /J`, absolute, no admin required) are the Windows
primitive; the harness creates them via `fs.symlinkSync(target, link,
'junction')` and additionally attempts a privileged directory symlink
(recorded, never required). The Layer 1 signal is credential-free, so the
full discovery matrix runs on a hosted runner:

- Harness: `scripts/probe-linked-skill.ts` (`npm run probe:linked-skill`) —
  cross-platform; validated 7/7 on macOS before the Windows run.
- Workflow: `.github/workflows/linked-skill-probe.yml` (`workflow_dispatch`,
  `windows-latest`), invoking the npm package's native `claude.exe`
  directly via `CLAUDE_CLI_BIN`, mirroring the plugin targeting probe of
  [#45](https://github.com/wubq511/cc-profile-switch/issues/45).
- Raw evidence uploads as the `linked-skill-proof-windows` artifact
  (`probe-output/linked-skill-proof-win32-*.json` + log).

Layer 2 (real invocation) stays macOS-only: it needs API credentials, which
the hosted runner must not hold. Discovery already exercises the
filesystem-level path a junction must support — directory enumeration
through the link and `SKILL.md` frontmatter read through the link.

**Windows verdict: landed** in
[`linked-skill-loading-probe-windows.md`](linked-skill-loading-probe-windows.md)
([#50](https://github.com/wubq511/cc-profile-switch/issues/50),
[run 30641028514](https://github.com/wubq511/cc-profile-switch/actions/runs/30641028514)) —
junctions are discovered identically, matching the macOS findings; Linked
Skill installation is viable on both contracted platforms.
