# Linked Skill Loading Probe — Windows Re-run

Status: decision evidence
Probed: 2026-07-31
Upstream: `claude` CLI 2.1.220 (Claude Code), Windows (win32 x64), `windows-latest` GitHub Actions runner, Node 24
Wayfinder ticket: [#50](https://github.com/wubq511/cc-profile-switch/issues/50)
macOS original: [`linked-skill-loading-probe.md`](linked-skill-loading-probe.md) ([#49](https://github.com/wubq511/cc-profile-switch/issues/49))
Run: [actions/runs/30641028514](https://github.com/wubq511/cc-profile-switch/actions/runs/30641028514)

## Verdict

The Windows re-run **matches the macOS findings**. Claude Code discovers a
Skill whose directory under `claude-home/skills/` is a **junction** pointing
outside `CLAUDE_CONFIG_DIR` — the junctioned Skill
`ccps-linked-marker-skill` appeared in the session init `skills` array
alongside the real-directory control. A privileged **directory symlink**
(`ccps-win-symlink-skill`) was also creatable on the runner and was
discovered identically. Broken links and links to plain files were silently
ignored and never failed startup, and the real user home
(`C:\Users\runneradmin\.claude\skills`, `~/.agents`) stayed byte-identical
(or absent) across the probe.

Linked Skill installation under the provenance and transaction contract
resolved in [#38](https://github.com/wubq511/cc-profile-switch/issues/38) is
therefore viable on **both** contracted platforms: install = create one
symlink (macOS) or junction (Windows) in `claude-home/skills/<name>`;
removal = delete the link, never the source.

## Method

Credential-free, mirroring the plugin targeting probe of
[#45](https://github.com/wubq511/cc-profile-switch/issues/45):

- Harness: `scripts/probe-linked-skill.ts` (`npm run probe:linked-skill`) —
  the same cross-platform script validated 7/7 on macOS in #49. On win32 it
  creates the Linked Skill fixture with
  `fs.symlinkSync(target, link, 'junction')` and additionally attempts a
  privileged `'dir'` symlink (recorded, never required).
- Workflow: `.github/workflows/linked-skill-probe.yml` (`workflow_dispatch`,
  `windows-latest`) installs the current `@anthropic-ai/claude-code` npm
  package and invokes its native binary directly
  (`<npm-root>/@anthropic-ai/claude-code/bin/claude.exe` via
  `CLAUDE_CLI_BIN`), so the run never depends on `.cmd`/`.ps1` shim
  resolution.
- Discovery signal: `claude -p "hi" --output-format stream-json --verbose`
  with `CLAUDE_CONFIG_DIR=<temp>/claude-home` and a dummy
  `ANTHROPIC_API_KEY`. The session init message is emitted before any API
  call (the model turn then fails 401, expected), so the runner holds **no
  credentials**; the init line's `skills` array is the evidence. Discovery
  itself exercises both filesystem paths a junction must support: directory
  enumeration through the link and the `SKILL.md` frontmatter read through
  the link.
- Raw evidence: `linked-skill-proof-windows` artifact
  (`probe-output/linked-skill-proof-win32-{log.txt,node24.json}`).

## Evidence

`CLHOME` = `C:\Users\RUNNER~1\AppData\Local\Temp\ccps-linked-skill-probe-*\claude-home`.

| #   | Scenario                                                                        | Result                                                   |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Startup with broken/file links present                                          | Init message emitted normally; no failure                |
| 2   | Real-directory control Skill                                                    | **Discovered**                                           |
| 3   | Junction `skills/ccps-linked-marker-skill` → source outside `CLAUDE_CONFIG_DIR` | **Discovered** in init `skills`                          |
| 4   | Privileged directory symlink `skills/ccps-win-symlink-skill`                    | Created successfully on the runner; **discovered**       |
| 5   | Broken junction (target does not exist)                                         | Silently ignored; absent from init `skills`              |
| 6   | Junction to a plain file                                                        | Silently ignored                                         |
| 7   | Real-home isolation                                                             | `~/.claude/skills` and `~/.agents` unchanged (or absent) |

Scenario results: 6 pass, 1 skip (relative symlink — junctions are
absolute-only on Windows, so a relative-link install is not expressible;
ccps must therefore always create junctions from **absolute** target paths,
which its path-resolution safety rules already mandate).

## Platform notes for the Linked Skill contract

- **macOS**: symlink (absolute or relative) — full discovery, invocation,
  and live-source evidence in
  [`linked-skill-loading-probe.md`](linked-skill-loading-probe.md).
- **Windows**: junction (absolute target only) — discovery proven here.
  Model-turn invocation was not re-run on Windows (the hosted runner holds
  no credentials); discovery already covers the link-level filesystem
  behavior, and the invocation path is platform-independent once the Skill
  is registered.
- **Linux**: out of scope for this effort (map #24 standing decision).
