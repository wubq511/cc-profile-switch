import { describe, expect, it } from 'vitest';

import { appConfigSchema, appConfigV2Schema } from '../src/schemas/config';
import { profileConfigSchema } from '../src/schemas/profile';
import {
  BUNDLE_MANIFEST_VERSION,
  bundleManifestV1Schema,
  bundleManifestV2Schema,
  parseBundleManifest,
} from '../src/schemas/profile-bundle';
import {
  customTemplateManifestSchema,
  customTemplateManifestV1Schema,
  customTemplateManifestV2Schema,
} from '../src/schemas/custom-template';

const validV1Manifest = {
  version: 1,
  bundleFormat: 'ccps-profile-bundle',
  exporterVersion: '0.1.0',
  exportedAt: '2026-08-01T00:00:00.000Z',
  profileName: 'coding',
  includeSecrets: false,
  secretsPresent: true,
  secretsStripped: true,
  strippedKeys: [
    { file: 'claude-home/settings.json', scope: 'settings-env', keys: ['ANTHROPIC_API_KEY'] },
  ],
  resources: {
    userMemory: 1,
    autoMemory: 1,
    skills: 0,
    agents: 0,
    mcpServers: 0,
    settings: 1,
    launchConfig: 1,
  },
  mcpServerNames: [],
};

const validV2Manifest = {
  ...validV1Manifest,
  version: 2,
  topLevelEntries: ['claude-home', 'profile.json'],
  excludedTopLevelEntries: ['claude-home/sessions'],
};

describe('bundle manifest versioning (#105)', () => {
  it('writes version 2 manifests', () => {
    expect(BUNDLE_MANIFEST_VERSION).toBe(2);
  });

  it('parses a v2 manifest including the mcp-headers stripped-key scope', () => {
    const manifest = bundleManifestV2Schema.parse({
      ...validV2Manifest,
      strippedKeys: [
        {
          file: 'claude-home/.claude.json',
          scope: 'mcp-headers',
          mcpServer: 'httpapi',
          keys: ['Authorization'],
        },
      ],
    });
    expect(manifest.version).toBe(2);
    expect(manifest.topLevelEntries).toEqual(['claude-home', 'profile.json']);
  });

  it('still parses a v1 manifest (backward-compatible read)', () => {
    const manifest = bundleManifestV1Schema.parse(validV1Manifest);
    expect(manifest.version).toBe(1);
    // v1 has no v2 fields
    expect('topLevelEntries' in manifest).toBe(false);
  });

  it('parses v1 and v2 through the shared entry point', () => {
    expect(parseBundleManifest(validV1Manifest).version).toBe(1);
    expect(parseBundleManifest(validV2Manifest).version).toBe(2);
  });

  it('rejects a future manifest version', () => {
    expect(() => parseBundleManifest({ ...validV2Manifest, version: 3 })).toThrow();
    expect(() => bundleManifestV2Schema.parse({ ...validV2Manifest, version: 3 })).toThrow();
  });

  it('keeps the v2-only fields strict (unknown fields rejected)', () => {
    expect(() => bundleManifestV2Schema.parse({ ...validV2Manifest, unknown: true })).toThrow();
  });
});

describe('custom template manifest versioning (#105)', () => {
  const v1Template = {
    version: 1,
    name: 'my-template',
    sourceProfile: 'coding',
    createdAt: '2026-08-01T00:00:00.000Z',
    strippedKeys: [],
    mcpServerNames: [],
  };
  const v2Template = {
    ...v1Template,
    version: 2,
    linkedSkills: ['linked-skill'],
    excludedTopLevelEntries: ['claude-home/sessions'],
  };

  it('parses v1 and v2 template manifests', () => {
    expect(customTemplateManifestV1Schema.parse(v1Template).version).toBe(1);
    const v2 = customTemplateManifestV2Schema.parse(v2Template);
    expect(v2.linkedSkills).toEqual(['linked-skill']);
    expect(customTemplateManifestSchema.parse(v1Template).version).toBe(1);
    expect(customTemplateManifestSchema.parse(v2Template).version).toBe(2);
  });

  it('rejects future template versions and unknown fields', () => {
    expect(() => customTemplateManifestSchema.parse({ ...v2Template, version: 3 })).toThrow();
    expect(() => customTemplateManifestV2Schema.parse({ ...v2Template, unknown: true })).toThrow();
  });
});

