import fs from 'fs-extra';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureProfileCreator } from '../src/core/profile-creator';
import { getProfileTemplatePaths } from '../src/core/profile-template';
const skillRoot = join(
  process.cwd(),
  'src',
  'templates',
  'profile-creator',
  'skills',
  'ccps-create-profile',
);

describe('profile creator MCP guidance', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it('uses the target profile native user scope instead of legacy MCP files', async () => {
    const mainSkill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
    const configureMcp = await readFile(
      join(skillRoot, 'sub-skills', 'ccps-configure-mcp.md'),
      'utf8',
    );

    expect(mainSkill).toContain('claude mcp add --scope user');
    expect(mainSkill).not.toContain('更新 `<profile>/mcp.json`');
    expect(configureMcp).toContain(
      'env CLAUDE_CONFIG_DIR="<target-profile>/claude-home" claude mcp',
    );
    expect(configureMcp).toContain('$env:CLAUDE_CONFIG_DIR');
    expect(configureMcp).toContain('$CLAUDE_CONFIG_DIR/.claude.json');
    expect(configureMcp).toContain('`settings.json` 不支持 `mcpServers`');
    expect(configureMcp).toContain('不要直接编辑 `.claude.json`');
    expect(configureMcp).toContain('不要在 Agent 可见的终端运行 `claude mcp get`');
  });

  it('audits MCP through the target profile CLI without reading Claude state directly', async () => {
    const auditProfile = await readFile(
      join(skillRoot, 'sub-skills', 'ccps-audit-profile.md'),
      'utf8',
    );

    expect(auditProfile).toContain('env CLAUDE_CONFIG_DIR="<profile>/claude-home" claude mcp list');
    expect(auditProfile).toContain('$env:CLAUDE_CONFIG_DIR');
    expect(auditProfile).toContain('不要直接读取 `<profile>/claude-home/.claude.json`');
    expect(auditProfile).not.toContain('读取 `<profile>/mcp.json`');
    expect(auditProfile).toContain('不要在 Agent 可见的终端运行 `claude mcp get`');
  });

  it('creates the built-in profile creator with native MCP defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-profile-creator-mcp-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');

    const profileName = await ensureProfileCreator({ appHomePath: appHome });
    const paths = getProfileTemplatePaths(appHome, profileName);
    const profile = await fs.readJson(paths.profileConfigPath);

    expect(profile.launch.mcpMode).toBe('none');
    await expect(fs.pathExists(paths.mcpConfigPath)).resolves.toBe(false);
    await expect(fs.readFile(paths.ccpsProfileRulePath, 'utf8')).resolves.toContain(
      'ccps-managed-profile-boundary:start:v2',
    );
  });
});
