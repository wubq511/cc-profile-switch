import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  lineDiff,
  countChanges,
  diffUserMemory,
  diffAgents,
} from '../src/core/resource/diff';

describe('Resource diff service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-diff-'));
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

  describe('lineDiff', () => {
    it('detects identical content', () => {
      const lines = lineDiff(['a', 'b'], ['a', 'b']);
      expect(lines.every((l) => l.type === 'same')).toBe(true);
      expect(countChanges(lines)).toEqual({ add: 0, del: 0 });
    });

    it('detects additions', () => {
      const lines = lineDiff(['a'], ['a', 'b']);
      expect(lines.map((l) => [l.type, l.text])).toEqual([
        ['same', 'a'],
        ['add', 'b'],
      ]);
    });

    it('detects deletions', () => {
      const lines = lineDiff(['a', 'b'], ['a']);
      expect(lines.map((l) => [l.type, l.text])).toEqual([
        ['same', 'a'],
        ['del', 'b'],
      ]);
    });

    it('detects modifications', () => {
      const lines = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
      expect(countChanges(lines)).toEqual({ add: 1, del: 1 });
    });

    it('handles one side empty', () => {
      const onlyDel = lineDiff(['a', 'b'], []);
      expect(onlyDel.every((l) => l.type === 'del')).toBe(true);

      const onlyAdd = lineDiff([], ['a', 'b']);
      expect(onlyAdd.every((l) => l.type === 'add')).toBe(true);
    });
  });

  describe('diffUserMemory', () => {
    it('produces a unified line diff between two profiles', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.writeFile(join(coding, 'claude-home', 'CLAUDE.md'), '# A\nline1\nline2\n', 'utf8');
      await fs.writeFile(join(study, 'claude-home', 'CLAUDE.md'), '# A\nline1 changed\nline2\n', 'utf8');

      const diff = await diffUserMemory(appHome, 'coding', 'study');
      expect(diff.profileA).toBe('coding');
      expect(diff.profileB).toBe('study');
      const { add, del } = countChanges(diff.lines);
      expect(add).toBe(1);
      expect(del).toBe(1);
    });

    it('handles a missing file as empty content', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');
      await fs.writeFile(join(coding, 'claude-home', 'CLAUDE.md'), 'line1', 'utf8');
      const { claudeMdPath } = profileClaudeMd(appHome, 'study');
      await fs.remove(claudeMdPath);

      const diff = await diffUserMemory(appHome, 'coding', 'study');
      expect(diff.aLineCount).toBe(1);
      expect(diff.bLineCount).toBe(0);
      expect(diff.lines.some((l) => l.type === 'del')).toBe(true);
    });
  });

  describe('diffAgents', () => {
    it('flags added, removed, and changed agents', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      const codingAgents = join(coding, 'claude-home', 'agents');
      const studyAgents = join(study, 'claude-home', 'agents');
      await fs.ensureDir(codingAgents);
      await fs.ensureDir(studyAgents);

      // explore: only in coding (removed from study)
      await fs.writeFile(join(codingAgents, 'explore.md'), '---\nname: explore\n---\n', 'utf8');
      // editor: only in study (added)
      await fs.writeFile(join(studyAgents, 'editor.md'), '---\nname: editor\n---\n', 'utf8');
      // coder: in both, same
      await fs.writeFile(join(codingAgents, 'coder.md'), '---\nname: coder\n---\nsame\n', 'utf8');
      await fs.writeFile(join(studyAgents, 'coder.md'), '---\nname: coder\n---\nsame\n', 'utf8');
      // review: in both, changed
      await fs.writeFile(join(codingAgents, 'review.md'), '---\nname: review\n---\nold body\n', 'utf8');
      await fs.writeFile(join(studyAgents, 'review.md'), '---\nname: review\n---\nnew body\n', 'utf8');

      const diff = await diffAgents(appHome, 'coding', 'study');
      const byName = Object.fromEntries(diff.files.map((f) => [f.name, f]));

      expect(byName['explore'].verdict).toBe('removed');
      expect(byName['editor'].verdict).toBe('added');
      expect(byName['coder'].verdict).toBe('same');
      expect(byName['review'].verdict).toBe('changed');
      expect(byName['review'].lines).toBeDefined();
      expect(countChanges(byName['review'].lines!)).toEqual({ add: 1, del: 1 });

      expect(diff.removedCount).toBe(1);
      expect(diff.addedCount).toBe(1);
      expect(diff.sameCount).toBe(1);
      expect(diff.changedCount).toBe(1);
    });
  });
});

function profileClaudeMd(appHome: string, name: string): { claudeMdPath: string } {
  const { profilesPath } = getAppHomePaths(appHome);
  return { claudeMdPath: join(profilesPath, name, 'claude-home', 'CLAUDE.md') };
}
