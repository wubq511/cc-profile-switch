import { describe, expect, it } from 'vitest';

import { appConfigSchema, appConfigV2Schema } from '../src/schemas/config';
import { profileConfigSchema } from '../src/schemas/profile';

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
    expect(() =>
      appConfigV2Schema.parse({ version: 2, unknownField: true }),
    ).toThrow();
  });

  it('rejects invalid language values', () => {
    expect(() =>
      appConfigV2Schema.parse({ version: 2, workbench: { language: 'fr' } }),
    ).toThrow();
  });
});
