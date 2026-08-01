# Pinned Skills Acquisition Adapter Proof

Status: task proof (issue #39)
Investigated: 2026-07-31
Upstream pin: `skills@1.5.21` (exact dependency, no range)
Adapter: [`src/core/skills-acquisition.ts`](../../src/core/skills-acquisition.ts)
Harness: [`scripts/probe-skills-acquisition.ts`](../../scripts/probe-skills-acquisition.ts) (`npm run probe:skills`)

## Verdict

A fixed Skills CLI version **can** acquire supported remote sources only into an
isolated staging Profile, with a repository-compliant stable wrapper, on clean
macOS and hosted Windows. All 13 proof scenarios pass in three environments:

| Environment                        | Result  |
| ---------------------------------- | ------- |
| Local macOS (darwin arm64, Node 26) | 13/13  |
| Hosted macOS (`macos-latest`, Node 24) | 13/13 |
| Hosted Windows (`windows-latest`, Node 24) | 13/13 |

Hosted evidence: [probe workflow run](https://github.com/wubq511/cc-profile-switch/actions/runs/30608447232)
(artifacts `skills-acquisition-proof-macos-latest` /
`skills-acquisition-proof-windows-latest`), branch
`task/39-skills-acquisition-proof`.

## The stable wrapper

`src/core/skills-acquisition.ts` pins and invokes the CLI the way the
[integration contract](skills-ecosystem-integration-contract.md) requires:

- `skills` is an exact-version npm dependency (`1.5.21`, no caret). The wrapper
  resolves the installed package manifest, **fails on any version mismatch**
  (`SKILLS_CLI_VERSION_MISMATCH`), and spawns `process.execPath <bin/cli.mjs>`
  with an argv array and `shell: false`. No `npx`, no shim parsing, no floating
  version; identical invocation on Windows, macOS, and Linux.
- Every run targets isolated staging only:
  `CLAUDE_CONFIG_DIR=<staging>/claude-home`, `XDG_STATE_HOME=<staging>/state`,
  `DISABLE_TELEMETRY=1`, `NODE_DISABLE_COMPILE_CACHE=1`, argv
  `add <source> [--skill <name>] --global --agent claude-code --copy --yes`.
- The plan builder is pure and side-effect-free, so a dry-run plan and the real
  run are equivalent; every derived path goes through `resolveInside`.
- Output is captured, never parsed for state. Failure surface is classified
  into stable `CcpsError` codes (see below), with a 10-minute acquisition
  timeout (`SKILLS_ACQUISITION_TIMEOUT`).

### What the upstream exit contract actually is (measured)

- The CLI has exactly two exit codes: `0` and `1`. Every failure — usage,
  network, limits, no-match — exits `1`; success exits `0`.
- **Partial install failures still exit `0`.** The wrapper therefore never
  trusts the exit code alone: a zero exit with an empty staging directory is
  reported as `SKILLS_ACQUISITION_EMPTY`.
- `SKILLS_ACQUISITION_OFFLINE` is classified from captured output signatures
  (`fetch failed`, `Could not resolve host`, `Failed to connect to`,
  `ECONNREFUSED`/`ENOTFOUND`/`ETIMEDOUT`, clone timeouts, …). Limit violations,
  HTTP errors, and unmatched `--skill` stay `SKILLS_ACQUISITION_FAILED` — the
  probe's negative controls prove the classes do not blur.

## Proof scenarios

All scenarios run against fresh staging directories; real-home guard paths
(`~/.claude/skills`, `~/.agents`) are snapshotted before and after the whole
matrix.

1. **Source identity, remote** — GitHub shorthand (`vercel-labs/skills`),
   GitHub URL, `.git` URL, and tree URL
   (`…/tree/main/skills/find-skills`) each stage exactly `find-skills` out of
   the multi-Skill repository (selected by `--skill` or the tree path), the
   staged `SKILL.md` frontmatter `name` is `find-skills`, and the upstream lock
   lands at `<staging>/state/skills/.skill-lock.json` — never `~/.agents`.
2. **Source identity, local path** — staged copy with matching frontmatter
   name; the source directory remains intact; no upstream lock is written
   (upstream only locks normalized remote sources).
3. **Direct `SKILL.md` URL** — staged from a plain HTTP download with matching
   identity; no upstream lock.
4. **Bounded archives** — a valid `tar.gz` stages correctly; with
   `SKILLS_DOWNLOAD_MAX_BYTES=2048` an 8 KB incompressible archive is rejected
   before download (content-length pre-check); with
   `SKILLS_EXTRACT_MAX_FILES=5` an 11-entry archive is rejected during
   extraction. In both cases nothing is staged. Defaults when unset: 10 MiB
   download, 25 MiB extracted, 1000 files.
5. **Offline classification** — with `SKILLS_DOWNLOAD_URL`/`SKILLS_API_URL`
   pointed at a dead port and git's `https_proxy` blackholed, a remote GitHub
   acquisition and a dead direct URL both surface as
   `SKILLS_ACQUISITION_OFFLINE` with exit `1`, distinct from "no results" and
   from "unsafe".
6. **Stable exit behavior** — success `0`, every failure `1`, unmatched
   `--skill` is a stable non-offline `SKILLS_ACQUISITION_FAILED`.
7. **Isolation** — after the full matrix, `~/.claude/skills` and `~/.agents`
   are byte-identical (or still absent on the clean runners). In
   `--copy --global --agent claude-code` mode the upstream canonical store
   (`~/.agents/skills`) is never touched; the only persistent side-write is the
   isolated lock file, and only for remote sources.

## Operational notes for later tickets

- The CLI honors `SKILLS_DOWNLOAD_URL`, `SKILLS_API_URL`,
  `SKILLS_DOWNLOAD_MAX_BYTES`, `SKILLS_EXTRACT_MAX_BYTES`,
  `SKILLS_EXTRACT_MAX_FILES`, and `SKILLS_CLONE_TIMEOUT_MS`. The probe passes
  these through the wrapper's `extraEnv`; they are the supported seams for
  hermetic tests — Workbench itself should not set them in normal operation.
- HTTP goes through global `fetch` with **no proxy support**; git cloning goes
  through the `git` binary and does honor `https_proxy`. Offline simulation and
  corporate-proxy behavior must account for that split.
- The security-audit fetch (3 s timeout, swallowed on failure) never blocks
  installation — nothing in the wrapper infers safety from upstream output.
- The upstream lock is not a Profile manifest: it records no target Profile,
  agent, or install mode, and local/download sources skip it entirely. The
  ccps-owned provenance schema remains the job of the manifest transaction
  contract (issue #38).
- macOS and Windows behave identically through this adapter; no
  platform-specific branch was needed beyond the repo's existing spawn
  discipline.

## Decision for the Wayfinder map

The pinned acquisition adapter is proven: staging-only isolation, reliable
source identity, bounded archives, classified offline failures, and stable exit
behavior hold on clean macOS and hosted Windows with `skills@1.5.21` behind the
ccps wrapper. Profile Skill acquisition can build on this adapter; inventory,
provenance, apply, and recovery remain ccps-owned as resolved in the
integration contract.
