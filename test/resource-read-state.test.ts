import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  loadUserMemory,
  listAgents,
  readUserMemoryContent,
} from '../src/core/resource';
import { readFileWithState, listDirWithState, readJsonWithState } from '../src/core/resource/read-state';
import { loadWorkbenchData } from '../src/tui/workbench/profile-data';
import { validateProfile } from '../src/core/validator';
import { CcpsError } from '../src/utils/errors';

/**
 * Issue #110 (spec §7): a single broken resource must not block its Profile —
 * and a read failure (EISDIR/EACCES/format) must never be reported as a
 * successful empty list. The aggregate classifies per Profile/category:
 * ok / missing / unreadable.
 */

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');

describe('resource read-state classification (issue #110)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-read-state-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    return appHome;
  }

  async function makeProfile(appHome: string, name: string): Promise<void> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: FIXED_CLOCK,
    });
  }

  it('loadUserMemory throws RESOURCE_READ_FAILED when CLAUDE.md is a directory (EISDIR)', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const { claudeMdPath } = {
      claudeMdPath: join(getAppHomePaths(appHome).profilesPath, 'coding', 'claude-home', 'CLAUDE.md'),
    };
    await fs.remove(claudeMdPath);
    await fs.ensureDir(claudeMdPath); // EISDIR on read

    const error = await loadUserMemory(appHome, 'coding').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CcpsError);
    expect((error as CcpsError).code).toBe('RESOURCE_READ_FAILED');
  });

  it('listAgents throws RESOURCE_READ_FAILED when agents/ is a file (ENOTDIR-style read failure)', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const agentsDir = join(getAppHomePaths(appHome).profilesPath, 'coding', 'claude-home', 'agents');
    await fs.remove(agentsDir);
    await fs.writeFile(agentsDir, 'not a directory', 'utf8');

    const error = await listAgents(appHome, 'coding').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CcpsError);
    expect((error as CcpsError).code).toBe('RESOURCE_READ_FAILED');
  });

  it('readUserMemoryContent keeps null for a missing file', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const claudeMdPath = join(
      getAppHomePaths(appHome).profilesPath,
      'coding',
      'claude-home',
      'CLAUDE.md',
    );
    await fs.remove(claudeMdPath);
    expect(await readUserMemoryContent(appHome, 'coding')).toBeNull();
  });

  it('readFileWithState distinguishes missing, unreadable, and ok', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-read-state-file-'));
    tempRoots.push(root);
    const asDir = join(root, 'a-directory');
    await fs.ensureDir(asDir);

    const missing = await readFileWithState(join(root, 'nope.txt'));
    expect(missing.status).toBe('missing');

    const unreadable = await readFileWithState(asDir);
    expect(unreadable.status).toBe('unreadable');
    if (unreadable.status === 'unreadable') {
      expect(unreadable.code).toBe('EISDIR');
      expect(unreadable.detail.length).toBeGreaterThan(0);
    }

    const target = join(root, 'file.txt');
    await fs.writeFile(target, 'hello', 'utf8');
    const ok = await readFileWithState(target);
    expect(ok).toEqual({ status: 'ok', value: 'hello' });
  });

  it('listDirWithState reports EISDIR/ENOTDIR instead of an empty list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-read-state-dir-'));
    tempRoots.push(root);
    const asFile = join(root, 'a-file');
    await fs.writeFile(asFile, 'x', 'utf8');

    const missing = await listDirWithState(join(root, 'no-dir'));
    expect(missing.status).toBe('missing');

    const unreadable = await listDirWithState(asFile);
    expect(unreadable.status).toBe('unreadable');

    const dir = join(root, 'real-dir');
    await fs.ensureDir(dir);
    await fs.writeFile(join(dir, 'b.txt'), '', 'utf8');
    await fs.writeFile(join(dir, 'a.txt'), '', 'utf8');
    const ok = await listDirWithState(dir);
    expect(ok).toEqual({ status: 'ok', value: ['a.txt', 'b.txt'] });
  });

  it('readJsonWithState classifies malformed JSON as unreadable, not empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-read-state-json-'));
    tempRoots.push(root);
    const bad = join(root, 'bad.json');
    await fs.writeFile(bad, '{not json', 'utf8');

    const parsed = await readJsonWithState(bad);
    expect(parsed.status).toBe('unreadable');
    if (parsed.status === 'unreadable') {
      expect(parsed.code).toBe('JSON_INVALID');
    }

    await fs.writeFile(bad, '{"k":1}', 'utf8');
    expect(await readJsonWithState(bad)).toEqual({ status: 'ok', value: { k: 1 } });
  });
});


/** Non-optional view of resourceStates for assertions (the field is optional
 *  on the type so legacy fixtures degrade gracefully). */
function statesOf(profile: { name: string } & { resourceStates?: unknown }): Record<string, {
  status: string;
  code?: string;
}> {
  if (!profile.resourceStates) throw new Error('resourceStates must be present');
  return profile.resourceStates as Record<string, { status: string; code?: string }>;
}

