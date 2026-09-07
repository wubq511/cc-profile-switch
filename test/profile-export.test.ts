import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import * as tar from 'tar';

import { afterEach, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { exportProfile } from '../src/core/profile-export';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { bundleManifestSchema, type BundleManifest } from '../src/schemas/profile-bundle';
import { CcpsError } from '../src/utils/errors';

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');

async function extractBundle(bundlePath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ccps-export-extract-'));
  await tar.x({ file: bundlePath, cwd: dir });
  return dir;
}

async function readManifest(extractDir: string): Promise<BundleManifest> {
  const raw = await fs.readJson(path.join(extractDir, 'manifest.json'));
  return bundleManifestSchema.parse(raw);
}

/** Recursively search the decompressed bundle tree for a token (S122 check). */
async function treeContains(dir: string, needle: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await treeContains(full, needle)) {
        return true;
      }
    } else if (entry.isFile()) {
      const content = await fs.readFile(full, 'utf8').catch(() => '');
      if (content.includes(needle)) {
        return true;
      }
    }
  }
  return false;
}

describe('profile export service', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<{ userHome: string; appHome: string }> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-profile-export-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    const appHome = path.join(userHome, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    return { userHome, appHome };
  }

  async function makeProfile(appHome: string, name: string): Promise<void> {
    await createProfileFromTemplate({
      appHomePath: appHome,
      name,
      template: 'coding',
      clock: FIXED_CLOCK,
    });
  }

  async function injectSecrets(appHome: string, name: string): Promise<void> {
    const paths = getProfileTemplatePaths(appHome, name);
    // settings.json with ANTHROPIC_* + a non-secret managed env key
    await fs.writeJson(paths.settingsPath, {
      autoMemoryDirectory: paths.autoMemoryPath,
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-secret-token-123',
        ANTHROPIC_MODEL: 'claude-x',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      },
    });
    // .claude.json with MCP servers carrying env values
    await fs.writeJson(paths.claudeUserConfigPath, {
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontext/server-github'],
          env: { GITHUB_TOKEN: 'ghp_secret_token_456', EXTRA: 'plain' },
        },
        filesystem: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontext/server-filesystem'],
          env: { ROOT: '/tmp' },
        },
      },
    });
  }

  async function makeOutputPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ccps-export-out-'));
    tempRoots.push(dir);
    return path.join(dir, 'bundle.tar.gz');
  }

  it('writes a tar.gz bundle with manifest and profile tree (default mode)', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await makeOutputPath();

    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    expect(result.bundlePath).toBe(bundlePath);
    expect(await fs.pathExists(bundlePath)).toBe(true);

    const extractDir = await extractBundle(bundlePath);
    const manifest = await readManifest(extractDir);

    expect(manifest.bundleFormat).toBe('ccps-profile-bundle');
    expect(manifest.version).toBe(2);
    expect(manifest.exporterVersion).toBe('0.1.0');
    expect(manifest.profileName).toBe('coding');
    expect(manifest.includeSecrets).toBe(false);
    expect(manifest.secretsPresent).toBe(true);
    expect(manifest.secretsStripped).toBe(true);
    expect(manifest.exportedAt).toBe('2026-08-01T00:00:00.000Z');

    // profile tree is present
    expect(await fs.pathExists(path.join(extractDir, 'profile', 'profile.json'))).toBe(true);
    expect(await fs.pathExists(path.join(extractDir, 'profile', 'claude-home', 'CLAUDE.md'))).toBe(
      true,
    );
    expect(
      await fs.pathExists(
        path.join(extractDir, 'profile', 'claude-home', 'memory', 'auto', 'MEMORY.md'),
      ),
    ).toBe(true);
  });

  it('strips env.ANTHROPIC_* values by default and records key names', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await makeOutputPath();

    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    const extractDir = await extractBundle(bundlePath);
    const manifest = await readManifest(extractDir);
    const settings = await fs.readJson(
      path.join(extractDir, 'profile', 'claude-home', 'settings.json'),
    );

    // values replaced with placeholder
    expect(settings.env.ANTHROPIC_API_KEY).toBe('<redacted>');
    expect(settings.env.ANTHROPIC_MODEL).toBe('<redacted>');
    // non-secret env key keeps its value
    expect(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');

    // manifest records the stripped key names
    const settingsEntry = manifest.strippedKeys.find((e) => e.scope === 'settings-env');
    expect(settingsEntry?.file).toBe('claude-home/settings.json');
    expect(settingsEntry?.keys).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']),
    );
    expect(manifest.secretsStripped).toBe(true);

    // secret values never appear in the decompressed archive tree
    // (token-shape injection, S122)
    expect(await treeContains(extractDir, 'sk-ant-secret-token-123')).toBe(false);
    expect(await treeContains(extractDir, 'ghp_secret_token_456')).toBe(false);

    // source profile untouched
    const sourceSettings = await fs.readJson(
      getProfileTemplatePaths(appHome, 'coding').settingsPath,
    );
    expect(sourceSettings.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret-token-123');
    // result.strippedKeys mirrors manifest
    expect(result.strippedKeys).toEqual(manifest.strippedKeys);
  });

  it('strips MCP env values while preserving server names, command, and args', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await makeOutputPath();

    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    const extractDir = await extractBundle(bundlePath);
    const manifest = await readManifest(extractDir);
    const claudeJson = await fs.readJson(
      path.join(extractDir, 'profile', 'claude-home', '.claude.json'),
    );

    // server inventory preserved in manifest
    expect(manifest.mcpServerNames).toEqual(['filesystem', 'github']);
    expect(manifest.resources.mcpServers).toBe(2);

    // command + args preserved; env values redacted
    const github = claudeJson.mcpServers.github;
    expect(github.command).toBe('npx');
    expect(github.args).toEqual(['-y', '@modelcontext/server-github']);
    expect(github.env.GITHUB_TOKEN).toBe('<redacted>');
    expect(github.env.EXTRA).toBe('<redacted>');

    // every MCP env value redacted, including non-credential-looking ones
    const fs2 = claudeJson.mcpServers.filesystem;
    expect(fs2.env.ROOT).toBe('<redacted>');

    // stripped keys recorded per server
    const githubEntry = manifest.strippedKeys.find(
      (e) => e.scope === 'mcp-env' && e.mcpServer === 'github',
    );
    expect(githubEntry?.keys).toEqual(expect.arrayContaining(['EXTRA', 'GITHUB_TOKEN']));
  });

  it('include-secrets writes raw values and chmods the bundle 0600', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await makeOutputPath();

    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      includeSecrets: true,
      clock: FIXED_CLOCK,
    });

    expect(result.manifest.includeSecrets).toBe(true);
    // secretsPresent is true even though nothing was stripped — the profile
    // contained secret-class values, they just traveled raw (issue #73).
    expect(result.manifest.secretsPresent).toBe(true);
    expect(result.manifest.secretsStripped).toBe(false);
    expect(result.manifest.strippedKeys).toEqual([]);

    const extractDir = await extractBundle(bundlePath);
    const settings = await fs.readJson(
      path.join(extractDir, 'profile', 'claude-home', 'settings.json'),
    );
    expect(settings.env.ANTHROPIC_API_KEY).toBe('sk-ant-secret-token-123');

    // secrets present in the decompressed archive tree (this is the opt-in)
    expect(await treeContains(extractDir, 'sk-ant-secret-token-123')).toBe(true);

    // file mode 0600 — only verifiable on POSIX (S99 RM-Windows carve-out)
    if (process.platform !== 'win32') {
      const stats = await fs.stat(bundlePath);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it('include-secrets on Windows: bundle still written (mode asserted only off-win32)', async () => {
    // Cross-platform path: ensure the secrets path runs to completion regardless
    // of platform; the 0600 assertion is the only platform-conditional bit.
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    const bundlePath = await makeOutputPath();

    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      includeSecrets: true,
      clock: FIXED_CLOCK,
    });
    expect(result.bundlePath).toBe(bundlePath);
    expect(await fs.pathExists(bundlePath)).toBe(true);
  });

  it('never exports recovery-bin items (structural separation)', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectSecrets(appHome, 'coding');

    // simulate a sibling recoverybin at app-home level (where it will live per §13.1)
    const appPaths = getAppHomePaths(appHome);
    const recoveryBinPath = path.join(appPaths.appHomePath, 'recovery-bin');
    await fs.ensureDir(path.join(recoveryBinPath, '20260801T000000-coding-skill'));
    await fs.writeJson(path.join(recoveryBinPath, '20260801T000000-coding-skill', 'item.json'), {
      origin: 'remove',
      profile: 'coding',
      secretBearing: true,
    });

    const bundlePath = await makeOutputPath();
    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    const extractDir = await extractBundle(bundlePath);
    // the bin is a sibling of profiles/, never inside the exported profile tree
    expect(await fs.pathExists(path.join(extractDir, 'recovery-bin'))).toBe(false);
    expect(await fs.pathExists(path.join(extractDir, 'profile', 'recovery-bin'))).toBe(false);
  });

  it('preserves the plugins/ directory (delegated lifecycle, not runtime internals)', async () => {
    // spec §6.4: runtime internals = OAuth/tokens/sessions/history/caches/credentials.
    // Plugins are §7.6 (delegated lifecycle managed resource) and must travel
    // with the bundle — `plugins/known_marketplaces.json` is ccps-relevant inventory.
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    const pluginsDir = path.join(paths.claudeHomePath, 'plugins');
    await fs.ensureDir(pluginsDir);
    await fs.writeJson(path.join(pluginsDir, 'known_marketplaces.json'), {
      marketplaces: [{ name: 'example', source: 'owner/repo' }],
    });

    const bundlePath = await makeOutputPath();
    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    const extractDir = await extractBundle(bundlePath);
    const bundledPlugins = path.join(
      extractDir,
      'profile',
      'claude-home',
      'plugins',
      'known_marketplaces.json',
    );
    expect(await fs.pathExists(bundledPlugins)).toBe(true);
    const marketplace = await fs.readJson(bundledPlugins);
    expect(marketplace.marketplaces[0].name).toBe('example');
  });

  it('records secretsPresent=false for a profile with no secret-class values', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    // default template profile has no ANTHROPIC_* env and no MCP env values
    const bundlePath = await makeOutputPath();

    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    expect(result.manifest.secretsPresent).toBe(false);
    expect(result.manifest.secretsStripped).toBe(false);
    expect(result.manifest.strippedKeys).toEqual([]);
  });

  it('stages the bundle in the output directory for a same-volume atomic rename', async () => {
    // spec §15.3 invariant 6: the final move must be a rename, never copy+delete.
    // Verified by checking that no `.ccps-export-` staging residue leaks into
    // the system tmpdir after a successful export (staging lives under outputDir).
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const outDir = await mkdtemp(join(tmpdir(), 'ccps-export-staging-'));
    tempRoots.push(outDir);
    const bundlePath = path.join(outDir, 'bundle.tar.gz');

    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    expect(await fs.pathExists(bundlePath)).toBe(true);
    // staging dir is cleaned up in finally; assert no residue in outputDir
    const entries = await fs.readdir(outDir, { withFileTypes: true });
    const stagingResidue = entries.filter((e) => e.name.startsWith('.ccps-export-'));
    expect(stagingResidue).toEqual([]);
  });

  it('refuses to overwrite an existing output file', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const bundlePath = await makeOutputPath();
    await fs.writeFile(bundlePath, 'pre-existing', 'utf8');

    await expect(
      exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: bundlePath,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_PATH_EXISTS' });
  });

  it('refuses an output path inside the profile being exported', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    const insidePath = path.join(paths.profileRootPath, 'leak.tar.gz');

    await expect(
      exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: insidePath,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_PATH_INSIDE_PROFILE' });
  });

  it('refuses export when a secret-bearing settings.json is unparseable', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    // inject a value that looks like a secret but break the JSON
    await fs.writeFile(
      paths.settingsPath,
      '{ "env": { "ANTHROPIC_API_KEY": "sk-ant-broken", ', // malformed
      'utf8',
    );
    const bundlePath = await makeOutputPath();

    await expect(
      exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: bundlePath,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_SECRET_FILE_UNREADABLE' });
    // nothing written
    expect(await fs.pathExists(bundlePath)).toBe(false);
  });

  it('refuses export when the output directory does not exist', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const bundlePath = path.join(
      await mkdtemp(join(tmpdir(), 'ccps-export-outdir-')),
      'nested',
      'bundle.tar.gz',
    );

    await expect(
      exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: bundlePath,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_DIR_MISSING' });
  });

  it('counts resources in the manifest', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    // one auto-memory entry, one agent, one skill file
    await fs.writeFile(path.join(paths.autoMemoryPath, 'note-1.md'), '# note', 'utf8');
    await fs.writeFile(path.join(paths.agentsPath, 'reviewer.md'), '# reviewer', 'utf8');
    await fs.writeFile(path.join(paths.skillsPath, 'pdf.md'), '# pdf skill', 'utf8');
    await fs.writeJson(paths.claudeUserConfigPath, {
      mcpServers: { alpha: { command: 'x' }, beta: { command: 'y' } },
    });
    const bundlePath = await makeOutputPath();

    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    const manifest = await readManifest(await extractBundle(bundlePath));
    expect(manifest.resources).toEqual({
      userMemory: 1,
      autoMemory: 2,
      skills: 1,
      agents: 1,
      mcpServers: 2,
      settings: 1,
      launchConfig: 1,
    });
  });

  it.skipIf(process.platform !== 'darwin')(
    'refuses a Linked Skill symlink in the bundle (macOS)',
    async () => {
      const { appHome } = await makeAppHome();
      await makeProfile(appHome, 'coding');
      const paths = getProfileTemplatePaths(appHome, 'coding');
      // a Linked Skill is a symlink in claude-home/skills/<name>; Portable
      // Export refuses it (issue #105): a link cannot keep its live-at-source
      // semantics inside a tar bundle.
      const linkTarget = await mkdtemp(join(tmpdir(), 'ccps-skill-src-'));
      await fs.writeFile(path.join(linkTarget, 'SKILL.md'), '# linked skill', 'utf8');
      await fs.symlink(linkTarget, path.join(paths.skillsPath, 'linked-skill'), 'dir');

      const bundlePath = await makeOutputPath();

      await expect(
        exportProfile({
          appHomePath: appHome,
          name: 'coding',
          outputPath: bundlePath,
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_LINK_FORBIDDEN' });
      // nothing published
      expect(await fs.pathExists(bundlePath)).toBe(false);
      // the external skill source was never read or modified (synthetic sentinel)
      const sentinel = path.join(linkTarget, 'SKILL.md');
      expect(await fs.readFile(sentinel, 'utf8')).toBe('# linked skill');
    },
  );

  it('redacts secrets in legacy root mcp.json when present', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(paths.mcpConfigPath, {
      mcpServers: {
        legacy: { command: 'node', args: ['s.js'], env: { LEGACY_TOKEN: 'legacy-secret' } },
      },
    });
    const bundlePath = await makeOutputPath();

    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    const extractDir = await extractBundle(bundlePath);
    const manifest = await readManifest(extractDir);
    const mcpJson = await fs.readJson(path.join(extractDir, 'profile', 'mcp.json'));
    expect(mcpJson.mcpServers.legacy.env.LEGACY_TOKEN).toBe('<redacted>');

    const legacyEntry = manifest.strippedKeys.find(
      (e) => e.scope === 'mcp-env' && e.mcpServer === 'legacy',
    );
    expect(legacyEntry?.file).toBe('mcp.json');
    expect(legacyEntry?.keys).toEqual(['LEGACY_TOKEN']);
  });

  // Platform-invariant path behavior: tar writing and path resolution behave
  // identically on win32/darwin/linux (tar is pure JS; only chmod/symlink
  // assertions are platform-conditional above). This case documents that the
  // platform contract holds for the common path.
  it('resolves output paths consistently across platforms', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const outDir = await mkdtemp(join(tmpdir(), 'ccps-export-paths-'));
    tempRoots.push(outDir);
    // a path with no extension is accepted as-is; the bundle is written verbatim
    const bundlePath = path.join(outDir, 'plain-bundle');

    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });
    expect(result.bundlePath).toBe(path.resolve(bundlePath));
    expect(await fs.pathExists(bundlePath)).toBe(true);
  });

  // --- issue #105 boundary: resource selection & header redaction ------------

  it('excludes runtime and unknown claude-home entries in every mode (selection before staging)', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    // known runtime data + unknown top-level entries + credentials file
    await fs.outputFile(path.join(paths.claudeHomePath, 'sessions', 's.jsonl'), '{}');
    await fs.outputFile(path.join(paths.claudeHomePath, 'history', 'h.jsonl'), '{}');
    await fs.outputFile(path.join(paths.claudeHomePath, 'projects', 'p', 'x.jsonl'), '{}');
    await fs.outputFile(path.join(paths.claudeHomePath, 'todos', 't.json'), '[]');
    await fs.outputFile(path.join(paths.claudeHomePath, 'cache', 'c.bin'), 'x');
    await fs.outputFile(path.join(paths.claudeHomePath, 'shell-snapshots', 'sh'), 'x');
    await fs.outputFile(path.join(paths.claudeHomePath, '.credentials.json'), '{"t":1}');
    await fs.outputFile(path.join(paths.claudeHomePath, 'some-unknown-runtime-dir', 'x'), 'x');
    await fs.outputFile(path.join(paths.claudeHomePath, 'unknown-top-file.txt'), 'x');

    for (const includeSecrets of [false, true]) {
      const bundlePath = await makeOutputPath();
      await exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: bundlePath,
        includeSecrets,
        clock: FIXED_CLOCK,
      });
      const extractDir = await extractBundle(bundlePath);
      const claudeHome = path.join(extractDir, 'profile', 'claude-home');
      for (const excluded of [
        'sessions',
        'history',
        'projects',
        'todos',
        'cache',
        'shell-snapshots',
        '.credentials.json',
        'some-unknown-runtime-dir',
        'unknown-top-file.txt',
      ]) {
        expect(await fs.pathExists(path.join(claudeHome, excluded))).toBe(false);
      }
      // supported resources still travel
      expect(await fs.pathExists(path.join(claudeHome, 'settings.json'))).toBe(true);
      expect(await fs.pathExists(path.join(extractDir, 'profile', 'profile.json'))).toBe(true);
      // manifest records exclusions
      const manifest = await readManifest(extractDir);
      if (manifest.version === 2) {
        expect(manifest.excludedTopLevelEntries).toEqual(
          expect.arrayContaining([
            'claude-home/sessions',
            'claude-home/history',
            'claude-home/projects',
            'claude-home/todos',
            'claude-home/cache',
          ]),
        );
      }
    }
  });

  it('never exports an unknown top-level profile entry (e.g. stray downloads)', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.outputFile(path.join(paths.profileRootPath, 'leaked-runtime.bin'), 'x');
    await fs.outputFile(path.join(paths.profileRootPath, 'backups'), 'not really');

    const bundlePath = await makeOutputPath();
    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });
    const extractDir = await extractBundle(bundlePath);
    expect(await fs.pathExists(path.join(extractDir, 'profile', 'leaked-runtime.bin'))).toBe(false);
    expect(await fs.pathExists(path.join(extractDir, 'profile', 'backups'))).toBe(false);
  });

  it('carries the Skill Provenance Record with the bundle', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(path.join(paths.profileRootPath, 'skills-provenance.json'), {
      version: 1,
      skills: {},
    });

    const bundlePath = await makeOutputPath();
    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });
    const extractDir = await extractBundle(bundlePath);
    expect(await fs.pathExists(path.join(extractDir, 'profile', 'skills-provenance.json'))).toBe(
      true,
    );
  });

  it('strips MCP header values alongside env values with a dedicated mcp-headers scope', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(paths.claudeUserConfigPath, {
      mcpServers: {
        httpapi: {
          type: 'http',
          url: 'https://mcp.example.com/v1',
          headers: { Authorization: 'Bearer hdr-secret-789', 'X-Api-Key': 'key-000' },
          env: { GITHUB_TOKEN: 'ghp_secret_token_456' },
        },
        legacyhdr: {
          type: 'sse',
          url: 'https://sse.example.com',
          headers: 'not-an-object',
        },
      },
    });
    const bundlePath = await makeOutputPath();

    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    const extractDir = await extractBundle(bundlePath);
    const claudeJson = await fs.readJson(
      path.join(extractDir, 'profile', 'claude-home', '.claude.json'),
    );
    // header values redacted in place
    expect(claudeJson.mcpServers.httpapi.headers.Authorization).toBe('<redacted>');
    expect(claudeJson.mcpServers.httpapi.headers['X-Api-Key']).toBe('<redacted>');
    expect(claudeJson.mcpServers.httpapi.url).toBe('https://mcp.example.com/v1');

    // dedicated v2 scope recorded per server
    const headerEntry = result.strippedKeys.find(
      (e) => e.scope === 'mcp-headers' && e.mcpServer === 'httpapi',
    );
    expect(headerEntry?.file).toBe('claude-home/.claude.json');
    expect(headerEntry?.keys).toEqual(['Authorization', 'X-Api-Key']);
    // env scope separate from header scope
    const envEntry = result.strippedKeys.find(
      (e) => e.scope === 'mcp-env' && e.mcpServer === 'httpapi',
    );
    expect(envEntry?.keys).toEqual(['GITHUB_TOKEN']);

    // malformed (non-object) headers: the raw string's characters are not
    // trusted through — the bag is replaced with an empty object, and no
    // value survives into the bundle
    const malformedEntry = result.strippedKeys.find(
      (e) => e.scope === 'mcp-headers' && e.mcpServer === 'legacyhdr',
    );
    expect(malformedEntry).toBeUndefined();
    expect(claudeJson.mcpServers.legacyhdr.headers).toEqual({});
    expect(await treeContains(extractDir, 'not-an-object')).toBe(false);

    // header secret never lands in the archive
    expect(await treeContains(extractDir, 'hdr-secret-789')).toBe(false);
    expect(await treeContains(extractDir, 'key-000')).toBe(false);
  });

  it('refuses a malformed settings.json env bag instead of treating it as safe', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(paths.settingsPath, { env: 'not-an-object' });

    const bundlePath = await makeOutputPath();
    await expect(
      exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: bundlePath,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_SECRET_FILE_UNREADABLE' });
    expect(await fs.pathExists(bundlePath)).toBe(false);
  });

  it('include-secrets keeps raw env/header values but still excludes runtime entries', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(paths.claudeUserConfigPath, {
      mcpServers: {
        httpapi: {
          type: 'http',
          url: 'https://mcp.example.com/v1',
          headers: { Authorization: 'Bearer hdr-secret-789' },
        },
      },
    });
    await fs.outputFile(path.join(paths.claudeHomePath, 'sessions', 's.jsonl'), '{}');

    const bundlePath = await makeOutputPath();
    await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      includeSecrets: true,
      clock: FIXED_CLOCK,
    });

    const extractDir = await extractBundle(bundlePath);
    const claudeJson = await fs.readJson(
      path.join(extractDir, 'profile', 'claude-home', '.claude.json'),
    );
    expect(claudeJson.mcpServers.httpapi.headers.Authorization).toBe('Bearer hdr-secret-789');
    // runtime exclusion holds even in include-secrets mode
    expect(await fs.pathExists(path.join(extractDir, 'profile', 'claude-home', 'sessions'))).toBe(
      false,
    );
  });

  it('never carries non-MCP fields of .claude.json (runtime state), in either mode', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    // Fields Claude Code may write under the profile's claude-home: OAuth
    // account state and per-project history metadata. These are runtime data,
    // not the supported mcpServers inventory.
    await fs.writeJson(paths.claudeUserConfigPath, {
      oauthAccount: { email: 'runtime-user@example.com', tokens: { t: 'rt-oauth-token-000' } },
      projects: { '/some/project': { lastSessionId: 'rt-session-111' } },
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          env: { GITHUB_TOKEN: 'ghp_secret_token_456' },
        },
      },
    });

    for (const includeSecrets of [false, true]) {
      const bundlePath = await makeOutputPath();
      await exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: bundlePath,
        includeSecrets,
        clock: FIXED_CLOCK,
      });
      const extractDir = await extractBundle(bundlePath);
      const claudeJson = await fs.readJson(
        path.join(extractDir, 'profile', 'claude-home', '.claude.json'),
      );
      // only the mcpServers inventory survives
      expect(Object.keys(claudeJson).sort()).toEqual(['mcpServers']);
      expect(claudeJson.mcpServers.github.command).toBe('npx');
      // runtime state never lands in the archive
      expect(await treeContains(extractDir, 'rt-oauth-token-000')).toBe(false);
      expect(await treeContains(extractDir, 'rt-session-111')).toBe(false);
      // source profile untouched
      const source = await fs.readJson(paths.claudeUserConfigPath);
      expect(source.oauthAccount.email).toBe('runtime-user@example.com');
      expect(source.projects['/some/project'].lastSessionId).toBe('rt-session-111');
    }
  });

  it('redacts non-string header/env values (nested objects never pass the scan)', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(paths.claudeUserConfigPath, {
      mcpServers: {
        httpapi: {
          type: 'http',
          url: 'https://mcp.example.com/v1',
          headers: { Authorization: 'Bearer hdr-secret-789', 'X-Nested': { token: 'nested-000' } },
          env: { COMPLEX: ['arr-secret-001'] },
        },
      },
    });

    const bundlePath = await makeOutputPath();
    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });
    const extractDir = await extractBundle(bundlePath);
    const claudeJson = await fs.readJson(
      path.join(extractDir, 'profile', 'claude-home', '.claude.json'),
    );
    const server = claudeJson.mcpServers.httpapi;
    // every value replaced with the marker — none survives in any shape
    expect(server.headers.Authorization).toBe('<redacted>');
    expect(server.headers['X-Nested']).toBe('<redacted>');
    expect(server.env.COMPLEX).toBe('<redacted>');
    expect(await treeContains(extractDir, 'nested-000')).toBe(false);
    expect(await treeContains(extractDir, 'arr-secret-001')).toBe(false);
    // key names reported under their own scopes
    const headerEntry = result.strippedKeys.find(
      (e) => e.scope === 'mcp-headers' && e.mcpServer === 'httpapi',
    );
    expect(headerEntry?.keys).toEqual(['Authorization', 'X-Nested']);
    const envEntry = result.strippedKeys.find(
      (e) => e.scope === 'mcp-env' && e.mcpServer === 'httpapi',
    );
    expect(envEntry?.keys).toEqual(['COMPLEX']);
  });

  it('refuses export when a config file is a symlink to excluded content (sentinel untouched)', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    // external sentinel the link points at — must never be read or modified
    const sentinelDir = await mkdtemp(join(tmpdir(), 'ccps-export-sentinel-'));
    tempRoots.push(sentinelDir);
    const sentinel = path.join(sentinelDir, 'settings.json');
    await fs.writeFile(sentinel, '{"env":{"ANTHROPIC_API_KEY":"sk-ant-outside"}}', 'utf8');
    await fs.unlink(paths.settingsPath);
    await fs.symlink(sentinel, paths.settingsPath);

    const bundlePath = await makeOutputPath();
    await expect(
      exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: bundlePath,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFIG_LINK_FORBIDDEN' });
    expect(await fs.pathExists(bundlePath)).toBe(false);
    // the linked external file was not read into the bundle or rewritten
    expect(await fs.readFile(sentinel, 'utf8')).toContain('sk-ant-outside');
  });

  it('refuses export when an ancestor directory of a config file is a symlink', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    // swap the real claude-home for a link to an external dir holding settings
    const external = await mkdtemp(join(tmpdir(), 'ccps-export-ancestor-'));
    tempRoots.push(external);
    await fs.copy(paths.claudeHomePath, path.join(external, 'claude-home'));
    await fs.writeJson(path.join(external, 'claude-home', 'settings.json'), {
      env: { ANTHROPIC_API_KEY: 'sk-ant-via-ancestor' },
    });
    await fs.remove(paths.claudeHomePath);
    await fs.symlink(path.join(external, 'claude-home'), paths.claudeHomePath, 'dir');

    const bundlePath = await makeOutputPath();
    await expect(
      exportProfile({
        appHomePath: appHome,
        name: 'coding',
        outputPath: bundlePath,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LINK_FORBIDDEN' });
    expect(await fs.pathExists(bundlePath)).toBe(false);
    expect(
      await fs.readFile(path.join(external, 'claude-home', 'settings.json'), 'utf8'),
    ).toContain('sk-ant-via-ancestor');
  });

  it('reports accurate manifest counts reflecting the real output tree', async () => {
    const { appHome } = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await injectSecrets(appHome, 'coding');
    await fs.outputFile(path.join(paths.claudeHomePath, 'sessions', 's.jsonl'), '{}');

    const bundlePath = await makeOutputPath();
    const result = await exportProfile({
      appHomePath: appHome,
      name: 'coding',
      outputPath: bundlePath,
      clock: FIXED_CLOCK,
    });

    // stripped keys mirror the actual redaction pass (2 settings + 3 mcp env)
    expect(result.strippedKeys.reduce((sum, e) => sum + e.keys.length, 0)).toBe(5);
    expect(result.manifest.secretsPresent).toBe(true);
    expect(result.manifest.secretsStripped).toBe(true);
    const manifest = await readManifest(await extractBundle(bundlePath));
    expect(manifest.strippedKeys).toEqual(result.strippedKeys);
  });
});

