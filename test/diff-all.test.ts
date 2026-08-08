import fs from 'fs-extra';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { applySkillTransaction, stageSkillTree } from '../src/core/skills-transaction';
import type { CaptureProcess } from '../src/platform/process';
import type { SkillSource } from '../src/schemas/skills-provenance';
import { CREDENTIAL_PATTERNS } from './fixtures/credentials';
import {
  buildMcpInventory,
  DIFF_CATEGORIES,
  diffCopiedSkills,
  diffResources,
} from '../src/core/resource/diff-all';

describe('diff-all shell orchestrator', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  async function makeAppHome(): Promise<string> {
    const root = await makeTempRoot('ccps-diff-all-');
    const appHome = path.join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    return appHome;
  }

  async function makeProfile(appHome: string, name = 'coding'): Promise<string> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    const { profilesPath } = getAppHomePaths(appHome);
    return path.join(profilesPath, name);
  }

  async function makeSkillTree(
    root: string,
    name: string,
    extra: Record<string, string> = {},
  ): Promise<string> {
    const dir = path.join(root, name);
    await fs.ensureDir(dir);
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: A ${name} skill.\n---\n# ${name}\n`,
      'utf8',
    );
    for (const [rel, content] of Object.entries(extra)) {
      await fs.writeFile(path.join(dir, rel), content, 'utf8');
    }
    return dir;
  }

  async function installCopy(
    appHome: string,
    profileRoot: string,
    profileName: string,
    name: string,
    sourceTree: string,
    source: SkillSource,
  ): Promise<void> {
    const { stagedPath } = await stageSkillTree({
      appHomePath: appHome,
      localSourcePath: sourceTree,
    });
    await applySkillTransaction({
      profileRootPath: profileRoot,
      profileName,
      name,
      mode: 'copy',
      stagedPath,
      source,
      clock: () => new Date('2026-08-01T09:00:00.000Z'),
    });
  }

  function localSource(sourcePath: string, repoRoot: string, skillPathInRepo: string): SkillSource {
    return {
      kind: 'local',
      path: sourcePath,
      repo: { root: repoRoot, skillPathInRepo, remoteUrl: 'https://example.com/repo.git', ref: 'main' },
    };
  }

  /** Write a profile's `.claude.json` mcpServers map directly (test fixture). */
  async function writeClaudeJson(
    profileRoot: string,
    servers: Record<string, { type?: string; command?: string; url?: string; env?: Record<string, string> }>,
  ): Promise<void> {
    const claudeJson = path.join(profileRoot, 'claude-home', '.claude.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = (await fs.readJson(claudeJson)) as Record<string, unknown>;
    } catch {
      // file absent — start empty
    }
    existing.mcpServers = servers;
    await fs.writeJson(claudeJson, existing);
  }

  describe('diffResources routing', () => {
    it('routes user-memory to a unified line diff', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.writeFile(path.join(coding, 'claude-home', 'CLAUDE.md'), '# A\nx\n', 'utf8');
      await fs.writeFile(path.join(study, 'claude-home', 'CLAUDE.md'), '# A\ny\n', 'utf8');

      const result = await diffResources(appHome, 'coding', 'study', 'user-memory');
      expect(result.category).toBe('user-memory');
      if (result.category !== 'user-memory') return;
      expect(result.diff.profileA).toBe('coding');
      expect(result.diff.profileB).toBe('study');
      expect(result.diff.lines.some((l) => l.type === 'del')).toBe(true);
      expect(result.diff.lines.some((l) => l.type === 'add')).toBe(true);
    });

    it('routes agents to a per-file layer', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.ensureDir(path.join(coding, 'claude-home', 'agents'));
      await fs.ensureDir(path.join(study, 'claude-home', 'agents'));
      await fs.writeFile(path.join(coding, 'claude-home', 'agents', 'explore.md'), '---\nname: explore\n---\n', 'utf8');

      const result = await diffResources(appHome, 'coding', 'study', 'agents');
      expect(result.category).toBe('agents');
      if (result.category !== 'agents') return;
      expect(result.diff.removedCount).toBe(1);
      expect(result.diff.files[0]?.verdict).toBe('removed');
    });

    it('routes settings to a redacted key table (values never carried)', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.writeJson(path.join(coding, 'claude-home', 'settings.json'), {
        model: 'sonnet',
        env: { ANTHROPIC_API_KEY: 'sk-ant-secret-a' },
      });
      await fs.writeJson(path.join(study, 'claude-home', 'settings.json'), {
        model: 'opus',
        env: { ANTHROPIC_API_KEY: 'sk-ant-secret-b' },
      });

      const result = await diffResources(appHome, 'coding', 'study', 'settings');
      expect(result.category).toBe('settings');
      if (result.category !== 'settings') return;
      expect(result.diff).toContainEqual({ key: 'model', verdict: 'changed' });
      expect(result.diff).toContainEqual({ key: 'env.ANTHROPIC_API_KEY', verdict: 'changed' });
      for (const entry of result.diff) {
        expect(Object.keys(entry)).toEqual(['key', 'verdict']);
      }
      // No serialization of the result may leak a secret value.
      expect(JSON.stringify(result)).not.toContain('sk-ant-secret-a');
      expect(JSON.stringify(result)).not.toContain('sk-ant-secret-b');
    });

    it('routes launch-config to a key table with values and sensitive flags', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.writeJson(path.join(coding, 'profile.json'), {
        name: 'coding',
        launch: { mcpMode: 'none', skipPermissions: false },
      });
      await fs.writeJson(path.join(study, 'profile.json'), {
        name: 'study',
        launch: { mcpMode: 'none', skipPermissions: true },
      });

      const result = await diffResources(appHome, 'coding', 'study', 'launch-config');
      expect(result.category).toBe('launch-config');
      if (result.category !== 'launch-config') return;
      const skipRow = result.diff.find((e) => e.key === 'skipPermissions');
      expect(skipRow).toMatchObject({ verdict: 'changed', sensitive: true });
      expect(skipRow?.valueA).toBe(false);
      expect(skipRow?.valueB).toBe(true);
    });

    it('routes mcp to a per-profile inventory (config values never present)', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await writeClaudeJson(coding, {
        shared: { type: 'stdio', command: 'node', env: { API_KEY: 'secret-a' } },
        onlyA: { type: 'http', url: 'https://a.example.com' },
      });
      await writeClaudeJson(study, {
        shared: { type: 'stdio', command: 'node' },
        onlyB: { type: 'sse', url: 'https://b.example.com' },
      });
      const capture: CaptureProcess = async () => ({
        exitCode: 0,
        stdout: 'shared connected\nonlyA connected\nonlyB connected\n',
        stderr: '',
        timedOut: false,
      });

      const result = await diffResources(appHome, 'coding', 'study', 'mcp', { captureProcess: capture });
      expect(result.category).toBe('mcp');
      if (result.category !== 'mcp') return;

      const byName = new Map(result.diff.rows.map((r) => [r.name, r]));
      const shared = byName.get('shared');
      expect(shared).toMatchObject({ inA: true, inB: true, transportA: 'stdio', transportB: 'stdio' });
      expect(shared?.connectionA).toBe('connected');
      const onlyA = byName.get('onlyA');
      expect(onlyA).toMatchObject({ inA: true, inB: false, transportA: 'http', transportB: null });
      const onlyB = byName.get('onlyB');
      expect(onlyB).toMatchObject({ inA: false, inB: true, transportB: 'sse' });
      // No config value (command/url/env) appears in the diff surface.
      expect(JSON.stringify(result)).not.toContain('secret-a');
      expect(JSON.stringify(result)).not.toContain('node');
    });

    it('routes skills to per-profile hash-tree diffs vs own source', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      const root = await makeTempRoot('ccps-diff-all-skill-');
      const repoA = path.join(root, 'repo-a');
      const repoB = path.join(root, 'repo-b');
      const sourceA = await makeSkillTree(repoA, 'shared', { 'a.txt': 'a\n' });
      const sourceB = await makeSkillTree(repoB, 'shared', { 'b.txt': 'b\n' });
      await installCopy(appHome, coding, 'coding', 'shared', sourceA, localSource(sourceA, repoA, 'shared'));
      await installCopy(appHome, study, 'study', 'shared', sourceB, localSource(sourceB, repoB, 'shared'));
      await fs.writeFile(path.join(sourceA, 'a.txt'), 'a2\n', 'utf8');
      await fs.writeFile(path.join(sourceB, 'b.txt'), 'b2\n', 'utf8');

      const result = await diffResources(appHome, 'coding', 'study', 'skills');
      expect(result.category).toBe('skills');
      if (result.category !== 'skills') return;

      expect(result.diff.skills).toHaveLength(1);
      const row = result.diff.skills[0]!;
      expect(row).toMatchObject({ name: 'shared', inA: true, inB: true });
      // Each Profile's row reflects only its own source.
      expect(row.aVsSource?.entries.map((e) => e.relPath)).toContain('a.txt');
      expect(row.aVsSource?.entries.some((e) => e.relPath === 'b.txt')).toBe(false);
      expect(row.bVsSource?.entries.map((e) => e.relPath)).toContain('b.txt');
      expect(row.bVsSource?.entries.some((e) => e.relPath === 'a.txt')).toBe(false);
    });
  });

  describe('buildMcpInventory', () => {
    it('merges only-in-one and in-both servers with per-profile cells', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await writeClaudeJson(coding, { shared: { type: 'stdio', command: 'node' } });
      await writeClaudeJson(study, { shared: { type: 'stdio', command: 'node' }, extra: { type: 'sse', url: 'https://x' } });
      const capture: CaptureProcess = async () => ({
        exitCode: 0,
        stdout: 'shared connected\nextra failed\n',
        stderr: '',
        timedOut: false,
      });

      const diff = await buildMcpInventory(appHome, 'coding', 'study', { captureProcess: capture });
      expect(diff.profileA).toBe('coding');
      expect(diff.rows).toHaveLength(2);
      const extra = diff.rows.find((r) => r.name === 'extra');
      expect(extra).toMatchObject({ inA: false, inB: true, connectionB: 'failed' });
    });
  });

  describe('diffCopiedSkills', () => {
    it('computes a vs-source tree for a skill present in only one profile', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');
      const root = await makeTempRoot('ccps-diff-all-onlyone-');
      const source = await makeSkillTree(root, 'only-coding', { 'a.txt': 'a\n' });
      await installCopy(appHome, coding, 'coding', 'only-coding', source, localSource(source, root, 'only-coding'));
      // The source advances after install — drift vs own source is visible.
      await fs.writeFile(path.join(source, 'a.txt'), 'a2\n', 'utf8');

      const diff = await diffCopiedSkills(appHome, 'coding', 'study');
      const row = diff.skills.find((s) => s.name === 'only-coding');
      expect(row).toMatchObject({ inA: true, inB: false, aDisabledReason: null });
      expect(row?.aVsSource).not.toBeNull();
      expect(row?.aVsSource?.entries.some((e) => e.relPath === 'a.txt')).toBe(true);
    });

    it('reports a disabled reason for a backfilled unknown-source skill', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      await makeProfile(appHome, 'study');
      // A pre-manifest skill directory with no provenance record: inspectSkills
      // backfills an `unknown`-kind record lazily.
      const skillsDir = path.join(coding, 'claude-home', 'skills', 'legacy');
      await fs.ensureDir(skillsDir);
      await fs.writeFile(path.join(skillsDir, 'SKILL.md'), '# legacy\n', 'utf8');

      const diff = await diffCopiedSkills(appHome, 'coding', 'study');
      const row = diff.skills.find((s) => s.name === 'legacy');
      expect(row).toMatchObject({ inA: true, inB: false, aDisabledReason: 'no-source', aVsSource: null });
    });

    it('keeps identical-ish results stable when a source is missing', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      const root = await makeTempRoot('ccps-diff-all-missing-');
      const source = await makeSkillTree(root, 'gone');
      await installCopy(appHome, coding, 'coding', 'gone', source, localSource(source, root, 'gone'));
      await installCopy(appHome, study, 'study', 'gone', source, localSource(source, root, 'gone'));
      await fs.remove(source);

      const diff = await diffCopiedSkills(appHome, 'coding', 'study');
      const row = diff.skills.find((s) => s.name === 'gone');
      expect(row).toMatchObject({ inA: true, inB: true });
      expect(row?.aVsSource?.sourceMissing).toBe(true);
      expect(row?.bVsSource?.sourceMissing).toBe(true);
    });

    it('records an error reason when a remote re-acquisition fails (shell survives)', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      const root = await makeTempRoot('ccps-diff-all-remerr-');
      const sourceTree = await makeSkillTree(root, 'find-skills');
      const remote = { kind: 'git-remote' as const, url: 'vercel-labs/skills', skillPath: 'skills/find-skills' };
      await installCopy(appHome, coding, 'coding', 'find-skills', sourceTree, remote);
      await installCopy(appHome, study, 'study', 'find-skills', sourceTree, remote);
      const failing: CaptureProcess = async () => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false });

      const diff = await diffCopiedSkills(appHome, 'coding', 'study', { captureProcess: failing });
      const row = diff.skills.find((s) => s.name === 'find-skills');
      expect(row).toMatchObject({ inA: true, inB: true });
      // The per-Skill failure degrades to a reason instead of killing the shell.
      expect(row?.aVsSource).toBeNull();
      expect(row?.aDisabledReason).toBe('error');
      expect(row?.bDisabledReason).toBe('error');
    });

    it('declares the diffable resource categories', () => {
      // The single Diff entry point is pairwise — no N-way matrix (AC#1).
      expect(DIFF_CATEGORIES).toEqual([
        'user-memory',
        'agents',
        'settings',
        'mcp',
        'skills',
        'launch-config',
      ]);
    });
  });

  describe('redaction across the diff surface (AC#3)', () => {
    it('never leaks credential-shaped values from settings (key names only)', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      // Inject the real credential shapes the insulation scan detects.
      await fs.writeJson(path.join(coding, 'claude-home', 'settings.json'), {
        model: 'sonnet',
        env: {
          ANTHROPIC_API_KEY: `sk-ant-api03-${'A'.repeat(36)}`,
          GITHUB_TOKEN: `ghp_${'B'.repeat(36)}`,
        },
      });
      await fs.writeJson(path.join(study, 'claude-home', 'settings.json'), {
        model: 'opus',
        env: {
          ANTHROPIC_API_KEY: `sk-ant-api03-${'C'.repeat(36)}`,
          GITHUB_TOKEN: `ghp_${'D'.repeat(36)}`,
          AWS_ACCESS_KEY_ID: `AKIA${'E'.repeat(16)}`,
        },
      });

      const result = await diffResources(appHome, 'coding', 'study', 'settings');
      const serialized = JSON.stringify(result);

      // The surface carries key names + verdicts only — never values.
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(pattern.test(serialized), `leaked a ${pattern} credential shape`).toBe(false);
      }
      // The key NAMES are present (the redaction contract shows names, never values).
      expect(serialized).toContain('env.ANTHROPIC_API_KEY');
      expect(serialized).toContain('env.GITHUB_TOKEN');
      expect(serialized).toContain('env.AWS_ACCESS_KEY_ID');
    });

    it('never leaks MCP env values (inventory rows carry no config)', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await writeClaudeJson(coding, {
        weather: { type: 'stdio', command: 'node', env: { API_KEY: `sk-ant-api03-${'F'.repeat(36)}` } },
      });
      await writeClaudeJson(study, {
        weather: { type: 'stdio', command: 'node' },
        remote: { type: 'http', url: 'https://example.com/sse' },
      });
      const capture: CaptureProcess = async () => ({
        exitCode: 0,
        stdout: 'weather connected\nremote connected\n',
        stderr: '',
        timedOut: false,
      });

      const result = await diffResources(appHome, 'coding', 'study', 'mcp', { captureProcess: capture });
      const serialized = JSON.stringify(result);
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(pattern.test(serialized), `leaked a ${pattern} credential shape via MCP`).toBe(false);
      }
      // Server names and transports ARE present; config values never are.
      expect(serialized).toContain('weather');
      expect(serialized).toContain('stdio');
    });

    it('shows launch-config values because launch config is not secret-class', async () => {
      const appHome = await makeAppHome();
      const coding = await makeProfile(appHome, 'coding');
      const study = await makeProfile(appHome, 'study');
      await fs.writeJson(path.join(coding, 'profile.json'), {
        name: 'coding',
        launch: { mcpMode: 'none', skipPermissions: false },
      });
      await fs.writeJson(path.join(study, 'profile.json'), {
        name: 'study',
        launch: { mcpMode: 'none', skipPermissions: true },
      });

      const result = await diffResources(appHome, 'coding', 'study', 'launch-config');
      // Values are carried by design (§12); the sensitive field is flagged.
      expect(JSON.stringify(result)).toContain('false');
      expect(JSON.stringify(result)).toContain('true');
    });
  });
});
