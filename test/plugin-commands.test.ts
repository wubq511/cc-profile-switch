import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli';
import { createAppConfig } from '../src/core/app-config';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { captureProcess as realCaptureProcess } from '../src/platform/process';
import type { CaptureProcess } from '../src/platform/process';

describe('plugin CLI commands', () => {
  const tempRoots: string[] = [];
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
  });

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
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
  });

  async function makeUserHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-plugin-cli-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: () => new Date('2026-07-31T16:00:00Z') });
    await createProfileFromTemplate({
      appHomePath: appHome,
      name: 'coding',
      template: 'coding',
      clock: () => new Date('2026-07-31T16:00:00Z'),
    });
    return root;
  }

  async function runCli(
    userHome: string,
    args: string[],
    capture: CaptureProcess,
  ): Promise<string> {
    const output: string[] = [];
    const program = createProgram({
      writeOut: (value) => output.push(value),
      captureProcess: capture,
      spawnProcess: async () => ({ exitCode: 0 }),
    });
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });

    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    program.exitOverride();

    await program.parseAsync(['node', 'ccps', ...args], { from: 'node' });
    return output.join('');
  }

  function recordingCapture(    results: Array<{ stdout?: string; exitCode?: number }> = [],
  ): { calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>; capture: CaptureProcess } {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const capture: CaptureProcess = async (_command, args, options) => {
      calls.push({ args, env: options.env });
      const result = results.shift() ?? {};
      return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? '', stderr: '', timedOut: false };
    };
    return { calls, capture };
  }

  it('delegates plugin list with CLAUDE_CONFIG_DIR set to the profile claude-home', async () => {
    const userHome = await makeUserHome();
    const claudeHome = getProfileTemplatePaths(join(userHome, '.cc-profile-switch'), 'coding').claudeHomePath;
    const { calls, capture } = recordingCapture([{ stdout: '[]' }]);

    const output = await runCli(userHome, ['plugin', 'list', 'coding'], capture);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['plugin', 'list', '--json']);
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(claudeHome);
    expect(output).toContain('No plugins installed for profile "coding"');
  });

  it('delegates plugin list --available and install with --config', async () => {
    const userHome = await makeUserHome();
    const { calls, capture } = recordingCapture([
      { stdout: JSON.stringify({ installed: [], available: [] }) },
      {},
    ]);

    await runCli(userHome, ['plugin', 'list', 'coding', '--available'], capture);
    await runCli(userHome, ['plugin', 'install', 'coding', 'p@m', '--config', 'model=fast'], capture);

    expect(calls[0].args).toEqual(['plugin', 'list', '--available', '--json']);
    expect(calls[1].args).toEqual(['plugin', 'install', 'p@m', '--scope', 'user', '--config', 'model=fast']);
  });

  it('surfaces the restart notice on plugin update', async () => {
    const userHome = await makeUserHome();
    const { capture } = recordingCapture([
      { stdout: '✔ Plugin "p" updated from 0.1.0 to 0.2.0. Restart to apply changes.' },
    ]);

    const output = await runCli(userHome, ['plugin', 'update', 'coding', 'p@m'], capture);

    expect(output).toContain('Restart to apply changes.');
  });

  it('surfaces file:// marketplace rejection as an error', async () => {
    const userHome = await makeUserHome();
    const { capture } = recordingCapture();

    await expect(
      runCli(userHome, ['plugin', 'marketplace', 'add', 'coding', 'file:///tmp/x'], capture),
    ).rejects.toMatchObject({ code: 'PLUGIN_MARKETPLACE_FILE_URL_REJECTED' });
  });

  it('prints the Recovery item id after plugin uninstall', async () => {
    const userHome = await makeUserHome();
    const { capture } = recordingCapture([
      { stdout: '[]' }, // list before uninstall
      { stdout: '✔ Successfully uninstalled plugin' },
    ]);

    const output = await runCli(userHome, ['plugin', 'uninstall', 'coding', 'p@m', '--config-key', 'apiKey'], capture);

    expect(output).toContain('Uninstalled p@m for profile "coding"');
    expect(output).toMatch(/Recovery item: \d{8}T\d{6}-coding-p-m/);
  });

  it('lists the Recovery Bin and restores a plugin item through the wired handler', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    // Seed a plugin Recovery item directly through the core service.
    const { createPluginItem } = await import('../src/core/recovery-bin');
    const item = await createPluginItem({
      appHomePath: appHome,
      origin: 'remove',
      profile: 'coding',
      coordinates: { plugin: 'p', marketplace: 'm', enabled: false },
      clock: () => new Date('2026-07-31T16:13:29.000Z'),
    });
    // Declare the marketplace so restore passes the presence check.
    const claudeHome = getProfileTemplatePaths(appHome, 'coding').claudeHomePath;
    await fs.writeJson(join(claudeHome, 'settings.json'), {
      extraKnownMarketplaces: { m: { source: { source: 'directory', path: '/tmp/m' } } },
    });

    const { capture } = recordingCapture([
      {}, // install
      { stdout: JSON.stringify([{ id: 'p@m', version: '0.9.0', enabled: false }]) }, // list
    ]);

    const listOutput = await runCli(userHome, ['bin', 'list'], capture);
    expect(listOutput).toContain(item.id);

    const restoreOutput = await runCli(userHome, ['bin', 'restore', item.id], capture);
    expect(restoreOutput).toContain(`Restored p@m version 0.9.0 (marketplace current).`);
    expect(restoreOutput).toContain('Restored item for profile "coding"');
  });

  it('asserts real-home isolation through a real spawned subprocess', async () => {
    const userHome = await makeUserHome();
    const appHome = join(userHome, '.cc-profile-switch');
    const claudeHome = getProfileTemplatePaths(appHome, 'coding').claudeHomePath;

    // A plausible real Claude home with a sentinel; must stay untouched.
    const realClaudeDir = join(userHome, '.claude');
    await fs.ensureDir(realClaudeDir);
    await fs.writeFile(join(realClaudeDir, 'sentinel.txt'), 'real-home', 'utf8');

    // A real node subprocess that records the env it actually received and
    // answers as the plugin CLI would (stdout is parsed by listPlugins).
    const scriptPath = join(userHome, 'record-claude.mjs');
    const recordPath = join(userHome, 'recorded.json');
    await fs.writeFile(
      scriptPath,
      `import fs from 'node:fs';\nfs.writeFileSync(process.env.RECORD_PATH, JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, argv: process.argv.slice(2) }));\nprocess.stdout.write('[]');\n`,
      'utf8',
    );

    const capture: CaptureProcess = async (_command, _args, options) => {
      const sub = await realCaptureProcess(process.execPath, [scriptPath], {
        cwd: options.cwd,
        shell: false,
        env: { ...options.env, RECORD_PATH: recordPath },
        timeoutMs: 10000,
      });
      return { exitCode: sub.exitCode ?? 0, stdout: sub.stdout, stderr: sub.stderr, timedOut: sub.timedOut };
    };

    await runCli(userHome, ['plugin', 'list', 'coding'], capture);

    const recorded = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    expect(recorded.configDir).toBe(claudeHome);
    // The real home was never pointed at: it still holds only the sentinel.
    const realClaudeEntries = await fs.readdir(realClaudeDir);
    expect(realClaudeEntries).toEqual(['sentinel.txt']);
    expect(await fs.readFile(join(realClaudeDir, 'sentinel.txt'), 'utf8')).toBe('real-home');
  });
});
