# Built-in Profile Template Quality Bar and Content Spec

Status: proposed specification (Wayfinder ticket #48)
Date: 2026-08-01
Grounding: docs/research/built-in-template-usermemory-official.md, docs/research/built-in-template-usermemory-github.md, docs/research/built-in-template-usermemory-blogs.md

## Quality bar

A named template earns its name through **behavioral difference, not labeling**: its
CLAUDE.md (User Memory) must carry domain working agreements that change how Claude
behaves in that domain. The per-line test, from Anthropic's own guidance: *"Would
removing this line cause Claude to make mistakes? If not, cut it."* A named template
that fails this test is blank with a title and does not ship.

- **User Memory is the only mandatory dimension.** Skills, Agents, and per-template
  Settings are opt-in per template and ship only with an explicit justification.
  For all six built-ins today: none ship. Rationale: shipped Skills/Agents are
  snapshots ccps must maintain and version; the conversational `create-profile` path
  and custom templates (#43) cover rich setups; official guidance pushes
  occasionally-needed procedures into user-authored skills, not vendor-shipped ones.
- **`general` is not exempt**: it carries 2–4 domain-neutral working agreements, so
  choosing it over `blank` is a real choice.
- **`blank` is intentionally near-empty** — an officially supported form, since
  Claude Code auto memory (on by default, per-profile `memory/auto/`) accumulates
  per-project learnings without seeded content.

## Cross-template contract

1. **Language: English only.** ccps is distributed as OSS with an English CLI;
   Claude adapts its reply language to the user's session regardless of instruction
   language. No parallel bilingual content (doubles length), no locale-dependent
   template variants (breaks determinism).
2. **CLAUDE.md carries domain content only.** The ccps plumbing meta paragraph in
   today's seeds ("This file belongs to a ccps-managed profile…") is removed; the
   profile boundary and MCP workflow already live in the managed
   `rules/ccps-profile.md`, which `init`/`launch` backfill. One instruction lives in
   exactly one place.
3. **Fixed skeleton**: `# <Domain> Profile` title → one usage line →
   `## Conventions` (3–7 agreements) → at most one domain-specific section.
   Total length 20–50 lines (official: user memory well under 200 lines; community
   sweet spot 40–80; we take the lower band because seeds must earn every line and
   subagents load the full CLAUDE.md hierarchy).
4. **Guidance phrasing over hard bans.** Newest official direction (2026-07):
   over-specified rules crowd out the model's judgment. Write "prefer X because Y"
   or "match the surrounding code" style guidance; reserve `NEVER`/`ALWAYS` for at
   most 3 genuine safety boundaries (e.g. fabricated sources). Every prohibition is
   paired with its alternative.
5. **No placeholders.** Built-ins are user-level seeds, complete as shipped.
   `<project name>`-style fill-in templates belong to the conversational
   create-profile path.
6. **One HTML maintainer comment allowed** at the top (block comments are stripped
   before injection — zero context cost): tells the user the file is theirs to edit
   and that ccps manages only `rules/ccps-profile.md`.
7. **No `#` quick-add references** anywhere (removed from Claude Code; do not
   document it). Auto memory and `/memory` are the official paths.
8. **Settings stay uniform** across all six templates (attribution env,
   `autoMemoryDirectory`, `claudeMdExcludes`); no per-template settings differences.

## Description copy

Shown when choosing a template (CLI create, Workbench picker). Contract: domain +
what it does, parallel verb structure, no adjectives, ≤ 80 characters, honest about
content differences.

| Template | Description |
| --- | --- |
| coding | `Software development: implementation, refactoring, code review.` |
| study | `Structured learning: explanations, exercises, comprehension checks.` |
| work | `Professional delivery: planning, coordination, status communication.` |
| research | `Investigation: source review, synthesis, cited analysis.` |
| general | `General use with baseline working agreements.` |
| blank | `Empty profile: no seeded instructions.` |

## Per-template CLAUDE.md seeds

All six share this leading maintainer comment (stripped before injection):

```markdown
<!-- ccps seed: this file is yours — edit freely. ccps manages only rules/ccps-profile.md. -->
```

### coding

```markdown
# Coding Profile

Use this profile for implementation, refactoring, and code review work.

## Conventions

- Think before coding: state the approach in one or two sentences before large changes.
- Make surgical changes: touch only what the task requires; leave unrelated refactors out.
- Match the surrounding code — its comment density, naming, and idiom — because
  consistency with the codebase beats personal style.
- Prefer simple solutions, and say so when a simpler alternative exists.

## Verification

- A task is done only when the project's own checks pass (typecheck, tests, lint,
  build — whatever the repository defines).
- If no verification command exists, say so and propose one instead of claiming done.
- When a change breaks unrelated tests, stop and report before attempting fixes.
```

Grounding: Karpathy-style behavioral guidelines + verification loop
(docs/research/built-in-template-usermemory-github.md); verification-over-style
(official include/exclude table, blogs consensus #9).

### study

```markdown
# Study Profile

Use this profile for structured learning, exercises, and explanation-heavy work.

## Conventions

- Teach to the current level: ask what the learner already knows before explaining
  a new topic.
- Explain in short steps, then check understanding with one question before moving on.
- Prefer worked examples over abstract definitions; connect new ideas to ones the
  learner already understands.
- When unsure of a fact, say so and verify it with a source rather than guessing —
  fabricated facts are worse than admitted gaps.
```

Grounding: Socratic tutor pattern (CFP-Study) minus its embedded syllabus;
anti-hallucination citation rule as the single hard boundary.

### work

```markdown
# Work Profile

Use this profile for planning, coordination, and delivery work.

## Conventions

- Lead with the answer or decision, then the reasoning.
- Keep messages short but complete; prefer lists over prose for plans and status.
- End every interim update with clear next actions, or state that nothing is needed
  from the reader.
- For multi-step work, write the plan down and get agreement before executing.
- Surface risks and blockers early, each with a proposed way forward.
```

Grounding: lestrrat reporting rules (answer-first, explicit action items) +
plan-first principle (pedrohcgs).

### research

```markdown
# Research Profile

Use this profile for source review, synthesis, and exploratory analysis.

## Conventions

- Plan the investigation before searching: state the question and what would answer it.
- Cite a source for every factual claim; mark anything unverified as unverified.
- Prefer primary sources over summaries, and note the date of time-sensitive claims.
- Distinguish findings from interpretations; label open questions explicitly.
- Keep one document per investigation as the single source of truth for its notes.
```

Grounding: pedrohcgs core principles (plan first, verify after, single source of
truth) minus LaTeX/R specifics; anti-hallucination schemas (WenyuChiou).

### general

```markdown
# General Profile

Use this profile when no specialized workflow is needed.

## Conventions

- State assumptions before acting on them.
- When a request is ambiguous, ask a clarifying question instead of guessing.
- Default to concise answers; expand only when the task calls for detail.
- Verify before declaring done: run the check the task implies, or say what could
  not be verified.
```

Grounding: the four domain-neutral agreements that pass the quality bar without
inventing a fake domain (Karpathy skeleton's think/simplicity/verify rules
generalized).

### blank

```markdown
# Blank Profile

This profile intentionally ships no seeded instructions.
Claude Code auto memory accumulates per-project learnings on its own; add your own
instructions here as you find yourself repeating them.
```

Grounding: official — near-empty user memory is a supported form; auto memory (on by
default) absorbs learnings; Boris Cherny's "second repeated correction" rule of
thumb for when to add instructions.

## Migration and compatibility

- New seeds apply to profiles created after the change. Existing profiles keep
  their current CLAUDE.md untouched — it is user data, and the managed rule
  backfill (`ensureCcpsProfileRule`) already maintains their boundary rule.
- The `none` template alias continues to resolve to `blank`.
- `resolveTemplateName` currently maps `undefined` and `'blank'` to `'none'`; that
  behavior is unchanged — only content changes.

## Durable enforcement (for implementation)

- Tests assert: every named template's CLAUDE.md differs from every other's;
  each seed is within the 20–50 line band (blank excepted); no seed contains ccps
  plumbing strings ("CLAUDE_CONFIG_DIR", "ccps-managed"), `#` quick-add references,
  or non-ASCII (language) content; descriptions match the table above and stay
  ≤ 80 characters.
- The quality bar paragraph at the top of this document is the review standard for
  any future template content change.