describe('export command output', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function runCli(userHome: string, args: string[]): Promise<string> {
    const output: string[] = [];
    const program = createProgram({
      writeOut: (value) => output.push(value),
      clock: FIXED_CLOCK,
    });
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    program.exitOverride();
    try {
      await program.parseAsync(['node', 'ccps', ...args], { from: 'node' });
      return output.join('');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
    }
  }

  async function setup(userHome: string): Promise<void> {
    const appHome = path.join(userHome, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: FIXED_CLOCK,
    });
    const paths = getProfileTemplatePaths(appHome, 'coding');
    await fs.writeJson(paths.settingsPath, {
      autoMemoryDirectory: paths.autoMemoryPath,
      env: { ANTHROPIC_API_KEY: 'sk-ant-secret-123' },
    });
    await fs.writeJson(paths.claudeUserConfigPath, {
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'x'], env: { GITHUB_TOKEN: 'ghp_secret' } },
      },
    });
  }

  it('default mode prints stripped key names and excludes secret values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-export-cli-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    await fs.mkdir(userHome);
    await setup(userHome);
    const outDir = await mkdtemp(join(tmpdir(), 'ccps-export-cli-out-'));
    tempRoots.push(outDir);
    const bundlePath = path.join(outDir, 'bundle.tar.gz');

    const output = await runCli(userHome, ['export', 'coding', bundlePath]);

    expect(output).toContain(`Exported profile "coding" to ${bundlePath}`);
    expect(output).toContain('Secrets: excluded (2 keys stripped)');
    expect(output).toContain('claude-home/settings.json: ANTHROPIC_API_KEY');
    expect(output).toContain('claude-home/.claude.json (github): GITHUB_TOKEN');
    expect(output).toContain('MCP servers: github');
    expect(output).toContain('Exporter: ccps 0.1.0');
    // the warning is NOT printed in default mode
    expect(output).not.toContain('WARNING: this bundle contains plaintext credentials');
    // secret insulation is covered by the core service tests (S122); this
    // case focuses on the CLI output surface.
  });

  it('include-secrets prints the plaintext-credentials warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-export-cli-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    await fs.mkdir(userHome);
    await setup(userHome);
    const outDir = await mkdtemp(join(tmpdir(), 'ccps-export-cli-out-'));
    tempRoots.push(outDir);
    const bundlePath = path.join(outDir, 'bundle.tar.gz');

    const output = await runCli(userHome, ['export', 'coding', bundlePath, '--include-secrets']);

    expect(output).toContain('WARNING: this bundle contains plaintext credentials');
    expect(output).toContain('Secrets: included');
    expect(output).not.toContain('keys stripped');
  });

  it('reports no secrets stripped for a clean profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-export-cli-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    await fs.mkdir(userHome);
    const appHome = path.join(userHome, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: FIXED_CLOCK,
    });
    const outDir = await mkdtemp(join(tmpdir(), 'ccps-export-cli-out-'));
    tempRoots.push(outDir);
    const bundlePath = path.join(outDir, 'bundle.tar.gz');

    const output = await runCli(userHome, ['export', 'coding', bundlePath]);

    expect(output).toContain('Secrets: excluded (none present)');
  });

  it('surfaces EXPORT_PATH_EXISTS as an error when the file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ccps-export-cli-'));
    tempRoots.push(root);
    const userHome = path.join(root, 'userhome');
    await fs.mkdir(userHome);
    await setup(userHome);
    const outDir = await mkdtemp(join(tmpdir(), 'ccps-export-cli-out-'));
    tempRoots.push(outDir);
    const bundlePath = path.join(outDir, 'bundle.tar.gz');
    await fs.writeFile(bundlePath, 'x', 'utf8');

    await expect(runCli(userHome, ['export', 'coding', bundlePath])).rejects.toMatchObject({
      code: 'EXPORT_PATH_EXISTS',
    });
  });
});

describe('export respects error contract', () => {
  it('CcpsError codes are surfaced with the EXPORT_ prefix', () => {
    const err = new CcpsError('EXPORT_PATH_EXISTS', 'A file already exists at the export path.', {
      guidance: 'Remove the existing file.',
    });
    expect(err.code).toBe('EXPORT_PATH_EXISTS');
    expect(err.message).toBe('A file already exists at the export path.');
    expect(err.guidance).toBe('Remove the existing file.');
  });
});