describe('loadWorkbenchData error isolation (issue #110)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-isolation-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    return appHome;
  }

  async function makeProfile(appHome: string, name: string): Promise<void> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: FIXED_CLOCK,
    });
  }

  function claudeHomeOf(appHome: string, name: string): string {
    return join(getAppHomePaths(appHome).profilesPath, name, 'claude-home');
  }

  it('a broken User Memory does not block a healthy Profile; failed read is not an empty list', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'healthy');
    await makeProfile(appHome, 'broken');
    // broken: CLAUDE.md is a directory → EISDIR on read.
    const brokenClaudeMd = join(claudeHomeOf(appHome, 'broken'), 'CLAUDE.md');
    await fs.remove(brokenClaudeMd);
    await fs.ensureDir(brokenClaudeMd);

    const data = await loadWorkbenchData(appHome);

    const names = data.profiles.map((p) => p.name).sort();
    expect(names).toEqual(['broken', 'healthy']);

    const broken = data.profiles.find((p) => p.name === 'broken');
    const healthy = data.profiles.find((p) => p.name === 'healthy');
    if (!broken || !healthy) {
      throw new Error('both profiles must load');
    }

    // The failed category is explicitly unreadable, not ok/empty.
    const brokenStates = statesOf(broken);
    const healthyStates = statesOf(healthy);
    expect(brokenStates.userMemory.status).toBe('unreadable');
    expect(brokenStates.userMemory.code).toBe('EISDIR');
    expect(brokenStates.agents.status).toBe('ok');
    // The healthy profile is fully intact.
    expect(healthyStates.userMemory.status).toBe('ok');
    expect(healthy.resourceDetails.userMemory.exists).toBe(true);
    expect(healthyStates.agents.status).toBe('ok');
  });

  it('an unreadable agents directory is classified without hiding the profile', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'healthy');
    await makeProfile(appHome, 'broken');
    const brokenAgents = join(claudeHomeOf(appHome, 'broken'), 'agents');
    await fs.remove(brokenAgents);
    await fs.writeFile(brokenAgents, 'not a directory', 'utf8');

    const data = await loadWorkbenchData(appHome);
    const broken = data.profiles.find((p) => p.name === 'broken');
    if (!broken) throw new Error('broken profile must load');
    expect(statesOf(broken).agents.status).toBe('unreadable');
    expect(statesOf(broken).userMemory.status).toBe('ok');
    expect(data.profiles).toHaveLength(2);
  });

  it('a missing CLAUDE.md is `missing` — distinct from unreadable and from ok', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await fs.remove(join(claudeHomeOf(appHome, 'coding'), 'CLAUDE.md'));

    const data = await loadWorkbenchData(appHome);
    expect(statesOf(data.profiles[0]!).userMemory.status).toBe('missing');
  });

  it('repairing the resource clears the error state on the next load (no restart)', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const claudeMd = join(claudeHomeOf(appHome, 'coding'), 'CLAUDE.md');
    await fs.remove(claudeMd);
    await fs.ensureDir(claudeMd);

    const before = await loadWorkbenchData(appHome);
    expect(statesOf(before.profiles[0]!).userMemory.status).toBe('unreadable');

    // User repairs the resource on disk.
    await fs.remove(claudeMd);
    await fs.writeFile(claudeMd, '# repaired', 'utf8');

    const after = await loadWorkbenchData(appHome);
    expect(statesOf(after.profiles[0]!).userMemory.status).toBe('ok');
    expect(after.profiles[0]!.resourceDetails.userMemory.exists).toBe(true);
    expect(after.profiles[0]!.resourceDetails.userMemory.lineCount).toBe(1);
  });

  it('error isolation does not raise the broken profile launch readiness', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const claudeMd = join(claudeHomeOf(appHome, 'coding'), 'CLAUDE.md');
    await fs.remove(claudeMd);
    await fs.ensureDir(claudeMd);

    const data = await loadWorkbenchData(appHome);
    const profile = data.profiles[0]!;
    // The skipped-read resource must not become a successful validation.
    expect(profile.validation).not.toBeNull();
    expect(profile.validation!.status).toBe('error');
    expect(
      profile.validation!.findings.some(
        (f) => f.code === 'REQUIRED_FILE_INVALID' && f.path === claudeMd,
      ),
    ).toBe(true);

    // And the independent validator path agrees.
    const direct = await validateProfile({ appHomePath: appHome, name: 'coding' });
    expect(direct.status).toBe('error');
  });

  it('listing stays bounded: isolation adds no extra scans (loadWorkbenchData still one pass)', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const data = await loadWorkbenchData(appHome);
    expect(data.profiles).toHaveLength(1);
    expect(statesOf(data.profiles[0]!).userMemory.status).toBe('ok');
  });
});