import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import {
  createProfileFromCustomTemplate,
  listCustomTemplates,
  previewSaveProfileAsTemplate,
  removeCustomTemplate,
  saveProfileAsTemplate,
} from '../src/core/custom-template';
import { getClaudeJsonPath } from '../src/core/mcp-servers';
import {
  createProfileFromTemplate,
  getProfileTemplatePaths,
} from '../src/core/profile-template';
import type { CaptureProcess } from '../src/platform/process';
import {
  customTemplateManifestSchema,
  type CustomTemplateManifest,
} from '../src/schemas/custom-template';

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');
// Fake credential-shaped fixtures (same convention as profile-export.test.ts),
// used only to assert redaction/insulation. Never a real secret.
const SECRET_TOKEN = 'sk-ant-secret-token-123';
const MCP_TOKEN = 'ghp_secret_token_456';
const LEGACY_TOKEN_VALUE = 'legacy-secret-value';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeAppHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ccps-custom-template-'));
  tempRoots.push(root);
  const appHome = path.join(root, '.cc-profile-switch');
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

async function injectSecrets(appHome: string, name: string): Promise<void> {
  const paths = getProfileTemplatePaths(appHome, name);
  await fs.writeJson(paths.settingsPath, {
    autoMemoryDirectory: paths.autoMemoryPath,
    claudeMdExcludes: [],
    env: {
      ANTHROPIC_API_KEY: SECRET_TOKEN,
      ANTHROPIC_MODEL: 'claude-x',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    },
  });
  await fs.writeJson(paths.claudeUserConfigPath, {
    hasCompletedOnboarding: true,
    oauthAccount: { email: 'user@example.com' },
    mcpServers: {
      github: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontext/server-github'],
        env: { GITHUB_TOKEN: MCP_TOKEN, EXTRA: 'plain' },
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

async function injectLegacyMcp(appHome: string, name: string): Promise<void> {
  const paths = getProfileTemplatePaths(appHome, name);
  await fs.writeJson(paths.mcpConfigPath, {
    mcpServers: {
      legacy: { command: 'node', args: ['s.js'], env: { LEGACY_TOKEN: LEGACY_TOKEN_VALUE } },
    },
  });
}

/** Runtime internals + Auto Memory + resources that must/must not travel. */
async function injectProfileFixture(appHome: string, name: string): Promise<void> {
  const paths = getProfileTemplatePaths(appHome, name);
  await injectSecrets(appHome, name);
  await injectLegacyMcp(appHome, name);
  // runtime internals (must never travel)
  await fs.outputFile(path.join(paths.claudeHomePath, 'sessions', 'abc.jsonl'), '{}', 'utf8');
  await fs.outputFile(path.join(paths.claudeHomePath, 'projects', 'proj', 'x.jsonl'), '{}', 'utf8');
  // auto memory entries (session-derived; excluded from templates)
  await fs.writeFile(path.join(paths.autoMemoryPath, 'note-1.md'), '# note', 'utf8');
  // captured resources
  await fs.writeFile(path.join(paths.skillsPath, 'pdf.md'), '# pdf skill', 'utf8');
  await fs.writeFile(path.join(paths.agentsPath, 'reviewer.md'), '# reviewer', 'utf8');
}

/** Recursively search a tree for a token (secret-insulation check). */
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

async function readTemplateManifest(
  appHome: string,
  templateName: string,
): Promise<CustomTemplateManifest> {
  const raw = await fs.readJson(
    path.join(appHome, 'templates', templateName, 'template.json'),
  );
  return customTemplateManifestSchema.parse(raw);
}

function templateProfilePath(appHome: string, templateName: string): string {
  return path.join(appHome, 'templates', templateName, 'profile');
}

// --- mock `claude mcp add` delegation (mirrors profile-import.test.ts) ---------

type RecordedCall = { args: string[]; claudeConfigDir: string };

function mockClaudeAdd(
  failOn?: (name: string) => boolean,
): { capture: CaptureProcess; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const capture: CaptureProcess = async (_command, args, options) => {
    const claudeConfigDir = options.env?.CLAUDE_CONFIG_DIR as string;
    calls.push({ args, claudeConfigDir });
    if (args[0] === 'mcp' && args[1] === 'add') {
      const name = parseAddName(args);
      if (name && failOn?.(name)) {
        return { exitCode: 1, stdout: '', stderr: 'mock add failure', timedOut: false };
      }
      applyMcpAdd(claudeConfigDir, args);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }
    return { exitCode: 1, stdout: '', stderr: 'no mock match', timedOut: false };
  };
  return { capture, calls };
}

function parseAddName(args: string[]): string | undefined {
  let i = 2;
  while (i < args.length) {
    const a = args[i];
    if (a === '--scope' || a === '--transport' || a === '-e' || a === '--env') {
      i += 2;
      continue;
    }
    return a;
  }
  return undefined;
}

function applyMcpAdd(claudeConfigDir: string, args: string[]): void {
  let i = 2;
  let transport: 'stdio' | 'sse' | 'http' = 'stdio';
  const env: Record<string, string> = {};
  while (i < args.length) {
    const a = args[i];
    if (a === '--scope') { i += 2; continue; }
    if (a === '--transport') { transport = args[i + 1] as 'sse' | 'http'; i += 2; continue; }
    if (a === '-e' || a === '--env') {
      const pair = args[i + 1];
      const eq = pair.indexOf('=');
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 2;
      continue;
    }
    break;
  }
  const name = args[i];
  i += 1;
  const entry: Record<string, unknown> = {};
  if (transport !== 'stdio') entry.type = transport;
  if (transport === 'sse' || transport === 'http') {
    entry.url = args[i];
  } else {
    if (args[i] === '--') i += 1;
    entry.command = args[i];
    i += 1;
    if (i < args.length) entry.args = args.slice(i);
  }
  if (Object.keys(env).length > 0) entry.env = env;
  writeMcpServer(claudeConfigDir, name, entry);
}

function writeMcpServer(claudeConfigDir: string, name: string, entry: Record<string, unknown>): void {
  const file = path.join(claudeConfigDir, '.claude.json');
  let json: Record<string, unknown> = {};
  try {
    json = fs.readJsonSync(file);
  } catch {
    json = {};
  }
  if (!isRecord(json.mcpServers)) {
    json.mcpServers = {};
  }
  (json.mcpServers as Record<string, unknown>)[name] = entry;
  fs.outputJsonSync(file, json, { spaces: 2 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// =============================================================================

describe('saveProfileAsTemplate', () => {
  it('saves a stripped template tree with a valid manifest', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectProfileFixture(appHome, 'coding');

    const { manifest, strippedCount } = await saveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
      templateName: 'my-template',
      clock: FIXED_CLOCK,
    });

    expect(manifest.version).toBe(1);
    expect(manifest.name).toBe('my-template');
    expect(manifest.sourceProfile).toBe('coding');
    expect(manifest.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(manifest.mcpServerNames).toEqual(['filesystem', 'github']);
    // 2 settings keys + 3 .claude.json mcp env keys + 1 legacy mcp.json key
    expect(strippedCount).toBe(6);

    // on-disk manifest parses and matches the returned one
    const onDisk = await readTemplateManifest(appHome, 'my-template');
    expect(onDisk).toEqual(manifest);

    const templateProfile = templateProfilePath(appHome, 'my-template');
    // captured resources travel
    expect(await fs.pathExists(path.join(templateProfile, 'profile.json'))).toBe(true);
    expect(await fs.pathExists(path.join(templateProfile, 'claude-home', 'CLAUDE.md'))).toBe(true);
    expect(await fs.pathExists(path.join(templateProfile, 'claude-home', 'skills', 'pdf.md'))).toBe(true);
    expect(await fs.pathExists(path.join(templateProfile, 'claude-home', 'agents', 'reviewer.md'))).toBe(true);
    // Auto Memory excluded entirely
    expect(await fs.pathExists(path.join(templateProfile, 'claude-home', 'memory', 'auto'))).toBe(false);
    // runtime internals pruned
    expect(await fs.pathExists(path.join(templateProfile, 'claude-home', 'sessions'))).toBe(false);
    expect(await fs.pathExists(path.join(templateProfile, 'claude-home', 'projects'))).toBe(false);

    // settings env values redacted, key names recorded
    const settings = await fs.readJson(path.join(templateProfile, 'claude-home', 'settings.json'));
    expect(settings.env.ANTHROPIC_API_KEY).toBe('<redacted>');
    expect(settings.env.ANTHROPIC_MODEL).toBe('<redacted>');
    expect(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    const settingsEntry = manifest.strippedKeys.find((e) => e.scope === 'settings-env');
    expect(settingsEntry?.keys).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']);

    // .claude.json pruned to just mcpServers; env values redacted; inventory kept
    const claudeJson = await fs.readJson(path.join(templateProfile, 'claude-home', '.claude.json'));
    expect(Object.keys(claudeJson)).toEqual(['mcpServers']);
    expect(claudeJson.mcpServers.github.command).toBe('npx');
    expect(claudeJson.mcpServers.github.env.GITHUB_TOKEN).toBe('<redacted>');
    const githubEntry = manifest.strippedKeys.find(
      (e) => e.scope === 'mcp-env' && e.mcpServer === 'github',
    );
    expect(githubEntry?.file).toBe('claude-home/.claude.json');
    expect(githubEntry?.keys).toEqual(['EXTRA', 'GITHUB_TOKEN']);

    // legacy mcp.json env redacted and recorded
    const legacyJson = await fs.readJson(path.join(templateProfile, 'mcp.json'));
    expect(legacyJson.mcpServers.legacy.env.LEGACY_TOKEN).toBe('<redacted>');
    const legacyEntry = manifest.strippedKeys.find(
      (e) => e.scope === 'mcp-env' && e.mcpServer === 'legacy',
    );
    expect(legacyEntry?.file).toBe('mcp.json');
    expect(legacyEntry?.keys).toEqual(['LEGACY_TOKEN']);
  });

  it('never stores any secret value in the template tree (no opt-in exists)', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectProfileFixture(appHome, 'coding');

    await saveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
      templateName: 'sealed',
      clock: FIXED_CLOCK,
    });

    const templateDir = path.join(appHome, 'templates', 'sealed');
    expect(await treeContains(templateDir, SECRET_TOKEN)).toBe(false);
    expect(await treeContains(templateDir, MCP_TOKEN)).toBe(false);
    expect(await treeContains(templateDir, LEGACY_TOKEN_VALUE)).toBe(false);
    expect(await treeContains(templateDir, 'user@example.com')).toBe(false);
  });

  it('never mutates the source profile', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectProfileFixture(appHome, 'coding');

    await saveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
      templateName: 'snapshot',
      clock: FIXED_CLOCK,
    });

    const paths = getProfileTemplatePaths(appHome, 'coding');
    const settings = await fs.readJson(paths.settingsPath);
    expect(settings.env.ANTHROPIC_API_KEY).toBe(SECRET_TOKEN);
    expect(await fs.pathExists(path.join(paths.autoMemoryPath, 'note-1.md'))).toBe(true);
    expect(await fs.pathExists(path.join(paths.claudeHomePath, 'sessions'))).toBe(true);
  });

  it('refuses built-in template names as reserved', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');

    for (const reserved of ['coding', 'study', 'work', 'research', 'general', 'blank', 'none']) {
      await expect(
        saveProfileAsTemplate({
          appHomePath: appHome,
          profileName: 'coding',
          templateName: reserved,
          clock: FIXED_CLOCK,
        }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_NAME_RESERVED' });
    }
    expect(await fs.pathExists(path.join(appHome, 'templates'))).toBe(false);
  });

  it('refuses an existing template name', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await saveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
      templateName: 'taken',
      clock: FIXED_CLOCK,
    });

    await expect(
      saveProfileAsTemplate({
        appHomePath: appHome,
        profileName: 'coding',
        templateName: 'taken',
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_ALREADY_EXISTS' });
  });

  it('refuses a missing source profile', async () => {
    const appHome = await makeAppHome();

    await expect(
      saveProfileAsTemplate({
        appHomePath: appHome,
        profileName: 'ghost',
        templateName: 'anything',
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });

  it('refuses an invalid template name', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');

    await expect(
      saveProfileAsTemplate({
        appHomePath: appHome,
        profileName: 'coding',
        templateName: '../escape',
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROFILE_NAME' });
    expect(await fs.pathExists(path.join(appHome, 'templates'))).toBe(false);
  });
});

describe('previewSaveProfileAsTemplate', () => {
  it('reports the stripping summary without writing anything', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await injectProfileFixture(appHome, 'coding');

    const preview = await previewSaveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
    });

    expect(preview.autoMemoryExcluded).toBe(true);
    expect(preview.strippedCount).toBe(6);
    expect(preview.strippedKeys).toHaveLength(4); // settings + 2 servers + legacy
    // nothing written — no templates dir, no staging residue
    expect(await fs.pathExists(path.join(appHome, 'templates'))).toBe(false);
    const residue = (await fs.readdir(appHome)).filter((e) => e.startsWith('.ccps-'));
    expect(residue).toEqual([]);
    // source untouched
    const settings = await fs.readJson(getProfileTemplatePaths(appHome, 'coding').settingsPath);
    expect(settings.env.ANTHROPIC_API_KEY).toBe(SECRET_TOKEN);
  });

  it('reports zero stripped fields for a clean profile', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');

    const preview = await previewSaveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
    });

    expect(preview.strippedCount).toBe(0);
    expect(preview.strippedKeys).toEqual([]);
    expect(preview.autoMemoryExcluded).toBe(true);
  });

  it('refuses a missing profile', async () => {
    const appHome = await makeAppHome();

    await expect(
      previewSaveProfileAsTemplate({ appHomePath: appHome, profileName: 'ghost' }),
    ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });
});

describe('listCustomTemplates', () => {
  it('returns an empty list when no templates directory exists', async () => {
    const appHome = await makeAppHome();
    expect(await listCustomTemplates(appHome)).toEqual([]);
  });

  it('lists saved templates sorted by name with source info', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    for (const name of ['zeta', 'alpha', 'mid']) {
      await saveProfileAsTemplate({
        appHomePath: appHome,
        profileName: 'coding',
        templateName: name,
        clock: FIXED_CLOCK,
      });
    }

    const templates = await listCustomTemplates(appHome);
    expect(templates.map((t) => t.name)).toEqual(['alpha', 'mid', 'zeta']);
    expect(templates[0].sourceProfile).toBe('coding');
  });

  it('skips a template whose manifest is corrupt without deleting it', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await saveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
      templateName: 'good',
      clock: FIXED_CLOCK,
    });
    const corruptDir = path.join(appHome, 'templates', 'corrupt');
    await fs.ensureDir(corruptDir);
    await fs.writeFile(path.join(corruptDir, 'template.json'), '{ not json', 'utf8');

    const templates = await listCustomTemplates(appHome);
    expect(templates.map((t) => t.name)).toEqual(['good']);
    // the corrupt entry is left on disk (never silently deleted)
    expect(await fs.pathExists(path.join(corruptDir, 'template.json'))).toBe(true);
  });
});

