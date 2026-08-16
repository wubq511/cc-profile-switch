import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { loadAppState, recordRecentProjectDir } from '../src/core/app-state';

const fixedClock = () => new Date('2026-01-02T03:04:05.000Z');

describe('app state', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-app-state-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome);
    return appHome;
  }

  it('returns empty state when state.json does not exist', async () => {
    const appHome = await makeAppHome();
    const state = await loadAppState(appHome);

    expect(state).toEqual({ version: 1, recentProjectDirs: [] });
  });

  it('loads an existing state.json', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    await fs.writeJson(paths.statePath, {
      version: 1,
      recentProjectDirs: [{ path: '/project/a', lastUsedAt: '2026-01-01T00:00:00.000Z' }],
    });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(1);
    expect(state.recentProjectDirs[0].path).toBe('/project/a');
  });

  it('records a recent project directory', async () => {
    const appHome = await makeAppHome();
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toEqual([
      { path: '/project/alpha', lastUsedAt: '2026-01-02T03:04:05.000Z' },
    ]);
  });

  it('moves an existing entry to the front (MRU)', async () => {
    const appHome = await makeAppHome();
    const laterClock = () => new Date('2026-01-03T00:00:00.000Z');

    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });
    await recordRecentProjectDir(appHome, '/project/beta', { clock: laterClock });
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: laterClock });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs.map((d) => d.path)).toEqual([
      '/project/alpha',
      '/project/beta',
    ]);
  });

  it('dedupes by filesystem path identity', async () => {
    const appHome = await makeAppHome();
    // On POSIX, /project/Alpha and /project/alpha are different paths
    // On Windows they would be the same — this test verifies the dedupe function is used
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(1);
  });

  it('caps at 10 entries evicting the oldest', async () => {
    const appHome = await makeAppHome();

    for (let i = 0; i < 12; i++) {
      const clock = () => new Date(`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`);
      await recordRecentProjectDir(appHome, `/project/${i}`, { clock });
    }

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(10);
    // Oldest (0, 1) evicted; newest (11) at front
    expect(state.recentProjectDirs[0].path).toBe('/project/11');
    expect(state.recentProjectDirs[9].path).toBe('/project/2');
  });

  it('never prunes dead directories on the read path', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    // Write state with a non-existent directory
    await fs.writeJson(paths.statePath, {
      version: 1,
      recentProjectDirs: [
        { path: '/nonexistent/dead', lastUsedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(1);
    expect(state.recentProjectDirs[0].path).toBe('/nonexistent/dead');
  });

  it('writes state atomically (no .tmp residue)', async () => {
    const appHome = await makeAppHome();
    await recordRecentProjectDir(appHome, '/project/alpha', { clock: fixedClock });

    const files = await fs.readdir(appHome);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('rejects corrupt state.json', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    await fs.writeFile(paths.statePath, '{broken', 'utf8');

    await expect(loadAppState(appHome)).rejects.toMatchObject({
      code: 'APP_STATE_INVALID_JSON',
    });
  });

  it('rejects a future version state.json', async () => {
    const appHome = await makeAppHome();
    const paths = getAppHomePaths(appHome);
    await fs.writeJson(paths.statePath, { version: 99, recentProjectDirs: [] });

    await expect(loadAppState(appHome)).rejects.toMatchObject({
      code: 'APP_STATE_FUTURE_VERSION',
    });
  });
});
