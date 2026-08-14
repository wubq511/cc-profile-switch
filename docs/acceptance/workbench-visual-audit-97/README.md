# Workbench Visual Audit — Issue #97

Complete PTY screenshot audit of the Profile Workbench: every screen and
overlay × zh/en × compact (80×24) / wide (140×40), plus zero-profile,
watching, resize-guard, and NO_COLOR runs. The deliverable is the annotated
fix list below; **no production code is changed by this ticket**.

## Method

- Harness: `scripts/visual-audit/` drives the real Workbench
  (`dist/workbench.mjs`) inside a Python PTY, replays each frame's raw byte
  stream through `@xterm/headless` (the VS Code terminal emulator engine),
  and renders PNGs with Pillow. DSL session scripts in
  `scripts/visual-audit/scripts/` navigate with self-healing primitives
  (`until-hl`, `until-marker`, `nav-grid`, `press-until`, `wait-until`,
  `until-gone`) because Ink drops keypresses non-deterministically under
  scripted input — absolute key counts proved unreliable at 90/500/1000 ms
  pacing. The harness is macOS-only (Menlo/PingFang font paths, BSD `sed`);
  it tests the Workbench, which itself stays cross-platform.
- Fixture: 20 generated profiles (baseline tier) + seeded backups, Recovery
  Bin items (profile / skill / auto-memory ×2), a custom template, export
  bundles, a local skill source, a zero-resource `sandbox` profile, one
  deliberately broken profile (profile-018), and `claude`/`editor-stub`
  shims on PATH. The `claude` shim seeds all three Plugins-card states:
  populated (two plugins, one enabled) for normal profiles, empty list for
  `sandbox`, fail-closed "unavailable" for `profile-018`. Rebuilt per
  session by `reset-home.sh`. The wizard2 session
  adds `--trim-skills`: with the full fixture the install wizard's
  cross-profile source list discovers ~950 sources (19 profiles × 50
  skills), so the manual-entry tail row is unreachable; trimming every other
  profile's `skills/` leaves a list whose only row is manual entry.
- Matrix: `./scripts/visual-audit/run-all.sh` — 7 primary sessions + wizard2
  × en/zh × 80×24/140×40, plus zero ×4, watch ×4 (live editor stub), resize
  ×2 (79×23), NO_COLOR ×2. Compact runs also render a light-background
  variant.

Full frame archive lives in `audit-output/` (gitignored); the frames cited
below are committed under `shots/`.

## Coverage map

