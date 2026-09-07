import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyClaudeHomeEntry,
  selectResourcesIntoStaging,
  sweepRuntimeEntriesFromStagedProfile,
  type ResourceSelectionResult,
} from '../src/core/resource-policy';

// Probe symlink capability synchronously at module load, so it.skipIf can read
// it when the describe bodies register their tests (beforeAll runs too late).
let canCreateSymlink = false;
{
  const probeDir = fs.mkdtempSync(path.join(tmpdir(), 'ccps-symlink-probe-'));
  const probeTarget = path.join(probeDir, 'target');
  const probeLink = path.join(probeDir, 'link');
  try {
    fs.mkdirSync(probeTarget);
    fs.symlinkSync(probeTarget, probeLink);
    canCreateSymlink = true;
  } catch {
    canCreateSymlink = false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

describe('resource-policy shared selection pipeline (#105)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  /** Minimal profile tree with every policy-relevant entry kind. */
  async function makeProfileRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'ccps-resource-policy-'));
    tempRoots.push(root);
    const claudeHome = path.join(root, 'claude-home');
    await fs.outputFile(path.join(root, 'profile.json'), '{"name":"coding"}');
    await fs.outputFile(path.join(root, 'mcp.json'), '{"mcpServers":{}}');
    await fs.outputFile(path.join(root, 'skills-provenance.json'), '{"version":1,"skills":{}}');
    await fs.outputFile(path.join(root, 'stray-root-file.bin'), 'x');
    await fs.outputFile(path.join(root, 'stray-root-dir', 'inner.txt'), 'x');
    await fs.outputFile(path.join(claudeHome, 'settings.json'), '{"env":{}}');
    await fs.outputFile(path.join(claudeHome, 'CLAUDE.md'), '# user memory');
    await fs.outputFile(path.join(claudeHome, '.claude.json'), '{"mcpServers":{}}');
    await fs.outputFile(path.join(claudeHome, 'memory', 'auto', 'note-1.md'), '# auto');
    await fs.outputFile(path.join(claudeHome, 'memory', 'custom', 'note-2.md'), '# custom');
    await fs.outputFile(path.join(claudeHome, 'skills', 'pdf.md'), '# pdf skill');
    await fs.outputFile(path.join(claudeHome, 'agents', 'reviewer.md'), '# reviewer');
    await fs.outputFile(path.join(claudeHome, 'rules', 'ccps-profile.md'), '# rule');
    await fs.outputFile(path.join(claudeHome, 'plugins', 'p', 'config.json'), '{}');
    await fs.outputFile(path.join(claudeHome, 'plugins', 'cache', 'c.bin'), 'cache');
    // runtime + unknown entries (must never be selected)
    await fs.outputFile(path.join(claudeHome, 'sessions', 's.jsonl'), '{}');
    await fs.outputFile(path.join(claudeHome, 'history', 'h.jsonl'), '{}');
    await fs.outputFile(path.join(claudeHome, 'projects', 'p', 'x.jsonl'), '{}');
    await fs.outputFile(path.join(claudeHome, 'todos', 't.json'), '[]');
    await fs.outputFile(path.join(claudeHome, 'cache', 'c.bin'), 'x');
    await fs.outputFile(path.join(claudeHome, 'shell-snapshots', 's'), 'x');
    await fs.outputFile(path.join(claudeHome, '.credentials.json'), '{"oauth":1}');
    await fs.outputFile(path.join(claudeHome, 'unknown-runtime-dir', 'x'), 'x');
    return root;
  }

  async function runSelection(
    sourceRoot: string,
    options: { includeAutoMemory?: boolean; keepLinkedSkillReferences?: boolean } = {},
  ): Promise<{ selection: ResourceSelectionResult; stagingRoot: string }> {
    const stagingRoot = await mkdtemp(path.join(tmpdir(), 'ccps-resource-staging-'));
    tempRoots.push(stagingRoot);
    const selection = await selectResourcesIntoStaging({
      sourceProfileRoot: sourceRoot,
      stagingProfileRoot: stagingRoot,
      includeAutoMemory: options.includeAutoMemory !== false,
      keepLinkedSkillReferences: options.keepLinkedSkillReferences,
    });
    return { selection, stagingRoot };
  }

  function listTree(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else {
          out.push(rel);
        }
      }
    };
    walk(root, '');
    return out.sort();
  }

  it('classifies claude-home entries into supported/runtime-excluded/unknown', () => {
    expect(classifyClaudeHomeEntry('memory')).toBe('supported');
    expect(classifyClaudeHomeEntry('skills')).toBe('supported');
    expect(classifyClaudeHomeEntry('agents')).toBe('supported');
    expect(classifyClaudeHomeEntry('rules')).toBe('supported');
    expect(classifyClaudeHomeEntry('plugins')).toBe('supported');
    expect(classifyClaudeHomeEntry('CLAUDE.md')).toBe('supported');
    expect(classifyClaudeHomeEntry('settings.json')).toBe('supported');
    expect(classifyClaudeHomeEntry('.claude.json')).toBe('supported');
    expect(classifyClaudeHomeEntry('sessions')).toBe('runtime-excluded');
    expect(classifyClaudeHomeEntry('history')).toBe('runtime-excluded');
    expect(classifyClaudeHomeEntry('projects')).toBe('runtime-excluded');
    expect(classifyClaudeHomeEntry('todos')).toBe('runtime-excluded');
    expect(classifyClaudeHomeEntry('cache')).toBe('runtime-excluded');
    expect(classifyClaudeHomeEntry('shell-snapshots')).toBe('runtime-excluded');
    expect(classifyClaudeHomeEntry('.credentials.json')).toBe('runtime-excluded');
    expect(classifyClaudeHomeEntry('statsig')).toBe('runtime-excluded');
    expect(classifyClaudeHomeEntry('some-future-runtime')).toBe('unknown');
    expect(classifyClaudeHomeEntry('notes.txt')).toBe('unknown');
  });

  it('selects supported resources into staging; runtime and unknown entries are never copied', async () => {
    const sourceRoot = await makeProfileRoot();
    const { selection, stagingRoot } = await runSelection(sourceRoot, {
      includeAutoMemory: true,
    });

    expect(selection.failures).toEqual([]);
    const staged = listTree(stagingRoot);
    // supported resources present (export keeps Auto Memory)
    for (const expected of [
      'profile.json',
      'mcp.json',
      'skills-provenance.json',
      'claude-home/settings.json',
      'claude-home/CLAUDE.md',
      'claude-home/.claude.json',
      'claude-home/memory/auto/note-1.md',
      'claude-home/memory/custom/note-2.md',
      'claude-home/skills/pdf.md',
      'claude-home/agents/reviewer.md',
      'claude-home/rules/ccps-profile.md',
      'claude-home/plugins/p/config.json',
    ]) {
      expect(staged).toContain(expected);
    }
    // runtime internals, plugin cache and unknown entries never staged
    for (const absent of [
      'claude-home/sessions/s.jsonl',
      'claude-home/history/h.jsonl',
      'claude-home/projects/p/x.jsonl',
      'claude-home/todos/t.json',
      'claude-home/cache/c.bin',
      'claude-home/shell-snapshots/s',
      'claude-home/.credentials.json',
      'claude-home/unknown-runtime-dir/x',
      'claude-home/plugins/cache/c.bin',
      'stray-root-file.bin',
      'stray-root-dir/inner.txt',
    ]) {
      expect(staged).not.toContain(absent);
    }
    // skipped inventory records every exclusion with a policy-relative path
    expect(selection.skipped).toEqual(
      expect.arrayContaining([
        'stray-root-file.bin',
        'stray-root-dir',
        'claude-home/sessions',
        'claude-home/history',
        'claude-home/projects',
        'claude-home/todos',
        'claude-home/cache',
        'claude-home/shell-snapshots',
        'claude-home/.credentials.json',
        'claude-home/unknown-runtime-dir',
        'claude-home/plugins/cache',
      ]),
    );
    expect(selection.copiedTopLevelEntries).toEqual(
      expect.arrayContaining(['claude-home', 'profile.json', 'mcp.json', 'skills-provenance.json']),
    );
    expect(selection.copiedFiles).toBeGreaterThan(0);
    expect(selection.copiedDirs).toBeGreaterThan(0);
  });

  it('template selection excludes Auto Memory but keeps the memory/ category', async () => {
    const sourceRoot = await makeProfileRoot();
    const { stagingRoot } = await runSelection(sourceRoot, { includeAutoMemory: false });

    const staged = listTree(stagingRoot);
    expect(staged).not.toContain('claude-home/memory/auto/note-1.md');
    expect(staged).toContain('claude-home/memory/custom/note-2.md');
  });

  it.skipIf(!canCreateSymlink)(
    'refuses a config file that is a symlink before reading its target',
    async () => {
      const sourceRoot = await makeProfileRoot();
      const externalDir = await mkdtemp(path.join(tmpdir(), 'ccps-resource-sentinel-'));
      tempRoots.push(externalDir);
      const sentinel = path.join(externalDir, 'settings-sentinel.json');
      await fs.writeFile(sentinel, '{"env":{"ANTHROPIC_API_KEY":"sk-ant-outside"}}');
      await fs.remove(path.join(sourceRoot, 'claude-home', 'settings.json'));
      await fs.symlink(sentinel, path.join(sourceRoot, 'claude-home', 'settings.json'));

      const stagingRoot = await mkdtemp(path.join(tmpdir(), 'ccps-resource-staging-'));
      tempRoots.push(stagingRoot);
      const selection = await selectResourcesIntoStaging({
        sourceProfileRoot: sourceRoot,
        stagingProfileRoot: stagingRoot,
        includeAutoMemory: true,
      });

      expect(selection.failures[0]).toMatchObject({
        relativePath: 'claude-home/settings.json',
        code: 'RESOURCE_CONFIG_LINK_FORBIDDEN',
      });
      // the external sentinel was not read into staging nor modified
      expect(listTree(stagingRoot)).not.toContain('claude-home/settings.json');
      expect(await fs.readFile(sentinel, 'utf8')).toContain('sk-ant-outside');
    },
  );

  it.skipIf(!canCreateSymlink)(
    'refuses when an ancestor directory of config files is a symlink',
    async () => {
      const sourceRoot = await makeProfileRoot();
      const external = await mkdtemp(path.join(tmpdir(), 'ccps-resource-external-'));
      tempRoots.push(external);
      await fs.outputFile(
        path.join(external, 'settings.json'),
        '{"env":{"ANTHROPIC_API_KEY":"sk-ant-outside"}}',
      );
      await fs.remove(path.join(sourceRoot, 'claude-home'));
      await fs.symlink(external, path.join(sourceRoot, 'claude-home'), 'dir');

      const stagingRoot = await mkdtemp(path.join(tmpdir(), 'ccps-resource-staging-'));
      tempRoots.push(stagingRoot);
      const selection = await selectResourcesIntoStaging({
        sourceProfileRoot: sourceRoot,
        stagingProfileRoot: stagingRoot,
        includeAutoMemory: true,
      });

      expect(selection.failures[0]).toMatchObject({
        relativePath: 'claude-home',
        code: 'RESOURCE_LINK_FORBIDDEN',
      });
      expect(await fs.readFile(path.join(external, 'settings.json'), 'utf8')).toContain(
        'sk-ant-outside',
      );
    },
  );

  it.skipIf(!canCreateSymlink)('refuses when the profile root itself is a symlink', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'ccps-resource-base-'));
    tempRoots.push(base);
    const realRoot = path.join(base, 'real-profile');
    await fs.outputFile(path.join(realRoot, 'profile.json'), '{}');
    const linkRoot = path.join(base, 'linked-profile');
    await fs.symlink(realRoot, linkRoot, 'dir');

    const stagingRoot = await mkdtemp(path.join(tmpdir(), 'ccps-resource-staging-'));
    tempRoots.push(stagingRoot);
    await expect(
      selectResourcesIntoStaging({
        sourceProfileRoot: linkRoot,
        stagingProfileRoot: stagingRoot,
        includeAutoMemory: true,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LINK_FORBIDDEN' });
  });

  it.skipIf(!canCreateSymlink)(
    'export mode refuses a Linked Skill link and prompts for a Copied Skill',
    async () => {
      const sourceRoot = await makeProfileRoot();
      const linkTarget = await mkdtemp(path.join(tmpdir(), 'ccps-skill-src-'));
      tempRoots.push(linkTarget);
      await fs.writeFile(path.join(linkTarget, 'SKILL.md'), '# linked skill', 'utf8');
      await fs.symlink(
        linkTarget,
        path.join(sourceRoot, 'claude-home', 'skills', 'linked-skill'),
        'dir',
      );

      const stagingRoot = await mkdtemp(path.join(tmpdir(), 'ccps-resource-staging-'));
      tempRoots.push(stagingRoot);
      const selection = await selectResourcesIntoStaging({
        sourceProfileRoot: sourceRoot,
        stagingProfileRoot: stagingRoot,
        includeAutoMemory: true,
      });

      expect(selection.failures[0]).toMatchObject({
        relativePath: 'claude-home/skills/linked-skill',
        code: 'RESOURCE_LINK_FORBIDDEN',
      });
      expect(selection.failures[0]?.guidance).toContain('Copied Skill');
      // the external source directory was never materialized into staging
      expect(listTree(stagingRoot)).not.toContain('claude-home/skills/linked-skill/SKILL.md');
      expect(await fs.readFile(path.join(linkTarget, 'SKILL.md'), 'utf8')).toBe('# linked skill');
    },
  );

  it.skipIf(!canCreateSymlink)(
    'template mode records a direct Linked Skill reference and never copies its source',
    async () => {
      const sourceRoot = await makeProfileRoot();
      const linkTarget = await mkdtemp(path.join(tmpdir(), 'ccps-skill-src-'));
      tempRoots.push(linkTarget);
      await fs.writeFile(path.join(linkTarget, 'SKILL.md'), '# linked skill', 'utf8');
      await fs.symlink(
        linkTarget,
        path.join(sourceRoot, 'claude-home', 'skills', 'linked-skill'),
        'dir',
      );

      const stagingRoot = await mkdtemp(path.join(tmpdir(), 'ccps-resource-staging-'));
      tempRoots.push(stagingRoot);
      const selection = await selectResourcesIntoStaging({
        sourceProfileRoot: sourceRoot,
        stagingProfileRoot: stagingRoot,
        includeAutoMemory: true,
        keepLinkedSkillReferences: true,
      });

      expect(selection.failures).toEqual([]);
      expect(selection.skipped).toContain('claude-home/skills/linked-skill');
      const staged = listTree(stagingRoot);
      // link itself is not re-created by selection and the source is not copied
      expect(staged).not.toContain('claude-home/skills/linked-skill/SKILL.md');
      expect(staged).toContain('claude-home/skills/pdf.md');
    },
  );

  it.skipIf(!canCreateSymlink)(
    'template mode still refuses a symlink nested inside a skill entry (direct children only)',
    async () => {
      const sourceRoot = await makeProfileRoot();
      const linkTarget = await mkdtemp(path.join(tmpdir(), 'ccps-skill-src-'));
      tempRoots.push(linkTarget);
      await fs.outputFile(
        path.join(sourceRoot, 'claude-home', 'skills', 'copied-skill', 'inner.md'),
        'x',
      );
      await fs.symlink(
        linkTarget,
        path.join(sourceRoot, 'claude-home', 'skills', 'copied-skill', 'deep'),
        'dir',
      );

      const stagingRoot = await mkdtemp(path.join(tmpdir(), 'ccps-resource-staging-'));
      tempRoots.push(stagingRoot);
      const selection = await selectResourcesIntoStaging({
        sourceProfileRoot: sourceRoot,
        stagingProfileRoot: stagingRoot,
        includeAutoMemory: true,
        keepLinkedSkillReferences: true,
      });

      // a link that is not itself a direct skills/ entry cannot keep its
      // Linked semantics in a template — refuse rather than drop it silently
      expect(selection.failures[0]).toMatchObject({
        relativePath: 'claude-home/skills/copied-skill/deep',
        code: 'RESOURCE_LINK_FORBIDDEN',
      });
    },
  );

  it('sweep removes runtime and unknown entries a legacy bundle may carry', async () => {
    const sourceRoot = await makeProfileRoot();
    // additional profile-root runtime/unknown artifacts an old exporter carried
    await fs.outputFile(path.join(sourceRoot, 'old-transaction-tmp', 'x'), 'x');
    await fs.outputFile(path.join(sourceRoot, 'backups', 'b.tar.gz'), 'x');

    const removed = await sweepRuntimeEntriesFromStagedProfile(sourceRoot);

    // runtime + unknown claude-home entries removed, including plugin cache
    expect(removed).toEqual(
      expect.arrayContaining([
        'claude-home/sessions',
        'claude-home/history',
        'claude-home/projects',
        'claude-home/todos',
        'claude-home/cache',
        'claude-home/shell-snapshots',
        'claude-home/.credentials.json',
        'claude-home/unknown-runtime-dir',
        'claude-home/plugins/cache',
        'old-transaction-tmp',
        'backups',
      ]),
    );
    // supported resources preserved (Auto Memory included — v1 exports kept it)
    expect(listTree(sourceRoot)).toEqual(
      expect.arrayContaining([
        'profile.json',
        'mcp.json',
        'skills-provenance.json',
        'claude-home/settings.json',
        'claude-home/CLAUDE.md',
        'claude-home/.claude.json',
        'claude-home/memory/auto/note-1.md',
        'claude-home/skills/pdf.md',
        'claude-home/plugins/p/config.json',
      ]),
    );
  });
});
