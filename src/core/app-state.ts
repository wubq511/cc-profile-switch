import { areSameFilesystemPath } from '../platform/path';
import { appStateV1Schema, type AppState } from '../schemas/state';
import { CcpsError } from '../utils/errors';
import {
  loadVersionedJson,
  saveVersionedJson,
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

export async function recordRecentProjectDir(
  appHomePath: string,
  dirPath: string,
  options: AppStateWriteOptions = {},
): Promise<AppState> {
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const state = await loadAppState(appHomePath);

  // Dedupe: remove existing entry for the same filesystem path
  const filtered = state.recentProjectDirs.filter(
    (entry) => !areSameFilesystemPath(entry.path, dirPath),
  );

  // Prepend new entry (MRU — newest first)
  const updated = [{ path: dirPath, lastUsedAt: now }, ...filtered];

  // Cap at 10
  const capped = updated.slice(0, 10);

  const nextState: AppState = {
    version: 1,
    recentProjectDirs: capped,
  };

  const { statePath } = getAppHomePaths(appHomePath);
  return saveVersionedJson(appStateSpec, statePath, nextState);
}
