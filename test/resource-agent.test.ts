import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import {
  createAgent,
  listAgents,
  loadAgent,
  readAgentContent,
  removeAgent,
  copyAgentToProfile,
  updateAgentFrontmatter,
  validateNewAgentName,
} from '../src/core/resource/agent';
import { listRecoveryBinItems } from '../src/core/recovery-bin';
import { CcpsError } from '../src/utils/errors';

describe('Agent resource service', () => {
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
    const root = await mkdtemp(join(tmpdir(), 'ccps-agent-'));
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

  function agentsPath(appHome: string, name: string): string {
    const { profilesPath } = getAppHomePaths(appHome);
    return join(profilesPath, name, 'claude-home', 'agents');
  }

  const fixedClock = () => new Date('2026-07-31T16:13:29.000Z');

  const AGENT_CONTENT = [
    '---',
    'name: explore',
    'description: read-only codebase exploration',
    '---',
    '',
    'Explore the codebase and report findings.',
  ].join('\n');

  describe('validateNewAgentName', () => {
    it('accepts safe names including CJK and spaces', () => {
      expect(validateNewAgentName('explore')).toBe('explore');
      expect(validateNewAgentName('my-agent_2')).toBe('my-agent_2');
      expect(validateNewAgentName('研究代理')).toBe('研究代理');
      expect(validateNewAgentName('code reviewer')).toBe('code reviewer');
    });

    it('rejects empty, separator, and control names', () => {
      expect(() => validateNewAgentName('')).toThrow(CcpsError);
      expect(() => validateNewAgentName(' a ')).toThrow(CcpsError);
      expect(() => validateNewAgentName('a/b')).toThrow(CcpsError);
      expect(() => validateNewAgentName('..')).toThrow(CcpsError);
    });
  });

  describe('CJK and spaced agent files', () => {
    it('lists, reads, removes, and updates pre-existing CJK agent files', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const dir = join(profilePath, 'claude-home', 'agents');
      const content = '---\nname: 研究代理\ndescription: 中文代理\n---\n\n正文内容。\n';
      await fs.writeFile(join(dir, '研究代理.md'), content, 'utf8');

      const agents = await listAgents(appHome, 'coding');
      expect(agents.map((a) => a.name)).toContain('研究代理');
      expect(await readAgentContent(appHome, 'coding', '研究代理')).toBe(content);

      await updateAgentFrontmatter(appHome, 'coding', '研究代理', { description: '更新描述' });
      const updated = await readAgentContent(appHome, 'coding', '研究代理');
      expect(updated).toContain('description: 更新描述');

      const binItem = await removeAgent(appHome, 'coding', '研究代理', fixedClock);
      expect(binItem.kind).toBe('agent');
      expect(await readAgentContent(appHome, 'coding', '研究代理')).toBeNull();
    });
  });

  describe('listAgents', () => {
    it('returns an empty list when agents dir is missing', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await fs.remove(agentsPath(appHome, 'coding'));

      expect(await listAgents(appHome, 'coding')).toEqual([]);
    });

    it('lists agent files with parsed frontmatter', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      await fs.writeFile(join(profilePath, 'claude-home', 'agents', 'explore.md'), AGENT_CONTENT, 'utf8');

      const agents = await listAgents(appHome, 'coding');
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('explore');
      expect(agents[0].frontmatter).toEqual({
        name: 'explore',
        description: 'read-only codebase exploration',
      });
      expect(agents[0].bodyExcerpt).toContain('Explore the codebase');
    });

    it('handles files without frontmatter', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      await fs.writeFile(join(profilePath, 'claude-home', 'agents', 'plain.md'), '# Plain agent\n', 'utf8');

      const agents = await listAgents(appHome, 'coding');
      expect(agents[0].frontmatter).toBeNull();
      expect(agents[0].frontmatterParseError).toBeNull();
    });

    it('marks malformed frontmatter with a parse error', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      await fs.writeFile(join(profilePath, 'claude-home', 'agents', 'broken.md'), '---\nname: explore\n', 'utf8');

      const agents = await listAgents(appHome, 'coding');
      expect(agents[0].frontmatterParseError).not.toBeNull();
      expect(agents[0].frontmatter).toBeNull();
    });

    it('sorts agents alphabetically', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const dir = join(profilePath, 'claude-home', 'agents');
      await fs.writeFile(join(dir, 'zebra.md'), '---\nname: zebra\n---\n', 'utf8');
      await fs.writeFile(join(dir, 'alpha.md'), '---\nname: alpha\n---\n', 'utf8');

      const agents = await listAgents(appHome, 'coding');
      expect(agents.map((a) => a.name)).toEqual(['alpha', 'zebra']);
    });
  });

  describe('createAgent', () => {
    it('creates a minimal frontmatter scaffold', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      const filePath = await createAgent(appHome, 'coding', 'helper');
      expect(filePath.endsWith('agents/helper.md')).toBe(true);

      const agent = await loadAgent(appHome, 'coding', 'helper');
      expect(agent).not.toBeNull();
      expect(agent!.frontmatter).toEqual({ name: 'helper', description: '' });
    });

    it('refuses duplicate agent names', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');
      await createAgent(appHome, 'coding', 'helper');

      await expect(createAgent(appHome, 'coding', 'helper')).rejects.toBeInstanceOf(CcpsError);
    });
  });

  describe('removeAgent', () => {
    it('removes the file and creates a file-tree Bin item', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const dir = join(profilePath, 'claude-home', 'agents');
      await fs.writeFile(join(dir, 'explore.md'), AGENT_CONTENT, 'utf8');

      const binItem = await removeAgent(appHome, 'coding', 'explore', fixedClock);
      expect(binItem.kind).toBe('agent');
      expect(binItem.coordinates).toEqual({ targetRelativePath: 'claude-home/agents/explore.md' });

      expect(await readAgentContent(appHome, 'coding', 'explore')).toBeNull();

      const items = await listRecoveryBinItems(appHome);
      expect(items.map((i) => i.id)).toContain(binItem.id);
    });

    it('throws for a missing agent', async () => {
      const appHome = await makeAppHome();
      await makeProfile(appHome, 'coding');

      await expect(removeAgent(appHome, 'coding', 'nope', fixedClock)).rejects.toBeInstanceOf(CcpsError);
    });
  });

  describe('copyAgentToProfile', () => {
    it('copies an agent file to the target profile', async () => {
      const appHome = await makeAppHome();
      const sourceProfile = await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');
      const dir = join(sourceProfile, 'claude-home', 'agents');
      await fs.writeFile(join(dir, 'explore.md'), AGENT_CONTENT, 'utf8');

      await copyAgentToProfile(appHome, 'coding', 'study', 'explore');
      expect(await readAgentContent(appHome, 'study', 'explore')).toBe(AGENT_CONTENT);
    });

    it('refuses when target already has the agent', async () => {
      const appHome = await makeAppHome();
      const sourceProfile = await makeProfile(appHome, 'coding');
      const targetProfile = await makeProfile(appHome, 'study');
      const sourceDir = join(sourceProfile, 'claude-home', 'agents');
      const targetDir = join(targetProfile, 'claude-home', 'agents');
      await fs.writeFile(join(sourceDir, 'explore.md'), AGENT_CONTENT, 'utf8');
      await fs.writeFile(join(targetDir, 'explore.md'), AGENT_CONTENT, 'utf8');

      await expect(copyAgentToProfile(appHome, 'coding', 'study', 'explore')).rejects.toBeInstanceOf(CcpsError);
    });
  });

  describe('updateAgentFrontmatter', () => {
    it('updates frontmatter fields and preserves body', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const dir = join(profilePath, 'claude-home', 'agents');
      await fs.writeFile(join(dir, 'explore.md'), AGENT_CONTENT, 'utf8');

      await updateAgentFrontmatter(appHome, 'coding', 'explore', {
        description: 'new description',
        model: 'claude-sonnet-4-6',
      });

      const content = await readAgentContent(appHome, 'coding', 'explore');
      expect(content).toContain('description: new description');
      expect(content).toContain('model: claude-sonnet-4-6');
      expect(content).toContain('Explore the codebase and report findings.');
    });

    it('throws when frontmatter is malformed', async () => {
      const appHome = await makeAppHome();
      const profilePath = await makeProfile(appHome, 'coding');
      const dir = join(profilePath, 'claude-home', 'agents');
      await fs.writeFile(join(dir, 'explore.md'), '---\nname: explore\n', 'utf8');

      await expect(
        updateAgentFrontmatter(appHome, 'coding', 'explore', { description: 'x' }),
      ).rejects.toBeInstanceOf(CcpsError);
    });
  });
});

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