| Surface | Frames | Sessions |
| --- | --- | --- |
| Welcome / home / sidebar tree | a01–a03 | main |
| Search (focus / name / content / no-match) | a04–a07 | main |
| Help sheet (`?`) | a08, n03 | main, nocolor |
| Validate OK + findings (broken profile) | b01, c01–c02 | main |
| Backup success flash | b02 | main |
| Remove confirm (destructive panel) | b03 | main |
| Save-template prompt / confirm / flash | b04–b07 | main |
| Description inline edit | b08 | main |
| Copy / Rename prompts | b17–b18 | main |
| Export prompt | b09 | main |
| Import error / preview / collision | b10–b12 | main |
| Create picker (built-in + custom rows) | b13–b16, z03–z04 | main, zero |
| Template remove flash | b15 | main |
| Plugins card (populated / empty / unavailable states) | a02–a03, c03, c01 | main |
| Grid focus (7 cards) | e01, k02 | drills, main |
| User Memory list / preview / diff | e02–e04 | drills |
| Agents list / frontmatter editor / create / preview / copy / search | e05–e10 | drills |
| MCP diff / Settings diff | e11–e12 | drills |
| MCP category drill (bulk surface, 1 server row) | e13 | drills |
| Launch Config diff (`launch.*` keys; `⚠ sensitive` renders only on changed/only-rows, so the fixture's identical `skipPermissions` shows none) | e14 | drills |
| Bulk ops (skills 50 items, select-all, copy targets, remove) | f01–f04 | bulk |
| Skills Discover (results, search, source prompt) | f05–f07 | bulk |
| Auto Memory drill / copy prompt / restore picker / collision | g01–g05 | automem |
| Recovery Bin list / delete confirm / empty confirm / retention / backup row / restore collision / rename | h01–h07 | recovery |
| Edit fallback menu / path flash | i01–i02 | launch |
| Launch bar / dry-run / directory screen / blocked / exit flash / missing CLAUDE.md | i03–i09 | launch |
| Empty states (blank profile, empty categories, empty bulk, empty auto-memory) | k01–k06 | main |
| Install wizard — full list (kind, ~950-row source list, remote input / staging error) | d01–d02, d10–d12 | wizard |
| Install wizard — manual path (empty source list, manual entry, source error, mode, confirm, success, collision) | d03–d09 | wizard2 |
| Zero-profile state | z01–z05 | zero |
| Watching badge / preview change / missing overlay | w03–w06 | watch |
| Resize guard (79×23) | r01 | resize |
| NO_COLOR | n01–n03 | nocolor |

Design notes on what the map does **not** list, so the coverage claim stays
honest:

- Settings and Launch Config are non-drillable categories
  (`categories.ts:17-18`): selecting them only focuses the grid card, so
  their sole content surface in the current build is the pairwise diff
  (e12, e14) — there is no inspect/preview screen to shoot (spec S45/S86
  preview panes are not implemented yet).
- Skills' category drill **is** the bulk-ops surface (spec §11.1), covered
  by f01–f04; per-skill SKILL.md preview (S61) is not implemented.
- Every session runs en + zh × 80×24 + 140×40, so each frame above exists
  in four combinations; light-background variants render for the compact
  runs (the 80-col layout is where contrast risk concentrates).

## Fix list

> Each entry: current shot · problem · proposed change · §14 constraint
> check. Numbering is stable for cross-referencing from the follow-up
> polish ticket.

Severity: **P0** strands the user or hides primary content · **P1** garbles a
surface but a workaround exists · **P2** polish. Shots referenced live in
`shots/`.

### Functional blockers

**F1 — Launch bar: Esc is a no-op; blocked state has no way out.**
`shots/i03-launch-bar.png` · `shots/i07-launch-blocked.png`

- Problem: in launch phase `bar`, Esc dispatches `LAUNCH_DISMISS`
  (`app.tsx:760-762`), but the reducer only honors that action in phase
  `exited` (`lifecycle.ts:405-411`) — so Esc does nothing. When validation
  findings contain an error, `LAUNCH_CONFIRM` also returns state unchanged
  (`lifecycle.ts:347-350`), so Enter is dead too: the user is stranded on
  the bar with only `q` (quit the whole app) as an exit. The bar itself
  prints no `[esc]` hint, so nothing tells the user they are stuck.
- Proposed change: honor `LAUNCH_DISMISS` in phases `bar`, `dry-run`, and
  `blocked` (reset launch state to idle); add `[esc] cancel` to the bar's
  hint line, and in the blocked state make Esc the documented exit while
  keeping Enter disabled.
- §14: behavior-only fix; no color, glyph, or layout change. Nothing removed.

**F2 — Success flash swallows keys for 1.5 s.**
`shots/b02-backup-success-bar.png`

- Problem: all lifecycle keys are gated on `lifecycle.phase === 'idle'`
  (`sidebar.tsx:343`), while the success flash lives for 1.5 s
  (`sidebar.tsx:455-461`). Any key pressed inside that window is silently
  dropped — during the audit the `b` of a follow-up backup and a `d` were
  both eaten. To a user this reads as "the app ignores me".
- Proposed change: when a lifecycle key arrives during `success`, dismiss
  the flash immediately and fall through to normal handling of that key
  (the flash is a notification, not a mode). Alternatively treat only
  printable lifecycle keys this way and keep arrows/esc as dismiss-only.
- §14: behavior-only fix. Nothing removed.

**F3 — Install wizard source list is not virtualized; manual entry
unreachable.**
`shots/d02-wizard-sources.png`

- Problem: `listLocalSkillSources` enumerates every other profile's skills
  (fixture: 19 profiles × 50 skills ≈ 950 rows), with no scroll window and
  no position counter. The manual-entry tail row sits at index ~950 —
  unreachable in practice (the audit's scripted navigation could not reach
  it at all; the wizard2 session only works because the fixture is trimmed
  via `--trim-skills`).
- Proposed change: give the source list the same follow-cursor window the
  sidebar already uses (`sidebar.tsx:479`), add an `N/M` position indicator,
  and pin the manual-entry row as a fixed last row below the window so it
  is always one keypress away regardless of source count.
- §14: the manual row stays in the same list on the same screen (14.6
  holds); `N/M` is plain text; no color-only state.

### Visual — P0

**V1 — Grid cards lose the category name at 80 columns.**
`shots/a02-home.png` vs `shots/a02-home-wide.png`

- Problem: at 80 cols the card title row truncates away the category name
  (the primary label of the card) while keeping secondary decoration; at
  140 cols the same cards read fine. The collapse cascades further in the
  drills fixture (see `shots/e01-grid-focus.png`): card content overflows
  into the borders (`─d diff vs another ─`), and the Plugins card heading
  fuses with the last grid card (`Pluginsle`).
- Proposed change: reserve a minimum width for the category name; truncate
  the descriptor/count segment first, drop it entirely before touching the
  name, and only then truncate the name with `…`. The border/content
  overflow half of this is the same Ink height-miscalc family as V3/V6 —
  erase and clip card content to its box.
- §14: text-only; `…` is BMP; nothing moves screens.

**V2 — Grid focus indicator is collateral damage of V1 at 80 columns.**
`shots/e01-grid-focus.png`

- Problem: the focus indicator exists in code — the focused card renders
  `▸` + inverse cyan (`main-pane.tsx:299-300`) and shows correctly at 140
  cols — but at 80 cols V1's title-row destruction takes the indicator
  with it, leaving the 7-card grid with no visible focus at all.
- Proposed change: no separate fix; verify after the V1 fix that the
  focused card's `▸` + inverse survives at 80 cols (add a compact-width
  snapshot to lock it). If the title row must ever drop the label, the `▸`
  must move to the border or count row — focus visibility is not optional
  (§14.7's spirit: operability never rides on an invisible channel).
- §14: `▸` (U+25B8) is BMP and already used; glyph + inverse is not
  color-alone; works under NO_COLOR because the glyph remains.

**V3 — Create picker swallows rows and bleeds into the sidebar.**
`shots/b13-create-picker.png`

- Problem: at 80 cols the `study` / `general` template rows vanish from the
  picker (they vanish in zh too, so it is width-driven, not locale), and
  stale fragments of those rows (`studyg/generalh`) bleed through the
  sidebar border — the old cells are never erased when the overlay
  repaints.
- Proposed change: cap picker rows to one terminal row each (truncate long
  template names with `…`); erase the overlay's full rectangle on every
  repaint so shrinking content cannot leave residue. See V6 for the general
  overlay-background fix — this picker's row loss is the severe half of the
  same bug family.
- §14: text/layout-only.

**V4 — Wizard source list: cursor row invisible, names left-clipped.**
`shots/d02-wizard-sources.png` · contrast `shots/d03-source-list-empty.png`

- Problem: with ~950 rows, the cursor row renders with no visible marker
  (the `▸` + cyan used elsewhere never appears); long source names are
  clipped from the left, so `skill-024` reads as `ill-024` — the user
  cannot tell which skill a row is. In the empty-list case (d03) the `▸`
  renders correctly, so this is specific to the long-list rendering path.
- Proposed change: render the cursor row with the standard `▸` + inverse
  treatment in all list lengths; right-truncate (or middle-ellipsis) source
  names so the distinguishing prefix stays visible.
- §14: glyph + inverse, not color-alone; BMP only.

**V5 — Help sheet columns collide; zh loses characters.**
`shots/a08-help.png` · `shots/a08-help-zh.png`

- Problem: at 80 cols the multi-column help layout overlaps — section
  headings are eaten by the first content row of the previous column, and
  the zh concept paragraph drops characters. Reproduces identically in en,
  zh, and NO_COLOR, so it is a layout bug, not a palette issue.
- Proposed change: below ~100 cols switch the help sheet to a
  single-column, vertically stacked layout (scroll if needed); keep the
  multi-column layout only where each column's width is guaranteed. Enforce
  ≥2 cells of gutter between columns.
- §14: same content, same screen (14.6 holds — reflow within the sheet, not
  movement to another surface); text-only.

### Visual — P1

**V6 — Overlays have no opaque background; underlying text bleeds through.**
`shots/b06-save-template-confirm.png` · `shots/i04-dry-run.png`

- Problem: modal overlays paint only their own glyphs, so whatever was
  behind them shows through: the save-template confirm reads
  `audit-tpl-2"?gin inventory unavailable`, and the dry-run overlay shows
  `cc-profile-switche-switch` / `Args:nd: claude`. Also affects readability
  on every other prompt overlay.
- Proposed change: before drawing an overlay, fill its rectangle with blank
  cells in the terminal's default background (Ink: render a background
  `<Box>` of spaces), and clear the rectangle again on close.
