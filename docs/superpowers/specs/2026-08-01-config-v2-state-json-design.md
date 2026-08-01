# config.json v2, state.json, and Universal JSON Migration Rules

**Issue:** #55
**Parent spec:** #53 → `docs/Spec-profile-workbench.md` §13.2–§13.4
**Date:** 2026-08-01

## Problem

User preferences and machine-local state currently share no versioning or migration framework. `config.json` is v1 with no migration path, writes are non-atomic (direct `fs.writeFile`), and there is no `state.json` for recent project directories. The spec (§13.4) requires every ccps-owned JSON file to follow the same rules: version literal + strict schema, additive evolution, loud failure on unknown fields/higher versions/corruption, lazy migrate-on-load, and atomic writes everywhere.

## Design

### 1. Versioned JSON framework (`src/core/versioned-json.ts`)

A small generic module enforcing §13.4 migration rules for every ccps-owned JSON file.

```typescript
type VersionedJsonSpec<T, V extends number> = {
  fileName: string;           // "config.json" — for error messages
  currentVersion: V;
  currentSchema: ZodSchema<T>; // strict schema for the current version
  migrate: (raw: unknown, rawVersion: number) => T; // old version → current shape
  errorPrefix: string;        // "APP_CONFIG" → APP_CONFIG_INVALID, etc.
};

// loadVersionedJson(spec, filePath) → T
//   ENOENT → throws <PREFIX>_NOT_FOUND
//   Invalid JSON → throws <PREFIX>_INVALID_JSON
//   version missing/wrong type → throws <PREFIX>_INVALID_VERSION
//   version > current → throws <PREFIX>_FUTURE_VERSION (advises upgrading ccps)
//   unknown fields → throws <PREFIX>_INVALID (strict schema rejection)
//   version < current → migrate() fills defaults in memory, returns current shape
//   READ PATHS NEVER WRITE

// saveVersionedJson(spec, filePath, data, options?) → T
//   Validates against currentSchema
//   Writes via atomicWriteJson
//   Returns validated data
```

**Atomic write implementation:**

```typescript
async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(tmpPath, filePath);
}
```

For create-only writes (`overwrite: false`): check existence first, then atomic write. The old `wx` flag is incompatible with temp-file+rename, so existence check replaces it.

**Startup sweep:** `cleanupTmpResidue(appHomePath)` called once during `ensureAppHomeStructure`, removes any `*.tmp` files left by crashed atomic writes. Housekeeping, not correctness — next write would overwrite .tmp anyway.

### 2. config.json v2 schema (`src/schemas/config.ts`)

```typescript
const appConfigV2Schema = z.object({
  version: z.literal(2),
  defaultProfile: profileNameSchema.optional(),
  lastUsedProfile: profileNameSchema.nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  recovery: z.object({
    retentionDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]).default(30),
  }).default({}),
  workbench: z.object({
    editor: z.string().optional(),                          // absent = platform default VS Code
    skillsDiscoveryExperimental: z.boolean().default(true), // off switch for §7.4
    language: z.enum(['zh', 'en']).optional(),              // absent = system locale per §14
  }).default({}),
}).strict();
```

**Migration v1→v2:** spread all v1 fields, add `recovery: { retentionDays: 30 }` and `workbench: { skillsDiscoveryExperimental: true }`. `createInitialAppConfig` produces v2 directly.

**Backward compatibility:** `loadAppConfig` delegates to `loadVersionedJson` with the v1→v2 migrator. `saveAppConfig` delegates to `saveVersionedJson`. Public API signatures unchanged — callers don't change.

### 3. state.json (`src/schemas/state.ts` + `src/core/app-state.ts`)

**Schema:**

```typescript
const appStateV1Schema = z.object({
  version: z.literal(1),
  recentProjectDirs: z.array(z.object({
    path: z.string(),
    lastUsedAt: z.string(), // ISO 8601
  })).max(10),
}).strict();
```

**Module `src/core/app-state.ts`:**

