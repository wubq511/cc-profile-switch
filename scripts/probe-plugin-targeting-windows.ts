/**
 * Windows re-run of the plugin lifecycle Profile-targeting probe (issue #45,
 * macOS original: issue #42 / docs/research/plugin-lifecycle-profile-targeting-probe.md).
 *
 * Runs the `claude plugin` / `claude plugin marketplace` lifecycle headless with
 * CLAUDE_CONFIG_DIR=<temp-profile>/claude-home on a hosted Windows machine and
 * proves that every operation reads and writes only the selected Profile:
 * the real user Claude directory (%USERPROFILE%\.claude, %USERPROFILE%\.claude.json,
 * %USERPROFILE%\.claude\settings.json) is baseline-hashed before the probe and
 * re-verified after every single command.
 *
 * The claude CLI is invoked as its native binary directly (path supplied via
 * CLAUDE_CLI_BIN) so the probe never depends on platform shim resolution
 * (.cmd/.ps1). The npm package ships the same native binary at
 * bin/claude.exe on every platform.
 *
 * Exits non-zero when any operation escapes the selected Profile, so the hosted
 * Windows run is directly comparable to the macOS evidence.
 *
 * Usage: CLAUDE_CLI_BIN=<path-to-claude-binary> npm run probe:plugins-windows
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { join, relative } from 'node:path';

type FileHashes = Map<string, string>;

type TreeDiff = {
  added: string[];
  modified: string[];
  removed: string[];
};

type StepEvidence = {
  id: number;
  label: string;
  argv: string[];
  exitCode: number;
  durationMs: number;
  profileWrites: TreeDiff;
  realHomeGuardedWrites: TreeDiff;
  realHomeNoiseChanges: TreeDiff;
  realDotfilesChanged: string[];
};

// Session-noise directories Claude Code maintains for its own runtime state.
// They are tracked separately from plugin/config state, exactly as in #42:
// excluded from the per-step guarded watch but verified over the whole window.
const SESSION_NOISE_DIRS = new Set([
  'projects',
  'todos',
  'sessions',
  'history',
  'shell-snapshots',
  'statsig',
  'ide',
  '__store',
  'debug',
]);

const PROBE_MARKETPLACE = 'probe-marketplace';
const PROBE_PLUGIN = 'probe-plugin';
const PLUGIN_REF = `${PROBE_PLUGIN}@${PROBE_MARKETPLACE}`;
const GITHUB_MARKETPLACE_SOURCE = 'wubq511/agy-plugin-cc';
const GITHUB_MARKETPLACE_NAME = 'agy-plugin-cc';

const logLines: string[] = [];
function log(line: string): void {
  logLines.push(line);
  console.log(line);
}

function hashFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashTree(root: string): FileHashes | null {
  if (!fs.existsSync(root)) {
    return null;
  }
  const hashes: FileHashes = new Map();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        hashes.set(relative(root, full), hashFile(full) as string);
      }
    }
  };
  walk(root);
  return hashes;
}

function splitNoise(tree: FileHashes | null): { guarded: FileHashes; noise: FileHashes } {
  const guarded: FileHashes = new Map();
  const noise: FileHashes = new Map();
  if (tree) {
    for (const [rel, hash] of tree) {
      const top = rel.split(/[\\/]/)[0];
      (SESSION_NOISE_DIRS.has(top) ? noise : guarded).set(rel, hash);
    }
  }
  return { guarded, noise };
}

function diffTrees(before: FileHashes | null, after: FileHashes | null): TreeDiff {
  const prior = before ?? new Map();
  const current = after ?? new Map();
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [rel, hash] of current) {
    if (!prior.has(rel)) {
      added.push(rel);
    } else if (prior.get(rel) !== hash) {
      modified.push(rel);
    }
  }
  for (const rel of prior.keys()) {
    if (!current.has(rel)) {
      removed.push(rel);
    }
  }
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}

function diffSummary(diff: TreeDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`+${diff.added.length} [${diff.added.join(', ')}]`);
  if (diff.modified.length > 0)
    parts.push(`~${diff.modified.length} [${diff.modified.join(', ')}]`);
  if (diff.removed.length > 0) parts.push(`-${diff.removed.length} [${diff.removed.join(', ')}]`);
  return parts.length === 0 ? 'none' : parts.join(' ');
}

async function main(): Promise<void> {
  const claudeCliBin = process.env.CLAUDE_CLI_BIN;
  if (!claudeCliBin || !fs.existsSync(claudeCliBin)) {
    throw new Error(
      `CLAUDE_CLI_BIN must point at the installed claude native binary (got: ${claudeCliBin ?? 'unset'})`,
    );
  }

  const home = homedir();
  const realClaudeDir = join(home, '.claude');
  const realDotfiles = [join(home, '.claude.json'), join(realClaudeDir, 'settings.json')];

  const probeRoot = fs.mkdtempSync(join(tmpdir(), 'ccps-plugin-probe-win-'));
  const claudeHome = join(probeRoot, 'profile', 'claude-home');
  const marketplaceDir = join(probeRoot, 'dir-marketplace');
  fs.mkdirSync(claudeHome, { recursive: true });

  const writePluginVersion = (version: string): void => {
    fs.mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(join(marketplaceDir, PROBE_PLUGIN, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(
        {
          name: PROBE_MARKETPLACE,
          owner: { name: 'ccps-probe' },
          plugins: [
            {
              name: PROBE_PLUGIN,
              source: `./${PROBE_PLUGIN}`,
              description: 'Windows targeting probe fixture',
            },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      join(marketplaceDir, PROBE_PLUGIN, '.claude-plugin', 'plugin.json'),
      JSON.stringify(
        { name: PROBE_PLUGIN, version, description: 'Windows targeting probe fixture' },
        null,
        2,
      ),
    );
  };
  writePluginVersion('0.1.0');

  const versionResult = spawnSync(claudeCliBin, ['--version'], {
    encoding: 'utf8',
  });

  log('# Plugin lifecycle Profile-targeting probe — Windows re-run (issue #45)');
  log(`platform: ${platform()} (${process.arch}), node: ${process.version}`);
  log(`claude CLI: ${String(versionResult.stdout).trim()} (${claudeCliBin})`);
  log(`probe root: ${probeRoot}`);
  log(`CLAUDE_CONFIG_DIR: ${claudeHome}`);
  log(`real home under guard: ${realClaudeDir}`);
  log('');

  // Baseline of the real user Claude directory before any command runs.
  let realTree = hashTree(realClaudeDir);
  let { guarded: realGuarded, noise: realNoise } = splitNoise(realTree);
  const baselineGuarded = new Map(realGuarded);
  const baselineNoise = new Map(realNoise);
  const baselineDotfiles = new Map(realDotfiles.map((f) => [f, hashFile(f)]));
  let profileTree: FileHashes | null = hashTree(claudeHome);

  log(
    `baseline: real .claude ${realTree ? `${realTree.size} files` : 'absent'}; ` +
      realDotfiles.map((f) => `${f}: ${baselineDotfiles.get(f) ?? 'absent'}`).join('; '),
  );
  log('');

  const steps: StepEvidence[] = [];
  const persistenceObserved = new Set<string>();
  let stepId = 0;

  const runStep = (label: string, argv: string[]): void => {
    stepId += 1;
    const beforeGuarded = realGuarded;
    const beforeNoise = realNoise;
    const beforeProfile = profileTree;
    const beforeDotfiles = new Map(realDotfiles.map((f) => [f, hashFile(f)]));

    const started = Date.now();
    const result = spawnSync(claudeCliBin, argv, {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome },
    });
    const durationMs = Date.now() - started;
    const exitCode = result.status ?? -1;

    realTree = hashTree(realClaudeDir);
    ({ guarded: realGuarded, noise: realNoise } = splitNoise(realTree));
    profileTree = hashTree(claudeHome);

    const step: StepEvidence = {
      id: stepId,
      label,
      argv,
      exitCode,
      durationMs,
      profileWrites: diffTrees(beforeProfile, profileTree),
      realHomeGuardedWrites: diffTrees(beforeGuarded, realGuarded),
      realHomeNoiseChanges: diffTrees(beforeNoise, realNoise),
      realDotfilesChanged: realDotfiles.filter((f) => hashFile(f) !== beforeDotfiles.get(f)),
    };
    steps.push(step);

    for (const rel of [...step.profileWrites.added, ...step.profileWrites.modified]) {
      persistenceObserved.add(rel);
    }

    log(`## step ${step.id}: claude ${argv.join(' ')} — exit ${exitCode} (${durationMs}ms)`);
    if (exitCode !== 0) {
      log(`stdout: ${String(result.stdout).trim()}`);
      log(`stderr: ${String(result.stderr).trim()}`);
    }
    log(`profile writes: ${diffSummary(step.profileWrites)}`);
    log(`real-home guarded writes: ${diffSummary(step.realHomeGuardedWrites)}`);
    log(`real-home noise changes: ${diffSummary(step.realHomeNoiseChanges)}`);
    log(
      `real dotfiles changed: ${step.realDotfilesChanged.length === 0 ? 'none' : step.realDotfilesChanged.join(', ')}`,
    );
    log('');
  };

  const plugin = (...args: string[]): string[] => ['plugin', ...args];

  // Directory-source marketplace lifecycle + plugin lifecycle (mirrors #42 steps 1–18).
  runStep('plugin list --json (empty)', plugin('list', '--json'));
  runStep('plugin list --available --json', plugin('list', '--available', '--json'));
  runStep('plugin marketplace list (empty)', plugin('marketplace', 'list'));
  runStep('plugin marketplace add <local-dir>', plugin('marketplace', 'add', marketplaceDir));
  runStep('plugin marketplace list', plugin('marketplace', 'list'));
  runStep('plugin list --available --json (after add)', plugin('list', '--available', '--json'));
  runStep(
    `plugin install ${PLUGIN_REF} --scope user`,
    plugin('install', PLUGIN_REF, '--scope', 'user'),
  );
  runStep('plugin list --json', plugin('list', '--json'));
  runStep(`plugin disable ${PLUGIN_REF}`, plugin('disable', PLUGIN_REF));
  runStep(`plugin enable ${PLUGIN_REF}`, plugin('enable', PLUGIN_REF));
  runStep(`plugin update ${PLUGIN_REF} (no newer version)`, plugin('update', PLUGIN_REF));

  // Real 0.1.0 -> 0.2.0 update path (mirrors #42 steps 13–16).
  writePluginVersion('0.2.0');
  runStep(
    `plugin marketplace update ${PROBE_MARKETPLACE} (source bumped to 0.2.0)`,
    plugin('marketplace', 'update', PROBE_MARKETPLACE),
  );
  runStep(`plugin update ${PLUGIN_REF} (0.1.0 -> 0.2.0)`, plugin('update', PLUGIN_REF));
  runStep('plugin list --json (shows 0.2.0)', plugin('list', '--json'));
  runStep(`plugin uninstall ${PLUGIN_REF} (0.2.0)`, plugin('uninstall', PLUGIN_REF));
  runStep(
    `plugin marketplace remove ${PROBE_MARKETPLACE}`,
    plugin('marketplace', 'remove', PROBE_MARKETPLACE),
  );
  runStep('plugin marketplace list (empty again)', plugin('marketplace', 'list'));

  // GitHub-source marketplace lifecycle (mirrors #42 steps 23–25).
  runStep(
    `plugin marketplace add ${GITHUB_MARKETPLACE_SOURCE} (GitHub source)`,
    plugin('marketplace', 'add', GITHUB_MARKETPLACE_SOURCE),
  );
  runStep(
    `plugin marketplace update ${GITHUB_MARKETPLACE_NAME}`,
    plugin('marketplace', 'update', GITHUB_MARKETPLACE_NAME),
  );
  runStep(
    `plugin marketplace remove ${GITHUB_MARKETPLACE_NAME}`,
    plugin('marketplace', 'remove', GITHUB_MARKETPLACE_NAME),
  );

  // Whole-window verification against the baseline.
  const finalGuardedDiff = diffTrees(baselineGuarded, realGuarded);
  const finalNoiseDiff = diffTrees(baselineNoise, realNoise);
  const finalDotfilesChanged = realDotfiles.filter((f) => hashFile(f) !== baselineDotfiles.get(f));

  const guardedEscapes = steps.filter(
    (s) =>
      s.realHomeGuardedWrites.added.length > 0 ||
      s.realHomeGuardedWrites.modified.length > 0 ||
      s.realHomeGuardedWrites.removed.length > 0 ||
      s.realDotfilesChanged.length > 0,
  );
  const failedCommands = steps.filter((s) => s.exitCode !== 0);

  const finalSettingsPath = join(claudeHome, 'settings.json');
  const finalInstalledPath = join(claudeHome, 'plugins', 'installed_plugins.json');
  const finalKnownPath = join(claudeHome, 'plugins', 'known_marketplaces.json');

  log('# Whole-window verification');
  log(`guarded real-home diff vs baseline: ${diffSummary(finalGuardedDiff)}`);
  log(`noise real-home diff vs baseline: ${diffSummary(finalNoiseDiff)}`);
  log(
    `real dotfiles changed vs baseline: ${finalDotfilesChanged.length === 0 ? 'none' : finalDotfilesChanged.join(', ')}`,
  );
  log('');
  log('# Profile persistence files observed across the probe');
  for (const rel of [...persistenceObserved].sort()) {
    log(`- ${rel}`);
  }
  log('');
  for (const [label, filePath] of [
    ['final profile settings.json', finalSettingsPath],
    ['final installed_plugins.json', finalInstalledPath],
    ['final known_marketplaces.json', finalKnownPath],
  ] as const) {
    log(`# ${label}`);
    log(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '(absent)');
    log('');
  }

  const verdict =
    guardedEscapes.length === 0 &&
    finalDotfilesChanged.length === 0 &&
    finalGuardedDiff.added.length === 0 &&
    finalGuardedDiff.modified.length === 0 &&
    finalGuardedDiff.removed.length === 0 &&
    failedCommands.length === 0;

  log(`# Verdict: ${verdict ? 'PASS' : 'FAIL'}`);
  if (guardedEscapes.length > 0) {
    log(`guarded escapes at steps: ${guardedEscapes.map((s) => s.id).join(', ')}`);
  }
  if (failedCommands.length > 0) {
    log(`non-zero exits at steps: ${failedCommands.map((s) => s.id).join(', ')}`);
  }
  if (
    finalNoiseDiff.added.length + finalNoiseDiff.modified.length + finalNoiseDiff.removed.length >
    0
  ) {
    log(
      'note: session-noise directories changed in the real home over the probe window (see above)',
    );
  }

  const outputDir = join(process.cwd(), 'probe-output');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    join(outputDir, 'plugin-targeting-windows-evidence.json'),
    JSON.stringify(
      {
        ticket: 45,
        platform: platform(),
        arch: process.arch,
        node: process.version,
        claudeCli: String(versionResult.stdout).trim(),
        probeRoot,
        claudeHome,
        baseline: {
          realClaudeFileCount: baselineGuarded.size + baselineNoise.size,
          realClaudeAbsentAtBaseline: baselineGuarded.size === 0 && baselineNoise.size === 0,
          dotfiles: Object.fromEntries(baselineDotfiles),
        },
        steps,
        finalGuardedDiff,
        finalNoiseDiff,
        finalDotfilesChanged,
        persistenceObserved: [...persistenceObserved].sort(),
        verdict,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(join(outputDir, 'plugin-targeting-windows-log.txt'), `${logLines.join('\n')}\n`);

  if (!verdict) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
