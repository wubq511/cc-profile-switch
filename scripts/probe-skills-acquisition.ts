/**
 * Empirical proof harness for the pinned Skills acquisition adapter (issue #39).
 *
 * Runs the acquisition matrix against fresh isolated staging directories and
 * records evidence: staged identity, real-home isolation, bounded archives,
 * offline classification, and exit behavior. Exits non-zero when any proof
 * fails, so clean macOS and hosted Windows runs are directly comparable.
 *
 * Usage: npm run probe:skills
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import fs from 'fs-extra';
import * as tar from 'tar';

import { acquireSkillIntoStaging, SKILLS_CLI_PINNED_VERSION } from '../src/core/skills-acquisition';
import { CcpsError } from '../src/utils/errors';

type GuardSnapshot = Record<string, { missing: true } | { entries: string[] }>;

type ScenarioEvidence = {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
  durationMs: number;
};

const evidence: ScenarioEvidence[] = [];

function record(name: string, status: 'pass' | 'fail', detail: string, durationMs: number): void {
  evidence.push({ name, status, detail, durationMs });
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} ${name} — ${detail} (${durationMs}ms)`);
}

async function runScenario(name: string, body: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await body();
    record(name, 'pass', detail, Date.now() - started);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    record(name, 'fail', detail, Date.now() - started);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

async function expectErrorCode(run: () => Promise<unknown>, code: string): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CcpsError && error.code === code) {
      return code;
    }
    throw new Error(
      `expected CcpsError ${code}, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
  throw new Error(`expected CcpsError ${code}, but the acquisition succeeded`);
}

async function snapshotGuardPaths(): Promise<GuardSnapshot> {
  const home = homedir();
  const targets = [join(home, '.claude', 'skills'), join(home, '.agents')];
  const snapshot: GuardSnapshot = {};

  for (const target of targets) {
    if (!(await fs.pathExists(target))) {
      snapshot[target] = { missing: true };
      continue;
    }

    const entries: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const stats = await fs.stat(full);
          entries.push(`${full}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
        }
      }
    }
    await walk(target);
    snapshot[target] = { entries: entries.sort() };
  }

  return snapshot;
}

async function readSkillFrontmatterName(skillDir: string): Promise<string | undefined> {
  const raw = await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() : undefined;
}

function skillMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function makeLocalSkill(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await fs.ensureDir(dir);
  await fs.writeFile(join(dir, 'SKILL.md'), skillMarkdown(name, `Probe fixture ${name}`), 'utf8');
  return dir;
}

async function makeTarGz(
  root: string,
  fileName: string,
  files: Record<string, string>,
): Promise<string> {
  const sourceDir = join(root, `${fileName}-src`);
  await fs.ensureDir(sourceDir);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(sourceDir, relative);
    await fs.ensureDir(join(target, '..'));
    await fs.writeFile(target, content, 'utf8');
  }
  const archivePath = join(root, fileName);
  await tar.create({ gzip: true, file: archivePath, cwd: sourceDir }, await fs.readdir(sourceDir));
  return archivePath;
}

type FixtureServer = { server: Server; port: number; close: () => Promise<void> };

async function startFixtureServer(routes: Record<string, Buffer | string>): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    const body = request.url ? routes[request.url] : undefined;
    if (body === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    response.writeHead(200, { 'content-length': payload.byteLength }).end(payload);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function main(): Promise<void> {
  const probeRoot = await fs.mkdtemp(join(tmpdir(), 'ccps-skills-probe-'));
  const outputDir = join(process.cwd(), 'probe-output');

  const guardBefore = await snapshotGuardPaths();
  console.log(`probe root: ${probeRoot}`);
  console.log(`guard paths: ${Object.keys(guardBefore).join(', ')}`);

  // --- Identity: supported remote and local source forms ---------------------

  const IDENTITY_SOURCES: Array<{
    label: string;
    source: string;
    skill?: string;
    expected: string;
  }> = [
    {
      label: 'github-shorthand',
      source: 'vercel-labs/skills',
      skill: 'find-skills',
      expected: 'find-skills',
    },
    {
      label: 'github-url',
      source: 'https://github.com/vercel-labs/skills',
      skill: 'find-skills',
      expected: 'find-skills',
    },
    {
      label: 'git-url',
      source: 'https://github.com/vercel-labs/skills.git',
      skill: 'find-skills',
      expected: 'find-skills',
    },
    {
      label: 'github-tree-url',
      source: 'https://github.com/vercel-labs/skills/tree/main/skills/find-skills',
      expected: 'find-skills',
    },
  ];

  for (const { label, source, skill, expected } of IDENTITY_SOURCES) {
    await runScenario(`identity-${label}`, async () => {
      const result = await acquireSkillIntoStaging({
        source,
        skill,
        stagingPath: join(probeRoot, `staging-${label}`),
      });

      assert(result.exitCode === 0, `exit code ${String(result.exitCode)}`);
      assert(
        result.stagedSkills.length === 1 && result.stagedSkills[0] === expected,
        `staged skills ${JSON.stringify(result.stagedSkills)}`,
      );
      const stagedName = await readSkillFrontmatterName(
        join(result.plan.stagedSkillsPath, expected),
      );
      assert(stagedName === expected, `frontmatter name ${String(stagedName)}`);

      const lockPath = join(result.plan.stateHomePath, 'skills', '.skill-lock.json');
      assert(await fs.pathExists(lockPath), `isolated lock missing at ${lockPath}`);

      return `staged ${expected} via ${source}; lock at ${lockPath}`;
    });
  }

  await runScenario('identity-local-path', async () => {
    const localSkill = await makeLocalSkill(probeRoot, 'probe-local-skill');
    const result = await acquireSkillIntoStaging({
      source: localSkill,
      stagingPath: join(probeRoot, 'staging-local'),
    });

    assert(result.stagedSkills.length === 1, `staged ${JSON.stringify(result.stagedSkills)}`);
    const stagedName = await readSkillFrontmatterName(
      join(result.plan.stagedSkillsPath, result.stagedSkills[0]),
    );
    assert(stagedName === 'probe-local-skill', `frontmatter name ${String(stagedName)}`);
    assert(await fs.pathExists(join(localSkill, 'SKILL.md')), 'local source must remain intact');
    const lockPath = join(result.plan.stateHomePath, 'skills', '.skill-lock.json');
    assert(
      !(await fs.pathExists(lockPath)),
      'local-path acquisition must not write an upstream lock',
    );

    return `staged ${result.stagedSkills[0]}; source intact; no upstream lock`;
  });

  // --- Direct URL sources, bounded archives (local fixture server) -----------

  const fixtureRoot = join(probeRoot, 'fixtures');
  await fs.ensureDir(fixtureRoot);
  const validArchive = await makeTarGz(fixtureRoot, 'skill.tar.gz', {
    'probe-archive-skill/SKILL.md': skillMarkdown('probe-archive-skill', 'Probe archive fixture'),
  });
  const bigArchive = await makeTarGz(fixtureRoot, 'big.tar.gz', {
    'probe-big-skill/SKILL.md': skillMarkdown('probe-big-skill', 'Probe oversize fixture'),
    // Random bytes keep the gzipped archive above the probed download limit.
    'probe-big-skill/payload.txt': randomBytes(8192).toString('base64'),
  });
  const manyFiles: Record<string, string> = {
    'probe-many-skill/SKILL.md': skillMarkdown('probe-many-skill', 'Probe file-count fixture'),
  };
  for (let index = 0; index < 10; index += 1) {
    manyFiles[`probe-many-skill/file-${index}.txt`] = `file ${index}`;
  }
  const manyArchive = await makeTarGz(fixtureRoot, 'many.tar.gz', manyFiles);

  const fixtures = await startFixtureServer({
    '/SKILL.md': skillMarkdown('probe-url-skill', 'Probe direct URL fixture'),
    '/skill.tar.gz': await fs.readFile(validArchive),
    '/big.tar.gz': await fs.readFile(bigArchive),
    '/many.tar.gz': await fs.readFile(manyArchive),
  });
  console.log(`fixture server on 127.0.0.1:${fixtures.port}`);

  await runScenario('identity-direct-skill-url', async () => {
    const result = await acquireSkillIntoStaging({
      source: `http://127.0.0.1:${fixtures.port}/SKILL.md`,
      stagingPath: join(probeRoot, 'staging-url'),
    });

    assert(result.stagedSkills.length === 1, `staged ${JSON.stringify(result.stagedSkills)}`);
    const stagedName = await readSkillFrontmatterName(
      join(result.plan.stagedSkillsPath, result.stagedSkills[0]),
    );
    assert(stagedName === 'probe-url-skill', `frontmatter name ${String(stagedName)}`);
    const lockPath = join(result.plan.stateHomePath, 'skills', '.skill-lock.json');
    assert(
      !(await fs.pathExists(lockPath)),
      'direct-URL acquisition must not write an upstream lock',
    );

    return `staged ${result.stagedSkills[0]}; no upstream lock`;
  });

  await runScenario('archive-valid', async () => {
    const result = await acquireSkillIntoStaging({
      source: `http://127.0.0.1:${fixtures.port}/skill.tar.gz`,
      stagingPath: join(probeRoot, 'staging-archive'),
    });

    assert(result.stagedSkills.length === 1, `staged ${JSON.stringify(result.stagedSkills)}`);
    const stagedName = await readSkillFrontmatterName(
      join(result.plan.stagedSkillsPath, result.stagedSkills[0]),
    );
    assert(stagedName === 'probe-archive-skill', `frontmatter name ${String(stagedName)}`);

    return `staged ${result.stagedSkills[0]} from tar.gz`;
  });

  await runScenario('archive-download-bytes-bounded', async () => {
    const stagingPath = join(probeRoot, 'staging-big');
    const code = await expectErrorCode(
      () =>
        acquireSkillIntoStaging({
          source: `http://127.0.0.1:${fixtures.port}/big.tar.gz`,
          stagingPath,
          extraEnv: { SKILLS_DOWNLOAD_MAX_BYTES: '2048' },
        }),
      'SKILLS_ACQUISITION_FAILED',
    );

    assert(
      !(await fs.pathExists(join(stagingPath, 'claude-home', 'skills', 'probe-big-skill'))),
      'oversize archive must not be staged',
    );
    return `rejected oversize download with ${code}; nothing staged`;
  });

  await runScenario('archive-file-count-bounded', async () => {
    const stagingPath = join(probeRoot, 'staging-many');
    const code = await expectErrorCode(
      () =>
        acquireSkillIntoStaging({
          source: `http://127.0.0.1:${fixtures.port}/many.tar.gz`,
          stagingPath,
          extraEnv: { SKILLS_EXTRACT_MAX_FILES: '5' },
        }),
      'SKILLS_ACQUISITION_FAILED',
    );

    assert(
      !(await fs.pathExists(join(stagingPath, 'claude-home', 'skills', 'probe-many-skill'))),
      'over-limit archive must not be staged',
    );
    return `rejected over-limit file count with ${code}; nothing staged`;
  });

  // --- Offline classification -------------------------------------------------

  const offlineEnv = {
    SKILLS_DOWNLOAD_URL: 'http://127.0.0.1:9',
    SKILLS_API_URL: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=2',
  };

  await runScenario('offline-remote-source-classified', async () => {
    const code = await expectErrorCode(
      () =>
        acquireSkillIntoStaging({
          source: 'vercel-labs/skills',
          skill: 'find-skills',
          stagingPath: join(probeRoot, 'staging-offline-remote'),
          extraEnv: offlineEnv,
        }),
      'SKILLS_ACQUISITION_OFFLINE',
    );

    return `remote acquisition under dead network classified ${code}`;
  });

  await runScenario('offline-direct-url-classified', async () => {
    const code = await expectErrorCode(
      () =>
        acquireSkillIntoStaging({
          source: 'http://127.0.0.1:9/SKILL.md',
          stagingPath: join(probeRoot, 'staging-offline-url'),
          extraEnv: offlineEnv,
        }),
      'SKILLS_ACQUISITION_OFFLINE',
    );

    return `dead direct URL classified ${code}`;
  });

  // --- Exit behavior and classifier negative control --------------------------

  await runScenario('exit-behavior-skill-not-found', async () => {
    const localSkill = await makeLocalSkill(probeRoot, 'probe-negative-skill');
    const code = await expectErrorCode(
      () =>
        acquireSkillIntoStaging({
          source: localSkill,
          skill: 'nonexistent-skill',
          stagingPath: join(probeRoot, 'staging-negative'),
        }),
      'SKILLS_ACQUISITION_FAILED',
    );

    return `unmatched --skill is a stable non-offline failure (${code})`;
  });

  await fixtures.close();

  // --- Isolation guard: the real Claude home must be untouched ----------------

  await runScenario('isolation-real-home-untouched', async () => {
    const guardAfter = await snapshotGuardPaths();
    const changed = Object.keys(guardBefore).filter(
      (target) => JSON.stringify(guardBefore[target]) !== JSON.stringify(guardAfter[target]),
    );
    assert(changed.length === 0, `guard paths changed: ${changed.join(', ')}`);

    return 'real ~/.claude/skills and ~/.agents unchanged (or still absent)';
  });

  // --- Evidence output ---------------------------------------------------------

  await fs.ensureDir(outputDir);
  const report = {
    probe: 'skills-acquisition-adapter',
    skillsCliVersion: SKILLS_CLI_PINNED_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runAt: new Date().toISOString(),
    scenarios: evidence,
  };
  const reportPath = join(
    outputDir,
    `skills-acquisition-proof-${process.platform}-node${process.versions.node.split('.')[0]}.json`,
  );
  await fs.writeJson(reportPath, report, { spaces: 2 });

  const failed = evidence.filter((entry) => entry.status === 'fail');
  console.log(`evidence written to ${reportPath}`);
  console.log(`${evidence.length - failed.length}/${evidence.length} scenarios passed`);
  await fs.rm(probeRoot, { recursive: true, force: true });

  if (failed.length > 0) {
    console.error(`probe failed: ${failed.map((entry) => entry.name).join(', ')}`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
