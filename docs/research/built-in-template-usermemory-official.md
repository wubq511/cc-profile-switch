# Official Anthropic Guidance on CLAUDE.md (User Memory) for Built-in Template Seeds

Status: research findings (built-in profile templates: coding, study, work, research, general, blank)
Investigated: 2026-08-01
Primary sources: code.claude.com/docs (current official docs home), anthropic.com/engineering
Docs recency: pages cite behavior up to Claude Code v2.1.219; all version-gated notes below are from v2.1.x (2026). Content verified live on 2026-08-01.

## Verdict

Current official guidance supports shipping **short, preference-level** user-memory seeds:
facts Claude cannot infer, phrased as verifiable rules, under 200 lines (in practice far
fewer for user scope), with procedures deferred to skills and path-specific content
deferred to rules. The legacy `#` quick-add memory shortcut is gone from the docs; auto
memory plus "ask Claude to remember" is the official replacement. User-scope imports and
`rules/` load without the external-import approval dialog, so in-profile `@` imports and
a managed `rules/ccps-profile.md` are officially sanctioned mechanisms.

## Memory scopes and where user memory sits

- Four CLAUDE.md scopes, loaded broadest → most specific: **Managed policy** (macOS
  `/Library/Application Support/ClaudeCode/CLAUDE.md`, Linux/WSL `/etc/claude-code/CLAUDE.md`,
  Windows `C:\Program Files\ClaudeCode\CLAUDE.md`) → **User** `~/.claude/CLAUDE.md`
  ("Personal preferences for all projects"; examples: code styling preferences, personal
  tooling shortcuts) → **Project** `./CLAUDE.md` or `./.claude/CLAUDE.md` (team-shared, via
  version control) → **Local** `./CLAUDE.local.md` (personal, gitignored).
  Source: https://code.claude.com/docs/en/memory ("Choose where to put CLAUDE.md files")
- Settings page feature table confirms the same mapping: user CLAUDE.md lives at
  `~/.claude/CLAUDE.md`; user subagents at `~/.claude/agents/`; user settings at
  `~/.claude/settings.json`; MCP user/local scope in `~/.claude.json`.
  Source: https://code.claude.com/docs/en/settings ("What uses scopes")
- ccps note: with `CLAUDE_CONFIG_DIR=<profile>/claude-home`, every `~/.claude` path above
  resolves inside the profile. Officially, user memory is *personal, cross-project* — a
  domain-specific profile (coding/study/...) is a compatible use as long as seed content
  stays preference-level, not project-level.

## CLAUDE.md vs auto memory (two official systems)

- CLAUDE.md: written by the user, holds instructions/rules, loaded every session in full.
- Auto memory: written by Claude itself (learnings, build commands, debugging insights),
  on by default, stored per project at `~/.claude/projects/<project>/memory/` with a
  `MEMORY.md` index; only the first 200 lines or 25KB of `MEMORY.md` load at startup.
  Source: https://code.claude.com/docs/en/memory ("CLAUDE.md vs auto memory", "Auto memory")
- Both are context, not enforcement: "Claude treats them as context, not enforced
  configuration." CLAUDE.md content is delivered as a user message after the system prompt.
  For hard enforcement use PreToolUse hooks or `permissions.deny`.
  Source: https://code.claude.com/docs/en/memory ("Troubleshoot memory issues")
- Official rule of thumb: use CLAUDE.md for what you would otherwise re-explain every
  session; let auto memory absorb discovered preferences without manual effort.
  Source: https://code.claude.com/docs/en/memory

## What officially belongs in a memory file (seed content spec)

- "Keep it to facts Claude should hold in every session: build commands, conventions,
  project layout, 'always do X' rules. If an entry is a multi-step procedure or only
  matters for one part of the codebase, move it to a skill or a path-scoped rule instead."
  Source: https://code.claude.com/docs/en/memory ("When to add to CLAUDE.md")
- Best-practices include/exclude table — Include: bash commands Claude can't guess; code
  style rules that differ from defaults; testing instructions and preferred test runners;
  repository etiquette; project-specific architectural decisions; dev-environment quirks;
  common gotchas. Exclude: anything Claude can figure out by reading code; standard
  language conventions; detailed API docs (link instead); frequently changing information;
  long explanations/tutorials; file-by-file codebase descriptions; self-evident advice
  like "write clean code".
  Source: https://www.anthropic.com/engineering/claude-code-best-practices ("Write an effective CLAUDE.md")
- Per-line test: "Would removing this cause Claude to make mistakes? If not, cut it."
  Bloated files cause Claude to ignore real instructions; "the over-specified CLAUDE.md"
  is a named common failure pattern.
  Source: https://www.anthropic.com/engineering/claude-code-best-practices ("Avoid common failure patterns")