describe('createProfileFromCustomTemplate', () => {
  async function makeTemplate(appHome: string, templateName = 'base'): Promise<void> {
    await makeProfile(appHome, 'coding');
    await injectProfileFixture(appHome, 'coding');
    await saveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
      templateName,
      clock: FIXED_CLOCK,
    });
  }

  it('creates a working profile re-stamped for its own name', async () => {
    const appHome = await makeAppHome();
    await makeTemplate(appHome);
    const { capture } = mockClaudeAdd();

    const result = await createProfileFromCustomTemplate({
      appHomePath: appHome,
      templateName: 'base',
      name: 'fresh',
      captureProcess: capture,
      clock: FIXED_CLOCK,
    });

    expect(result.profileName).toBe('fresh');
    const paths = getProfileTemplatePaths(appHome, 'fresh');
    expect(await fs.pathExists(paths.profileRootPath)).toBe(true);
    expect(await fs.pathExists(paths.claudeMdPath)).toBe(true);
    expect(await fs.pathExists(path.join(paths.skillsPath, 'pdf.md'))).toBe(true);
    expect(await fs.pathExists(path.join(paths.agentsPath, 'reviewer.md'))).toBe(true);

    // profile.json re-stamped: new name, mcpMode forced to 'none'
    const profileJson = await fs.readJson(paths.profileConfigPath);
    expect(profileJson.name).toBe('fresh');
    expect(profileJson.launch.mcpMode).toBe('none');
    expect(profileJson.createdAt).toBe('2026-08-01T00:00:00.000Z');

    // settings repointed at the new profile's own auto-memory dir; managed
    // fields backfilled (env default, claudeMdExcludes, ccps rule)
    const settings = await fs.readJson(paths.settingsPath);
    expect(settings.autoMemoryDirectory).toBe(paths.autoMemoryPath);
    expect(settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(Array.isArray(settings.claudeMdExcludes)).toBe(true);
    expect(await fs.pathExists(paths.ccpsProfileRulePath)).toBe(true);

    // Auto Memory was excluded from the template — recreated empty with entrypoint
    expect(await fs.pathExists(paths.autoMemoryPath)).toBe(true);
    expect(await fs.pathExists(paths.autoMemoryEntrypointPath)).toBe(true);
    const entrypoint = await fs.readFile(paths.autoMemoryEntrypointPath, 'utf8');
    expect(entrypoint).toContain('fresh');
    expect(await fs.pathExists(path.join(paths.autoMemoryPath, 'note-1.md'))).toBe(false);

    // auto-validate ran
    expect(result.validation.profileName).toBe('fresh');
    expect(result.validation.status).toBe('valid');
  });

  it("forces launch.mcpMode 'none' even when the source profile opted into strict", async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    const sourcePaths = getProfileTemplatePaths(appHome, 'coding');
    const tampered = await fs.readJson(sourcePaths.profileConfigPath);
    await fs.writeJson(sourcePaths.profileConfigPath, {
      ...tampered,
      launch: { mcpMode: 'strict' },
    });
    await saveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
      templateName: 'strict-source',
      clock: FIXED_CLOCK,
    });

    await createProfileFromCustomTemplate({
      appHomePath: appHome,
      templateName: 'strict-source',
      name: 'fresh',
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    const created = await fs.readJson(
      getProfileTemplatePaths(appHome, 'fresh').profileConfigPath,
    );
    expect(created.launch?.mcpMode).toBe('none');
  });

  it('re-registers MCP servers via delegated claude mcp add, collecting failures', async () => {
    const appHome = await makeAppHome();
    await makeTemplate(appHome);
    const { capture, calls } = mockClaudeAdd((name) => name === 'filesystem');

    const result = await createProfileFromCustomTemplate({
      appHomePath: appHome,
      templateName: 'base',
      name: 'fresh',
      captureProcess: capture,
      clock: FIXED_CLOCK,
    });

    expect(result.mcpServers).toHaveLength(2);
    const github = result.mcpServers.find((s) => s.name === 'github');
    const filesystem = result.mcpServers.find((s) => s.name === 'filesystem');
    expect(github?.reRegistered).toBe(true);
    expect(github?.envKeysToReenter).toEqual(['EXTRA', 'GITHUB_TOKEN']);
    expect(filesystem?.reRegistered).toBe(false);
    expect(filesystem?.failureMessage).toBeTruthy();
    expect(filesystem?.envKeysToReenter).toEqual(['ROOT']);

    // env values never pass through the delegated add (secret-in-memory rule)
    for (const call of calls) {
      expect(call.args).not.toContain('-e');
      expect(call.args).not.toContain('--env');
    }
    // the successful server landed in the new profile's own .claude.json
    const claudeJson = await fs.readJson(
      getClaudeJsonPath(getProfileTemplatePaths(appHome, 'fresh').profileRootPath),
    );
    expect(Object.keys(claudeJson.mcpServers)).toEqual(['github']);
    expect(claudeJson.mcpServers.github.env).toBeUndefined();
  });

  it('resets the staged .claude.json before re-registration (no direct writes)', async () => {
    const appHome = await makeAppHome();
    await makeTemplate(appHome);

    await createProfileFromCustomTemplate({
      appHomePath: appHome,
      templateName: 'base',
      name: 'fresh',
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    const claudeJson = await fs.readJson(
      getClaudeJsonPath(getProfileTemplatePaths(appHome, 'fresh').profileRootPath),
    );
    // only the delegated adds repopulated it — OAuth/account fields never landed
    expect(Object.keys(claudeJson)).toEqual(['mcpServers']);
  });

  it('reports the secret keys needing guided re-entry (import parity)', async () => {
    const appHome = await makeAppHome();
    await makeTemplate(appHome);

    const result = await createProfileFromCustomTemplate({
      appHomePath: appHome,
      templateName: 'base',
      name: 'fresh',
      captureProcess: mockClaudeAdd().capture,
      clock: FIXED_CLOCK,
    });

    expect(result.settingsSecretKeysToReenter).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']);
    expect(result.legacyMcpEnvKeysToReenter).toEqual([
      { server: 'legacy', keys: ['LEGACY_TOKEN'] },
    ]);
    // settings placeholders stay as key-name placeholders in the new profile
    const settings = await fs.readJson(getProfileTemplatePaths(appHome, 'fresh').settingsPath);
    expect(settings.env.ANTHROPIC_API_KEY).toBe('<redacted>');
  });

  it('refuses a missing template', async () => {
    const appHome = await makeAppHome();

    await expect(
      createProfileFromCustomTemplate({
        appHomePath: appHome,
        templateName: 'ghost',
        name: 'fresh',
        captureProcess: mockClaudeAdd().capture,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('refuses an existing profile name', async () => {
    const appHome = await makeAppHome();
    await makeTemplate(appHome);
    await makeProfile(appHome, 'taken');

    await expect(
      createProfileFromCustomTemplate({
        appHomePath: appHome,
        templateName: 'base',
        name: 'taken',
        captureProcess: mockClaudeAdd().capture,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_ALREADY_EXISTS' });
  });
});

describe('removeCustomTemplate', () => {
  it('removes a custom template', async () => {
    const appHome = await makeAppHome();
    await makeProfile(appHome, 'coding');
    await saveProfileAsTemplate({
      appHomePath: appHome,
      profileName: 'coding',
      templateName: 'doomed',
      clock: FIXED_CLOCK,
    });
    expect(await listCustomTemplates(appHome)).toHaveLength(1);

    await removeCustomTemplate({ appHomePath: appHome, templateName: 'doomed' });

    expect(await listCustomTemplates(appHome)).toEqual([]);
    expect(await fs.pathExists(path.join(appHome, 'templates', 'doomed'))).toBe(false);
  });

  it('refuses to remove built-in template names', async () => {
    const appHome = await makeAppHome();

    await expect(
      removeCustomTemplate({ appHomePath: appHome, templateName: 'coding' }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NAME_RESERVED' });
  });

  it('refuses a missing template', async () => {
    const appHome = await makeAppHome();

    await expect(
      removeCustomTemplate({ appHomePath: appHome, templateName: 'ghost' }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });
});