- `loadAppState(appHomePath)` — delegates to `loadVersionedJson`. Missing file returns empty state `{ version: 1, recentProjectDirs: [] }` (not an error — state.json is optional until first launch).
- `recordRecentProjectDir(appHomePath, dirPath, options?)` — loads state, dedupes using `areSameFilesystemPath`, moves existing entry to front (MRU), caps at 10, saves atomically. Only called after a successful real launch.
- `getAppHomePaths` gains `statePath` alongside `configPath`.

### 4. Launch integration

In `launchProfile`, after the existing `saveAppConfig` for `lastUsedProfile` (line 233–241), call `recordRecentProjectDir(appHomePath, plan.cwd)`. This is the only write site for state.json.

Dry-run and validation-blocked launches never call `recordRecentProjectDir` — they go through `buildLaunchPlan` which is side-effect-free.

### 5. Atomic writes everywhere

Replace `writeJsonFile` (direct `fs.writeFile`) with `atomicWriteJson` from the framework. The old `writeJsonFile` signature (`{ overwrite: boolean }`) is preserved as a thin wrapper for callers that use the create-only pattern (e.g. `createAppConfig`, profile creation).

### 6. Read-only command guarantee

Read-only commands (`validate`, `list`, `show`) already don't call save functions. `loadVersionedJson` explicitly never writes (lazy migrate-on-load fills defaults in memory only). No additional guards needed.

### 7. Error codes

New codes following the existing `APP_CONFIG_*` pattern:

| Code | When | Guidance |
|------|------|----------|
| `APP_CONFIG_INVALID_VERSION` | version field missing, wrong type, or unrecognized | "Check the version field in config.json." |
| `APP_CONFIG_FUTURE_VERSION` | version > current | "Upgrade ccps to a version that supports this config format." |
| `APP_STATE_INVALID_JSON` | state.json is not valid JSON | "Fix state.json or delete it to reset on next launch." |
| `APP_STATE_INVALID` | state.json doesn't match schema | "Check state.json fields." |
| `APP_STATE_INVALID_VERSION` | state.json version field invalid | "Check the version field in state.json." |
| `APP_STATE_FUTURE_VERSION` | state.json version too high | "Upgrade ccps to a version that supports this state format." |

### 8. Files changed

| File | Change |
|------|--------|
| `src/core/versioned-json.ts` | **New** — generic framework |
| `src/schemas/config.ts` | v1→v2 schema, migration |
| `src/schemas/state.ts` | **New** — state.json v1 schema |
| `src/core/app-config.ts` | Delegate to versioned-json, atomic writes, v2 initial config |
| `src/core/app-state.ts` | **New** — load/record/save state |
| `src/core/launcher.ts` | Call `recordRecentProjectDir` after successful launch |
| `src/platform/path.ts` | Add `statePath` to `AppHomePaths` |
| `src/utils/errors.ts` | No change — existing `CcpsError` covers new codes |
| `test/versioned-json.test.ts` | **New** — framework tests |
| `test/app-config.test.ts` | Extend — v1→v2 migration, v2 round-trip, new fields |
| `test/app-state.test.ts` | **New** — state.json tests |
| `test/launcher.test.ts` | Extend — state.json write on launch, no write on dry-run |

### 9. Test plan

**`versioned-json.test.ts`** — framework tests:
- v1→v2 migration fills defaults
- Unknown fields rejected loudly
- Future version rejected with upgrade advice
- Corrupt JSON rejected
- Read path never writes
- Atomic write produces correct file
- Atomic write cleans up .tmp on success

**`app-config.test.ts`** — extend existing:
- v1 config on disk loads as v2 with defaults filled in memory
- v2 config round-trips through load/save
- New fields (`recovery`, `workbench`) accessible after load
- `createInitialAppConfig` produces v2

**`app-state.test.ts`** — new:
- Missing state.json returns empty state (not error)
- `recordRecentProjectDir` adds entry, saves atomically
- Dedupe by `areSameFilesystemPath` (case-insensitive on Windows)
- MRU: existing entry moves to front
- Cap at 10: oldest evicted
- Dead directories never pruned on read path

**`launcher.test.ts`** — extend:
- Successful launch records cwd in state.json
- Dry-run does not write state.json
- Validation-blocked launch does not write state.json