- Only broadly applicable content belongs in CLAUDE.md because it loads every session;
  "for domain knowledge or workflows that are only relevant sometimes, use skills instead."
  Source: https://www.anthropic.com/engineering/claude-code-best-practices

## Size, structure, tone

- **Size**: target under 200 lines per file. Longer files consume context and reduce
  adherence. Splitting into `@` imports aids organization but does not reduce context —
  imports load at launch too.
  Source: https://code.claude.com/docs/en/memory ("Write effective instructions")
- **Structure**: markdown headers and bullets grouped by topic; Claude scans structure
  like a reader. No required format, but "keep it short and human-readable."
  Sources: https://code.claude.com/docs/en/memory ; https://www.anthropic.com/engineering/claude-code-best-practices
- **Specificity**: write verifiable rules — "Use 2-space indentation" not "Format code
  properly"; "Run `npm test` before committing" not "Test your changes".
  Source: https://code.claude.com/docs/en/memory
- **Consistency**: contradictory rules make Claude pick arbitrarily; prune periodically.
  Emphasis like `IMPORTANT` / `YOU MUST` improves adherence.
  Sources: https://code.claude.com/docs/en/memory ; https://www.anthropic.com/engineering/claude-code-best-practices
- Block-level HTML comments (`<!-- maintainer notes -->`) are stripped before injection —
  seeds can carry maintainer notes at zero context cost. Comments inside code blocks survive.
  Source: https://code.claude.com/docs/en/memory ("How CLAUDE.md files load")
- `/doctor` (v2.1.206+) proposes trims for checked-in CLAUDE.md: cuts content derivable
  from the codebase, keeps pitfalls, rationale, and non-default conventions.
  Source: https://code.claude.com/docs/en/memory ("My CLAUDE.md is too large")

## Import syntax and user-scope trust

- `@path/to/import` anywhere in CLAUDE.md; relative paths resolve against the containing
  file (not cwd); recursive imports allowed to depth 4; parsing skips code spans and fenced
  blocks (wrap in backticks to mention without importing).
  Source: https://code.claude.com/docs/en/memory ("Import additional files")
- External imports in **project** memory trigger a one-time approval dialog. Imports in
  **user-scope** memory (`~/.claude/CLAUDE.md`, `~/.claude/rules/`) load without the dialog
  and "carry the same trust as the rest of your personal configuration" — safe for
  template-shipped `@` imports inside claude-home.
  Source: https://code.claude.com/docs/en/memory
- Claude Code reads CLAUDE.md, not AGENTS.md; import it (`@AGENTS.md`) or symlink on
  Unix (on Windows use the import — symlinks need admin/Developer Mode).
  Source: https://code.claude.com/docs/en/memory ("AGENTS.md")

## Loading mechanics relevant to profiles

- Claude walks up from cwd loading `CLAUDE.md` + `CLAUDE.local.md` at each level;
  discovered files are concatenated (not overridden), root-first so instructions closer
  to cwd are read last; within a directory `CLAUDE.local.md` appends after `CLAUDE.md`.
  Subdirectory files load on demand when Claude reads files there.
  Source: https://code.claude.com/docs/en/memory ("How CLAUDE.md files load")
- Project-root CLAUDE.md survives `/compact` (re-read and re-injected); nested ones reload
  on next file read in that subdirectory.
  Source: https://code.claude.com/docs/en/memory ("Instructions seem lost after /compact")
- `--add-dir` directories do not load CLAUDE.md by default; opt in with
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
  Source: https://code.claude.com/docs/en/memory ("Load from additional directories")

## rules/ directories (project and user level)

- `.claude/rules/*.md`: modular per-topic instructions; discovered recursively; optional
  YAML `paths` frontmatter scopes a rule to matching files (loads on demand); rules without
  `paths` load at launch with same priority as `.claude/CLAUDE.md`.
  Source: https://code.claude.com/docs/en/memory ("Organize rules with .claude/rules/")
- **User-level rules**: `~/.claude/rules/` applies to every project; "use them for
  preferences that aren't project-specific"; loaded before project rules (project rules
  win on conflict). Official home for a profile-managed boundary rule like
  `rules/ccps-profile.md`.
  Source: https://code.claude.com/docs/en/memory ("User-level rules")

## Interaction with settings.json

- `claudeMdExcludes`: glob patterns or absolute paths of CLAUDE.md files to skip; matched
  against absolute file paths; settable at any settings layer (user/project/local/managed),
  arrays merge; managed policy CLAUDE.md cannot be excluded.
  Sources: https://code.claude.com/docs/en/settings ; https://code.claude.com/docs/en/memory ("Exclude specific CLAUDE.md files")