describe('config schemas', () => {
  it('parses app config v2 with optional profile metadata', () => {
    const config = appConfigSchema.parse({
      version: 2,
      defaultProfile: 'coding',
      lastUsedProfile: null,
    });

    expect(config.defaultProfile).toBe('coding');
    expect(config.lastUsedProfile).toBeNull();
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);
  });

  it('rejects invalid profile names in app config', () => {
    expect(() =>
      appConfigSchema.parse({
        version: 2,
        defaultProfile: '../coding',
      }),
    ).toThrow();
  });

  it('parses app config with workbench settings', () => {
    const config = appConfigSchema.parse({
      version: 2,
      workbench: {
        language: 'zh',
        editor: 'code -w',
        skillsDiscoveryExperimental: false,
      },
    });

    expect(config.workbench?.language).toBe('zh');
    expect(config.workbench?.editor).toBe('code -w');
    expect(config.workbench?.skillsDiscoveryExperimental).toBe(false);
  });

  it('parses app config with recovery settings', () => {
    const config = appConfigSchema.parse({
      version: 2,
      recovery: { retentionDays: 30 },
    });

    expect(config.recovery?.retentionDays).toBe(30);
  });

  it('parses profile config launch settings', () => {
    const profile = profileConfigSchema.parse({
      name: 'research',
      description: 'Research profile',
      template: 'research',
      launch: {
        mcpMode: 'merge',
        pluginDirs: ['plugins'],
        disableAutoMemory: true,
        skipPermissions: false,
      },
    });

    expect(profile.launch.mcpMode).toBe('merge');
    expect(profile.launch.pluginDirs).toEqual(['plugins']);
    expect(profile.launch.disableAutoMemory).toBe(true);
    expect(profile.launch.skipPermissions).toBe(false);
  });

  it('applies safe launch defaults', () => {
    const profile = profileConfigSchema.parse({
      name: 'blank_profile',
      template: 'blank',
    });

    expect(profile.description).toBe('');
    expect(profile.launch).toEqual({
      mcpMode: 'merge',
      pluginDirs: [],
      disableAutoMemory: false,
      skipPermissions: true,
      claudeArgs: [],
    });
  });

  it('allows omitting template for blank profiles', () => {
    const profile = profileConfigSchema.parse({
      name: 'no_template',
    });

    expect(profile.template).toBeUndefined();
    expect(profile.description).toBe('');
  });

  it('rejects invalid launch config values', () => {
    expect(() =>
      profileConfigSchema.parse({
        name: 'coding',
        template: 'coding',
        launch: {
          mcpMode: 'strict-by-default',
        },
      }),
    ).toThrow();
  });
});

describe('app config v2 schema', () => {
  it('parses a minimal v2 config with defaults', () => {
    const config = appConfigV2Schema.parse({ version: 2 });

    expect(config.version).toBe(2);
    expect(config.recovery.retentionDays).toBe(30);
    expect(config.workbench.skillsDiscoveryExperimental).toBe(true);
    expect(config.workbench.editor).toBeUndefined();
    expect(config.workbench.language).toBeUndefined();
  });

  it('parses a full v2 config', () => {
    const config = appConfigV2Schema.parse({
      version: 2,
      defaultProfile: 'coding',
      lastUsedProfile: 'study',
      recovery: { retentionDays: 7 },
      workbench: {
        editor: 'vim',
        skillsDiscoveryExperimental: false,
        language: 'zh',
      },
    });

    expect(config.recovery.retentionDays).toBe(7);
    expect(config.workbench.editor).toBe('vim');
    expect(config.workbench.skillsDiscoveryExperimental).toBe(false);
    expect(config.workbench.language).toBe('zh');
  });

  it('accepts retentionDays as 7, 30, 90, or null', () => {
    for (const days of [7, 30, 90, null] as const) {
      const config = appConfigV2Schema.parse({
        version: 2,
        recovery: { retentionDays: days },
      });
      expect(config.recovery.retentionDays).toBe(days);
    }
  });

  it('rejects invalid retentionDays', () => {
    expect(() =>
      appConfigV2Schema.parse({ version: 2, recovery: { retentionDays: 14 } }),
    ).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => appConfigV2Schema.parse({ version: 2, unknownField: true })).toThrow();
  });

  it('rejects invalid language values', () => {
    expect(() => appConfigV2Schema.parse({ version: 2, workbench: { language: 'fr' } })).toThrow();
  });
});
