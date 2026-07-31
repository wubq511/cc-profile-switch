/**
 * Packaging gate probe for the Ink 7 ESM Workbench prototype (issue #36).
 *
 * Proves the real shipping path: npm-pack the package, install the tarball
 * into a fresh project, verify headless CLI invariants on the installed
 * package, lazy-load the bundled ESM Ink gate with piped stdio (default and
 * screen-reader forms), and run the deterministic Vitest suite 5 times.
 * Evidence lands in probe-output/; exits non-zero when any gate fails, so
 * hosted Windows and macOS runs are directly comparable.
 *
 * Usage: npm run probe:ink-gate
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fs from 'fs-extra';

type GateEvidence = {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
};

const evidence: GateEvidence[] = [];
const repoRoot = process.cwd();
const outputDir = join(repoRoot, 'probe-output');
const nodeMajor = process.versions.node.split('.')[0];
const logPrefix = `ink-gate-${process.platform}-node${nodeMajor}`;

// Keep in sync with CJK_TEXT + CJK_END in src/tui/prototype-ink-gate/app.tsx.
const CJK_SENTINEL = 'INK-GATE:CJK:配置切换プロファイル│';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_SHOW = '\x1b[?25h';
const FOCUS_OFF = '\x1b[?1004l';

function record(name: string, status: 'pass' | 'fail', detail: string): void {
  evidence.push({ name, status, detail });
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

async function runGate(name: string, body: () => Promise<string>): Promise<void> {
  try {
    const detail = await body();
    record(name, 'pass', detail);
  } catch (error) {
    record(name, 'fail', error instanceof Error ? error.message : String(error));
  }
}

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function run(
  command: string,
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): RunResult {
  const result = spawnSync(command, args, {
    shell: false,
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ? Buffer.from(result.stdout).toString('utf8') : '',
    stderr: result.stderr ? Buffer.from(result.stderr).toString('utf8') : '',
    error: result.error,
  };
}

// npm on Windows is a .cmd shim that spawnSync(shell:false) cannot launch.
// When invoked via `npm run`, npm_execpath points at npm's CLI entry, which
// Node can execute directly on every platform.
function npmRun(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): RunResult {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }
  return run('npm', args, options);
}

function writeLog(name: string, content: string): void {
  writeFileSync(join(outputDir, `${logPrefix}-${name}.log`), content, 'utf8');
}

async function main(): Promise<void> {
  await fs.ensureDir(outputDir);
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'ccps-ink-gate-probe-'));
  console.log(`sandbox: ${sandboxRoot}`);

  // --- Gate 1: build ships the ESM bundle ------------------------------------

  await runGate('build-ships-esm-bundle', async () => {
    const build = npmRun(['run', 'build']);
    writeLog('build', build.stdout + build.stderr);
    assert(build.status === 0, `npm run build exited ${String(build.status)}`);
    const bundlePath = join(repoRoot, 'dist', 'ink-gate-workbench.mjs');
    assert(await fs.pathExists(bundlePath), 'dist/ink-gate-workbench.mjs missing after build');
    const stats = await fs.stat(bundlePath);
    return `dist/ink-gate-workbench.mjs present (${stats.size} bytes)`;
  });

  // --- Gate 2: npm pack + tarball install -------------------------------------

  const installDir = join(sandboxRoot, 'install-target');

  await runGate('npm-pack-and-install', async () => {
    const packDir = join(sandboxRoot, 'pack');
    await fs.ensureDir(packDir);
    const pack = npmRun(['pack', '--json', '--pack-destination', packDir]);
    writeLog('npm-pack', pack.stdout + pack.stderr);
    assert(pack.status === 0, `npm pack exited ${String(pack.status)}`);
    const packJson = JSON.parse(pack.stdout) as Array<{ filename: string }>;
    const tarball = join(packDir, packJson[0].filename);
    assert(await fs.pathExists(tarball), `tarball missing: ${tarball}`);

    await fs.ensureDir(installDir);
    await fs.writeJson(join(installDir, 'package.json'), {
      name: 'ink-gate-install-target',
      version: '0.0.0',
      private: true,
    });
    const install = npmRun(['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], {
      cwd: installDir,
    });
    writeLog('npm-install', install.stdout + install.stderr);
    assert(install.status === 0, `npm install exited ${String(install.status)}`);

    const installedDist = join(installDir, 'node_modules', 'cc-profile-switch', 'dist');
    assert(await fs.pathExists(join(installedDist, 'index.js')), 'installed dist/index.js missing');
    assert(
      await fs.pathExists(join(installedDist, 'ink-gate-workbench.mjs')),
      'installed dist/ink-gate-workbench.mjs missing — the ESM bundle must ship in the tarball',
    );
    return `installed ${packJson[0].filename} into a fresh project`;
  });

  const installedBin = join(installDir, 'node_modules', 'cc-profile-switch', 'dist', 'index.js');

  // --- Gate 3: headless CLI invariants on the INSTALLED package ----------------
  // Frozen by issue #34: command surface, exit codes, stdout/stderr split.

  const cliCases: Array<{
    name: string;
    args: string[];
    expectStatus: number;
    check: (result: RunResult) => void;
  }> = [
    {
      name: '--version',
      args: ['--version'],
      expectStatus: 0,
      check: (result) => {
        assert(/^\d+\.\d+\.\d+/.test(result.stdout.trim()), 'version output missing');
      },
    },
    {
      name: '--help',
      args: ['--help'],
      expectStatus: 0,
      check: (result) => {
        assert(result.stdout.includes('Usage: ccps'), 'help missing on stdout');
      },
    },
    {
      name: 'unknown-command',
      args: ['definitely-not-a-command'],
      expectStatus: 1,
      check: () => undefined,
    },
    {
      name: 'bare-non-tty',
      args: [],
      expectStatus: 1,
      check: (result) => {
        assert(result.stdout === '', 'bare invocation must not write to stdout');
        assert(result.stderr.includes('Usage: ccps'), 'help must go to stderr on bare invocation');
      },
    },
  ];

  for (const cliCase of cliCases) {
    await runGate(`cli-invariant-${cliCase.name}`, async () => {
      const result = run(process.execPath, [installedBin, ...cliCase.args]);
      writeLog(`cli-${cliCase.name}`, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert(
        result.status === cliCase.expectStatus,
        `exit ${String(result.status)}, expected ${cliCase.expectStatus}`,
      );
      cliCase.check(result);
      return `exit ${cliCase.expectStatus} as frozen by issue #34`;
    });
  }

  // --- Gate 4: lazy ESM load from the installed package (piped stdio) ---------

  let autorunOutput = '';
  await runGate('lazy-esm-autorun', async () => {
    const result = run(process.execPath, [installedBin], {
      env: {
        CCPS_INK_GATE: '1',
        CCPS_INK_GATE_AUTORUN: '1',
      },
    });
    autorunOutput = result.stdout + result.stderr;
    writeLog('autorun', autorunOutput);
    assert(result.error === undefined, `spawn error: ${String(result.error)}`);
    assert(result.status === 0, `exit ${String(result.status)}`);
    assert(autorunOutput.includes('INK-GATE:RENDERED'), 'INK-GATE:RENDERED missing');
    assert(autorunOutput.includes(CJK_SENTINEL), 'CJK sentinel not byte-exact');
    assert(autorunOutput.includes('INK-GATE:CLEANUP-OK'), 'INK-GATE:CLEANUP-OK missing');
    assert(autorunOutput.includes(ALT_OFF), 'alternate-screen leave missing');
    assert(autorunOutput.includes(CURSOR_SHOW), 'cursor show missing');
    assert(autorunOutput.includes(FOCUS_OFF), 'focus-reporting off missing');
    assert(autorunOutput.includes('INK-GATE prototype · issue #36'), 'gate frame missing');
    return 'exit 0, sentinels + CJK byte-exact + cleanup sequences present';
  });

  await runGate('lazy-esm-screen-reader', async () => {
    const result = run(process.execPath, [installedBin], {
      env: {
        CCPS_INK_GATE: '1',
        CCPS_INK_GATE_AUTORUN: '1',
        INK_SCREEN_READER: 'true',
      },
    });
    const output = result.stdout + result.stderr;
    writeLog('autorun-screen-reader', output);
    assert(result.status === 0, `exit ${String(result.status)}`);
    assert(output.includes('INK-GATE:SCREEN-READER'), 'INK-GATE:SCREEN-READER missing');
    assert(output.includes('INK-GATE screen-reader summary'), 'screen-reader frame missing');
    assert(output !== autorunOutput, 'screen-reader output must differ from default autorun');
    assert(output.includes('INK-GATE:CLEANUP-OK'), 'cleanup incomplete in screen-reader mode');
    return 'Ink screen-reader mode changes the rendered output';
  });

  // --- Gate 5: deterministic Vitest, 5 runs -------------------------------------

  await runGate('vitest-deterministic-x5', async () => {
    const vitestBin = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
    assert(await fs.pathExists(vitestBin), 'node_modules/vitest/vitest.mjs missing');
    const summaries: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = run(process.execPath, [vitestBin, 'run', 'test/prototype-ink-gate.test.tsx']);
      writeLog(`vitest-run-${attempt}`, result.stdout + result.stderr);
      assert(result.status === 0, `vitest run ${attempt} exited ${String(result.status)}`);
      const testsLine = result.stdout
        .split('\n')
        .find((line) => line.includes('Tests') && line.includes('passed'));
      assert(testsLine !== undefined, `vitest run ${attempt} summary missing`);
      summaries.push(testsLine.trim());
    }
    assert(
      summaries.every((summary) => summary === summaries[0]),
      `vitest summaries differ: ${summaries.join(' | ')}`,
    );
    return `5/5 runs passed with identical summary: ${summaries[0]}`;
  });

  // --- Evidence report -----------------------------------------------------------

  const failed = evidence.filter((entry) => entry.status === 'fail');
  const reportPath = join(outputDir, `${logPrefix}.md`);
  const lines = [
    `# Ink packaging gate proof — ${process.platform} / Node.js ${process.versions.node}`,
    '',
    `Run at: ${new Date().toISOString()}`,
    `Result: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${evidence.length - failed.length}/${evidence.length} gates)`,
    '',
    '| Gate | Status | Detail |',
    '| --- | --- | --- |',
    ...evidence.map(
      (entry) =>
        `| ${entry.name} | ${entry.status === 'pass' ? 'PASS' : 'FAIL'} | ${entry.detail.replace(/\|/g, '\\|')} |`,
    ),
    '',
    'Raw logs: `probe-output/' + `${logPrefix}-*.log\` (build, npm pack, install, CLI, autorun, vitest).`,
    '',
  ];
  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`evidence written to ${reportPath}`);
  console.log(`${evidence.length - failed.length}/${evidence.length} gates passed`);

  await fs.rm(sandboxRoot, { recursive: true, force: true });

  if (failed.length > 0) {
    console.error(`probe failed: ${failed.map((entry) => entry.name).join(', ')}`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
