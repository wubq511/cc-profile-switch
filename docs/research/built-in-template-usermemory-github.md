# Built-in Template User Memory (CLAUDE.md) — GitHub Research

Status: research findings
Investigated: 2026-08-01
Purpose: ground seed content for the six built-in profile templates (coding, study, work, research, general, blank) in what the Claude Code community treats as professional CLAUDE.md practice.

## Verdict

Professional user-level CLAUDE.md files are short (roughly 15–160 lines), imperative, English-first, and organized as a lean "core + pointers" file: a few non-negotiable behavior rules up front, then tables mapping triggers to on-demand docs/skills. Long files are tolerated only when they embed irreplaceable domain data (exam syllabi, command catalogs). The strongest signals across all exemplary repos: verification loops, "Don't X — do Y" phrasing, emphasis keywords used sparingly, and progressive disclosure instead of embedded detail.

## Curated collections (what the community treats as exemplary)

- [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — 51.4k stars, last push 2026-08-01 (daily activity). The canonical awesome list. Relevant picks: `andrej-karpathy-skills` drop-in CLAUDE.md, HumanLayer's "Writing a Good CLAUDE.md" essay, Anthropic's official best practices.
- [josix/awesome-claude-md](https://github.com/josix/awesome-claude-md) — 531 stars, last push 2026-06-05. 89+ real project CLAUDE.md files in 6 categories (complex-projects, developer-tooling, libraries-frameworks, getting-started, infrastructure, project-handoffs) with per-file analysis. Project-level focus; best source for "what good looks like" breadth.
- [abhishekray07/claude-md-templates](https://github.com/abhishekray07/claude-md-templates/blob/main/principles.md) — principles compilation synthesizing Anthropic docs, HumanLayer research, Boris Cherny's team tips, and measured token-cost data from claude-code GitHub issues. The single best distilled rule set.
- [centminmod/my-claude-code-setup](https://github.com/centminmod/my-claude-code-setup) — 2.5k stars, last push 2026-07-26. Starter template + CLAUDE.md memory-bank system; popularizes the multi-file memory pattern.

## Exemplary repos by domain

### Coding (user-level / global)

- [citypaul/.dotfiles — claude/.claude/CLAUDE.md](https://github.com/citypaul/.dotfiles/blob/main/claude/.claude/CLAUDE.md) — 696 stars, last push 2026-07-31 (very active). Versioned (v3.0.0) "lean core" of ~160 lines: core philosophy → quick-reference bullet blocks per topic → each block ends with "For detailed X, load the `y` skill". Migrated from a 1,818-line monolith to core + on-demand skills. Patterns: one non-negotiable headline rule (TDD), "Quick reference" sections, skill-routing paragraphs, output guardrails ("write to files, not chat"), explicit tool preferences.
- [multica-ai/andrej-karpathy-skills — CLAUDE.md](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md) — ~60 lines, 4 numbered behavioral guidelines (Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution). Each rule has a bold one-line thesis, 3–6 bullets, and a self-check question ("Would a senior engineer say this is overcomplicated?"). Ends with a "these guidelines are working if..." success test. Ideal minimal general/coding seed.
- [lestrrat/claude-code — CLAUDE.md.global](https://github.com/lestrrat/claude-code/blob/main/CLAUDE.md.global) — global file with a "Before ANY Task" mandatory checklist, a pre-read rules table (Area | Trigger | Doc path), and an extensive Reporting section governing response length, word choice, stance, and interim-update format. Best example of communication-style rules at user level.

### Study / learning

- [chenran818/CFP-Study — CLAUDE.md](https://github.com/chenran818/CFP-Study/blob/main/CLAUDE.md) — defines a tutor role ("act as an interactive CFP exam tutor"), Socratic response structure (explore baseline → ~200-word explanation → comprehension check → adaptive follow-up), explicit DO/DON'T lists, a two-step session-tracking protocol (`/sessions/YYYY-MM-DD/` + single progress-tracker file), and a zero-tolerance verification protocol ("NEVER guess... search online first, cite your source"). Long (~200 lines) because it embeds the exam syllabus — domain data justifies length.
- Related skill-ecosystem signal: Socratic-tutor skills ([augmnt/collab](https://github.com/augmnt/collab), [egouilliard-leyton/python-tutor-skill](https://github.com/egouilliard-leyton/python-tutor-skill)) all converge on "never give the answer directly; graduated hints; track attempts."

### Work / professional execution

- [lestrrat CLAUDE.md.global](https://github.com/lestrrat/claude-code/blob/main/CLAUDE.md.global) (above) is the strongest work-domain reference: reporting rules (answer-first, terse-but-complete sentences, hard section budgets, "end every interim update with user action items or 'Nothing needed from you'"), GitHub etiquette (`gh` CLI only), request-wording rules.
- [humanlayer/humanlayer — CLAUDE.md](https://github.com/humanlayer/humanlayer/blob/main/CLAUDE.md) — 57-line project benchmark: repo overview, components, ASCII architecture flow, exact build/test commands, a priority-based TODO annotation convention (`TODO(0)`–`TODO(4)`, `PERF`). Shows a professional file can be under 60 lines.

### Research / data science

- [pedrohcgs/claude-code-my-workflow — CLAUDE.md](https://github.com/pedrohcgs/claude-code-my-workflow/blob/main/CLAUDE.md) — 1.4k stars / 2.8k forks, last push 2026-06-10; featured in awesome-claude-code's Research section. Ready-to-fork academic template (LaTeX/Beamer + R). Patterns: placeholder fields (`[YOUR PROJECT NAME]`), core principles (plan first, verify after, single source of truth), numeric quality gates (80 commit / 90 PR / 95 excellence), `[LEARN:category] wrong → right` tags written to MEMORY.md when corrected, exact compilation command blocks, skills quick-reference grouped by workflow.
- [WenyuChiou/ai-research-skills](https://github.com/WenyuChiou/ai-research-skills) (via awesome-claude-code) — anti-hallucination pattern for research: schemas force "gap" status on unsupported claims; downstream stages refuse overconfident handoffs.

## Reusable patterns (cross-domain)

Structure (in order of appearance):
1. Optional header line stating the file's purpose ("This file provides guidance to Claude Code...") — from the official `/init` convention.
2. Core principles / non-negotiables — 1 headline rule, bolded or capped.
3. Quick-reference sections per topic — bold "Core principle:" lead + 4–8 imperative bullets.
4. Commands / verification blocks — exact, copy-runnable commands; verification checklist ordered (typecheck → test → lint → build).
5. Routing tables — Area | Trigger | Doc/skill (progressive disclosure; the file is the index, docs are the library).
6. Conventions — TODO priorities, commit/PR etiquette, output guardrails.
7. Pointers to memory/state files (MEMORY.md, progress tracker) with update protocols.

Rule style:
- Imperative mood, second person implied; bold thesis line per rule, then bullets.
- "Don't X — do Y" (every prohibition paired with the alternative).
- Emphasis keywords (`IMPORTANT:`, `YOU MUST`, `NEVER`, `ALWAYS`) reserved for 2–3 truly non-negotiable rules; overuse explicitly flagged as an anti-pattern.
- Concrete and verifiable over vague: "Catch specific exceptions, not bare `Exception`" beats "handle errors properly."
- Self-check questions embedded in rules ("Would a senior engineer say this is overcomplicated?").
- Success tests at file end ("These guidelines are working if: ...").

Length norms:
- User-level/global: ~15 lines (Anthropic guidance) to ~160 lines (citypaul lean core); 40–80 is the sweet spot.
- Project-level: under 60 lines ideal (HumanLayer benchmark 57); 200 lines is Anthropic's documented ceiling; beyond that adherence drops uniformly.
- Attention budget: system prompt already consumes ~50 instructions; frontier models follow ~150–200 total — every line devalues every other line (HumanLayer).
- Exception: embedded domain data (exam syllabus, command catalogs, quality thresholds) justifies length because it cannot be discovered from code.

Language conventions:
- English is the default even for non-native authors; localized files are the exception (e.g. a German Socratic skill ships bilingual).
- Placeholders in templates use `[YOUR PROJECT NAME]`-style brackets with "(example — delete)" annotations.
- Tone: peer-to-peer engineering brief, no flattery, no personality instructions ("be a senior engineer" is a named anti-pattern).

Anti-patterns (community consensus):
- Unedited `/init` output; >100-line files of generic advice; formatting rules (linter's job); @-importing large docs into every session; negative-only rules; duplicate rules across files; treating CLAUDE.md as documentation/wiki; personality/persona prompts.

## Implications for ccps seed content

- All six templates should be English-first, imperative, and short; blank stays near-empty with the purpose header only.
- coding: Karpathy-style 4-rule skeleton + verification-loop block + "surgical changes" rule (~40–60 lines).
- study: CFP-Study pattern minus syllabus — tutor role, Socratic response structure, comprehension checks, session-notes + single-tracker protocol, "never guess; verify and cite" rule.
- work: lestrrat-style reporting rules (answer-first, action items explicit) + plan-first + quality-gate concept from pedrohcgs.
- research: pedrohcgs pattern minus LaTeX — core principles (plan first, verify after, single source of truth), `[LEARN]`-tag self-improvement loop pointing at the profile's `memory/auto/`, anti-hallucination citation rule.
- general: thin combination — think-before-coding, simplicity, verify-before-done, concise reporting (~20–30 lines).
- Every template: route detail to skills/docs instead of embedding; reserve `NEVER`/`ALWAYS` for ≤3 rules; pair every prohibition with its alternative.

## Sources

- https://github.com/hesreallyhim/awesome-claude-code (51.4k★, active 2026-08)
- https://github.com/josix/awesome-claude-md (531★, active 2026-06)
- https://github.com/abhishekray07/claude-md-templates/blob/main/principles.md
- https://github.com/centminmod/my-claude-code-setup (2.5k★, active 2026-07)
- https://github.com/citypaul/.dotfiles/blob/main/claude/.claude/CLAUDE.md (696★, active 2026-07)
- https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md
- https://github.com/lestrrat/claude-code/blob/main/CLAUDE.md.global
- https://github.com/chenran818/CFP-Study/blob/main/CLAUDE.md
- https://github.com/humanlayer/humanlayer/blob/main/CLAUDE.md
- https://github.com/pedrohcgs/claude-code-my-workflow/blob/main/CLAUDE.md (1.4k★, active 2026-06)
- https://github.com/WenyuChiou/ai-research-skills
- https://www.humanlayer.dev/blog/writing-a-good-claude-md (via above lists)
- https://code.claude.com/docs/en/best-practices (via above lists)