- §14: uses default background only — no new colors, NO_COLOR-safe.

**V7 — Footer: three owners share one row and collide.**
`shots/a02-home.png` (every compact frame)

- Problem: the contextual hint line, the locale/help/quit strip, and the
  `80×24` size badge all compete for the same rows; compact frames read
  `categories]Save as templa80×24` — hint text truncated mid-word into the
  badge.
- Proposed change: give the hint line and the locale/help/quit + badge line
  separate rows (or fixed, non-overlapping slots on one row with the hint
  truncated to the leftover width).
- §14: text/layout-only; nothing removed — all three elements stay.

**V8 — Sidebar hint block overflows and breaks the border.**
`shots/v08-sidebar-hint-overflow.png`

- Problem: the lifecycle hint block wraps without respecting the sidebar's
  inner width: `[a] Add skillmport` (two hints fused), and the bottom
  border is overwritten by hint text (`└─[x] Remove──┘`).
- Proposed change: word-wrap hints at the sidebar's inner width with a
  fixed hint-block height; truncate overflow with `…`; redraw the border
  after the hint text so text can never occupy a border cell.
- §14: text/layout-only; nothing removed.

**V9 — Validation findings render as chaos in the sidebar.**
`shots/c02-validation-findings.png`

- Problem: findings wrap into repeated red fragments, `settings.json.` is
  fused to the next word, and the summary line prints a green `✓` next to
  `2 errors` — the success glyph attached to an error count is actively
  misleading.
