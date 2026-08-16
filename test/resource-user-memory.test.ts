import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  createUserMemory,
  loadUserMemory,
  readUserMemoryContent,
  removeUserMemory,
  copyUserMemoryToProfile,
} from '../src/core/resource/user-memory';
import { listRecoveryBinItems } from '../src/core/recovery-bin';
import { CcpsError } from '../src/utils/errors';

describe('User Memory resource service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots) {
      const binDir = join(root, '.cc-profile-switch', 'recovery-bin');
      if (await fs.pathExists(binDir)) {
        try {
          await restorePermissions(binDir);
        } catch {
          // Best effort
        }
      }
    }
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-user-memory-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    return appHome;
  }

  async function makeProfile(appHome: string, name: string): Promise<string> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    const { profilesPath } = getAppHomePaths(appHome);
    return join(profilesPath, name);
  }

  const fixedClock = () => new Date('2026-07-31T16:13:29.000Z');

  describe('loadUserMemory', () => {
    it('returns exists=false when CLAUDE.md is missing', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const { claudeMdPath } = profilePaths(appHome, 'coding');
      await fs.remove(claudeMdPath);

      const entry = await loadUserMemory(appHome, 'coding');
      expect(entry.kind).toBe('user-memory');
      expect(entry.exists).toBe(false);
      expect(entry.name).toBe('CLAUDE.md');
      expect(entry.relativePath).toBe('claude-home/CLAUDE.md');
      expect(entry.lineCount).toBe(0);
    });

    it('reads existing CLAUDE.md and extracts line count + excerpt', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const content = [
        '# Coding Profile',
        '',
        'Prefer explicit answers.',
        'Keep diffs small.',
        '',
        'Third line of the body.',
      ].join('\n');
      await fs.writeFile(join(profilePath, 'claude-home', 'CLAUDE.md'), content, 'utf8');

      const entry = await loadUserMemory(appHome, 'coding');
      expect(entry.exists).toBe(true);
      expect(entry.lineCount).toBe(6);
      expect(entry.excerpt).toContain('Prefer explicit answers.');
      expect(entry.excerpt).toContain('Keep diffs small.');
    });
  });

  describe('readUserMemoryContent', () => {
    it('returns null when missing', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const { claudeMdPath } = profilePaths(appHome, 'coding');
      await fs.remove(claudeMdPath);

      expect(await readUserMemoryContent(appHome, 'coding')).toBeNull();
    });

    it('returns full content when present', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const content = '# Title\nBody here.\n';
      await fs.writeFile(join(profilePath, 'claude-home', 'CLAUDE.md'), content, 'utf8');

      expect(await readUserMemoryContent(appHome, 'coding')).toBe(content);
    });
  });

  describe('createUserMemory', () => {
    it('recreates a missing CLAUDE.md', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const claudeMdPath = join(profilePath, 'claude-home', 'CLAUDE.md');
      await fs.remove(claudeMdPath);

      await createUserMemory(appHome, 'coding', '# Recreated\n');
      expect(await readUserMemoryContent(appHome, 'coding')).toBe('# Recreated\n');
    });

    it('creates an empty file by default', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const claudeMdPath = join(profilePath, 'claude-home', 'CLAUDE.md');
      await fs.remove(claudeMdPath);

      await createUserMemory(appHome, 'coding');
      expect(await readUserMemoryContent(appHome, 'coding')).toBe('');
    });

    it('refuses when CLAUDE.md already exists', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(createUserMemory(appHome, 'coding', '# x\n')).rejects.toBeInstanceOf(CcpsError);
    });
  });

  describe('removeUserMemory', () => {
    it('removes CLAUDE.md and creates a file-tree Bin item', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const binItem = await removeUserMemory(appHome, 'coding', fixedClock);
      expect(binItem.kind).toBe('user-memory');
      expect(binItem.coordinates).toEqual({ targetRelativePath: 'claude-home/CLAUDE.md' });
      expect(binItem.origin).toBe('remove');
      expect(binItem.shape).toBe('file-tree');

      expect(await readUserMemoryContent(appHome, 'coding')).toBeNull();

      const items = await listRecoveryBinItems(appHome);
      expect(items.map((i) => i.id)).toContain(binItem.id);
    });

    it('throws when CLAUDE.md does not exist', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const { claudeMdPath } = profilePaths(appHome, 'coding');
      await fs.remove(claudeMdPath);

      await expect(removeUserMemory(appHome, 'coding', fixedClock)).rejects.toBeInstanceOf(CcpsError);
    });
  });

  describe('copyUserMemoryToProfile', () => {
    it('copies CLAUDE.md to the target profile', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');
      const sourceProfile = await makeProfile(appHome, 'research');

      const content = '# Source\nShared memory.\n';
      await fs.writeFile(join(sourceProfile, 'claude-home', 'CLAUDE.md'), content, 'utf8');
      // Remove the template CLAUDE.md from the target so the copy lands cleanly
      await fs.remove(join(profileRoot(appHome, 'study'), 'claude-home', 'CLAUDE.md'));

      await copyUserMemoryToProfile(appHome, 'research', 'study');
      expect(await readUserMemoryContent(appHome, 'study')).toBe(content);
    });

    it('refuses when target already has CLAUDE.md', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');

      await expect(copyUserMemoryToProfile(appHome, 'coding', 'study')).rejects.toBeInstanceOf(CcpsError);
    });

    it('refuses same source and target', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(copyUserMemoryToProfile(appHome, 'coding', 'coding')).rejects.toBeInstanceOf(CcpsError);
    });
  });
});

function profilePaths(appHome: string, name: string) {
  const { profilesPath } = getAppHomePaths(appHome);
  const profilePath = join(profilesPath, name);
  return { claudeMdPath: join(profilePath, 'claude-home', 'CLAUDE.md') };
}

function profileRoot(appHome: string, name: string): string {
  const { profilesPath } = getAppHomePaths(appHome);
  return join(profilesPath, name);
}

async function restorePermissions(dir: string): Promise<void> {
  await fs.chmod(dir, 0o755);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await restorePermissions(fullPath);
    }
  }
}
