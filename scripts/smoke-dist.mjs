/**
 * Offline smoke of the built distribution (issue #112, spec static/packaging
 * boundary). Runs AFTER `npm run build` and asserts the packaging contracts:
 *
 *  1. CLI (CJS, dist/index.js): `--help` and `--version` exit 0 offline.
 *  2. Workbench (ESM, dist/workbench.mjs): the bundle loads and its render
 *     loop stays alive against a throwaway app home (no real-home writes),
 *     distinguishing a module-configuration failure (crash at load) from a
 *     runtime concern.
 *
 * Deliberately dependency-free Node (no tsx/esbuild), so it can run in any
 * checkout/CI that just built dist/.
 */
/* global console, setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`SMOKE FAIL: ${message}`);
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(args) {
  return runNode([path.join(repoRoot, 'dist', 'index.js'), ...args], {
    ...process.env,
    NO_COLOR: '1',
  });
}

// Throwaway app home: an empty temp dir stands in for $HOME so the smoke
// never touches the real user configuration.
function sandboxEnv() {
  const sandboxHome = mkdtempSync(path.join(tmpdir(), 'ccps-smoke-home-'));
  return {
    env: {
      ...process.env,
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      NO_COLOR: '1',
    },
    sandboxHome,
  };
}

async function smokeCliHelpVersion() {
  const help = await runCli(['--help']);
  if (help.code !== 0) fail(`dist/index.js --help exited ${help.code}`);
  if (!/Usage:|ccps/i.test(help.stdout + help.stderr)) {
    fail('dist/index.js --help printed no usage text');
  }

  const version = await runCli(['--version']);
  if (version.code !== 0) fail(`dist/index.js --version exited ${version.code}`);
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const expected = `${packageJson.version}\n`;
  if (version.stdout !== expected && version.stdout.trim() !== packageJson.version) {
    fail(`dist/index.js --version printed "${version.stdout.trim()}", expected ${packageJson.version}`);
  }
  console.log(`SMOKE ok: dist/index.js --help (exit ${help.code}) and --version (${packageJson.version})`);
}

/** Load the Workbench ESM bundle headless and tell a module-configuration
 *  failure apart from a runtime concern (spec static/packaging boundary):
 *
 *  - "alive after settle": the Ink render loop is up — full pass.
 *  - early exit with Ink's EXACT known non-TTY message (thrown by Ink's
 *    render once main() already ran): every import resolved and startup
 *    reached the render call, so the module configuration is sound — the
 *    exit is environmental (CI has no TTY), not a load failure. The match
 *    is the precise thrown text, not a loose pattern, so a genuine startup
 *    crash (e.g. a TypeError mentioning stdin APIs) still fails.
 *  - early exit with anything else (loader errors, top-level crashes, other
 *    WORKBENCH_ERROR causes): a real module/startup failure — fail.
 *
 *  The sandbox home is initialized through the real CJS bin (`ccps init`)
 *  first — the Workbench requires an existing config.json and never reads
 *  the real user configuration. */
const INK_NON_TTY_MESSAGE = 'Raw mode is not supported on the current process.stdin';

const MODULE_FAILURE_PATTERN =
  /Cannot find (module|package)|ERR_MODULE|ERR_PACKAGE|SyntaxError|does not provide an export/i;

async function smokeWorkbenchLoad() {
  const { env, sandboxHome } = sandboxEnv();

  const init = await runNode([path.join(repoRoot, 'dist', 'index.js'), 'init'], env);
  if (init.code !== 0) {
    fail(`sandbox ccps init exited ${init.code}: ${(init.stderr + init.stdout).slice(0, 400)}`);
    rmSync(sandboxHome, { recursive: true, force: true });
    return;
  }

  const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'workbench.mjs')], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const SETTLE_MS = 4000;
  const earlyExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SETTLE_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (earlyExit === null) child.kill('SIGKILL');
  rmSync(sandboxHome, { recursive: true, force: true });

  const nonTtyLimitation = stderr.includes(INK_NON_TTY_MESSAGE);
  if (MODULE_FAILURE_PATTERN.test(stderr)) {
    fail(`dist/workbench.mjs module-graph failure: ${stderr.slice(0, 400)}`);
  } else if (earlyExit !== null && !nonTtyLimitation) {
    fail(
      `dist/workbench.mjs exited early (code ${earlyExit}) — module load or startup crashed. stderr: ${stderr.slice(0, 400)}`,
    );
  } else {
    console.log(
      earlyExit === null
        ? 'SMOKE ok: dist/workbench.mjs loaded and stayed alive (workbench entry up)'
        : 'SMOKE ok: dist/workbench.mjs module graph loaded (exited on known non-TTY runtime limitation, not a load failure)',
    );
  }
}

await smokeCliHelpVersion();
await smokeWorkbenchLoad();

if (failures.length > 0) {
  console.error(`\nsmoke-dist: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('smoke-dist: all checks passed');
