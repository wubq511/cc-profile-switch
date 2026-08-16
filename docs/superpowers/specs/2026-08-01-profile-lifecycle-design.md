# Profile Lifecycle Operations in the Workbench — Design

Date: 2026-08-01
Issue: #56
Parent spec: #53, `docs/Spec-profile-workbench.md`

## Problem

The Workbench sidebar (issue #54) shows profiles as cards but provides no way to act on them. Users must drop back to the CLI to create, copy, rename, set default, validate, or back up profiles. Issue #56 requires all profile lifecycle operations reachable from the sidebar, routed through existing core services.

## Design

### Architecture

All lifecycle actions route through existing core services — no new core code. The work is entirely in the TUI layer: wiring sidebar key bindings to core service calls and rendering inline prompts + results.

### Inline prompt state machine

A reducer in the sidebar manages the prompt lifecycle:

```
idle → (action key) → prompting → (Enter) → executing → (success) → success → (auto-dismiss) → idle
                                              → (error) → error → (Esc) → idle
prompting → (Esc) → idle
```

States:
- **idle**: sidebar shows action hint line
- **prompting**: inline input field replaces the hint line; user types and presses Enter
- **executing**: spinner/indicator while core service runs
- **success**: brief confirmation message, auto-dismisses after ~1.5s
- **error**: error message with recovery hint, dismissible with Esc

### Create-from-template flow

Two sequential inline prompts:
1. **Template picker**: arrow keys cycle through `coding/study/work/research/general/blank`, Enter confirms
2. **Name input**: type profile name, Enter creates

### Validate result rendering

Inline in the sidebar, showing findings with severity badges (`[error]` / `[warning]`). Errors block launch, warnings don't. Dismissible with Esc.

### Key bindings

| Key | Action | Prompt type |
|-----|--------|-------------|
| `n` | Create from template | Template picker → Name input |
| `c` | Copy profile | Type target name |
| `r` | Rename profile | Type new name |
| `d` | Toggle default | Immediate (no prompt) |
| `v` | Validate | Immediate, results inline |
| `b` | Backup | Immediate (no prompt) |
| `x` | Remove | Type exact name to confirm |

### Data refresh

After any mutating action (create, copy, rename, remove, default toggle), call `loadWorkbenchData()` to refresh the sidebar list and main pane.

### i18n

All new strings added to both `en.ts` and `zh.ts` locale files. Keys follow the existing `sidebar.*` and `lifecycle.*` namespace patterns.

### Files to modify

- `src/tui/workbench/sidebar.tsx` — add action bar, inline prompts, key bindings
- `src/tui/workbench/app.tsx` — pass refresh callback to sidebar
- `src/tui/workbench/profile-data.ts` — expose `loadWorkbenchData` for refresh
- `src/tui/workbench/i18n/en.ts` — add lifecycle strings
- `src/tui/workbench/i18n/zh.ts` — add lifecycle strings

### Files to add

- `src/tui/workbench/lifecycle.ts` — prompt state machine reducer + types
- `test/workbench-lifecycle.test.tsx` — interaction tests

### Testing

Core services already have comprehensive tests. New tests cover:
- Sidebar action bar renders correct keys for selected profile
- Inline prompt state transitions (idle → prompting → executing → success/error)
- Create-from-template two-step flow (template picker then name input)
- Validate findings rendered with correct severity badges
- Data refresh after mutations
- i18n key coverage (both locales have all keys)

### Acceptance criteria mapping

- **Create-from-template lands a fully seeded Profile** → `n` key → template picker → name input → `createProfile()` → refresh
- **Copy produces a complete clone** → `c` key → name input → `copyProfile()` → refresh
- **Rename moves the directory and updates every reference** → `r` key → name input → `renameProfile()` → refresh
- **Set/clear default moves the marker** → `d` key → `setDefaultProfile()`/`clearDefaultProfile()` → refresh
- **Validate renders error findings and warnings inline** → `v` key → `validateProfile()` → render findings in sidebar
- **All operations reuse existing core services** → all actions call existing core functions, no duplication
