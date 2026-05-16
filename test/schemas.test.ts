import { describe, expect, it } from 'vitest';

import { appConfigSchema } from '../src/schemas/config';
import { profileConfigSchema } from '../src/schemas/profile';

describe('config schemas', () => {
  it('parses app config with optional profile metadata', () => {
    const config = appConfigSchema.parse({
      version: 1,
      defaultProfile: 'coding',
      lastUsedProfile: null,
    });

    expect(config.defaultProfile).toBe('coding');
    expect(config.lastUsedProfile).toBeNull();
  });

  it('rejects invalid profile names in app config', () => {
    expect(() =>
      appConfigSchema.parse({
        version: 1,
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
      },
    });

    expect(profile.launch.mcpMode).toBe('merge');
    expect(profile.launch.pluginDirs).toEqual(['plugins']);
    expect(profile.launch.disableAutoMemory).toBe(true);
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
      claudeArgs: [],
    });
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
