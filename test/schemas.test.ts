import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../src/schemas/config';
import { profileConfigSchema } from '../src/schemas/profile';

describe('config schemas', () => {
  it('parses app config with optional profile metadata', () => {
    const config = appConfigSchema.parse({
      version: 2,
      defaultProfile: 'coding',
      lastUsedProfile: null,
    });

    expect(config.defaultProfile).toBe('coding');
    expect(config.lastUsedProfile).toBeNull();
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