- Proposed change: one finding per row, truncated to the pane width, with
  `+N more` overflow; severity glyph per row (`✗` error / `!` warning);
  drop the `✓` on the error-count line (use plain text or `✗`).
- §14: severity already carries a glyph second channel; keep it and fix the
  glyph semantics; no new colors. The `✓` removal replaces a wrong glyph
  with a correct one — a rendering correction, not a removed feature (the
  error count itself stays).

**V10 — Bulk list at 80 cols drops its first row and shows no cursor.**
`shots/f01-bulk-skills.png` vs `shots/f01-bulk-skills-wide.png`

- Problem: the compact bulk list scrolls `skill-001` out of the viewport
  (off-by-one in the follow-cursor window) and renders the cursor row
  without the `▸` marker that the wide layout shows.
- Proposed change: fix the window off-by-one so the cursor's row is always
  visible; render the `▸` cursor prefix at all widths.
- §14: `▸` glyph + highlight, not color-alone.

**V11 — Bulk status line is pushed off-screen.**
`shots/f02-bulk-selected.png`

- Problem: when items are selected, the status line (selection count /
  action result) is rendered below the visible area — the user performs an
  action and gets no feedback.
- Proposed change: reserve the last content row for the status line and
  exclude it from the list's scroll window, so status is always visible.
- §14: layout-only; the status line already exists — nothing removed.

**V12 — Flash message shares a row with the shortcut hints.**
`shots/b02-backup-success-bar.png`

- Problem: the success flash is appended onto the same terminal row as the
  contextual shortcut hints (`backed up [l]Launch…`), so both truncate
  each other and neither is fully readable.
- Proposed change: give the flash its own row — replace the hint row's
  content entirely while the flash is live instead of appending to it.
- §14: layout-only; hints return after the flash — nothing removed.

**V13 — Search result rows collide.**
`shots/e10-resource-search.png`

- Problem: in resource search results the profile-name column bleeds into
  the hit column (`agent-01rofile-001`), fusing two fields into an
  unreadable row.
- Proposed change: enforce fixed column slots with truncation: profile name
  truncated to its slot with `…`, hit text truncated to the remainder; one
  hit per row.
- §14: text/layout-only.

