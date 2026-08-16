import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { searchUserMemory, searchAgents, searchAllResources } from '../src/core/resource/search';

describe('Resource search service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-search-'));
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

  describe('searchUserMemory', () => {
    it('finds matching lines across profiles', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.writeFile(join(coding, 'claude-home', 'CLAUDE.md'), '# Coding\nPrefer explicit answers.\n', 'utf8');
      await fs.writeFile(join(study, 'claude-home', 'CLAUDE.md'), '# Study\nPrefer structured learning.\n', 'utf8');

      const hits = await searchUserMemory({ appHomePath: appHome, query: 'prefer' });
      expect(hits).toHaveLength(2);
      expect(hits.map((h) => h.profileName).sort()).toEqual(['coding', 'study']);
      expect(hits[0].category).toBe('user-memory');
      expect(hits[0].matchLine).toContain('Prefer');
    });

    it('is case-insensitive', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      await fs.writeFile(join(coding, 'claude-home', 'CLAUDE.md'), '# Coding\nPREFER explicit.\n', 'utf8');

      const hits = await searchUserMemory({ appHomePath: appHome, query: 'prefer' });
      expect(hits).toHaveLength(1);
    });

    it('respects profileNames filter', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.writeFile(join(coding, 'claude-home', 'CLAUDE.md'), '# Coding\nrefactor this.\n', 'utf8');
      await fs.writeFile(join(study, 'claude-home', 'CLAUDE.md'), '# Study\nrefactor that.\n', 'utf8');

      const hits = await searchUserMemory({ appHomePath: appHome, query: 'refactor', profileNames: ['study'] });
      expect(hits).toHaveLength(1);
      expect(hits[0].profileName).toBe('study');
    });

    it('returns no hits for an empty query', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      expect(await searchUserMemory({ appHomePath: appHome, query: '  ' })).toEqual([]);
    });
  });

  describe('searchAgents', () => {
    it('finds matching agent content across profiles', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.writeFile(
        join(coding, 'claude-home', 'agents', 'explore.md'),
        '---\nname: explore\n---\nScan the codebase for bugs.\n',
        'utf8',
      );
      await fs.writeFile(
        join(study, 'claude-home', 'agents', 'editor.md'),
        '---\nname: editor\n---\nReview prose style.\n',
        'utf8',
      );

      const hits = await searchAgents({ appHomePath: appHome, query: 'codebase' });
      expect(hits).toHaveLength(1);
      expect(hits[0].profileName).toBe('coding');
      expect(hits[0].itemName).toBe('explore');
      expect(hits[0].category).toBe('agents');
    });
  });

  describe('searchAllResources', () => {
    it('combines memory and agent hits', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      await fs.writeFile(join(coding, 'claude-home', 'CLAUDE.md'), '# Coding\nrefactor this.\n', 'utf8');
      await fs.writeFile(
        join(coding, 'claude-home', 'agents', 'explore.md'),
        '---\nname: explore\n---\nPlan the refactor.\n',
        'utf8',
      );

      const hits = await searchAllResources({ appHomePath: appHome, query: 'refactor' });
      expect(hits).toHaveLength(2);
      const categories = hits.map((h) => h.category).sort();
      expect(categories).toEqual(['agents', 'user-memory']);
    });
  });
});