- `autoMemoryEnabled` (default true) and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` toggle auto
  memory; `/memory` has a toggle too.
  Source: https://code.claude.com/docs/en/settings ; https://code.claude.com/docs/en/memory
- `autoMemoryDirectory`: custom auto-memory location; absolute or `~/`-prefixed path; read
  from any settings scope; from project/local settings honored only after workspace trust.
  Sources: https://code.claude.com/docs/en/settings ; https://code.claude.com/docs/en/memory ("Storage location")
- `claudeMd` (managed settings only): org-wide CLAUDE.md content inline in
  managed-settings.json; ignored in user/project/local settings.
  Sources: https://code.claude.com/docs/en/settings ; https://code.claude.com/docs/en/memory ("Deploy organization-wide CLAUDE.md")
- Settings files reload live (watched); user/project/local files are strictly validated —
  a file failing validation is rejected as a whole.
  Source: https://code.claude.com/docs/en/settings

## The `#` quick-add shortcut is gone

- Current memory page: "When you ask Claude to remember something... Claude saves it to
  auto memory. To add instructions to CLAUDE.md instead, ask Claude directly, like 'add
  this to CLAUDE.md,' or edit the file yourself via `/memory`." No `#` syntax documented.
  Source: https://code.claude.com/docs/en/memory ("View and edit with /memory")
- The interactive-mode Quick commands table now lists only `/`, `!`, `@`, `:`, `?` — no
  `#` entry. Source: https://code.claude.com/docs/en/interactive-mode
- Corroboration: anthropics/claude-code issue #14868 (2025-12-20) reports `#` stopped
  saving to CLAUDE.md. Template seeds and docs must not reference the `#` shortcut.
  Source: https://github.com/anthropics/claude-code/issues/14868

## skills/ and agents/ under the config dir (what a fresh profile may ship)

- Personal skills: `~/.claude/skills/<skill-name>/SKILL.md`, available across all projects.
  Precedence on name clash: enterprise > personal > project; any of these overrides a
  bundled skill of the same name. Directory name becomes the `/command`; `description`
  frontmatter is the one recommended field. Keep `SKILL.md` under 500 lines, body concise;
  skill content loads only when invoked, descriptions stay in context. Live change
  detection picks up edits without restart. Custom commands (`.claude/commands/`) are
  merged into skills and keep working.
  Source: https://code.claude.com/docs/en/skills ("Where skills live")
- User subagents: `~/.claude/agents/*.md` (recursive scan; identity comes from the `name`
  frontmatter, not the filename). Priority: managed > `--agents` CLI > project
  `.claude/agents/` > user `~/.claude/agents/` > plugin. Built-in Explore/Plan agents skip
  CLAUDE.md; all other subagents load the full CLAUDE.md hierarchy including user memory.
  Optional `memory` field gives a subagent persistent memory at
  `~/.claude/agent-memory/<name>/` (scopes: user/project/local).
  Source: https://code.claude.com/docs/en/sub-agents ("Choose the subagent scope", "What loads at startup")
- Best practices frame skills as the destination for "domain knowledge or workflows only
  relevant sometimes", and subagents for isolated tasks — reinforcing that profile seeds
  should stay thin and push procedures into skills.
  Source: https://www.anthropic.com/engineering/claude-code-best-practices ("Create skills", "Create custom subagents")

## Verification and maintenance commands (official)

- `/context` — confirm memory files actually loaded (listed under "Memory files").
- `/memory` — browse/edit all memory files across scopes; toggle auto memory; opens the
  auto-memory folder.
- `/init` — generates a starter project CLAUDE.md (suggests improvements if one exists);
  `CLAUDE_CODE_NEW_INIT=1` enables an interactive multi-phase flow that can also set up
  skills and hooks.
- `/doctor` — setup checkup including CLAUDE.md trim proposals (v2.1.206+).
- `InstructionsLoaded` hook — logs exactly which instruction files loaded, when, and why.
  Sources: https://code.claude.com/docs/en/memory ; https://code.claude.com/docs/en/interactive-mode

## Implications for the six ccps template seeds

- User memory's official role is cross-project personal preference. Domain profiles should
  seed *domain-level working agreements* (tone, workflow defaults, verification habits),
  not project architecture or commands — those belong to project CLAUDE.md or are
  inferable and officially excluded.
- Keep every seed well under 200 lines; apply the include/exclude table and the
  "would removing this cause mistakes?" test line by line. `blank` can legitimately ship
  near-empty: auto memory is on by default and accumulates per-project learnings itself.
- Do not reference `#` quick-add in any seed or docs; point users to "ask Claude to
  remember" (auto memory) or `/memory`.
- `@` imports inside claude-home and `rules/ccps-profile.md` are officially trusted
  user-scope mechanisms — no approval dialog.
- Seeds should not restate defaults ("write clean code") or duplicate settings/hook
  enforcement; CLAUDE.md is advisory, hooks/permissions are the enforcement layer.
