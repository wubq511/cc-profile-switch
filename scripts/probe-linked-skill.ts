/**
 * Linked Skill directory probe (issue #49).
 *
 * Proves whether Claude Code discovers a Skill whose directory under
 * `claude-home/skills/` is a filesystem link pointing OUTSIDE
 * `CLAUDE_CONFIG_DIR`: a symlink on macOS/Linux, a junction on Windows.
 * The answer gates the physical realization of Linked Skill installation
 * under the provenance and transaction contract resolved in issue #38.
 *
 * Discovery is observed through the stream-json session init message, which
 * is emitted before any API call and therefore needs no credentials: the
 * probe forces a dummy ANTHROPIC_API_KEY, the model turn fails with 401, and
 * the init line's `skills` array is the evidence. This keeps the hosted
 * Windows run credential-free. macOS invocation evidence (the linked Skill
 * actually served its content through the link) is recorded separately in
 * docs/research/linked-skill-loading-probe.md.
 *
 * On Windows the contract-relevant primitive is the junction (absolute,
 * no admin required); a privileged directory symlink is attempted and
 * recorded but never required. On macOS/Linux absolute and relative
 * symlinks are probed. The script is cross-platform so local runs validate
 * the harness itself before the hosted Windows run exercises junctions.
 *
 * Exits non-zero when any proof fails, so clean macOS and hosted Windows
 * runs are directly comparable.
 *
 * Usage: npm run probe:linked-skill
 *        CLAUDE_CLI_BIN=<path-to-claude-binary> npm run probe:linked-skill
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { join, relative, resolve } from 'node:path';

type ScenarioEvidence = {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  durationMs: number;
};

type DiscoveryResult = {
  exitCode: number | null;
  initSkills: string[];
  initError?: string;
};

const IS_WINDOWS = platform() === 'win32';
const CLAUDE_BIN = process.env.CLAUDE_CLI_BIN ?? 'claude';
const DUMMY_API_KEY = 'ccps-linked-skill-probe-dummy-key';

const DIRECT_SKILL = 'ccps-direct-marker-skill';
const LINKED_SKILL = 'ccps-linked-marker-skill';
const REL_LINKED_SKILL = 'ccps-rel-linked-skill';
const WIN_SYMLINK_SKILL = 'ccps-win-symlink-skill';
const BROKEN_LINK = 'ccps-broken-link';
const FILE_LINK = 'ccps-file-link';

const logLines: string[] = [];
function log(line: string): void {
  logLines.push(line);
  console.log(line);
}

const evidence: ScenarioEvidence[] = [];
function record(
  name: string,
  status: ScenarioEvidence['status'],
  detail: string,
  durationMs: number,
): void {
  evidence.push({ name, status, detail, durationMs });
  log(`${status.toUpperCase()} ${name} — ${detail} (${durationMs}ms)`);
}

function skillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

function makeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'SKILL.md'), skillMarkdown(name, `Probe fixture ${name}`), 'utf8');
}

/** Run one print-mode session and capture the stream-json init skills list. */
function runDiscovery(configDir: string, cwd: string): DiscoveryResult {
  const result = spawnSync(
    CLAUDE_BIN,
    ['-p', 'hi', '--output-format', 'stream-json', '--verbose'],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: DUMMY_API_KEY,
      },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  const stdout = result.stdout ?? '';
  const initLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'));

  if (!initLine) {
    return {
      exitCode: result.status,
      initSkills: [],
      initError: `no stream-json init line; exit ${String(result.status)}; stderr: ${(result.stderr ?? '').slice(0, 300)}`,
    };
  }

  try {
    const init = JSON.parse(initLine) as { type?: string; subtype?: string; skills?: string[] };
    if (init.type === 'system' && init.subtype === 'init' && Array.isArray(init.skills)) {
      return { exitCode: result.status, initSkills: init.skills };
    }
    return {
      exitCode: result.status,
      initSkills: [],
      initError: `first json line is not an init message: ${initLine.slice(0, 200)}`,
    };
  } catch (error) {
    return {
      exitCode: result.status,
      initSkills: [],
      initError: `init line not parseable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type GuardSnapshot = Record<string, { missing: true } | { entries: string[] }>;

function snapshotGuardPaths(): GuardSnapshot {
  const home = homedir();
  const targets = [join(home, '.claude', 'skills'), join(home, '.agents')];
  const snapshot: GuardSnapshot = {};

  for (const target of targets) {
    if (!fs.existsSync(target)) {
      snapshot[target] = { missing: true };
      continue;
    }
    const entries: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const hash = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          entries.push(`${relative(target, full)}:${hash}`);
        }
      }
    };
    walk(target);
    snapshot[target] = { entries: entries.sort() };
  }
  return snapshot;
}

function main(): void {
  const started = Date.now();
  const probeRoot = fs.mkdtempSync(join(tmpdir(), 'ccps-linked-skill-probe-'));
  const outputDir = join(process.cwd(), 'probe-output');

  const configDir = join(probeRoot, 'claude-home');
  const skillsDir = join(configDir, 'skills');
  const sourceRoot = join(probeRoot, 'source-skills');
  const projectDir = join(probeRoot, 'project');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const guardBefore = snapshotGuardPaths();
  log(`probe root: ${probeRoot}`);
  log(`platform: ${platform()} (${process.arch}), node ${process.version}`);
  log(`claude binary: ${CLAUDE_BIN}`);

  const version = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8' });
  log(`claude version: ${(version.stdout ?? version.stderr ?? 'unknown').trim()}`);

  // --- Fixtures ---------------------------------------------------------------
  // Direct control: a real directory inside claude-home/skills.
  makeSkill(join(skillsDir, DIRECT_SKILL), DIRECT_SKILL);

  // Linked Skill: link target lives OUTSIDE CLAUDE_CONFIG_DIR.
  const linkedTarget = join(sourceRoot, LINKED_SKILL);
  makeSkill(linkedTarget, LINKED_SKILL);
  // Junctions are always absolute on Windows; use an absolute symlink elsewhere.
  fs.symlinkSync(
    resolve(linkedTarget),
    join(skillsDir, LINKED_SKILL),
    IS_WINDOWS ? 'junction' : 'dir',
  );

  // Relative symlink escaping claude-home (POSIX only; junctions are absolute-only).
  let relativeLinkCreated = false;
  if (!IS_WINDOWS) {
    const relTarget = join(sourceRoot, REL_LINKED_SKILL);
    makeSkill(relTarget, REL_LINKED_SKILL);
    fs.symlinkSync(
      join('..', '..', 'source-skills', REL_LINKED_SKILL),
      join(skillsDir, REL_LINKED_SKILL),
      'dir',
    );
    relativeLinkCreated = true;
  }

  // Privileged Windows directory symlink: attempt and record, never require.
  let winSymlinkState = 'skip';
  if (IS_WINDOWS) {
    const winTarget = join(sourceRoot, WIN_SYMLINK_SKILL);
    makeSkill(winTarget, WIN_SYMLINK_SKILL);
    try {
      fs.symlinkSync(resolve(winTarget), join(skillsDir, WIN_SYMLINK_SKILL), 'dir');
      winSymlinkState = 'created';
    } catch (error) {
      winSymlinkState = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Broken link: target does not exist.
  fs.symlinkSync(
    resolve(join(sourceRoot, 'does-not-exist')),
    join(skillsDir, BROKEN_LINK),
    IS_WINDOWS ? 'junction' : 'dir',
  );

  // Link to a plain file, not a skill directory.
  const plainFile = join(sourceRoot, 'plain-file.txt');
  fs.writeFileSync(plainFile, 'not a skill', 'utf8');
  fs.symlinkSync(resolve(plainFile), join(skillsDir, FILE_LINK), IS_WINDOWS ? 'junction' : 'file');

  log(`skills dir entries: ${fs.readdirSync(skillsDir).join(', ')}`);

  // --- Discovery run ------------------------------------------------------------
  const discovery = runDiscovery(configDir, projectDir);
  log(
    `discovery run: exit ${String(discovery.exitCode)}, skills: ${JSON.stringify(discovery.initSkills)}`,
  );
  if (discovery.initError) {
    log(`discovery init error: ${discovery.initError}`);
  }

  const discovered = new Set(discovery.initSkills);
  const startupHealthy = discovery.initError === undefined;

  // --- Scenarios ----------------------------------------------------------------

  record(
    'discovery-startup-healthy-with-links',
    startupHealthy ? 'pass' : 'fail',
    startupHealthy
      ? 'init message emitted with broken/file links present; broken and file links cause no startup failure'
      : (discovery.initError ?? 'unknown'),
    Date.now() - started,
  );

  record(
    'discovery-direct-control',
    discovered.has(DIRECT_SKILL) ? 'pass' : 'fail',
    discovered.has(DIRECT_SKILL)
      ? `${DIRECT_SKILL} discovered from a real directory`
      : `${DIRECT_SKILL} missing from init skills`,
    0,
  );

  record(
    IS_WINDOWS ? 'discovery-linked-junction' : 'discovery-linked-absolute-symlink',
    discovered.has(LINKED_SKILL) ? 'pass' : 'fail',
    discovered.has(LINKED_SKILL)
      ? `${LINKED_SKILL} discovered through a ${IS_WINDOWS ? 'junction' : 'absolute symlink'} escaping CLAUDE_CONFIG_DIR`
      : `${LINKED_SKILL} missing from init skills`,
    0,
  );

  if (IS_WINDOWS) {
    record(
      'discovery-linked-relative-symlink',
      'skip',
      'junctions are absolute-only on Windows; a relative-link install is not expressible',
      0,
    );
  } else {
    record(
      'discovery-linked-relative-symlink',
      relativeLinkCreated && discovered.has(REL_LINKED_SKILL) ? 'pass' : 'fail',
      discovered.has(REL_LINKED_SKILL)
        ? `${REL_LINKED_SKILL} discovered through a relative symlink escaping CLAUDE_CONFIG_DIR`
        : `${REL_LINKED_SKILL} missing from init skills`,
      0,
    );
  }

  if (IS_WINDOWS) {
    if (winSymlinkState === 'created') {
      record(
        'discovery-windows-dir-symlink',
        discovered.has(WIN_SYMLINK_SKILL) ? 'pass' : 'fail',
        discovered.has(WIN_SYMLINK_SKILL)
          ? `${WIN_SYMLINK_SKILL} discovered through a privileged directory symlink`
          : `${WIN_SYMLINK_SKILL} missing from init skills`,
        0,
      );
    } else {
      record(
        'discovery-windows-dir-symlink',
        'skip',
        `directory symlink not available in this environment (${winSymlinkState}); junction is the Windows primitive`,
        0,
      );
    }
  }

  record(
    'discovery-broken-link-ignored',
    startupHealthy && !discovered.has(BROKEN_LINK) ? 'pass' : 'fail',
    !discovered.has(BROKEN_LINK)
      ? 'broken link absent from init skills and silently ignored'
      : 'broken link surfaced as a skill',
    0,
  );

  record(
    'discovery-file-link-ignored',
    startupHealthy && !discovered.has(FILE_LINK) ? 'pass' : 'fail',
    !discovered.has(FILE_LINK)
      ? 'link to a plain file absent from init skills and silently ignored'
      : 'file link surfaced as a skill',
    0,
  );

  // --- Isolation guard ----------------------------------------------------------

  const guardAfter = snapshotGuardPaths();
  const changed = Object.keys(guardBefore).filter(
    (target) => JSON.stringify(guardBefore[target]) !== JSON.stringify(guardAfter[target]),
  );
  record(
    'isolation-real-home-untouched',
    changed.length === 0 ? 'pass' : 'fail',
    changed.length === 0
      ? 'real ~/.claude/skills and ~/.agents unchanged (or still absent)'
      : `guard paths changed: ${changed.join(', ')}`,
    0,
  );

  // --- Evidence output ------------------------------------------------------------

  fs.mkdirSync(outputDir, { recursive: true });
  const nodeMajor = process.versions.node.split('.')[0];
  const report = {
    probe: 'linked-skill-loading',
    issue: 49,
    claudeVersion: (version.stdout ?? '').trim(),
    node: process.version,
    platform: platform(),
    arch: process.arch,
    linkPrimitive: IS_WINDOWS ? 'junction' : 'symlink',
    windowsDirSymlink: IS_WINDOWS ? winSymlinkState : 'n/a',
    discovery: {
      exitCode: discovery.exitCode,
      initSkills: discovery.initSkills,
      initError: discovery.initError,
    },
    runAt: new Date().toISOString(),
    scenarios: evidence,
  };
  const reportPath = join(outputDir, `linked-skill-proof-${platform()}-node${nodeMajor}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    join(outputDir, `linked-skill-proof-${platform()}-log.txt`),
    `${logLines.join('\n')}\n`,
    'utf8',
  );

  const failed = evidence.filter((entry) => entry.status === 'fail');
  log(`evidence written to ${reportPath}`);
  log(`${evidence.length - failed.length}/${evidence.length} scenarios passed`);
  fs.rmSync(probeRoot, { recursive: true, force: true });

  if (failed.length > 0) {
    console.error(`probe failed: ${failed.map((entry) => entry.name).join(', ')}`);
    process.exit(1);
  }
}

main();
