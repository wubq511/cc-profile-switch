import { areSameFilesystemPath } from '../platform/path';
import { appStateV1Schema, type AppState } from '../schemas/state';
import { CcpsError } from '../utils/errors';
import {
  loadVersionedJson,
  loadVersionedJsonSync,
  saveVersionedJson,
  saveVersionedJsonSync,
  type VersionedJsonSpec,
} from './versioned-json';
import { getAppHomePaths } from './app-config';
import { type Clock } from './types';

export type { Clock } from './types';

export type AppStateWriteOptions = {
  clock?: Clock;
};

const appStateSpec: VersionedJsonSpec<AppState, 1> = {
  fileName: 'state.json',
  currentVersion: 1,
  currentSchema: appStateV1Schema,
  migrate: (_raw: unknown, rawVersion: number): AppState => {
    throw new CcpsError(
      'APP_STATE_INVALID_VERSION',
      `Cannot migrate state.json from version ${rawVersion}.`,
      {
        guidance: 'Check the version field in state.json.',
      },
    );
  },
  errorPrefix: 'APP_STATE',
};

export async function loadAppState(appHomePath: string): Promise<AppState> {
  const { statePath } = getAppHomePaths(appHomePath);

  try {
    return await loadVersionedJson(appStateSpec, statePath);
  } catch (error) {
    if (error instanceof CcpsError && error.code === 'APP_STATE_NOT_FOUND') {
      return { version: 1, recentProjectDirs: [] };
    }
    throw error;
  }
}

/** Synchronous variant of loadAppState — identical defaults and errors. */
export function loadAppStateSync(appHomePath: string): AppState {
  const { statePath } = getAppHomePaths(appHomePath);

  try {
    return loadVersionedJsonSync(appStateSpec, statePath);
  } catch (error) {
    if (error instanceof CcpsError && error.code === 'APP_STATE_NOT_FOUND') {
      return { version: 1, recentProjectDirs: [] };
    }
    throw error;
  }
}

function nextAppState(state: AppState, dirPath: string, now: string): AppState {
  // Dedupe: remove existing entry for the same filesystem path
  const filtered = state.recentProjectDirs.filter(
    (entry) => !areSameFilesystemPath(entry.path, dirPath),
  );

  // Spread first: additive optional fields (hintUsage, issue #76) survive a
  // recents write. Prepend new entry (MRU — newest first), cap at 10.
  return {
    ...state,
    version: 1,
    recentProjectDirs: [{ path: dirPath, lastUsedAt: now }, ...filtered].slice(0, 10),
  };
}

export async function recordRecentProjectDir(
  appHomePath: string,
  dirPath: string,
  options: AppStateWriteOptions = {},
): Promise<AppState> {
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const state = await loadAppState(appHomePath);

  const { statePath } = getAppHomePaths(appHomePath);
  return saveVersionedJson(appStateSpec, statePath, nextAppState(state, dirPath, now));
}

/** Synchronous variant of recordRecentProjectDir — identical schema parse,
 * dedupe/MRU/cap semantics, and atomic write. Used after spawnSync, where the
 * caller must stay synchronous (Workbench launch, spec §10/§13.3). */
export function recordRecentProjectDirSync(
  appHomePath: string,
  dirPath: string,
  options: AppStateWriteOptions = {},
): AppState {
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const state = loadAppStateSync(appHomePath);

  const { statePath } = getAppHomePaths(appHomePath);
  return saveVersionedJsonSync(appStateSpec, statePath, nextAppState(state, dirPath, now));
}

/** Record one use of a Workbench contextual-hint key (issue #76). Counts live
 * in state.json so a hint retires permanently once its key reaches the
 * retirement threshold across sessions. Load-modify-save through the schema
 * with an atomic write; corruption surfaces from the load, never a silent
 * reset (spec §13.4). */
export function recordHintUseSync(appHomePath: string, key: string): AppState {
  const state = loadAppStateSync(appHomePath);
  const next: AppState = {
    ...state,
    hintUsage: { ...(state.hintUsage ?? {}), [key]: (state.hintUsage?.[key] ?? 0) + 1 },
  };

  const { statePath } = getAppHomePaths(appHomePath);
  return saveVersionedJsonSync(appStateSpec, statePath, next);
}