### Visual — P2

**V14 — Directory screen wraps long paths flush against the border.**
`shots/i05-launch-dir.png`

- Problem: a long launch-directory path wraps with no indent or ellipsis,
  so the continuation sits at column 0 looking like a new entry.
- Proposed change: keep paths on one row with leading-ellipsis truncation
  (`…/Projects/cc-profile-switch`), or hang-indent wrapped continuations
  by 2 cells.
- §14: `…` is BMP; text-only.

**V15 — Preview-missing overlay renders its title twice.**
`shots/w06-preview-missing-overlay.png`

- Problem: the same title text appears on the badge row and again on the
  overlay's own title row, one line apart.
- Proposed change: render the title in exactly one of the two places (keep
  the overlay title, drop the duplicate from the badge row, or vice versa).
- §14: removes a duplicate rendering artifact, not a feature — the title
  remains.

**V16 — Recovery pane title tears across the border.**
`shots/h01-recovery.png`

- Problem: the pane title (`Recovery · temp items…/Bin durable`) wraps
  mid-token onto the pane border at 80 cols.
- Proposed change: truncate pane titles to the inner width with `…` instead
  of wrapping.
- §14: text-only.

**V17 — Wide sidebar: Auto Memory rows mis-bound (en drops the category
row, zh drops the first child).**
`shots/g00-tree-automem-row-wide.png` · `shots/g00-tree-automem-row-zh-wide.png`

- Problem: at 140 cols the tree's Auto Memory section binds rows to the
  wrong parents: en shows `MEMORY.md (3)` in the category row's slot (the
  category label vanishes), zh shows the category but loses its first
  child. Compact renders correctly, so this is width-dependent row
  binding.
- Proposed change: fix the tree row builder's width-dependent branch so
  category rows and child rows keep their association at any width; add a
  wide-width tree snapshot test to lock it.
- §14: text/layout-only; nothing removed.

**V18 — Zero-state text sits flush against the border.**
`shots/z02-zero-state.png`

- Problem: the empty-workspace message (`│No Profiles yet.│`) touches the
  pane border with zero padding, reading as cramped and unpolished.
- Proposed change: pad the message by ≥1 cell inside the border (and
  consider one blank row above it).
- §14: layout-only.

**V19 — Light background: dim text is too faint.**
`shots/a02-home-light.png`

- Problem: on a light terminal the dim treatment (secondary tree text,
  card hint lines like `d diff vs another Profile`) drops to
  near-background contrast.
- Proposed change: on light backgrounds use the dark-gray end of the
  16-color palette for dim text instead of light gray (or pair dim with
  regular weight and let the glyph/text channel carry the hierarchy), and
  re-shoot the light variant to verify.
- §14: stays inside the 16-color ANSI palette; dim is an emphasis channel
  here, not state, so no color-alone violation; NO_COLOR unaffected.

## Locked-constraint checklist (§14 + issue #97)

Every proposed change is checked against: 16-color ANSI palette only ·
readable on light and dark backgrounds · `NO_COLOR` honored · no state by
color alone (glyph/text/weight second channel) · BMP glyphs only, no emoji
· information never moves between screens · nothing removed.

Summary of the per-entry checks inline above:

- **16-color palette / light & dark / NO_COLOR**: only V19 touches color at
  all, and it stays inside the standard 16-color ANSI set with a re-shoot
  requirement. Everything else is text, layout, or behavior, so it is
  palette-neutral and NO_COLOR-safe by construction. NO_COLOR evidence:
  `shots/n02-home-nocolor.png`.
- **No state by color alone**: V2, V4, V10 add or restore a `▸` glyph
  (plus inverse) as the focus channel — state never rides on color. V9
  fixes a glyph-semantics misuse (`✓` on an error count).
- **BMP glyphs only**: proposals use `▸` (U+25B8, already used in the app),
  `…` (U+2026), `✗`, `!` — all BMP, no emoji.
- **Information never moves between screens**: F3 pins the manual row
  within the same list; V5 reflows the help sheet's own content; V7/V11/V12
  re-slot elements on the same screen. No content changes surfaces.
- **Nothing removed**: V15 deletes a duplicated title rendering (the title
  itself remains); every other entry adds, fixes, or re-slots.
