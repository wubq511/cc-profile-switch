# Profile Workbench — Product and Interaction Specification

Status: implementation-ready specification (Wayfinder map [#24](https://github.com/wubq511/cc-profile-switch/issues/24), closing ticket [#52](https://github.com/wubq511/cc-profile-switch/issues/52))
Date: 2026-08-01
Grounding: the 25 closed decision tickets of map #24 (cited inline as `#NN`); prototype branches `prototype/workbench-nav` and `codex/terminal-profile-experience-wayfinding`; evidence reports under `docs/research/`; companion document `docs/Spec-built-in-profile-templates.md` (#48); vocabulary per `CONTEXT.md`.

This document is the destination deliverable of map #24: the complete, implementation-ready product and interaction specification for Profile Workbench. Each section states the operative decisions; the cited ticket holds the alternatives evaluated and the full rationale.

## 1. Purpose and scope

Profile Workbench is a local, terminal-first surface for discovering, inspecting, editing, launching, and safely managing Profiles and Managed Profile Resources without manual filesystem navigation (#24 destination).

- **Primary user:** an individual, local Claude Code user who understands why Profiles exist but is never required to know their filesystem layout. Guidance is progressive and contextual.
- **Managed Profile Resources:** profile metadata and launch configuration, User Memory, Auto Memory, Skills, Agents, MCP, and Settings.
- **Plugins** are visible but changed only through Claude Code-supported mechanisms (delegated lifecycle, §7.6).
- **Out of scope** (ruled out on the map, never graduates): production implementation inside the wayfinding effort itself; cloud sync, team sharing, accounts, multi-user permissions, hosted services; OAuth/session/token/history/cache migration or inspection; direct mutation of Claude Code-managed plugin internals; a custom Markdown editor inside Workbench; a proprietary Skills marketplace or index; a local Web fallback surface (#25's terminal model satisfied the experience); Linux support; real screen-reader walkthroughs (#40 keeps Ink's screen-reader mode CI-guarded only).
- **Open follow-up outside this spec:** the v1+OIDC credential configuration UX for skills.sh discovery is deliberately uncommitted, gated on upstream response to [vercel-labs/skills#1825](https://github.com/vercel-labs/skills/issues/1825) (#37, #47).

## 2. Architecture foundation

Decided by #26, gated and proven by #36.

- **UI foundation: Ink 7.x**, behind a separately built, lazy-loaded ESM Workbench entry. The existing CommonJS `ccps` bin, Commander CLI, and shared core services are unchanged.
- **Node floor: `>=22`** (declared, build, and runtime). Node 22 and 24 are both mandatory support targets (#40).
- **Loading boundary:** scriptable commands never import UI. The Workbench loads only via dynamic `import()` when `stdin.isTTY && stdout.isTTY` both hold.
- **Build shape:** tsup CJS bin + separately built esbuild ESM Workbench bundle. Packaging facts the implementation must carry (#36):
  - Bundling Ink into one ESM file requires stubbing `react-devtools-core` (its DEV-guarded dynamic import otherwise crashes the bundle at load) and a `createRequire` banner (CJS deps dynamically require builtins).
  - Ink 7 throws on non-TTY stdin when `useInput` is active; headless/CI rendering needs a separate component variant without raw-mode input.
  - CI-environment detection misjudges interactivity on hosted runners' PTYs; PTY-driven smoke entries must force interactive mode explicitly.
  - `ink-testing-library` v4 does not declare Ink 7 compatibility; deterministic tests use a fake-TTY render harness instead.
- **CLI and TUI route through the same core services** (project contract, unchanged).
- **Fallbacks:** Terminal Kit only if a structural Windows/packaging failure emerges (the #36 gate passed, so none did); OpenTUI revisited only when its renderer runs on LTS Node without experimental FFI; blessed/neo-blessed rejected (no documented Windows resize/mouse support).

## 3. Entry model and CLI compatibility

Decided by #34 (frozen/revisable split) and the map's standing entry decision.

### 3.1 Entry model

- Interactive (dual-TTY) bare `ccps` opens Profile Workbench.
- `ccps <command>` remains stable and scriptable.
- `ccps tui` is the explicit Workbench entry; the legacy readline menu is retired. Non-TTY `ccps tui` fails with a `TUI_REQUIRES_TTY`-style error on stderr, exit 1.
- Non-TTY bare `ccps` prints help to **stderr**, exit **1**.

### 3.2 Frozen CLI surface (must not change)

1. All 14 existing command names, arguments, flags; commander `help`/`--version`/`--help` behavior.
2. Error format `CODE: message\nNext: guidance`; the existing error-code set (new codes may be added; old meanings never change).
3. Exit codes 0/1 only: `validate` exits 0 even with error findings; Claude's non-zero exit collapses to 1 (`CLAUDE_EXITED_WITH_ERROR`); signal termination counts as exit 0; Claude's real exit codes are never propagated.
4. Stream discipline: normal output stdout, errors stderr.
5. Parseable structures: the tab-separated `list` table and the `launch --dry-run` labeled block.
6. `remove`'s exact-name confirmation in the CLI; never a `--yes`/`--force` bypass; piping the confirmation remains supported. (The Workbench's own removal flow follows §9 — the exact-name rule is a CLI-contract freeze, not a Workbench interaction.)
7. Non-TTY bare `ccps` behavior above.
8. Build/entry surface: CJS `dist/index.js` bin, `"type": "commonjs"`, Node >=22.

### 3.3 Intentionally revised

- Dual-TTY bare `ccps` opens Workbench; `ccps tui` reroutes to Workbench (above).
- `remove` with stdin at EOF fails explicitly with exit 1 (no more silent exit-0).
- `launch`'s three startup lines move to *before* the spawn.
- Wording-level copy (including `Starting ccps TUI.` and `Next:` hints) may change; tests updated in step.
- New commands and flags may be added additively.

### 3.4 Non-goals

No `--json` or machine-readable output in this effort (additive flag if ever); no Claude exit-code propagation.

## 4. Navigation and layout

Decided by #25 (Variant E), with the guidance model of #29 and the baseline of #40.

### 4.1 Layout

- **Full-screen two-pane:** a card-tree sidebar on the left, a main pane on the right.
- **Sidebar:** Profiles are cards (name, resource counts, last used); a Profile's resource categories and items are indented tree rows beneath their card.
- **Main pane:** the selected Profile shows its seven Managed Profile Resource categories as a card grid; drilling into a category shows its items and previews.
- **Terminal sizes:** floor 80×24. Below the floor the Workbench enters a resize-guidance mode — still keyboard-operable, escapable, never rendering a truncated destructive confirmation — and resumes in place once resized. Above the floor: compact (80–119 cols) and wide (≥120) layouts; exact breakpoints are an implementation detail. Live resize re-layouts correctly at any moment.

### 4.2 Search

- A live search box pinned to the **top** of the sidebar.
- Reachable two ways: `/`, or `↑` past the top of the list; `↓`/`Enter` returns focus to the filtered list; `Esc` clears.
- Typing filters the card-tree in place and auto-expands matched paths. Search covers Profile names/descriptions and resource items, in-Profile and cross-Profile (per the capability matrix, §6).

### 4.3 Actions and help

- **Contextual letter keys** in the main pane: `l` launch, `e` edit in VS Code, `b` backup, `x` remove, and per-surface additions (the `?` overlay is the keymap documentation). Destructive actions sit behind graduated protection (§9).
- **Fixed keymap:** arrows/Enter navigation, Esc back, `/` search, `?` help overlay, `q` top-level quit, Ctrl+C quit. Every action is reachable by keyboard alone. No user remapping in v1.
- **Mouse:** mouse reporting is never enabled — terminal-native text selection keeps working; mouse input has no bound effect. Keyboard scrolling (arrows + PgUp/PgDn) covers long lists and previews.
- A persistent hint line and the sidebar footer surface current view state.

### 4.4 Verified envelope

The model was verified against small (3) and large (42) Profile inventories and across terminal sizes from 80×24 up, including card-mode scrolling with large inventories (#25).

## 5. Guidance system

Decided by #29 (Variant I — per-surface mix). Goal: a user with no filesystem model can operate the Workbench, while steady state converges to near-minimal.

- **Contextual hints that retire:** hints attach to the focused element and disappear after their key has been used three times. Steady state converges to near-minimal as the user learns.
- **First-run:** one dismissible welcome card per session (what Profiles are + the three keys to know); never shown again within the session.
- **Empty states:** 2–3 line recipes with the concrete next step — the zero-Profile state explains what a Profile is and offers `[n]`; the no-match state says what search covers; empty categories offer `[a] add` (Skills: copy or link).
- **Errors:** boxed panel with numbered recovery steps.
- **Destructive actions:** inline panel — one consequence line plus the graduated options (`[y]` backup default / `[u]` no-backup → Recovery Bin / `[esc]` keep), with the linked-source note where relevant (§9).
- **Help:** full `?` sheet **including the concepts section** (Profile, Copied vs Linked Skill, Backup, Recovery Bin, Plugins as Claude-managed) — concepts, never filesystem paths.
- **Discovery tips:** small just-in-time only — a one-line tip on first search focus; an amber nudge on Profiles with failed MCP servers. No rotating tips, no coach strip.

Implementation notes found while prototyping (#29): flashes carry a generation counter (a stale `setTimeout` cleared newer messages); guidance dialogs are `flexShrink={0}` (Yoga clipped the first row); guidance copy must fit the narrowest sidebar (~26 cols) or wrap — truncation of guidance text is not acceptable.

## 6. Capability model

Decided by #28. Ten verbs over a three-block matrix.

### 6.1 Verb vocabulary

- **Inspect** — summary and metadata.
- **Preview** — the resource's content itself.
- **Search** — in-Profile and cross-Profile.
- **Create** — new resource.
- **Edit** — modify content or fields: structured fields inside Workbench; long text via VS Code (§8).
- **Update** — sync/upgrade from an external source only; N/A for resources without one.
- **Validate** — launch readiness only.
- **Diff** — vs another Profile's resource or vs source (§12).
- **Copy / Link** — two modes marked per cell.
- **Remove / Restore** — Remove lands in the Recovery Bin; Restore means from the Bin (§9). Backup restore is Profile-lifecycle, not a resource action.
- **Launch** — Profile-only; N/A on every resource row.

### 6.2 Block 1 — Profile lifecycle

| Action | Verdict | Notes |
|---|---|---|
| Create | ✅ | Templates + `create-profile` flow (§11.3) |
| Inspect / Search | ✅ | List, default marker, status summaries — the navigation home |
| Edit metadata | ✅ | Same action as resource-row Edit |
| Copy | ✅ | Whole-Profile clone |
| Rename | ✅ | Includes directory move |
| Backup | ✅ | Durable, never auto-expires |
| Restore (from Backup) | ✅ | Fills the current CLI gap; auto-backs-up current state before restoring |
| Restore (from Recovery Bin) | ✅ | Collision rules per §9.3; restore consumes the item |
| Remove | ✅ | One lightweight confirmation; protection carried by the explicit backup opt-in choice (§9.1) |
| Set / Clear Default | ✅ | Existing |
| Validate | ✅ | Launch-readiness semantics |
| Launch | ✅ | Preserve cwd, set `CLAUDE_CONFIG_DIR`, dry-run ≡ real launch (§10) |

### 6.3 Block 2 — Managed Profile Resource matrix

**User Memory** (`claude-home/CLAUDE.md`): Inspect ✅ · Preview ✅ · Search ✅ · Create ✅ (recreate if missing) · Edit ✅ (VS Code long-text channel) · Update N/A · Validate N/A · Diff ✅ (plain text) · Copy ✅ cross-Profile / Link ❌ · Remove/Restore ✅ · Launch N/A

**Agents** (`claude-home/agents/*.md`): as User Memory, plus Create ✅ = minimal frontmatter scaffold then VS Code; Edit ✅ **dual-channel** — frontmatter structured fields inside Workbench, body via VS Code; Validate N/A.

**Settings** (`claude-home/settings.json`): Inspect ✅ · Preview ✅ · Search ✅ · Diff ✅ — all four redact credential-class values (key names only, never values). Create ✅ (with managed-field backfill). Edit ✅ restricted: `mcpServers` key refused outright (MCP contract); ccps-managed fields (`autoMemoryDirectory`, `claudeMdExcludes`, `env.CLAUDE_CODE_ATTRIBUTION_HEADER`) read-only. Validate ✅. Copy ✅ / Link ❌. **Remove ❌** — load-bearing; key-level removal via Edit instead.

**MCP** (`.claude.json`, Claude-managed — delegated + redacted): Inspect ✅ (names, scope, transport, connection state) · Preview ✅ redacted per-server view (command/args/env key names; never `claude mcp get` in an agent-visible terminal) · Search ✅ (names only) · Create/Edit ✅ delegated via `claude mcp add/remove --scope user` (edit = remove + re-add) · Update N/A · Validate ✅ (connection state; legacy root `mcp.json` launch-flag path) · Diff ✅ (server inventory only) · Copy ✅ restricted / Link ❌ · Remove ✅ (zero-confirm auto-Bin, fragment-type item) / Restore ✅.

**Skills** (richest row; §7.1–§7.4): Inspect ✅ (Copied/Linked type, link health, "source updated" marker) · Preview ✅ · Search ✅ (installed + online discovery) · Create ✅ dual-path (remote via staging adapter; local as Copy or Link, both offered, Copy default) plus new-skill scaffold + VS Code · Edit ✅ per-mode (Copied edits normally; Linked edits the shared source with an explicit notice) · Update ✅ three modes · Validate N/A · Diff ✅ (Copied only) · Remove/Restore ✅ (Linked removal never deletes its source).

**Auto Memory** (`memory/auto/`): Inspect ✅ · Preview ✅ · Search ✅ · **Create ❌** (authorship boundary: manually created entries are User Memory by definition) · Edit ✅ (curation via VS Code) · Update N/A · Validate N/A · **Diff ❌** (session-derived state; cross-Profile comparison is noise) · Copy ✅ (seed a new Profile) / Link ❌ · Remove/Restore ✅.

**Profile metadata & launch configuration** (`profile.json`): Inspect ✅ · Preview ✅ (raw JSON) · Search ✅ · Create N/A (lifecycle owns it; missing file = Validate failure) · Edit ✅ restricted (`name` only via lifecycle Rename; security-sensitive fields `skipPermissions`/`claudeArgs` show consequence warnings before editing) · Update N/A · Validate ✅ (primary Validate target) · Diff ✅ · Copy/Link ❌ · **Remove ❌** (load-bearing) · Launch N/A.

### 6.4 Block 3 — boundary rows

- **Plugins (Claude-managed): fully delegated lifecycle** (§7.6) — Inspect / Preview / Search / Create / Edit / Update / Remove / Restore via coordinates-type Recovery Item, all through the `claude plugin` CLI.
- **Runtime internals** (OAuth, tokens, sessions, history, caches, credentials): not in the matrix at all. Declared so the absence reads as a decision, not an omission.

### 6.5 Global boundaries

1. **Credentials:** redaction across Inspect/Preview/Search/Diff (names only, never values). Secret values exist only in process memory — never displayed, logged, passed as CLI arguments, or written to temp files (0600 temp file + immediate delete if a handoff is unavoidable; Copy fallback: copy non-secret fields and prompt re-entry). Secret-bearing Recovery Items are stored 0600, excluded from Profile Backups and exports (the export opt-in of §11.2 excepted), and physically purged at retention expiry. Pre-action confirmation views list env **key names** only.
2. **Ownership:** `.claude.json` and Plugins change only through Claude Code delegation; Linked Skill sources are never deleted by ccps; ccps-managed settings fields are read-only.
3. **Load-bearing files:** `settings.json` and `profile.json` are never resource-removable.
4. **Recovery:** resource removals are zero-confirm auto-Bin; Profile removal is one light confirmation with the backup opt-in carrying protection; restore collisions and consumption follow §9.

## 7. Resource specifics

### 7.1 Skill provenance and transactions

Decided by #38. ccps owns a per-Profile Skill provenance manifest and a rename-swap transaction contract; the upstream Skills lock file is never consulted.

**Manifest** — `profiles/<name>/skills-provenance.json`, ccps-owned, outside `claude-home`, traveling with Profile Backup and Recovery Item file-tree snapshots for free.

- **Key:** the install directory name in `claude-home/skills/<name>`. Install collisions refuse by default and offer rename-install; no silent overwrite. Reconciliation invariant: every skills directory entry has a record, every record has a directory — violations are corruption signals.
- **Source kinds:** `git-remote` / `url` / `local` / `unknown`. skills.sh is never a source kind — it is the discovery layer; records carry the real underlying source. `local` installs discover the enclosing git repository at install time and record `repo { root, remoteUrl, skillPathInRepo, ref }`; when none is found the field is omitted and Update is disabled with a stated reason.
- **Record shape** (only fields with consumers): `version`, `mode` (`copy`|`link`), `source { kind, url?, path?, ref?, skillPath?, repo? }`, `contentHash`, `installedAt`, `updatedAt`, `sourceCheckedAt`, `link { targetPath }?`, `audit { state, provider, fetchedAt }?`.
- **contentHash:** full-tree sha256 — all regular files sorted by `/`-normalized relative path, hashed as (path + per-file sha256) concatenation; symlinks hash their target string; permission bits ignored; no exclusion list. Semantics: fingerprint of the last successfully applied tree. The Inspect "source updated" marker (source live hash ≠ recorded) and the local-drift warning (profile copy live hash ≠ recorded) both derive from this single value.
- **Link health:** never stored; computed live at Inspect — `ok` / `link-missing` / `wrong-target` / `source-missing`. No auto-repair in any state.
- **Backfill:** pre-manifest Skills get a lazily created `unknown`-kind record at first Inspect/list (content hash computed live, `installedAt` = directory mtime, `mode: copy`). Update and Diff-vs-source are disabled with the reason shown; reinstalling with a real source upgrades the record to full provenance. No migration command, no startup scan.

**Transaction contract**

- **stage:** produce the new tree in staging without touching the Profile (pinned CLI adapter for remote, §7.3; validated read for local). Failure is a pure error — nothing touched.
- **preview:** hash-based file diff (added/changed/removed), local-drift overwrite warning requiring explicit confirmation, cached audit state, and the link target for link mode.
- **apply:** rename swap inside `claude-home/skills/` (same partition) — new tree lands as `.ccps-tmp-*`, old renames to `.ccps-old-*`, new renames to the final name, old is deleted, then the manifest is written atomically (temp file + rename). Never in-place rewrite.
- **rollback** (apply-failure restoration only, not a user operation): three enumerable crash states reconciled at the startup sweep — tmp residue only → delete; old + final both present → delete old (apply had succeeded); old present without final → rename back. A crash between file swap and manifest write surfaces as local drift, handled by exactly the same path as a manual user edit — deliberately.
- **update:** three modes — copied-remote re-acquires the recorded source into staging → diff → apply (never `skills update`); copied-local runs `git pull --ff-only` on the discovered repo (dirty repo aborts; missing remote/upstream disables with reason; one pull refreshes all Skills sharing the repo) → hash-diff → re-copy; linked = one-click repo pull, content live immediately. **Undo of a successful update goes through the Recovery Bin:** the replaced old tree becomes a Recovery Item tagged `origin: update` with a **fixed 3-day TTL** independent of the global retention setting. Linked pulls create no Bin item — git itself is the undo mechanism.
- **audit cache:** captured from the skills.sh result at install when present; lazy refresh at Inspect with a 24h TTL; refresh failure keeps the old value marked `cached-stale`; manual refresh action available; never blocks any operation.

### 7.2 Local Skill installation (Copy and Link)

Decided by #30 (Variant L wizard), physically proven by #49 (macOS symlinks) and #50 (Windows junctions).

A **3-step wizard**:

1. **Source** — pick the Local Skill Source from a list; invalid sources (no SKILL.md) are marked at this step.
2. **Copy or Link** — two equal-weight bordered cards side by side, **Copy pre-selected (default)**, each card carrying its ownership and update semantics in place (Copy: Profile-owned snapshot, source edits never flow in, update = re-copy with Recovery Bin undo; Link: live source, edits appear immediately, removal never deletes the source).
3. **Confirm** — target-change preview (what lands in `claude-home/skills/<name>` plus the provenance record), health checks, and only then the install action.

Settled sub-decisions:

- **Name collisions** resolve on the confirm step: rename (suggested `name-2` or typed), replace the existing Skill (old copy goes to the Recovery Bin), or step back. Install is blocked until resolved.
- **Link health** is checked pre-install and shown on the confirm step (source readable / SKILL.md present / platform can create links).
- **Platform cannot create a link** fails safe: nothing is written, the panel explains the blocker, `[c]` falls back to Copy with the same source.
- Wizard pacing: one decision per screen, `esc` walks back.

Physical realization (#49/#50): install = one symlink (macOS) or junction (Windows, absolute target paths only) in `claude-home/skills/<name>`; removal = delete the link, never the source. Claude Code discovers and loads links escaping `CLAUDE_CONFIG_DIR` on both platforms and serves live source content per launch; broken links are silently ignored. ccps owns link-target validation (absolute-path/traversal safety rules).

### 7.3 Remote Skill acquisition

Proven by #39; contract from #27.

- **Pinned adapter:** `skills@1.5.21` as an exact pinned dependency, wrapped by `src/core/skills-acquisition.ts`. The wrapper resolves the pinned package, rejects any version mismatch, and spawns `node bin/cli.mjs` with an argv array, `shell: false`, and staging-only env (`CLAUDE_CONFIG_DIR`, `XDG_STATE_HOME`, `DISABLE_TELEMETRY=1`, `NODE_DISABLE_COMPILE_CACHE=1`).
- **Isolation:** remote acquisitions stage only into `<staging>/claude-home/skills`; the real `~/.claude` is byte-identical after acquisition (proven on clean macOS and hosted Windows, 13/13 scenarios).
- **Source identity:** GitHub shorthand, GitHub URL, `.git` URL, tree URL, local path, and direct `SKILL.md` URL each stage exactly the selected Skill with matching frontmatter identity.
- **Bounded archives:** download-byte and file-count limits (10 MiB / 25 MiB / 1000-file defaults, `SKILLS_*_MAX_*` overrides); nothing is staged on rejection.
- **Failure classification:** upstream exits only 0/1 and can exit 0 on partial failure, so the wrapper verifies staged output and classifies `SKILLS_ACQUISITION_OFFLINE` vs `SKILLS_ACQUISITION_FAILED` (plus `EMPTY`/`TIMEOUT`/`UNAVAILABLE`/`VERSION_MISMATCH`).
- The plan builder is pure, so dry-run ≡ real run.

### 7.4 Skills discovery (online)

Decided by #37; upstream request tracked by #47. Two-layer architecture tiered by contract reliability.

**Supported layer (zero-config, guaranteed)**

- **Floor:** source entry (GitHub/GitLab/git URL, direct download URL, local path) plus browser handoff (open skills.sh, paste the source back).
- **GitHub backbone:** a small built-in curated source list (first-party/well-known repositories; user-extensible; lists sources only — no ratings or rankings, not a marketplace), browsed via documented contents/raw APIs with `SKILL.md` frontmatter parsed by ccps; documented repository search (10 req/min unauthenticated); a detected local `gh` token is borrowed automatically, raising search to 30 req/min and unlocking code search.
- Installation from **any** source — including a skills.sh result — goes through the §7.3 adapter. Installing is supported even where searching is experimental.

**Experimental layer (on by default, honestly labelled)**

- skills.sh catalog search (undocumented `GET /api/search`): on by default with a persistent experimental badge on the results region; the `workbench.skillsDiscoveryExperimental` settings switch disables it.
- Merged display with the GitHub backbone, deduplicated (same repository + same directory = same Skill); install counts and trending shown when available. Each layer covers the other's failure: skills.sh outage → backbone plus stale-marked cache; backbone rate-limit → skills.sh.
- Security audits ride with the search layer: six states (`pass` / `warn` / `fail` / `not audited` / `unavailable` / `cached-stale`); absence never means safe; audits never block installation.
- Results carry fetch timestamps; offline shows cached data marked stale; failure wording is "catalog unavailable", never disguised as "no results".

**Graduation/retirement:** a documented upstream credential-free (or lightweight client-auth) search contract sends the experimental layer into graduation review; an explicit decline or vanished endpoint retires it, leaving the supported layer unaffected. The authenticated v1+OIDC state's activation condition is named, but its configuration UX is uncommitted (map fog).

**Excluded:** no self-hosted mirror/index; no scraping skills.sh HTML; no parsing `skills find` human output; no treating `add-skill.vercel.sh/audit` as a stable API.

### 7.5 MCP

Per the matrix (§6.3): all mutation is delegated through `claude mcp add/remove --scope user` with `CLAUDE_CONFIG_DIR` set, so state lands in the selected Profile's `claude-home/.claude.json`. ccps never writes `.claude.json` directly, never puts `mcpServers` in `settings.json` or `claude-home/.mcp.json`, and never runs `claude mcp get` where it may print secrets. Preview and Diff are redacted (key names only). Only older profiles with a non-empty root `mcp.json` receive the legacy `--mcp-config` launch flag; `strict` remains explicit opt-in.

### 7.6 Plugins (delegated lifecycle)

Decided by #28, proven Profile-targeted by #42 (macOS, 21 commands) and #45 (Windows, 20 commands) with the real Claude home byte-identical throughout.

- All operations go through the `claude plugin` CLI with `CLAUDE_CONFIG_DIR` set: `plugin list --json` / `list --available --json`, `plugin marketplace add|list|remove|update`, `plugin install <plugin@marketplace> --scope user [--config k=v]`, `plugin uninstall`, `plugin enable|disable`, `plugin update`, `plugin details`.
- `plugin update` prints "Restart to apply changes" — the UI must surface it.
- Restore after uninstall uses a coordinates-type Recovery Item (records `plugin@marketplace`, enable state, userConfig key names); restore = delegated reinstall + state re-apply. Reinstall gets the marketplace's current version — surfaced; a missing marketplace fails visibly.
- Marketplace inventory for machine-reading: the Profile's own `settings.json` (`extraKnownMarketplaces`, `enabledPlugins`) plus `plugins/known_marketplaces.json` — `marketplace list` has no `--json`.
- `marketplace add` accepts `owner/repo`, `https://…`, or a local path; `file://` URLs are rejected.
- **Residual gap (bounded):** the `--config key=value` install flow is unexercised (no probe plugin declared `userConfig`); verify at first adoption of a config-declaring plugin.
- Boundaries: never read plugin internal state files, never touch plugin credential values, every write delegated.

## 8. External editing (VS Code)

Decided by #31. Structured fields are edited inside Workbench; long text defaults to VS Code, then Workbench refreshes its preview.

- **Handoff: non-modal.** A persistent "Editing in VS Code — Workbench is watching" banner sits atop the resource preview; the resource row carries a `✎ watching` badge; Workbench stays fully operable. Signalling uses high-contrast foreground colors, not background fills.
- **Refresh: automatic.** Recursive directory watch (atomic-save tolerant, ~100 ms debounce) refreshes the preview on every external save, stamped `updated HH:MM:SS`, with a per-session change counter. Manual-refresh mode rejected.
- **Deleted/renamed files** collapse into one `missing` state: tracking dropped without guessing the rename target; the preview keeps last known content under a warning; watching resumes automatically if the path reappears. No auto-recreate.
- **VS Code unavailable:** inline error offering three fallbacks — system default editor, copy the path, retry after fixing the install. No silent dead-end. The editor is overridable via `workbench.editor` in `config.json` (§13.2).
- **No data loss:** while a VS Code session is active on a file, Workbench structured-field writes to it (the Agents dual-channel case) are refused with "finish in VS Code first". Write-through-with-warning rejected — a dirty VS Code buffer can silently discard the Workbench write.
- **Concurrent sessions allowed:** each resource owns an independent edit session; banners and badges are per-resource.
- Platform contract unchanged: Windows opens VS Code through PowerShell; macOS uses `open -a "Visual Studio Code"`; the spawn uses the production `buildEditorSpawnCommand` path.

## 9. Safety: Profile Backups and the Recovery Bin

Decided by #33; persistence by #46; update-origin items by #38.

### 9.1 Profile removal

- **Backup on (default):** create a durable Profile Backup, then delete. One lightweight confirmation.
- **Explicit no-backup path:** create a Recovery Item (temporary safety net) instead, then delete. Same single lightweight confirmation.
- Protection is carried by the explicit opt-in choice (unchecking backup), not by confirmation friction. No exact-name typing on either path (supersedes the earlier standing decision; the CLI's frozen exact-name prompt is a separate contract, §3.2).

### 9.2 The two stores

- **Profile Backup:** durable, never expires automatically. Restore is a copy — the backup itself stays. Removed only by manual permanent deletion. Restoring auto-backs-up current state first.
- **Recovery Item:** snapshot + restore coordinates. Two shapes: file-tree (whole Profile, Skill directory, Memory file) and fragment (MCP server entry, Settings field — stored with profile/file/key-path coordinates and written back on restore). Linked Skill removals are fragments carrying link coordinates plus the provenance record — never copied source content.
- Every Managed Profile Resource removal creates a Recovery Item automatically, **zero confirmation** — the Bin is the safety net. Claude-managed resources (plugins) use their coordinates-type items per §7.6.
- A Profile removal with backup on does NOT also create a Recovery Item.
- Update-replaced Skill trees land as `origin: update` items with a fixed 3-day TTL (§7.1).

### 9.3 Restore and collisions

- Collisions default to **refuse**. Offered instead: restore-as-new-name, and an inline "delete the conflicting one, then restore" action. That deletion creates its own Recovery Item like any other — no overwrite path exists anywhere. Fragment collisions resolve the same way at entry level.
- Restoring from the Bin **consumes** the item on success — the Bin holds only unresolved deletions. Restoring from a Backup never consumes it.

### 9.4 Retention and cleanup

- Global setting: 7 / 30 / 90 days, or Never; **default 30**. Lives in `config.json` `recovery.retentionDays`.
- **Retroactive:** expiry recomputed from `removedAt` plus the current setting at evaluation time; items carry no policy snapshot. Changing the setting reports how many existing items would expire under it.
- Cleanup is a **lazy sweep on every ccps startup** (any command), which also reconciles §7.1 transaction crash states. When a sweep deletes something, the next launch prints one line (count + space reclaimed). No persistent cleanup log.

### 9.5 Visibility and permanent deletion

- Backup list and Bin list show per-entry sizes inline with a total at the top. No separate storage command.
- Permanent deletion (single item, single Backup, or emptying the Bin) uses one lightweight confirmation whose copy states plainly that it is permanent and unrecoverable — the only action in the system with no safety net.

## 10. Launch flow

Decided by #32 (Variant L).

1. **Pre-launch bar:** `l` opens a one-line bar defaulting to the directory `ccps` was started in (status-quo cwd semantics, zero steps). `L` opens a directory screen only when the user wants elsewhere: current directory, `tab`/digit-picked recent directories (App State, §13.3), or a typed path. Claude starts in the chosen directory with `CLAUDE_CONFIG_DIR=<profile>/claude-home`; cwd semantics unchanged, no `--add-dir`.
2. **Validation blockers inline:** error findings render inline (red box) and the launch key is disabled until resolved; the surface points at `ccps validate <name>` for the full list. **Warnings stay launchable**, surfaced inline — matching `isLaunchBlocking` semantics.
3. **Dry-run:** `d` opens the full launch-plan page (the frozen CLI `launch --dry-run` block structure per §3.2); `enter` launches from it, `esc` returns.
4. **Resume after exit:** the Workbench does not quit on launch — it leaves the alternate screen, spawns Claude Code, and when Claude exits it re-renders in place, same Profile selected, with a small "Claude exited (N)" flash.

Implementation requirements (#32):

- Launch must unmount/leave the alternate screen before spawning, then re-render after exit — a render loop at the Workbench entry, not a one-shot render. UI state that must survive the remount (selection, view) is carried outside the React tree.
- **SIGCHLD hazard:** after Ink's raw-mode stdin teardown, async `spawn`'s `exit` event is unreliable (defunct zombie, event never fires — reproduced minimally on macOS). The implementation must use a synchronous wait (`spawnSync`) or properly resolve stdin teardown; do not assume async spawn works after an Ink session.
- The macOS PTY wrapper (`script -q /dev/null …`) still applies under the resume model. Windows resume behavior needs a resume-chain check in acceptance (§15).

## 11. Bulk operations, import/export, templates

Decided by #43; built-in template content by #48.

### 11.1 Bulk operations

- **In:** in-Profile multi-select **Remove** (Skills, Agents, MCP servers, Auto Memory entries — §9.2 zero-confirm auto-Bin per item; one multi-item Bin landing); in-Profile multi-select **Update** (Skills only); cross-Profile fan-out **Copy** (selected Skills/Agents to multiple target Profiles in one action — the "equip a new Profile" path).
- **Out:** cross-Profile bulk Remove; Profile-lifecycle bulk; bulk Edit/Diff/Validate/Launch; mixed-resource-type multi-select (selection stays within one resource type).

### 11.2 Import/export — Profile-level portable bundle only

- **Export:** one Profile packaged as a single portable file at a user-specified path. Default excludes Secret-class values (`env.ANTHROPIC_*`, MCP env values); Memory is included; Recovery Bin items are never exported.
- **Opt-in "include secrets":** explicit warning (plaintext credentials; anyone holding the file can use the API account); export file written 0600.
- **Import:** create a new Profile from a bundle. Exact-name collision refused by default with import-as-new-name offered; mandatory manifest preview before creation (resource categories and counts, MCP server names, secrets presence, exporting ccps version); MCP servers re-registered through the delegated `claude mcp add --scope user` path — never direct `.claude.json` writes — with failures listed visibly; stripped secrets remain as key-name placeholders with post-import guided re-entry under the secret-in-memory rule; automatic Validate after import.
- **Out:** resource-level bundles, signing/trust infrastructure, any sharing workflow.

### 11.3 Profile templates

- **Surface:** "Save as template" + "create from custom template"; templates stored at app-home `templates/<name>/`.
- **Captured:** metadata, launch configuration, User Memory, Skills, Agents, Settings, MCP server inventory. **Excluded:** Auto Memory (session-derived), Backups, Recovery Bin, and secrets — **never, with no opt-in** (templates are plaintext at rest in app home; secrets are per-Profile by nature).
- Save-as-template shows a stripping summary ("3 secret fields stripped, Auto Memory not included") with one light confirmation; custom templates list alongside the six built-ins with a clear source distinction; key placeholders and guided re-entry after creation reuse the import experience.
- **Management surface: Remove only** (zero-confirm for a user-created artifact). No editing, no template import/export.
- **Built-in template content:** specified in full by `docs/Spec-built-in-profile-templates.md` (#48): a named template earns its name through behavioral working agreements in User Memory (per-line deletion test); English-only 20–50-line seeds; no shipped Skills/Agents/Settings; `general` carries 4 domain-neutral agreements; `blank` stays near-empty. New seeds apply to newly created profiles only.

## 12. Diff and cross-Profile comparison

Decided by #44 (Variant A — "format follows resource").

- **Single Diff entry point:** a pairwise view between two Profiles; the counterpart Profile is switchable in place. No N-way matrix entry.
- **Presentation is heterogeneous — the resource shape picks the format:**
  - **User Memory / Agents** — unified line diff (Agents add a per-file added/removed/changed layer; changed files drill into line diff).
  - **Settings** — key-level structured table under the redaction contract: key names and verdicts only (`≠` value differs — hidden, `+`/`-` only-in); values never rendered.
  - **MCP** — server inventory comparison (name / transport / connection state per Profile); config values never compared.
  - **Copied Skills** — hash-tree diff vs the skill's own source (changed / new-at-source / gone-at-source); a same-named skill with different sources across Profiles is compared per Profile against its own source, not cross-Profile.
  - **Launch configuration** — key-level table *with* values shown (not secret); security-sensitive fields carry an inline warning.

## 13. Persistence and migration

Decided by #46.

### 13.1 Recovery Bin layout

- Top-level `~/.cc-profile-switch/recovery-bin/`, physically separate from `backups/` — the separation makes backing up or exporting Bin items structurally impossible.
- One subdirectory per item: `<id>/item.json` + payload. **No central index** — listing and the lazy sweep scan directories, so there is no single point of corruption.

`item.json`:

```json
{
  "version": 1,
  "id": "20260731T161329-coding-skills-pdf",
  "origin": "remove",
  "kind": "skill",
  "shape": "file-tree",
  "profile": "coding",
  "coordinates": { "targetRelativePath": "claude-home/skills/pdf" },
  "removedAt": "2026-07-31T16:13:29.000Z",
  "sizeBytes": 184320,
  "secretBearing": false
}
```

- `id` = directory name: compact timestamp first (lexicographic = chronological) plus a readable `<profile>-<slug>` suffix; counter appended on collision.
- `origin`: `remove` (follows the global retention setting) / `update` (fixed 3-day TTL). No expiry or policy snapshot is ever stored.
- `shape`: `file-tree` (payload subdirectory) / `fragment` (value inside `coordinates`: `file` + `keyPath` + `value`).
- `sizeBytes` computed once at removal time (fragments record 0); items are frozen once they land, so Bin lists never rescan trees.
- `secretBearing: true` → the whole item directory is stored 0600. No redaction or encryption machinery.
- No display-name field — the display name derives from `profile` + `coordinates`.

### 13.2 `config.json` v2 — user settings

```jsonc
{
  "version": 2,
  "defaultProfile": "...",
  "lastUsedProfile": "...",
  "createdAt": "...",
  "updatedAt": "...",
  "recovery": { "retentionDays": 30 },   // 7 | 30 | 90 | null (Never); absent = 30
  "workbench": {
    "editor": "code -w",                 // optional; absent = VS Code per platform contract
    "skillsDiscoveryExperimental": true, // off switch for §7.4's default-on experimental layer
    "language": "zh"                     // optional; §14 resolution chain
  }
}
```

Only preferences with a confirmed consumer enter v2. Future preferences arrive additively with a versioned lazy migration. Deliberately not collected: theming, navigation expansion state, the recents cap.

### 13.3 `state.json` — App State, new file

```jsonc
{ "version": 1, "recentProjectDirs": [{ "path": "/abs/dir", "lastUsedAt": "..." }] }
```

- Split from `config.json` by churn class: recents are written on every successful real launch (CLI `ccps launch` and Workbench launch alike); dry-runs and validation-blocked launches record nothing.
- Cap 10, MRU order, oldest evicted. Dedupe by `areSameFilesystemPath` semantics (case-insensitive on Windows).
- Dead directories are never proactively pruned (no stat on the read path); the Workbench marks unreachable entries and the user removes them explicitly.

### 13.4 Migration rules — every ccps-owned JSON file

1. `version` literal + strict schema. Evolution = additive fields plus a version bump. Unknown fields fail loudly; a higher version fails loudly and advises upgrading ccps — no downgrade tolerance.
2. Lazy migrate-on-load: an old version loads with defaults filled in memory, written back only on the next natural save — read paths never write. No migration commands, no startup scans.
3. All writes are atomic (temp file + rename); the current plain `writeJsonFile` gets fixed at implementation time.
4. Corruption is always an error, never a silent reset — the existing `APP_CONFIG_INVALID*` behavior extends to every new file.

## 14. Terminal compatibility and accessibility baseline

Decided by #40.

1. **Node:** 22 and 24 mandatory (both active LTS lines, covered by CI and the #36 gate).
2. **Verification environments:** hosted Windows + macOS runners × Node 22/24 with the deterministic suite gating every PR; plus a real-machine manual acceptance checklist on real Windows and real macOS before every release.
3. **Terminal emulators:** mandatory four — Windows Terminal (including degraded behavior under legacy conhost), macOS Terminal.app, VS Code integrated terminal on both platforms. iTerm2/WezTerm/Alacritty and others best-effort.
4. **Size:** floor 80×24 with resize-guidance mode below it (§4.1); live resize re-layouts at any moment.
5. **Keymap:** fixed, keyboard-only complete (§4.3); the `?` overlay is the keymap documentation.
6. **Mouse:** reporting never enabled (§4.3).
7. **Color:** first-class within the 16-color ANSI base palette, readable on light and dark backgrounds, `NO_COLOR` honored. Hard floor: **no state conveyed by color alone** — selected/error/warning/success/health always carry a second channel (glyph, text label, weight/reverse).
8. **CJK/emoji:** user data renders with correct display width (East Asian Width / grapheme boundaries), never breaking alignment or truncating mid-character; Chinese, emoji, long paths, long names are mandatory in interaction tests and real-machine acceptance. Workbench chrome never uses emoji — stable BMP glyphs only (● ✓ ⚠ ✗ …).
9. **Screen reader:** Ink's screen-reader mode stays functional (linear, self-sufficient output under `INK_SCREEN_READER=true`), guarded by the deterministic CI check. No screen-reading experience commitment, no VoiceOver/NVDA walkthroughs.
10. **Localization:** Workbench UI text is **bilingual Chinese/English, mandatory** — every user-facing string (menus, errors, `?` overlay, destructive confirmations) exists in both locales; dual-locale checks run in CI; a missing translation key fails CI. Resolution chain: explicit `language` field in `config.json` → system locale (`zh*` → Chinese, otherwise English); an in-Workbench switch re-renders immediately and writes back to `config.json`. The scriptable CLI stays English-only (§3.2).

## 15. Acceptance Evidence annex

Decided by #35. The scenario matrix (§15.1) is the spine; the other dimensions hang off its rows. No executable test skeletons at spec time — test method design belongs to implementation.

### 15.1 Scenario matrix

**Completeness rule:** every Workbench-reachable cell of the §6 matrix is covered by ≥1 row. Unreachable cells, marked with their reason: Auto Memory **Create** (authorship boundary, §6.3) and **Diff** (session-derived noise, §6.3); Settings **Remove** and `profile.json` **Remove** (load-bearing, §6.5); Plugins direct mutation (delegation boundary, §7.6); runtime internals (out of scope, §6.4).

**Columns:** precondition fixture → action path → expected observable result → applicability → evidence type. `RM` tags rows in the **real-machine acceptance subset** (CI-unobservable: real terminal rendering, real PTY handoff, OS-level filesystem semantics); untagged rows are CI-sufficient on the hosted Win/mac × Node 22/24 matrix. `zh/en` rows run in both locales.

#### Journeys — Profile lifecycle

| # | Scenario (fixture → action → expected) | Cells | Appl. | Evidence |
|---|---|---|---|---|
| S1 | No Profiles → open Workbench → zero-Profile recipe offers `[n]`; create from template `coding` → Profile card appears with seeded User Memory | Create, Inspect | all | automated |
| S2 | 3-Profile fixture → browse sidebar → cards show name, resource counts, last used; default marker visible | Inspect | all | automated |
| S3 | 42-Profile fixture → scroll card list → correct rendering, no clipping at 80×24 | Inspect | all, RM | automated + RM |
| S4 | Profiles `coding`/`study` → `/` then type `stu` → tree filters in place, matched paths auto-expand; `esc` clears | Search | all | automated |
| S5 | `coding` → edit description inline → saved; reflected on card | Edit metadata | all | automated |
| S6 | `coding` → Copy → clone appears with `(copy)`-style name, identical resource counts | Copy | all | automated |
| S7 | `coding` → Rename to `dev` → directory moved, card updated, provenance intact | Rename | all | automated |
| S8 | `coding` → `b` backup → durable entry in Backup list with size | Backup | all | automated |
| S9 | `coding` modified after S8 → restore from backup → current state auto-backed-up first; restored content live; backup unconsumed | Restore (Backup) | all | automated |
| S10 | `coding` → `x` remove, backup kept on → one light confirmation → backup created, Profile gone, **no** Bin item | Remove (backup) | all | automated |
| S11 | `coding` → `x` remove, backup unchecked (`u`) → one light confirmation → Profile gone, Bin item created | Remove (no-backup) | all | automated |
| S12 | After S11 → restore from Bin with name free → Profile back, item consumed | Restore (Bin) | all | automated |
| S13 | After S11, recreate `coding` → restore from Bin → collision refused; choose restore-as-new-name → both exist | Restore collision | all | automated |
| S14 | After S11, recreate `coding` → restore → choose inline delete-and-restore → conflicting Profile becomes its own Bin item; original restored | Restore collision | all | automated |
| S15 | `coding` → set default → marker moves; clear default → marker gone | Set/Clear Default | all | automated |
| S16 | Pathology P1 (broken `profile.json`) → Validate → error findings listed, launch disabled | Validate | all | automated |

#### Journeys — launch

| # | Scenario | Cells | Appl. | Evidence |
|---|---|---|---|---|
| S20 | `coding` → `l` → pre-launch bar defaults to ccps start directory → confirm → Claude spawned there with `CLAUDE_CONFIG_DIR` set | Launch | all | automated |
| S21 | `coding` → `L` → directory screen → pick recent via `tab`/digit → launches in that directory; recents reordered MRU-first | Launch, recents | all | automated |
| S22 | Type a new path in the directory screen → launches there; path appended to recents | Launch, recents | all | automated |
| S23 | Pathology P1 → `l` → error findings inline in red box, launch key disabled, pointer to `ccps validate`; warnings-only fixture stays launchable | Launch blockers | all | automated |
| S24 | `coding` → `d` → full-screen dry-run page matching the frozen CLI block → `enter` launches; `esc` returns | Dry-run | all | automated |
| S25 | Launch → Claude exits (code N) → Workbench re-renders in place, same Profile selected, "Claude exited (N)" flash | Resume | all, RM | RM (real PTY/SIGCHLD path) + automated state test |
| S26 | Dry-run vs real launch for same Profile+dir → plans equivalent (invariant 8) | Dry-run ≡ real | all | automated diff test |

#### Journeys — User Memory / Agents

| # | Scenario | Cells | Appl. | Evidence |
|---|---|---|---|---|
| S30 | `coding` → User Memory → preview shows CLAUDE.md content | Inspect, Preview | all | automated |
| S31 | Search `refactor` cross-Profile → matching Memory files surfaced | Search | all | automated |
| S32 | Pathology P2 (User Memory deleted) → Create → file recreated, editable | Create | all | automated |
| S33 | User Memory → `e` → VS Code opens; banner + `✎ watching` badge; Workbench stays operable; external save → preview refreshes stamped `updated HH:MM:SS` | Edit | all, RM (real editor) | RM + automated watch test |
| S34 | During S33 → file renamed externally → `missing` state keeps last content under warning; file restored → watching resumes | Edit, missing | all | automated |
| S35 | VS Code unavailable fixture → `e` → inline error with system-editor / copy-path / retry fallbacks | Edit fallback | all | automated |
| S36 | Agents → Create → minimal frontmatter scaffold, then VS Code opens body | Create (Agents) | all | automated |
| S37 | Agent with active VS Code session → attempt structured-field edit in Workbench → refused "finish in VS Code first" | Edit dual-channel block | all | automated |
| S38 | Agent frontmatter → structured edit (no VS Code session) → saved | Edit dual-channel | all | automated |
| S39 | `coding` vs `study` → Diff User Memory → unified line diff | Diff | all | automated |
| S40 | Diff Agents → per-file added/removed/changed layer; drill into changed file → line diff | Diff | all | automated |
| S41 | User Memory → Copy to `study` → file lands; no link semantics offered | Copy | all | automated |
| S42 | User Memory → Remove → zero-confirm → Bin file-tree item → Restore → content back, item consumed | Remove/Restore | all | automated |

#### Journeys — Settings / MCP

| # | Scenario | Cells | Appl. | Evidence |
|---|---|---|---|---|
| S45 | `coding` → Settings → Preview/Inspect/Search render key names only; `env.ANTHROPIC_*` values never appear in any view | Redaction | all | automated (token-shape injection) |
| S46 | Pathology P3 (Settings missing managed fields) → Create/backfill → managed fields restored, unrelated fields untouched | Create | all | automated |
| S47 | Settings → Edit → attempt `mcpServers` key → refused outright; attempt ccps-managed field → read-only notice; plain key edit → saved atomically | Edit restricted | all | automated |
| S48 | Pathology P4 (malformed `settings.json`) → Validate → parse error listed as launch blocker | Validate | all | automated |
| S49 | `coding` vs `study` → Diff Settings → key-level table with `≠`/`+`/`-` verdicts, values never rendered | Diff | all | automated |
| S50 | `coding` → MCP → Inspect shows names, scope, transport, connection state; failed server shows amber nudge on Profile | Inspect | all | automated |
| S51 | MCP server → Preview → redacted view: command/args/env key names only | Preview | all | automated |
| S52 | MCP → add server → delegated `claude mcp add --scope user`; lands in profile `.claude.json`; real home untouched | Create delegated | all | automated + isolation assertion |
| S53 | MCP server → Edit → remove + re-add delegation → new config live | Edit delegated | all | automated |
| S54 | `coding` vs `study` → Diff MCP → inventory comparison (name/transport/connection), no config values | Diff | all | automated |
| S55 | MCP server → Copy to `study` (restricted) → non-secret fields copied, user prompted to re-enter secrets (key names listed) | Copy restricted | all | automated |
| S56 | MCP server → Remove → zero-confirm → Bin fragment item (profile/file/keyPath coordinates) → Restore → entry written back; Restore collision at entry level per S13/S14 rules | Remove/Restore | all | automated |
| S57 | Profile with legacy root `mcp.json` → Validate surfaces legacy launch-flag path | Validate | all | automated |

#### Journeys — Skills

| # | Scenario | Cells | Appl. | Evidence |
|---|---|---|---|---|
| S60 | `coding` → Skills → list shows Copied/Linked type per entry, link health, "source updated" marker where source hash differs | Inspect | all | automated |
| S61 | Skill → Preview renders SKILL.md content | Preview | all | automated |
| S62 | Pathology P5 (pre-manifest Skill) → first Inspect → `unknown`-kind record created lazily (hash live, mtime as installedAt); Update and Diff-vs-source disabled with reason | Backfill | all | automated |
| S63 | Discover → enter GitHub URL → staged via pinned adapter → wizard confirm → installed with full provenance record | Create remote | all | automated |
| S64 | Discover → browser handoff opens skills.sh; pasted source installs through the same adapter | Floor | all, RM (browser) | RM |
| S65 | Discover → GitHub backbone browse curated list; search unauthenticated; with `gh` token fixture → elevated rate/unlocked code search | Backbone | all | automated |
| S66 | Discover → skills.sh layer on: merged dedup results, experimental badge, audit states shown, timestamps on results; toggle off → layer gone | Experimental layer | all | automated |
| S67 | Offline fixture → Discover shows cached data marked stale; skills.sh failure reads "catalog unavailable", never "no results" | Offline | all | automated |
| S68 | Local source → install wizard → mode cards equal weight, Copy pre-selected → confirm shows target preview + provenance record + health checks → installed | Create local Copy | all | automated |
| S69 | Local source → Link card → confirm → symlink (macOS) / junction from absolute path (Windows) created; source edit → content live in Profile | Create local Link | all, RM (junction semantics) | automated + RM Windows |
| S70 | Install colliding with existing Skill → blocked until resolved: rename suggestion works; replace sends old copy to Bin | Collision | all | automated |
| S71 | Link-incapable platform fixture → nothing written, blocker explained, `[c]` falls back to Copy with same source | Link fallback | all | automated |
| S72 | Invalid source (no SKILL.md) → marked at source step, cannot proceed | Health check | all | automated |
| S73 | Copied Skill → Edit → normal edit; Linked Skill → Edit → explicit "editing the source" notice | Edit per-mode | all | automated |
| S74 | Copied-remote Skill → Update → re-acquire recorded source → diff preview → apply via rename swap → old tree becomes `origin: update` Bin item (3-day TTL) → undo restores it | Update remote + undo | all | automated |
| S75 | Copied-local Skill with repo → Update → `git pull --ff-only` → hash-diff → re-copy; dirty-repo fixture aborts with reason; two Skills sharing one repo refresh together | Update local | all | automated |
| S76 | Linked Skill → Update → one-click repo pull; no Bin item created | Update linked | all | automated |
| S77 | Copied Skill → Diff vs source → hash-tree diff (changed / new-at-source / gone-at-source) | Diff | all | automated |
| S78 | Copied Skill → Remove → Bin item; Linked Skill → Remove → only the link deleted, source tree untouched (invariant 7); Restore re-creates the link | Remove/Restore | all | automated |
| S79 | Apply crash fixtures (three states) → next startup sweep reconciles: tmp residue deleted / old deleted / old renamed back | Rollback | all | automated crash-injection |

#### Journeys — Auto Memory / metadata / Plugins

| # | Scenario | Cells | Appl. | Evidence |
|---|---|---|---|---|
| S82 | `coding` → Auto Memory → Inspect/Preview/Search over `memory/auto/` entries | Inspect/Preview/Search | all | automated |
| S83 | Auto Memory entry → Edit via VS Code (curation) → saved | Edit | all | automated |
| S84 | Auto Memory → Copy to new Profile as seed → entries land | Copy | all | automated |
| S85 | Auto Memory entry → Remove → Bin item → Restore | Remove/Restore | all | automated |
| S86 | `coding` → launch configuration → Preview raw `profile.json`; Diff vs `study` → key-level table with values; `skipPermissions` row carries inline warning | Inspect/Preview/Diff | all | automated |
| S87 | Launch config → Edit → `name` refused (Rename owns it); `skipPermissions` edit shows consequence warning before saving | Edit restricted | all | automated |
| S88 | Plugins → Inspect installed + enable state; Preview `details` component inventory; Search marketplace-available | Inspect/Preview/Search | all | automated |
| S89 | Plugins → install `plugin@marketplace --scope user` → lands in Profile only; enable/disable toggles `enabledPlugins`; update surfaces "Restart to apply changes" | Create/Edit/Update delegated | all | automated + isolation |
| S90 | Marketplace → add (`owner/repo`, https, local path; `file://` rejected) / update / remove → registration persists per §7.6 locations | Source management | all | automated |
| S91 | Plugin → uninstall → coordinates-type Bin item (name@marketplace, enable state, userConfig key names) → Restore reinstalls + re-applies state; version-change note surfaced; missing-marketplace fixture fails visibly | Remove/Restore | all | automated |

#### Journeys — bulk / import-export / templates

| # | Scenario | Cells | Appl. | Evidence |
|---|---|---|---|---|
| S95 | `coding` → multi-select 3 Skills → Remove → one multi-item Bin landing, zero per-item confirms | Bulk Remove | all | automated |
| S96 | `coding` → multi-select Skills → Update → each updates per its mode; failures listed, others proceed | Bulk Update | all | automated |
| S97 | Select Skills + an Agent → Copy → fan out to `study`+`writing` → lands in both | Fan-out Copy | all | automated |
| S98 | `coding` → Export default → single file at chosen path; secrets excluded (key names listed as stripped); Memory included; Bin items never exported | Export | all | automated |
| S99 | Export with opt-in include-secrets → warning copy shown; file written 0600 | Export secrets | all, RM (perm bits) | automated + RM Windows |
| S100 | Import bundle → manifest preview (categories/counts, MCP names, secrets presence, exporter version) → create → MCP re-registered via delegation with failures listed → key-name placeholders for stripped secrets → guided re-entry → auto-Validate | Import | all | automated |
| S101 | Import with name collision → refused, import-as-new-name offered | Import collision | all | automated |
| S102 | `coding` → Save as template → stripping summary ("N secret fields stripped, Auto Memory not included") → one light confirm → listed alongside built-ins with source distinction | Template save | all | automated |
| S103 | Create from custom template → new Profile has captured resources; secret placeholders + guided re-entry reuse import flow | Template create | all | automated |
| S104 | Custom template → Remove → zero-confirm; built-ins not removable | Template remove | all | automated |

#### Journeys — safety, guidance, platform

| # | Scenario | Cells | Appl. | Evidence |
|---|---|---|---|---|
| S110 | First session → welcome card once; hint shown → use key 3× → hint retires; steady state near-minimal | Guidance | all | automated |
| S111 | Empty category → recipe offers `[a] add`; no-match search → explains coverage; first search focus → one-line tip | Empty states | all | automated |
| S112 | Trigger failure (e.g. offline acquire) → boxed error panel with numbered recovery steps | Errors | all | automated |
| S113 | `?` → full sheet including concepts section; `?` is complete keymap documentation (every bound key listed) | Help | all, zh/en | automated |
| S114 | Change retention 30→7 → report counts items that would expire; expired items swept on next startup; next launch prints one line (count + space) | Retention | all | automated |
| S115 | Bin/Backup lists → per-entry sizes inline, total at top | Visibility | all | automated |
| S116 | Permanently delete Bin item / Backup / empty Bin → one light confirmation stating permanent + unrecoverable | Permanent delete | all | automated |
| S117 | 80×23 terminal → resize-guidance mode: operable, escapable, no truncated destructive confirmation; resize to 80×24 → resumes in place; live resize re-layouts at any moment | Resize | all, RM | automated + RM |
| S118 | `NO_COLOR=1` → full operability; every state carries a second channel (glyph/text/weight) | Color independence | all | automated |
| S119 | CJK/emoji/space/overlong-name fixtures → correct widths, no mid-character truncation, alignment intact; chrome uses BMP glyphs only | CJK | all, RM, zh | automated + RM |
| S120 | `INK_SCREEN_READER=true` → linear self-sufficient output (deterministic CI check) | Screen reader | all | automated |
| S121 | Language: `config.json language=zh` → Chinese UI; absent → system locale; in-app switch → immediate re-render + write-back; CLI stays English | Localization | all, zh/en | automated |
| S122 | Inject known token shapes through log/error/export-default paths → shapes never appear (invariant 3) | Credential insulation | all | automated |
| S123 | Attempt writes toward real `~/.claude` / project `.claude` / `CLAUDE.md` / `.mcp.json` paths → path resolver blocks; project level byte-identical after full journey run (invariants 1–2) | Write sandbox | all | structural test |
| S124 | Launch from `/path/to/project` → child cwd is exactly that directory; no `--add-dir` (invariant 4) | cwd invariance | all | automated |

### 15.2 Usability evidence

The HITL prototype resolutions **are** the usability evidence; each critical journey maps to the resolution that proved it:

- Navigation, search, layout (S2–S5) → #25 (`prototype/workbench-nav`, variants A–E, PTY smoke 39 checks).
- Guidance (S110–S113) → #29 (variants F–I, `smoke-guidance.py`).
- Local Skill installation (S68–S72) → #30 (variants L/M/N, `smoke-install.py`).
- Launch flow (S20–S25) → #32 (variants J/K/L, `smoke-launch.py`).
- External editing (S33–S35) → #31 (`prototype-edit-session`, real fs.watch + production spawn path).
- Diff (S39–S40, S49, S54, S77, S86) → #44 (`prototype-diff`, variants A/B/C).
- Packaging/loading (all rows' foundation) → #36 (hosted 4/4 matrix + human TTY verification).

**Not prototype-verified (risk accepted by owner):** bulk operations (S95–S97), import/export (S98–S101), template save/create (S102–S104), Recovery Bin management views (S114–S116), and the Plugins journeys (S88–S91 — CLI-proven but not interaction-prototyped). No external testers.

### 15.3 Safety invariants

| # | Invariant | Proof class |
|---|---|---|
| 1 | Write sandbox — every write stays inside the Profile sandbox; never the real `~/.claude`, `~/.claude.json`, or Windows equivalents | structural test (path resolver + write-target assertions) |
| 2 | Project level read-only — never modify project `.claude/`, `CLAUDE.md`, `.mcp.json` | structural test |
| 3 | Credential insulation — never read/migrate OAuth/sessions/tokens/history/caches/credentials; secrets in memory only, redacted on disk and in logs | automated test (token-shape injection through log/error paths) |
| 4 | cwd invariance — launch keeps the invocation directory, no `--add-dir` | automated test |
| 5 | No silent deletion — all removals follow §9 Recovery Bin semantics | automated test |
| 6 | Write atomicity — rename-swap; any failure rolls back to pre-operation state; a crash leaves no half-applied state | automated crash-injection test + design argument |
| 7 | Link never kills source — removing a Linked Skill never deletes its Local Skill Source | automated test |
| 8 | dry-run ≡ real plan — preview and real execution produce equivalent plans | automated diff test |

Concurrent double-open Workbench write conflicts are explicitly **not guarded** — a documented known limitation, not an invariant.

### 15.4 Performance thresholds

Measured against the **baseline fixture tier (20 Profiles × 50 Skills each)**, at the real-machine release gate (not CI — hosted-runner noise produces false alarms):

- Cold start to interactive: **≤ 400 ms**
- Keystroke to repaint: **≤ 50 ms**
- Search filtering per keystroke: **≤ 100 ms**

A **3× tier (60×150)** sets no latency thresholds; any single operation must complete ≤ 2 s or show an explicit loading state. No memory/CPU thresholds.

### 15.5 Interaction-test boundary

- **Behavior contracts** — keybindings, state transitions, error paths, loading/degraded states — are locked as automated interaction tests (Ink component level: inject key sequences, assert state transitions and key rendered information).
- **Visual presentation** (spacing, alignment, specific color assignment) is **not** pinned by pre-generated snapshots and is not acceptance evidence; it is constrained only by §14 (CJK width safety, color never the sole channel, `NO_COLOR`, 80×24 degraded mode). Snapshot tests remain an implementer-chosen regression tool.
- CLI output stays frozen per §3.2.

### 15.6 Fixtures and the Pathology Library

- Fixtures come from a **deterministic checked-in generator** (fixed seed; size params → directory structure; the two tiers above). The annex defines the generator contract, not its implementation.
- **Real Profiles are never checked in** (invariant 3); real-shape coverage comes from real-machine acceptance on the owner's own Profiles.
- **Pathology Library** (referenced by ID from matrix rows): **P1** corrupt/missing-field `profile.json`; **P2** deleted User Memory file; **P3** Settings missing managed fields; **P4** malformed `settings.json`; **P5** pre-manifest Skill (unknown-kind backfill); **P6** broken symlink and circular symlink Skill entries; **P7** missing junction target (Windows); **P8** CJK/emoji/space-containing Profile and Skill names; **P9** overlong paths; **P10** expired Recovery Items (triggers lazy sweep); **P11** malformed `env` values; **P12** malformed MCP entries in `.claude.json`; **P13** apply-crash residue (three transaction states of §7.1).

## Appendix A. Decision provenance

Every section above consolidates closed map-#24 tickets; the ticket holds alternatives and rationale:

- #25 navigation model → §4 · #26/#36 framework + packaging → §2 · #27/#37/#39/#47 Skills ecosystem → §7.3–§7.4 · #28 capability matrix → §6 · #29 guidance → §5 · #30 install wizard → §7.2 · #31 external editing → §8 · #32 launch → §10 · #33 backups/Bin → §9 · #34 CLI contract → §3 · #35 acceptance → §15 · #38 provenance/transactions → §7.1 · #40 compatibility baseline → §14 · #42/#45 plugins → §7.6 · #43 bulk/import-export/templates → §11 · #44 diff → §12 · #46 persistence → §13 · #48 built-in templates → §11.3 (+ `docs/Spec-built-in-profile-templates.md`) · #49/#50 linked Skills → §7.2.

Remaining open item outside this spec: v1+OIDC configuration UX (map fog; gated on [vercel-labs/skills#1825](https://github.com/vercel-labs/skills/issues/1825)).
