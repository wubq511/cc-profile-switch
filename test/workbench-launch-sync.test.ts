import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import { loadAppState } from '../src/core/app-state';
import {
  createProfileFromTemplate,
  getProfileTemplatePaths,
} from '../src/core/profile-template';
import { buildLaunchPlan, formatLaunchDryRun, launchProfile } from '../src/core/launcher';
import { workbenchLaunchSync } from '../src/core/workbench-launch';
import { appConfigV2Schema } from '../src/schemas/config';
import { appStateV1Schema } from '../src/schemas/state';

/**
 * In test environments, the macOS PTY wrapper (`script -q /dev/null`) fails
 * because there is no PTY. We inject a spawnImpl that skips the wrapper
 * and calls the command directly, matching the non-macOS behavior.
 */
function testSpawnSync(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
) {
  // If the command is 'script' with the PTY wrapper pattern, unwrap it
  if (command === 'script' && args[0] === '-q' && args[1] === '/dev/null') {
    const realCommand = args[2];
    const realArgs = args.slice(3);
    return spawnSync(realCommand, realArgs, options);
  }
  return spawnSync(command, args, options);
}

describe('workbench launch (spawnSync)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  async function makeProfile(name = 'coding'): Promise<{
    appHome: string;
    paths: ReturnType<typeof getProfileTemplatePaths>;
  }> {
    const appHome = join(await makeTempRoot('ccps-wblaunch-'), '.cc-profile-switch');
    await createAppConfig(appHome);
    await createProfileFromTemplate({ appHomePath: appHome, name, template: 'coding' });
    return { appHome, paths: getProfileTemplatePaths(appHome, name) };
  }

  it('workbenchLaunchSync uses spawnSync and records metadata', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    // Override command/args to exit immediately
    const testPlan = { ...plan, command: 'node', args: ['-e', 'process.exit(0)'] };

    const result = workbenchLaunchSync({
      plan: testPlan,
      appHomePath: appHome,
      spawnImpl: testSpawnSync,
      clock: () => new Date('2026-08-01T12:00:00Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();

    // Verify metadata was recorded
    const config = await fs.readJson(join(appHome, 'config.json'));
    expect(config.lastUsedProfile).toBe('coding');

    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(1);
    expect(state.recentProjectDirs[0].path).toBe(projectCwd);
  });

  it('workbenchLaunchSync records non-zero exit code', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    const testPlan = { ...plan, command: 'node', args: ['-e', 'process.exit(42)'] };

    const result = workbenchLaunchSync({
      plan: testPlan,
      appHomePath: appHome,
      spawnImpl: testSpawnSync,
    });

    expect(result.exitCode).toBe(42);
  });

  it('records neither recents nor lastUsedProfile on non-zero exit (spec §13.3)', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    const testPlan = { ...plan, command: 'node', args: ['-e', 'process.exit(42)'] };

    const result = workbenchLaunchSync({
      plan: testPlan,
      appHomePath: appHome,
      spawnImpl: testSpawnSync,
    });

    expect(result.exitCode).toBe(42);

    // config.json lastUsedProfile stays unset
    const config = await fs.readJson(join(appHome, 'config.json'));
    expect(config.lastUsedProfile).toBeNull();

    // state.json recents stay empty (file was never created)
    const state = await loadAppState(appHome);
    expect(state.recentProjectDirs).toHaveLength(0);
  });

  it('records schema-valid metadata atomically on exit 0 (no tmp residue)', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    const testPlan = { ...plan, command: 'node', args: ['-e', 'process.exit(0)'] };

    workbenchLaunchSync({
      plan: testPlan,
      appHomePath: appHome,
      spawnImpl: testSpawnSync,
    });

    // Both files validate against their strict schemas (spec §13.4)
    const rawConfig = await fs.readJson(join(appHome, 'config.json'));
    expect(appConfigV2Schema.safeParse(rawConfig).success).toBe(true);
    expect(rawConfig.lastUsedProfile).toBe('coding');

    const rawState = await fs.readJson(join(appHome, 'state.json'));
    expect(appStateV1Schema.safeParse(rawState).success).toBe(true);
    expect(rawState.recentProjectDirs[0].path).toBe(projectCwd);

    // Writes went through temp+rename — no residue left behind
    const entries = await fs.readdir(appHome);
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0);
  });

  it('leaves a state.json with unknown fields untouched (never silently rewrites)', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    // Pre-existing state.json carrying a field from a newer ccps version
    const foreignState = {
      version: 1,
      recentProjectDirs: [{ path: '/old/project', lastUsedAt: '2026-01-01T00:00:00.000Z' }],
      futureField: { from: 'newer-ccps' },
    };
    await fs.writeJson(join(appHome, 'state.json'), foreignState);

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    const testPlan = { ...plan, command: 'node', args: ['-e', 'process.exit(0)'] };

    const result = workbenchLaunchSync({
      plan: testPlan,
      appHomePath: appHome,
      spawnImpl: testSpawnSync,
    });

    expect(result.exitCode).toBe(0);

    // Strict schema (spec §13.4): the file fails parse, so the recents
    // update is skipped and the file is preserved verbatim — the old code
    // silently rewrote it without the unknown fields.
    const raw = await fs.readJson(join(appHome, 'state.json'));
    expect(raw).toEqual(foreignState);
  });

  it('workbenchLaunchSync passes CLAUDE_CONFIG_DIR and cwd to spawn', async () => {
    const { appHome, paths } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    const testPlan = { ...plan, command: 'node', args: ['-e', 'process.exit(0)'] };

    // Capture spawn arguments
    let capturedCommand: string | undefined;
    let capturedArgs: string[] | undefined;
    let capturedCwd: string | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    workbenchLaunchSync({
      plan: testPlan,
      appHomePath: appHome,
      spawnImpl: (command, args, options) => {
        capturedCommand = command;
        capturedArgs = args;
        capturedCwd = (options as Record<string, unknown>).cwd as string;
        capturedEnv = (options as Record<string, unknown>).env as NodeJS.ProcessEnv;
        return spawnSync('node', ['-e', 'process.exit(0)'], options);
      },
    });

    // On macOS, command should be 'script' with PTY wrapper args
    // On other platforms, command should be 'node'
    if (process.platform === 'darwin') {
      expect(capturedCommand).toBe('script');
      expect(capturedArgs?.[0]).toBe('-q');
      expect(capturedArgs?.[2]).toBe('node');
    } else {
      expect(capturedCommand).toBe('node');
    }
    expect(capturedCwd).toBe(projectCwd);
    expect(capturedEnv?.CLAUDE_CONFIG_DIR).toBe(paths.claudeHomePath);
  });
});

