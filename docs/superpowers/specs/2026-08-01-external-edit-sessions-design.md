# External Edit Sessions — Design (Issue #59)

Status: implementation-ready
Date: 2026-08-01
Parent spec: `docs/Spec-profile-workbench.md` (§8)

## Purpose

Long-text resources open in VS Code while the Workbench stays fully operable. A persistent banner and per-resource `✎ watching` badge signal the handoff. A recursive atomic-save-tolerant watch refreshes the preview on every external save. Deleted or renamed files collapse into a `missing` state that keeps last known content and resumes on reappearance. An unavailable VS Code yields inline fallbacks. While a session is active on a file, Workbench structured-field writes to it are refused.

## Architecture

Three layers, matching existing project patterns:

1. **Pure state machine** (`src/core/edit-session/reducer.ts`) — promoted from the prototype at `src/tui/prototype-edit-session/editSessionMachine.ts`, enriched with timestamp, file path, and last-known-content fields. Zero I/O.

2. **I/O service** (`src/core/edit-session/session-manager.ts`) — orchestrates real `fs.watch`, editor spawn, and content reads. Emits `SessionEvent` objects into the reducer. Tracks multiple concurrent sessions by file path. Provides the write-guard check (`isFileUnderSession(path)`).

3. **Ink components** (`src/tui/workbench/edit-session/`) — `EditBanner`, `WatchingBadge`, `MissingOverlay`, `FallbackMenu`.

## State machine

Phases: `idle → opening → watching → missing`

Events and transitions (from prototype, enriched):

| Current phase | Event | Next phase | Notes |
|---|---|---|---|
| idle | open-requested | opening | |
| opening | open-succeeded | watching | changeCount reset to 0 |
| opening | open-failed | idle | reason captured for fallback |
| watching | file-changed | watching | changeCount++, lastContent updated |
| watching | file-unlinked | missing | lastContent preserved |
| missing | file-changed | watching | file reappeared, changeCount++ |
| missing | file-reappeared | watching | explicit reappear event |
| watching/missing | session-ended | idle | cleanup |
| any | open-requested | same | "Already open — VS Code re-focused" |

Enriched fields beyond prototype:
- `filePath: string` — absolute path of the watched file
- `lastContent: string | null` — last successfully read content (for missing-state display)
- `lastUpdated: Date | null` — timestamp of last external save
- `openFailedReason: string | null` — reason for VS Code unavailability (for fallback menu)

## File watcher

- Node `fs.watch` with `recursive: false` on the **parent directory**, filtering to the target filename.
- This handles atomic saves (write-to-temp + rename) because the rename event fires on the parent dir.
- ~100ms debounce coalesces rapid save events.
- On `rename` event for the target file: if the file still exists → `file-changed`; if not → `file-unlinked`.
- On `change` event for the target file: `file-changed`.
- When in `missing` phase, the watcher stays active on the parent dir. Any event for the target filename triggers `file-reappeared` + `file-changed`.

## Session manager

Class-based (`EditSessionManager`), injected into the Workbench as a service.

State:
- `sessions: Map<absolutePath, EditSession>` — active sessions
- `watchers: Map<absolutePath, fs.FSWatcher>` — active file watchers
- `debounceTimers: Map<absolutePath, NodeJS.Timeout>` — per-file debounce timers

Methods:
- `open(filePath: string): Promise<void>` — dispatch `open-requested`, spawn editor, on success dispatch `open-succeeded` and start watcher; on failure dispatch `open-failed`
- `endSession(filePath: string): void` — dispatch `session-ended`, close watcher, clear debounce timer
- `isFileUnderSession(filePath: string): boolean` — write guard check
- `getSession(filePath: string): EditSession | undefined` — for UI rendering
- `getActiveSessionPaths(): string[]` — for banner display
- `dispose(): void` — end all sessions (Workbench shutdown)

Editor spawn uses the existing `buildEditorSpawnCommand` from `src/platform/editor.ts`. The `workbench.editor` config override is honored by passing it through to the spawn command.

## Write guard

The session manager exposes `isFileUnderSession(path)`. Workbench structured-field edit actions check this before writing and surface "Finish in VS Code first" if blocked. The guard is per-file: other files in the same profile are not blocked.

## Fallback flow

On `open-failed`, the reducer transitions to `idle` with `openFailedReason` populated. The Ink shell detects this and renders the `FallbackMenu` with three options:

1. **Open in system editor** — `$EDITOR` or `vi`/`nano` fallback
2. **Copy path to clipboard** — `clipboardy` or `pbcopy`/`xclip`/`clip`
3. **Retry VS Code** — re-dispatch `open-requested`

## Missing state

On `file-unlinked`, the manager preserves `lastContent` from the most recent successful read. The `MissingOverlay` shows this content under a warning. No rename-target guessing, no auto-recreate. When `file-reappeared` fires, the watcher reads the new content and the reducer transitions back to `watching`.

## Signalling

Foreground colors only (picocolors), no background fills — consistent with the color-independence baseline.

- `✎` prefix for watching badge (green foreground)
- `⚠` for missing state (amber/yellow foreground)
- Dim text for timestamps (`updated HH:MM:SS`)
- Change counter shown as `(#N)` suffix

## Ink components

### EditBanner
- Persistent top banner when any session is active
- Shows: `✎ Editing N file(s) in VS Code — Workbench is watching`
- Dismiss per-file or all

### WatchingBadge
- Per-resource inline badge: `✎ watching (#3) updated 14:32:05`
- Shown next to the resource name in the item list

### MissingOverlay
- Replaces the preview pane content when phase is `missing`
- Warning header + last known content (read-only display)
- "File deleted or renamed — tracking paused"

### FallbackMenu
- Shown when `openFailedReason` is set
- Three numbered options (system editor, copy path, retry)

## File structure

```
src/core/edit-session/
  reducer.ts          # pure state machine
  session-manager.ts  # I/O orchestration, multi-session tracking
  types.ts            # EditSession, SessionEvent, SessionPhase, etc.
src/tui/workbench/edit-session/
  EditBanner.tsx      # persistent banner
  WatchingBadge.tsx   # per-resource badge
  MissingOverlay.tsx  # missing file warning + last content
  FallbackMenu.tsx    # VS Code unavailable fallbacks
test/
  edit-session-reducer.test.ts   # pure reducer tests
  edit-session-manager.test.ts   # I/O service tests (mocked fs)
```

## Test plan

1. **Reducer unit tests** — every transition in the state table, edge cases (events in wrong phase, concurrent sessions)
2. **Session manager tests** — mocked `fs.watch` and `spawn`, verify watcher lifecycle, debounce, write guard, multi-session isolation
3. **Integration** — session manager + reducer together, verify the full lifecycle from open to close

## Out of scope

- Ink component rendering tests (Ink 7 testing library compatibility is unresolved per spec §2)
- Clipboard integration (copy-path fallback uses platform commands directly)
- Editor override beyond `workbench.editor` config
