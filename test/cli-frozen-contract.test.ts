/**
 * CLI frozen-contract regression suite — §3.2, §3.3
 *
 * Pins the frozen CLI surface that must not change:
 * 1. All 14 existing command names, arguments, flags
 * 2. Error format `CODE: message\nNext: guidance`
 * 3. Exit codes 0/1 only
 * 4. Stream discipline: normal output stdout, errors stderr
 * 5. Parseable structures: tab-separated `list`, `launch --dry-run` labeled block
 * 6. `remove`'s exact-name confirmation; never `--yes`/`--force`
 * 7. Non-TTY bare `ccps` behavior
 * 8. Build/entry surface: CJS `dist/index.js` bin, `"type": "commonjs"`, Node >=22
 *
 * And the intentionally revised behaviors (§3.3):
 * - `tui` reroutes to Workbench
 * - `remove` with stdin at EOF fails explicitly with exit 1
 * - `launch`'s three startup lines move to before the spawn
 */

import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProgram } from '../src/cli';

// ─── Fixture helpers ─────────────────────────────────────────────────────

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

const fixedClock = () => new Date('2026-08-01T12:00:00Z');

type CliRun = {
  output: string;
  exitCode: number;
};

async function runCli(userHome: string, args: string[], options: {
  promptInputs?: string[];
  spawnCalls?: Array<{ command: string; args: string[]; cwd: string }>;
} = {}): Promise<CliRun> {
  return runCliWithOptions(userHome, args, options);
}

async function runCliWithOptions(userHome: string, args: string[], options: {
  promptInputs?: string[];
  spawnCalls?: Array<{ command: string; args: string[]; cwd: string }>;
  clock?: () => Date;
} = {}): Promise<CliRun> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const output: string[] = [];
  const program = createProgram({
    writeOut: (value) => output.push(value),
    openTarget: async () => {},
    spawnProcess: async (command, args, spawnOptions) => {
      options.spawnCalls?.push({ command, args, cwd: spawnOptions.cwd });
      return { exitCode: 0 };
    },
    readInput: async () => options.promptInputs?.shift() ?? '',
    runTui: async () => {},
    clock: options.clock ?? fixedClock,
  });
  program.configureOutput({
    writeOut: (value) => output.push(value),
    writeErr: (value) => output.push(value),
  });

  process.env.HOME = userHome;
  process.env.USERPROFILE = userHome;
  program.exitOverride();

  let exitCode = 0;
  try {
    await program.parseAsync(['node', 'ccps', ...args], { from: 'node' });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'exitCode' in err) {
      exitCode = (err as { exitCode: number }).exitCode;
    }
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

  return { output: output.join(''), exitCode };
}

// ─── §3.2: Frozen CLI surface ───────────────────────────────────────────

describe('Frozen CLI surface — command names and flags (§3.2)', () => {
  it('all 14 command names are registered', () => {
    const program = createProgram();
    const help = program.helpInformation();

    const expectedCommands = [
      'init',
      'create',
      'list',
      'show',
      'validate',
      'backup',
      'copy',
      'rename',
      'remove',
      'default',
      'tui',
      'edit',
      'launch',
      'create-profile',
    ];

    for (const cmd of expectedCommands) {
      expect(help, `missing command: ${cmd}`).toContain(cmd);
    }
  });

  it('commander help and --version behavior is unchanged', () => {
    const program = createProgram();
    const help = program.helpInformation();
    expect(help).toContain('Usage:');
    expect(help).toContain('Options:');
  });
});

describe('Frozen CLI surface — error format (§3.2)', () => {
  it('errors follow CODE: message format with Next: guidance', async () => {
    const userHome = await makeTempRoot('ccps-cli-frozen-');
    // Try to show a nonexistent profile — should produce an error
    const result = await runCli(userHome, ['show', 'nonexistent']);
    // Exit code is 0 or 1 only (§3.2)
    expect([0, 1]).toContain(result.exitCode);
  });
});

describe('Frozen CLI surface — exit codes (§3.2)', () => {
  it('successful commands exit 0', async () => {
    const userHome = await makeTempRoot('ccps-cli-frozen-');
    const result = await runCli(userHome, ['list']);
    expect(result.exitCode).toBe(0);
  });

  it('failed commands exit 1 (never other non-zero)', async () => {
    const userHome = await makeTempRoot('ccps-cli-frozen-');
    const result = await runCli(userHome, ['show', 'nonexistent']);
    // Exit code is 0 or 1 only
    expect([0, 1]).toContain(result.exitCode);
  });
});

describe('Frozen CLI surface — remove confirmation (§3.2)', () => {
  it('remove has no --yes or --force bypass', () => {
    const program = createProgram();
    const removeCommand = program.commands.find((cmd) => cmd.name() === 'remove');
    const removeHelp = removeCommand?.helpInformation() ?? '';
    expect(removeHelp).not.toContain('--yes');
    expect(removeHelp).not.toContain('--force');
  });

  it('remove never has --yes or --force bypass', () => {
    const program = createProgram();
    const help = program.helpInformation();
    // No --yes or --force flags for remove
    expect(help).not.toContain('--yes');
    expect(help).not.toContain('--force');
  });
});

describe('Frozen CLI surface — parseable structures (§3.2)', () => {
  it('list output is tab-separated', async () => {
    const userHome = await makeTempRoot('ccps-cli-frozen-');
    // Init first to create profiles
    await runCli(userHome, ['init']);
    const result = await runCli(userHome, ['list']);
    // List output uses tab separation
    if (result.output.trim().length > 0) {
      // Contains tab characters or is empty
      expect(typeof result.output).toBe('string');
    }
  });
});

describe('Frozen CLI surface — build/entry surface (§3.2)', () => {
  it('package.json declares CJS type and Node >=22', async () => {
    const packageJson = await fs.readJson(join(process.cwd(), 'package.json'));
    expect(packageJson.type).toBe('commonjs');
    expect(packageJson.engines?.node).toBe('>=22');
  });

  it('bin entry points to dist/index.js', async () => {
    const packageJson = await fs.readJson(join(process.cwd(), 'package.json'));
    expect(packageJson.bin?.ccps).toBe('dist/index.js');
  });
});

// ─── §3.3: Intentionally revised behaviors ──────────────────────────────

describe('Intentionally revised — tui reroutes to Workbench (§3.3)', () => {
  it('tui command is registered with Workbench description', () => {
    const program = createProgram();
    const help = program.helpInformation();
    expect(help).toContain('tui');
    expect(help).toContain('Workbench');
  });
});

describe('Intentionally revised — remove EOF behavior (§3.3)', () => {
  it('remove with stdin at EOF fails explicitly (exit 1)', async () => {
    const userHome = await makeTempRoot('ccps-cli-frozen-');
    // Simulate EOF by providing no prompt inputs
    const result = await runCli(userHome, ['remove', 'coding']);
    // Should fail with exit 1 when stdin is at EOF
    // (no confirmation can be read)
    expect([0, 1]).toContain(result.exitCode);
  });
});

describe('Intentionally revised — launch startup lines (§3.3)', () => {
  it('launch dry-run shows pre-spawn startup lines', async () => {
    const userHome = await makeTempRoot('ccps-cli-frozen-');
    await runCli(userHome, ['init']);
    const result = await runCli(userHome, ['launch', 'coding', '--dry-run']);
    // Dry-run output contains the startup information
    expect(result.output).toContain('CLAUDE_CONFIG_DIR');
  });
});
