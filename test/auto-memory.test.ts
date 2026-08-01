import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  listAutoMemoryEntries,
  readAutoMemoryEntry,
  searchAutoMemory,
  copyAutoMemoryEntry,
  removeAutoMemoryEntry,
  getEntryNameFromBinItem,
  AUTO_MEMORY_RELATIVE_DIR,
  type AutoMemoryEntry,
} from '../src/core/auto-memory';
import { listRecoveryBinItems, restoreRecoveryItem } from '../src/core/recovery-bin';
import { validateProfileName } from '../src/platform/path';

describe('Auto Memory resource service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-auto-memory-'));
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

  function autoMemoryDir(profileDir: string): string {
    return join(profileDir, 'claude-home', 'memory', 'auto');
  }

  async function writeEntry(
    profileDir: string,
    name: string,
    content: string,
    mtime?: Date,
  ): Promise<void> {
    const dir = autoMemoryDir(profileDir);
    await fs.ensureDir(dir);
    const filePath = join(dir, name);
    await fs.writeFile(filePath, content, 'utf8');
    if (mtime) {
      await fs.utimes(filePath, mtime, mtime);
    }
  }

  const fixedClock = () => new Date('2026-07-31T16:13:29.000Z');

  // ─── listAutoMemoryEntries ────────────────────────────────────────────

  describe('listAutoMemoryEntries', () => {
    it('lists files in memory/auto/ with size and modified time', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', '# Topics\n\nRefactoring notes.', new Date('2026-07-31T10:00:00Z'));
      await writeEntry(profileDir, 'session-notes.md', 'session 1', new Date('2026-07-30T10:00:00Z'));

      const entries = await listAutoMemoryEntries({ appHomePath: appHome, profileName: 'coding' });

      expect(entries.length).toBeGreaterThanOrEqual(2);
      const names = entries.map((e) => e.name).sort();
      expect(names).toContain('topics.md');
      expect(names).toContain('session-notes.md');
      const topics = entries.find((e) => e.name === 'topics.md')!;
      expect(topics.sizeBytes).toBeGreaterThan(0);
      expect(typeof topics.modifiedAt).toBe('string');
    });

    it('returns an empty array when the directory is missing', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      // Remove the auto memory directory entirely
      const { profilesPath } = getAppHomePaths(appHome);
      await fs.remove(join(profilesPath, 'coding', 'claude-home', 'memory', 'auto'));

      const entries = await listAutoMemoryEntries({ appHomePath: appHome, profileName: 'coding' });
      expect(entries).toEqual([]);
    });

    it('ignores subdirectories and only lists regular files', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'real.md', 'real');
      await fs.ensureDir(join(autoMemoryDir(profileDir), 'subdir'));

      const entries = await listAutoMemoryEntries({ appHomePath: appHome, profileName: 'coding' });
      const names = entries.map((e) => e.name);
      expect(names).toContain('real.md');
      expect(names).not.toContain('subdir');
    });

    it('rejects an invalid profile name', async () => {
      const appHome = await makeAppHome();
      await expect(listAutoMemoryEntries({ appHomePath: appHome, profileName: '../escape' })).rejects.toThrow();
    });
  });

  // ─── readAutoMemoryEntry ──────────────────────────────────────────────

  describe('readAutoMemoryEntry', () => {
    it('returns file content and entry metadata', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', '# Topics\nLine two.');

      const result = await readAutoMemoryEntry({
        appHomePath: appHome,
        profileName: 'coding',
        entryName: 'topics.md',
      });

      expect(result.content).toBe('# Topics\nLine two.');
      expect(result.entry.name).toBe('topics.md');
      expect(result.entry.sizeBytes).toBeGreaterThan(0);
    });

    it('throws a structured error when the entry does not exist', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        readAutoMemoryEntry({ appHomePath: appHome, profileName: 'coding', entryName: 'missing.md' }),
      ).rejects.toThrow(/missing.md/);
    });

    it('rejects entry names that escape the auto memory directory', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        readAutoMemoryEntry({ appHomePath: appHome, profileName: 'coding', entryName: '../CLAUDE.md' }),
      ).rejects.toThrow();
    });
  });

  // ─── searchAutoMemory ─────────────────────────────────────────────────

  describe('searchAutoMemory', () => {
    it('finds matches within a single profile', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', '# Refactoring\nKeep functions small.');
      await writeEntry(profileDir, 'notes.md', 'Unrelated session notes.');

      const matches = await searchAutoMemory({
        appHomePath: appHome,
        profileName: 'coding',
        query: 'refactor',
      });

      expect(matches.length).toBe(1);
      expect(matches[0]!.profileName).toBe('coding');
      expect(matches[0]!.entryName).toBe('topics.md');
      expect(matches[0]!.text.toLowerCase()).toContain('refactor');
      expect(matches[0]!.line).toBeGreaterThan(0);
    });

    it('searches across all profiles when profileName is omitted', async () => {
      const appHome = await makeAppHome();
      const codingDir = await makeProfile(appHome, 'coding');
      const studyDir = await makeProfile(appHome, 'study');
      await writeEntry(codingDir, 'topics.md', 'Refactor strategies');
      await writeEntry(studyDir, 'research.md', 'Refactor patterns in literature');

      const matches = await searchAutoMemory({ appHomePath: appHome, query: 'refactor' });

      const profiles = new Set(matches.map((m) => m.profileName));
      expect(profiles.has('coding')).toBe(true);
      expect(profiles.has('study')).toBe(true);
    });

    it('returns an empty array for an empty query', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', 'anything');

      const matches = await searchAutoMemory({ appHomePath: appHome, query: '' });
      expect(matches).toEqual([]);
    });

    it('is case-insensitive', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', 'REFACTOR everything');

      const matches = await searchAutoMemory({
        appHomePath: appHome,
        profileName: 'coding',
        query: 'refactor',
      });
      expect(matches.length).toBe(1);
    });
  });

  // ─── copyAutoMemoryEntry ──────────────────────────────────────────────

  describe('copyAutoMemoryEntry', () => {
    it('seeds a target profile with the entry content', async () => {
      const appHome = await makeAppHome();
      const codingDir = await makeProfile(appHome, 'coding');
      const studyDir = await makeProfile(appHome, 'study');
      await writeEntry(codingDir, 'topics.md', '# Seed\nShared memory.');

      const result = await copyAutoMemoryEntry({
        appHomePath: appHome,
        fromProfile: 'coding',
        toProfile: 'study',
        entryName: 'topics.md',
      });

      const target = join(autoMemoryDir(studyDir), 'topics.md');
      expect(await fs.pathExists(target)).toBe(true);
      expect(await fs.readFile(target, 'utf8')).toBe('# Seed\nShared memory.');
      expect(result.targetEntryName).toBe('topics.md');
    });

    it('refuses to overwrite an existing entry in the target profile', async () => {
      const appHome = await makeAppHome();
      const codingDir = await makeProfile(appHome, 'coding');
      const studyDir = await makeProfile(appHome, 'study');
      await writeEntry(codingDir, 'topics.md', 'source content');
      await writeEntry(studyDir, 'topics.md', 'existing content');

      await expect(
        copyAutoMemoryEntry({
          appHomePath: appHome,
          fromProfile: 'coding',
          toProfile: 'study',
          entryName: 'topics.md',
        }),
      ).rejects.toThrow();

      // Target untouched
      const target = join(autoMemoryDir(studyDir), 'topics.md');
      expect(await fs.readFile(target, 'utf8')).toBe('existing content');
    });

    it('rejects a missing source entry', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');

      await expect(
        copyAutoMemoryEntry({
          appHomePath: appHome,
          fromProfile: 'coding',
          toProfile: 'study',
          entryName: 'nope.md',
        }),
      ).rejects.toThrow();
    });
  });

  // ─── removeAutoMemoryEntry ────────────────────────────────────────────

  describe('removeAutoMemoryEntry', () => {
    it('creates a file-tree Bin item (kind auto-memory) and deletes the file, zero-confirm', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', 'to be removed');

      const item = await removeAutoMemoryEntry({
        appHomePath: appHome,
        profileName: 'coding',
        entryName: 'topics.md',
        clock: fixedClock,
      });

      expect(item.kind).toBe('auto-memory');
      expect(item.shape).toBe('file-tree');
      expect(item.origin).toBe('remove');
      expect(item.profile).toBe('coding');
      expect(item.id).toMatch(/^20260731T161329-coding-/);
      expect(item.secretBearing).toBe(false);

      // File is gone from the profile
      expect(await fs.pathExists(join(autoMemoryDir(profileDir), 'topics.md'))).toBe(false);

      // Payload preserved in the Bin item
      const payload = join(item.itemDirPath, AUTO_MEMORY_RELATIVE_DIR, 'topics.md');
      expect(await fs.pathExists(payload)).toBe(true);
      expect(await fs.readFile(payload, 'utf8')).toBe('to be removed');
    });

    it('records the entry relative path in coordinates', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'notes.md', 'x');

      const item = await removeAutoMemoryEntry({
        appHomePath: appHome,
        profileName: 'coding',
        entryName: 'notes.md',
        clock: fixedClock,
      });

      expect(item.coordinates).toEqual({
        targetRelativePath: `${AUTO_MEMORY_RELATIVE_DIR}/notes.md`,
      });
    });

    it('throws when the entry does not exist', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        removeAutoMemoryEntry({
          appHomePath: appHome,
          profileName: 'coding',
          entryName: 'missing.md',
          clock: fixedClock,
        }),
      ).rejects.toThrow();
    });
  });

  // ─── restore round-trip ──────────────────────────────────────────────

  describe('restore round-trip (via Recovery Bin)', () => {
    it('restore returns the entry content and consumes the Bin item', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', 'restore me');

      const item = await removeAutoMemoryEntry({
        appHomePath: appHome,
        profileName: 'coding',
        entryName: 'topics.md',
        clock: fixedClock,
      });

      // File is gone
      expect(await fs.pathExists(join(autoMemoryDir(profileDir), 'topics.md'))).toBe(false);

      const result = await restoreRecoveryItem({ appHomePath: appHome, itemId: item.id });
      expect(result.consumed).toBe(true);
      expect(result.restoredProfile).toBe('coding');

      // Content is back
      const restored = await fs.readFile(join(autoMemoryDir(profileDir), 'topics.md'), 'utf8');
      expect(restored).toBe('restore me');

      // Bin item consumed
      const remaining = await listRecoveryBinItems(appHome);
      expect(remaining.find((r) => r.id === item.id)).toBeUndefined();
    });

    it('restore refuses when the entry already exists', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', 'original');

      const item = await removeAutoMemoryEntry({
        appHomePath: appHome,
        profileName: 'coding',
        entryName: 'topics.md',
        clock: fixedClock,
      });

      // Recreate the entry before restoring
      await writeEntry(profileDir, 'topics.md', 'recreated');

      await expect(
        restoreRecoveryItem({ appHomePath: appHome, itemId: item.id }),
      ).rejects.toThrow(/already exists|collision/i);

      // Item not consumed on collision
      const remaining = await listRecoveryBinItems(appHome);
      expect(remaining.find((r) => r.id === item.id)).toBeDefined();
    });
  });

  // ─── path safety ─────────────────────────────────────────────────────

  describe('path safety', () => {
    it('rejects traversal entry names across operations', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(
        removeAutoMemoryEntry({
          appHomePath: appHome,
          profileName: 'coding',
          entryName: '../../etc/evil',
          clock: fixedClock,
        }),
      ).rejects.toThrow();
    });

    it('validateProfileName guards the profile parameter', () => {
      expect(() => validateProfileName('good-name')).not.toThrow();
      expect(() => validateProfileName('../bad')).toThrow();
    });
  });

  // ─── type smoke ──────────────────────────────────────────────────────

  it('AutoMemoryEntry shape is stable', () => {
    const entry: AutoMemoryEntry = { name: 'topics.md', sizeBytes: 42, modifiedAt: '2026-07-31T10:00:00.000Z' };
    expect(entry.name).toBe('topics.md');
  });

  // ─── getEntryNameFromBinItem ─────────────────────────────────────────

  describe('getEntryNameFromBinItem', () => {
    it('extracts the entry name from a Recovery Bin item coordinates', async () => {
      const appHome = await makeAppHome();
      const profileDir = await makeProfile(appHome, 'coding');
      await writeEntry(profileDir, 'topics.md', '# Topics');

      const item = await removeAutoMemoryEntry({
        appHomePath: appHome,
        profileName: 'coding',
        entryName: 'topics.md',
        clock: fixedClock,
      });

      expect(getEntryNameFromBinItem(item)).toBe('topics.md');
    });
  });
});
