# Practitioner Blog Guidance for Built-in Template User Memory (CLAUDE.md)

Status: research findings (issue #48 support)
Investigated: 2026-08-01
Purpose: ground seed content for the six built-in ccps profile templates
(coding, study, work, research, general, blank) in recent practitioner
guidance on Claude Code `CLAUDE.md` / memory.

Scope note: ccps templates seed the **user-level** memory
(`<profile>/claude-home/CLAUDE.md`, equivalent to `~/.claude/CLAUDE.md`).
Most practitioner writing targets **project-level** `CLAUDE.md`; user-level
specifics are flagged where they exist, and the gap is noted at the end.

## Sources

### 1. HumanLayer — "Writing a good CLAUDE.md"

- URL: <https://www.humanlayer.dev/blog/writing-a-good-claude-md>
- Date: 2025 (search-index date 2025-11-25; page displays no date). The most
  cited practitioner post on this topic; widely re-circulated in Dec 2025.
- Author/site: HumanLayer (agent infra company, Dex Horthy).
- Recommendations:
  - `CLAUDE.md` is the only file in every session; treat it as onboarding:
    **WHAT** (stack, repo map), **WHY** (purpose), **HOW** (commands to
    build/test/verify).
  - Claude Code injects a system reminder telling Claude to *ignore*
    `CLAUDE.md` content unless "highly relevant" — bloated or non-universal
    content actively degrades performance.
  - Instruction budget: frontier models follow ~150–200 instructions; Claude
    Code's system prompt already spends ~50. More instructions degrade
    adherence **uniformly**, not just for the newest ones.
  - Length consensus: **< 300 lines, shorter is better** (their own root file
    is < 60 lines).
  - Progressive disclosure: keep task-specific instructions in separate
    `agent_docs/*.md` files, list them with one-line descriptions, let Claude
    read on demand. Prefer `file:line` pointers over copied snippets.
  - "Never send an LLM to do a linter's job" — keep style guidelines out;
    use deterministic formatters/linters (or Stop hooks) instead.
  - Do **not** auto-generate with `/init`; `CLAUDE.md` is the highest-leverage
    point of the harness — craft every line deliberately.

### 2. Anthropic (official) — "Claude Code: Best practices for agentic coding"

- URL: <https://www.anthropic.com/engineering/claude-code-best-practices>
- Date: originally published 2025-04; continuously updated (page now covers
  2026 features: `/goal`, auto mode, agent teams; no date on page).
- Recommendations (memory-relevant):
  - `CLAUDE.md` is read at the start of every conversation; keep it **short
    and human-readable**. Per line ask: "Would removing this cause Claude to
    make mistakes?" If not, cut it.
  - Run `/init` for a starter file, then refine over time (contradicts
    source 1 — see Disagreements).
  - Include/exclude table: include Bash commands Claude can't guess, style
    rules that **differ from defaults**, test-runner instructions, repo
    etiquette, project-specific architectural decisions, env quirks, gotchas;
    exclude anything inferable from code, standard conventions, detailed API
    docs, frequently-changing info, long explanations, file-by-file
    descriptions, "write clean code"-style truisms.
  - Emphasis (`IMPORTANT`, `YOU MUST`) improves adherence for rules that
    matter (contrast with source 8's newer stance).
  - `~/.claude/CLAUDE.md` (user level) applies to all sessions; project files
    at repo root / `./CLAUDE.local.md` / parent dirs; `@path` imports.
  - Skills for domain knowledge relevant only sometimes — keeps every-session
    context lean. Treat `CLAUDE.md` like code: review, prune, check in to git.
  - Broader context hygiene: explore → plan → implement; give Claude a
    verifiable check; `/clear` between unrelated tasks; prune the
    "over-specified CLAUDE.md" failure mode.

### 3. Armin Ronacher — "Agentic Coding Recommendations"

- URL: <https://lucumr.pocoo.org/2025/6/12/agentic-coding/>
- Date: 2025-06-12 (verified on page).
- Recommendations:
  - Keep agent-facing instructions minimal and practical; one of his few
    explicit `CLAUDE.md` uses is pointing the agent at where logs live so it
    can self-diagnose (observability > rules).
  - Make the environment legible to the agent instead of legislating
    behavior: fast tools, clear errors, log files the agent can read.
  - Keep instructions few enough that "fix lint" in `CLAUDE.md` suffices;
    avoid workflow machinery that duplicates what plain prompts do.

### 4. Armin Ronacher — "Agentic Coding Things That Didn't Work"

- URL: <https://lucumr.pocoo.org/2025/7/30/things-that-didnt-work/>
- Date: 2025-07-30 (verified on page).
- Recommendations:
  - Delete automations you stop using — unused commands/rules clutter the
    workspace and confuse (applies to stale memory content too).
  - Most elaborate pre-written prompts underperform "talk to the machine,
    give clear instructions, dump context". Favor simple, few, well-kept
    memory entries over extensive scripted workflow.
  - Static prompts/commands make context problems *worse*, not better;
    automate only what you've already done manually several times.

### 5. Angelo Lima — "Context and Memory Management in Claude Code"

- URL: <https://angelo-lima.fr/en/claude-code-context-memory-management/>
- Date: 2025-12-15 (verified on page). Part of a "Master Claude Code in 20
  Days" practitioner series.
- Recommendations:
  - Explicit 4-level memory hierarchy: enterprise policy → project memory →
    project rules (`.claude/rules/` with glob scoping) → **user memory
    (`~/.claude/CLAUDE.md`) = personal preferences**.
  - User-memory example content: code-style preferences (early returns,
    comment language, semicolons), **communication preferences** (concise
    replies, no emojis, table format for comparisons).
  - `#` prefix adds a live instruction to memory mid-session; `@` imports
    other files (up to 5 levels of recursion).
  - Document learnings into `CLAUDE.md` at end of session instead of
    repeating instructions; manage context with `/compact`, `/clear`,
    checkpoints + git.

### 6. x-cmd (Chinese) — "为什么你的 CLAUDE.md 总被 AI 忽略？"

- URL: <https://cn.x-cmd.com/blog/251203/>
- Date: 2025-12-03 (verified on page). Chinese adaptation/expansion of the
  HumanLayer post (cites it as reference); the most-read Chinese-language
  treatment of this topic.
- Recommendations: mirrors source 1 (WHAT/WHY/HOW; system-reminder ignore
  mechanism; 150–200 instruction budget; < 300 lines; progressive disclosure
  via `agent_docs/`; LLM is not a linter; hooks over style rules; avoid
  auto-generation). Confirms the HumanLayer guidance as the de facto
  consensus in the Chinese community too.

### 7. Boris Cherny's setup (Claude Code creator) — via XDA / 新智元

- Primary: Boris Cherny X thread (2026-01) and Pragmatic Engineer podcast.
- Secondary sources (dated, verifiable):
  - XDA: <https://www.xda-developers.com/set-up-claude-code-like-boris-cherny/>
    — 2026-03-16 (verified on page).
  - 新智元/BAAI: <https://hub.baai.ac.cn/view/52820> — 2026-03-03.
- Recommendations (memory-relevant):
  - Rule of thumb: if you explain the same mistake/preference **twice**, put
    it into `CLAUDE.md` — the file is the persistent "external brain";
    session intelligence shouldn't reset to zero.
  - Content: code style, directory conventions, common commands, do-not-touch
    boundaries, pitfalls already hit.
  - Periodically run a "tech-debt sweep" session to keep memory and repo
    healthy.
  - (Caveat: his advice targets team-shared **project** memory, not user
    memory; he also stresses there is no single correct setup.)

### 8. Thariq Shihipar (Anthropic, Claude Code) — "The new rules of context engineering for Claude 5 generation models"

- Original: Anthropic / @trq212 (2026-07-24); could not fetch the original
  URL directly (404 on guessed path; X not fetchable). Reliable dated
  secondary summary: <https://www.mager.co/blog/2026-07-24-context-engineering-claude-5/>
  (2026-07-24, verified on page). Also corroborated by
  <https://simonwillison.net/2026/Jul/24/introducing-claude-opus-5/> (2026-07-24).
- Recommendations (newest official guidance — shifts prior consensus):
  - Anthropic deleted **80%+ of Claude Code's own system prompt** for
    Claude 5 models with no measurable eval loss. Over-specified rules and
    conflicting instructions crowd out the model's judgment.
  - **Rules → judgment**: don't write "never do X" unless you have a
    demonstrable failure mode the model can't reason out of. Replace rigid
    rules with context-reading instructions (their example: "Write code that
    reads like the surrounding code: match its comment density, naming, and
    idiom").
  - **Examples → interface design**: examples constrain exploration space;
    prefer self-describing interfaces.
  - **Everything upfront → progressive disclosure**: skills + deferred tools;
    don't park occasionally-needed procedures in `CLAUDE.md`.
  - **Manual memory → auto-memory**: Claude Code now saves memories
    automatically when relevant; "You don't need to design CLAUDE.md as a
    memory store. Keep it lightweight."
  - Strip `CLAUDE.md` to repo purpose + **genuine gotchas** (things not
    inferable from reading the codebase). Run `/doctor` to audit.
  - Duplicated instructions across system prompt / CLAUDE.md / skills force
    the model to spend context resolving conflicts — put each instruction in
    exactly one place.

### 9. Thariq Shihipar — "Using Claude Code: Session Management & 1M Context"

- Original: 2026-04-15 (@trq212). Chinese translation by 宝玉 (baoyu.io):
  <https://baoyu.io/translations/claude-code-session-management> — 2026-04-15
  (verified on page; translator's note flags it as semi-official product
  guidance).
- Recommendations (context-side, informs how much memory content is safe):
  - Context rot: performance degrades as the window fills; every token of
    standing memory competes with task context.
  - Per-turn options: continue / rewind / clear / compact / subagent —
    prefer clean contexts over accumulated corrections.

## Recurring, actionable patterns (consensus across sources)

1. **Brevity with a per-line test.** < 300 lines (HumanLayer), ideally far
   shorter; every line must pass "removing it would cause mistakes"
   (Anthropic, HumanLayer, Thariq). For seed templates this means: a short
   scaffold, not a comprehensive rulebook.
2. **Universal applicability only.** Every-session content must apply to
   every task; non-universal content triggers the ignore-reminder and
   degrades adherence uniformly (HumanLayer, x-cmd, Anthropic).
3. **WHAT/WHY/HOW structure for orientation** (HumanLayer, x-cmd); for
   user-level memory this maps to: who the user is, how they work, how to
   communicate — not project facts.
4. **User memory = personal preferences, project memory = project facts.**
   Keep style/communication/output-format preferences at user level; keep
   commands, architecture, gotchas at project level (Angelo Lima, Anthropic
   memory docs). Do not duplicate project memory in user memory.
5. **Progressive disclosure.** Point to files, don't inline them; use
   `@import` / pointers / skills for occasionally-needed material
   (HumanLayer, Anthropic, Thariq).
6. **Deterministic tools over LLM rules.** Don't encode lint/format
   mechanics; prefer hooks/CLI tools (HumanLayer, Ronacher, Anthropic).
7. **Accumulate via a low-friction loop, but prune.** Add a rule after the
   second repeated correction (Boris); delete what stops being used
   (Ronacher); treat memory like code — review and prune (Anthropic).
8. **Concrete > vague.** "Use 2-space indentation", not "format properly";
   no "write clean code" truisms (Anthropic include/exclude table, all
   practitioners).
9. **Verification-oriented instructions beat style instructions.** Tell the
   agent how to verify its work (run tests, check logs) rather than how to
   write pretty code (Anthropic, Ronacher).
10. **Markdown structure, terse bullets, section headers** are the universal
    format; code fences for commands; no long prose (all sources' examples).

## Disagreements and contradictions

1. **`/init`: use it or not?** Anthropic official: "Run `/init` to generate a
   starter CLAUDE.md, then refine." HumanLayer: "Don't use `/init` or
   auto-generate — it's the highest-leverage file, craft it." (For ccps:
   seed templates are a curated middle path — hand-crafted starter content,
   explicitly intended to be edited.)
2. **Hard rules vs judgment-trusting guidance.** Anthropic's standing
   best-practices page (Claude 4 era) still endorses directives and
   `IMPORTANT`/`YOU MUST` emphasis; Thariq's 2026-07-24 Claude-5 guidance
   says remove "never do X" rules unless they encode a demonstrable failure
   mode, because over-specification now *hurts*. This is an explicit
   temporal reversal from the same vendor — newest guidance wins for
   forward-looking seed content: prefer guidance phrased as
   "match the surrounding code / prefer X because Y" over absolute bans,
   except for genuine safety boundaries.
3. **CLAUDE.md as growing memory store vs lightweight file.** Boris (2026-01)
   and Angelo Lima (2025-12): keep appending learnings to `CLAUDE.md`.
   Thariq (2026-07): with auto-memory, don't design `CLAUDE.md` as a memory
   store at all; keep it lightweight and let auto-memory (the profile's
   `memory/auto/` directory) absorb learnings. Direction of travel favors
   Thariq: static seed content stays small; learned facts live elsewhere.
4. **Style rules: in or out?** HumanLayer: keep style guidelines out
   entirely (linter's job). Anthropic: include style rules *that differ from
   defaults*, exclude standard conventions. Angelo Lima's user-memory example
   includes personal style preferences. Reconciled reading: a few
   genuinely-personal style defaults are legitimate in user memory; bulk
   style guides are not.
5. **Hooks enthusiasm varies.** HumanLayer/Anthropic endorse Stop hooks for
   formatting; Ronacher reports hooks gave him no gains and he replaced them
   with PATH interceptors. Seed content should not assume hooks exist.

## Gaps relevant to ccps templates

- Practitioner coverage is overwhelmingly **coding-centric**. No credible
  2025–2026 source gives concrete `CLAUDE.md` patterns for study / research /
  general-work usage; those templates must be derived from the general
  principles above (brevity, personal preferences, communication style,
  progressive disclosure, verification loops) rather than copied from
  domain-specific advice.
- User-level (as opposed to project-level) memory gets explicit treatment
  only in Angelo Lima (source 5) and Anthropic's memory docs; everything else
  must be adapted.
- Content-farm 2026 posts (sidetool, eesel, skywork, apidog, stackademic)
  repeat the same include/exclude table without new evidence; excluded from
  the source list above.