describe('dry-run equivalent to real plan (invariant 8)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeTempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  async function makeProfile(name = 'coding'): Promise<{
    appHome: string;
    paths: ReturnType<typeof getProfileTemplatePaths>;
  }> {
    const appHome = join(await makeTempRoot('ccps-dryrun-'), '.cc-profile-switch');
    await createAppConfig(appHome);
    await createProfileFromTemplate({ appHomePath: appHome, name, template: 'coding' });
    return { appHome, paths: getProfileTemplatePaths(appHome, name) };
  }

  it('dry-run plan and real launch plan produce equivalent output', async () => {
    const { appHome } = await makeProfile();
    const projectCwd = await makeTempRoot('ccps-project-');

    // Build the plan (this is what dry-run does)
    const plan = await buildLaunchPlan({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
    });

    // Format the dry-run output
    const dryRunOutput = formatLaunchDryRun(plan);

    // Now do a real launch (with a fake spawnProcess that captures the plan)
    const spawnCalls: Array<{
      command: string;
      args: string[];
      cwd: string;
      claudeConfigDir: string | undefined;
    }> = [];

    await launchProfile({
      appHomePath: appHome,
      profileName: 'coding',
      cwd: projectCwd,
      spawnProcess: async (command, args, options) => {
        spawnCalls.push({
          command,
          args,
          cwd: options.cwd,
          claudeConfigDir: options.env.CLAUDE_CONFIG_DIR,
        });
        return { exitCode: 0 };
      },
    });

    // The dry-run output must contain all the same values that the real launch uses
    expect(dryRunOutput).toContain(`Profile path: ${plan.profileRootPath}`);
    expect(dryRunOutput).toContain(`Claude home: ${plan.claudeHomePath}`);
    expect(dryRunOutput).toContain(`Cwd: ${projectCwd}`);
    expect(dryRunOutput).toContain(`CLAUDE_CONFIG_DIR=${plan.envChanges.CLAUDE_CONFIG_DIR}`);

    // The real spawn must use the same values
    expect(spawnCalls).toHaveLength(1);
    const expectedCommand = process.platform === 'darwin' ? 'script' : plan.command;
    const expectedArgs =
      process.platform === 'darwin' ? ['-q', '/dev/null', plan.command, ...plan.args] : plan.args;
    expect(spawnCalls[0]).toEqual({
      command: expectedCommand,
      args: expectedArgs,
      cwd: plan.cwd,
      claudeConfigDir: plan.envChanges.CLAUDE_CONFIG_DIR,
    });
  });
});
