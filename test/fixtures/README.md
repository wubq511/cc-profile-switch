# Profile Fixture Generator

Deterministic generator for Profile Workbench test fixtures and the Pathology
Library, per issue #77 and `docs/Spec-profile-workbench.md` §15.6. This is
test-only infrastructure: it lives under `test/` and is never compiled into the
shipped `dist` bundle (tsup builds `src/index.ts` only; `files: ["dist"]`).

Real Profiles are never checked in. Every byte of fixture content is synthetic,
derived from a fixed seed through the seeded PRNG in `prng.ts`.

## Generator contract: seed + params → structure

`buildFixturePlan({ seed, tier, pathologies })` returns a serializable
`FixturePlan` describing a complete ccps app-home tree (config, api-settings,
state, `profiles/<name>/...`, `recovery-bin/<id>/...`). The plan is the single
source of truth; `materializeFixture(plan, rootPath)` writes it to disk.

- **seed** (uint32, default `0x0707cc77`): feeds a mulberry32 PRNG. Same seed →
  same PRNG stream → same content on every platform and Node version. No
  `Date.now()`, `Math.random()`, or filesystem stat feeds the plan.
- **tier** (size parameters → directory structure):
  - `mini` — 3 profiles × 4 skills. Used by the golden plan and unit tests.
  - `baseline` — 20 profiles × 50 skills. The §15.4 performance-gate tier.
  - `3x` — 60 profiles × 150 skills. The §15.4 stress tier (no latency thresholds).
- **pathologies** (list of IDs, default all): each requested ID adds one
  dedicated pathology profile. `none` produces a clean tree.

The plan is serialized with `stableStringify` (recursively sorted keys, 2-space
indent, trailing `\n`). Two runs with the same seed + params on Windows, macOS,
and Linux produce **byte-identical plan bytes** — the cross-platform determinism
proof, pinned in CI against the committed golden at `golden/mini.plan.json`.

## Materialization

`materializeFixture` writes the plan with explicit `\n` line endings and
canonical JSON, so materialized regular-file content is byte-identical across
platforms. Platform-specific entries are best-effort, gated on capability:

- **symlinks** (P6 broken/circular, P7 junction fallback): created only when a
  startup probe confirms the platform can create symlinks; otherwise the entry
  is recorded as skipped with a reason. This mirrors the existing
  `canCreateSymlink` probe in `test/skills-provenance.test.ts`.
- **junctions** (P7): created on Windows; on macOS/Linux a broken symlink is
  created instead so the pathology is observable in CI.
- **overlong paths** (P9): attempted; on platforms that reject the length
  (`ENAMETOOLONG`) the entry is skipped with a reason. The plan always records
  the intent, so producibility is provable without materialization.

## Pathology Library (P1–P13)

Referenced by ID from the scenario matrix rows. Each ID is producible on its
own: `buildFixturePlan({ tier: 'mini', pathologies: ['Pn'] })`.

| ID  | Pathology                            | Materialized shape                                                                                     |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| P1  | corrupt/missing-field `profile.json` | `profile.json` is invalid JSON                                                                         |
| P2  | deleted User Memory                  | `claude-home/CLAUDE.md` absent                                                                         |
| P3  | Settings missing managed fields      | `settings.json` lacks `autoMemoryDirectory` / `claudeMdExcludes` / attribution env                     |
| P4  | malformed `settings.json`            | `settings.json` is invalid JSON                                                                        |
| P5  | pre-manifest Skill                   | skill dir present, `skills-provenance.json` omits it (backfill target)                                 |
| P6  | broken + circular symlink Skills     | self-referential and dangling `skills/<name>` symlinks                                                 |
| P7  | missing junction target (Windows)    | `skills/<name>` junction to an absent target                                                           |
| P8  | CJK/emoji/space names                | CJK skill/agent/memory names + CJK description (profile dir stays ASCII per the profile-name contract) |
| P9  | overlong paths                       | deeply nested skill path approaching OS limits                                                         |
| P10 | expired Recovery Items               | `recovery-bin/<id>/item.json` with `removedAt` far in the past                                         |
| P11 | malformed `env` values               | `settings.json` env with non-string values                                                             |
| P12 | malformed MCP entries                | `.claude.json` `mcpServers` is a non-object                                                            |
| P13 | apply-crash residue (3 states)       | `.ccps-tmp-*` only; `.ccps-old-*` + final; `.ccps-old-*` without final                                 |

**Profile directory names stay ASCII-safe** (`[A-Za-z0-9_-]`) per the profile-name
contract (`src/platform/path.ts` `validateProfileName`). P8 therefore puts CJK in
the description and in resource item names (skill dirs, agent files, auto-memory
files), which is what the §14 / S119 rendering-width scenarios exercise.

## Synthetic credentials

Fixtures contain placeholder credential values shaped `fixture-placeholder-<hex>-<n>`
in `api-settings.json` and (malformed, for P11) `settings.json`. These match no
real credential shape, so redaction tests have a value to redact without
introducing real-secret risk. The repo credential-insulation test
(`test/repo-credential-insulation.test.ts`) verifies no real credential shape is
committed anywhere, including in generated fixtures.

## Usage

```bash
# Materialize the baseline tier into a gitignored dir for local inspection
npm run fixtures:generate -- --tier baseline --out .fixtures-out

# Print the mini tier plan to stdout
npm run fixtures:generate -- --tier mini --pathologies none

# Regenerate the committed golden (only when the generator intentionally changes)
npm run fixtures:golden
```

## When the generator changes

If `buildFixturePlan` output intentionally changes, regenerate the golden and
commit it:

```bash
npm run fixtures:golden
```

The golden test (`test/fixture-generator.test.ts`) compares the rebuilt plan to
the committed golden byte-for-byte; it fails (on every CI OS) if the output
drifts, with a pointer to `npm run fixtures:golden`.
