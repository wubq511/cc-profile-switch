import { describe, expect, it, vi } from 'vitest';

import { runTuiController, type TuiControllerServices, type TuiPorts } from '../src/tui/controller';

describe('tui controller', () => {
  function makePorts(options: {
    actions?: string[];
    inputs?: string[];
    confirmations?: string[];
  } = {}): TuiPorts & { output: string[]; selectCalls: Array<{ prompt: string; choices: string[] }> } {
    const output: string[] = [];
    const actions = [...(options.actions ?? ['exit'])];
    const inputs = [...(options.inputs ?? [])];
    const confirmations = [...(options.confirmations ?? [])];
    const selectCalls: Array<{ prompt: string; choices: string[] }> = [];

    return {
      output,
      selectCalls,
      writeOut: (value) => output.push(value),
      select: async (prompt, choices) => {
        selectCalls.push({ prompt, choices: choices.map((choice) => choice.value) });
        return actions.shift() ?? 'exit';
      },
      input: async () => inputs.shift() ?? '',
      confirmByName: async () => confirmations.shift() ?? '',
    };
  }

  function makeServices(overrides: Partial<TuiControllerServices> = {}): TuiControllerServices {
    return {
      listProfilesForDisplay: vi.fn(async () => [
        {
          name: 'coding',
          status: 'valid',
          isDefault: true,
          isLastUsed: false,
          description: 'Focused software development profile.',
          profileRootPath: 'C:\\profiles\\coding',
          claudeHomePath: 'C:\\profiles\\coding\\claude-home',
        },
        {
          name: 'study',
          status: 'warning',
          isDefault: false,
          isLastUsed: true,
          description: 'Learning profile.',
          profileRootPath: 'C:\\profiles\\study',
          claudeHomePath: 'C:\\profiles\\study\\claude-home',
        },
      ]),
      copyProfile: vi.fn(async () => ({
        sourceName: 'coding',
        targetName: 'focus',
        sourcePath: 'C:\\profiles\\coding',
        targetPath: 'C:\\profiles\\focus',
      })),
      renameProfile: vi.fn(async () => ({
        oldName: 'coding',
        newName: 'focus',
        oldPath: 'C:\\profiles\\coding',
        newPath: 'C:\\profiles\\focus',
      })),
      removeProfile: vi.fn(async () => ({
        profileName: 'coding',
        removedPath: 'C:\\profiles\\coding',
        backupPath: 'C:\\backups\\coding-20260520-120000',
      })),
      setDefaultProfile: vi.fn(async () => 'coding'),
      clearDefaultProfile: vi.fn(async () => undefined),
      validateProfile: vi.fn(async () => ({
        profileName: 'coding',
        status: 'warning',
        profileRootPath: 'C:\\profiles\\coding',
        claudeHomePath: 'C:\\profiles\\coding\\claude-home',
        paths: {
          profileRootPath: 'C:\\profiles\\coding',
          profileConfigPath: 'C:\\profiles\\coding\\profile.json',
          claudeHomePath: 'C:\\profiles\\coding\\claude-home',
          claudeMdPath: 'C:\\profiles\\coding\\claude-home\\CLAUDE.md',
          settingsPath: 'C:\\profiles\\coding\\claude-home\\settings.json',
          memoryPath: 'C:\\profiles\\coding\\claude-home\\memory',
          autoMemoryPath: 'C:\\profiles\\coding\\claude-home\\memory\\auto',
          autoMemoryEntrypointPath: 'C:\\profiles\\coding\\claude-home\\memory\\auto\\MEMORY.md',
          skillsPath: 'C:\\profiles\\coding\\claude-home\\skills',
          agentsPath: 'C:\\profiles\\coding\\claude-home\\agents',
          mcpConfigPath: 'C:\\profiles\\coding\\mcp.json',
          pluginsPath: 'C:\\profiles\\coding\\claude-home\\plugins',
        },
        findings: [
          {
            severity: 'warning',
            code: 'SENSITIVE_FILENAME_MEDIUM',
            message: 'Medium-risk sensitive filename found in the profile.',
            path: 'C:\\profiles\\coding\\history.log',
          },
        ],
      })),
      buildLaunchPlan: vi.fn(async () => ({
        profileName: 'coding',
        profileRootPath: 'C:\\profiles\\coding',
        claudeHomePath: 'C:\\profiles\\coding\\claude-home',
        cwd: 'C:\\project',
        command: 'claude',
        args: [],
        envChanges: {
          CLAUDE_CONFIG_DIR: 'C:\\profiles\\coding\\claude-home',
        },
        memoryConfig: {
          userMemoryPath: 'C:\\profiles\\coding\\claude-home\\CLAUDE.md',
          autoMemoryDirectory: 'C:\\profiles\\coding\\claude-home\\memory\\auto',
          autoMemoryEntrypointPath: 'C:\\profiles\\coding\\claude-home\\memory\\auto\\MEMORY.md',
        },
        apiConfig: {
          common: { path: 'C:\\api-settings.json', present: false, keys: [] },
          profile: { path: 'C:\\settings.json', present: true, keys: [] },
          keys: [],
        },
        apiEnv: {},
        mcpMode: 'merge',
        pluginDirs: [],
        validationStatus: 'valid',
        warnings: [],
        validationFindings: [],
      })),
      formatLaunchDryRun: vi.fn(() => 'Launch dry-run for profile "coding"\nDry run: Claude Code was not started.\n'),
      ...overrides,
    };
  }

  it('lists profiles with validation, default, last-used, and description fields', async () => {
    const ports = makePorts({ actions: ['exit'] });
    const services = makeServices();

    await runTuiController({ appHomePath: 'C:\\app', ports, services });

    const output = ports.output.join('');
    expect(output).toContain('Profiles');
    expect(output).toContain('coding\tvalid\tdefault\t-\tFocused software development profile.');
    expect(output).toContain('study\twarning\t-\tlast-used\tLearning profile.');
    expect(ports.selectCalls[0].choices).toEqual([
      'list',
      'copy',
      'rename',
      'remove',
      'set-default',
      'clear-default',
      'show',
      'validate',
      'launch-dry-run',
      'exit',
    ]);
  });

  it('shows guidance and exits without prompting when there are zero profiles', async () => {
    const ports = makePorts();
    const services = makeServices({
      listProfilesForDisplay: vi.fn(async () => []),
    });

    await runTuiController({ appHomePath: 'C:\\app', ports, services });

    expect(ports.output.join('')).toContain('No profiles found.');
    expect(ports.output.join('')).toContain('Next: ccps init or ccps create <name> --template blank');
    expect(ports.selectCalls).toEqual([]);
  });

  it('supports copy, rename, set default, and clear default through shared services', async () => {
    const ports = makePorts({
      actions: ['copy', 'rename', 'set-default', 'clear-default', 'exit'],
      inputs: ['coding', 'focus', 'focus', 'deep_work', 'deep_work'],
    });
    const services = makeServices();

    await runTuiController({ appHomePath: 'C:\\app', ports, services, clock: () => new Date('2026-05-20T12:00:00Z') });

    expect(services.copyProfile).toHaveBeenCalledWith({
      appHomePath: 'C:\\app',
      from: 'coding',
      to: 'focus',
      clock: expect.any(Function),
    });
    expect(services.renameProfile).toHaveBeenCalledWith({
      appHomePath: 'C:\\app',
      oldName: 'focus',
      newName: 'deep_work',
      clock: expect.any(Function),
    });
    expect(services.setDefaultProfile).toHaveBeenCalledWith({
      appHomePath: 'C:\\app',
      name: 'deep_work',
      clock: expect.any(Function),
    });
    expect(services.clearDefaultProfile).toHaveBeenCalledWith({
      appHomePath: 'C:\\app',
      clock: expect.any(Function),
    });
    expect(ports.output.join('')).toContain('Copied profile "coding" to "focus".');
    expect(ports.output.join('')).toContain('Renamed profile "coding" to "focus".');
    expect(ports.output.join('')).toContain('Default profile set: coding');
    expect(ports.output.join('')).toContain('Default profile cleared.');
  });

  it('removes profiles by passing exact-name confirmation to the shared service', async () => {
    const ports = makePorts({
      actions: ['remove', 'exit'],
      inputs: ['coding'],
      confirmations: ['coding'],
    });
    const services = makeServices();

    await runTuiController({ appHomePath: 'C:\\app', ports, services });

    expect(services.removeProfile).toHaveBeenCalledWith({
      appHomePath: 'C:\\app',
      name: 'coding',
      confirmation: 'coding',
      clock: expect.any(Function),
    });
    expect(ports.output.join('')).toContain('Removed profile "coding".');
    expect(ports.output.join('')).toContain('Backup: C:\\backups\\coding-20260520-120000');
  });

  it('shows details, validates profiles, and runs launch dry-run only', async () => {
    const ports = makePorts({
      actions: ['show', 'validate', 'launch-dry-run', 'exit'],
      inputs: ['coding', 'coding', '', 'C:\\project'],
    });
    const services = makeServices();

    await runTuiController({ appHomePath: 'C:\\app', ports, services });

    expect(services.validateProfile).toHaveBeenCalledWith({ appHomePath: 'C:\\app', name: 'coding' });
    expect(services.validateProfile).toHaveBeenCalledTimes(2);
    expect(services.buildLaunchPlan).toHaveBeenCalledWith({
      appHomePath: 'C:\\app',
      profileName: undefined,
      cwd: 'C:\\project',
    });
    expect(services.formatLaunchDryRun).toHaveBeenCalled();
    expect(ports.output.join('')).toContain('Profile: coding');
    expect(ports.output.join('')).toContain('Status: warning');
    expect(ports.output.join('')).toContain('SENSITIVE_FILENAME_MEDIUM');
    expect(ports.output.join('')).toContain('Launch dry-run for profile "coding"');
  });
});
