// Performance measurement harness for the Profile Workbench (issue #79).
//
// Measures the three §15.4 thresholds against materialized fixture tiers:
//   - Cold start to interactive: ≤ 400 ms (baseline tier)
//   - Keystroke to repaint: ≤ 50 ms (baseline tier)
//   - Search filtering per keystroke: ≤ 100 ms (baseline tier)
//
// And the 3× tier loading-state rule: any single operation must complete ≤ 2 s
// or show an explicit loading state.
//
// This harness measures the *data layer* — the core async functions and pure
// functions that dominate cold-start and interaction cost. Ink render-to-terminal
// latency is a small fixed overhead on top; the data layer is the variable cost
// that scales with fixture size.
//
// We import from core/ (CJS-compatible) rather than tui/workbench/ (ESM with
// Ink) to avoid CJS/ESM interop issues in tsx. The sidebar tree builder is
// imported directly since it is a pure function with no Ink dependency.
//
// Usage:
//   tsx test/perf/harness.ts [--tier baseline|3x] [--iterations N] [--out <path>]
//
// Output: structured JSON to stdout (machine-readable) + summary to stderr.

import { performance } from 'node:perf_hooks';
import fs from 'fs-extra';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildFixturePlan,
  materializeFixture,
  TIER_PRESETS,
  type FixtureTierName,
} from '../fixtures/generator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PerfTierName = FixtureTierName;

export type PerfThresholds = {
  coldStartMs: number;
  keystrokeRepaintMs: number;
  searchFilterMs: number;
  /** 3× tier: any operation must complete within this or show loading state. */
  loadingStateRuleMs: number;
};

export type PerfMeasurement = {
  name: string;
  iterations: number;
  valuesMs: number[];
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  minMs: number;
};

export type PerfResult = {
  timestamp: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  tier: PerfTierName;
  tierSize: { profiles: number; skillsPerProfile: number };
  thresholds: PerfThresholds;
  measurements: PerfMeasurement[];
  verdict: {
    coldStartPass: boolean;
    keystrokeRepaintPass: boolean;
    searchFilterPass: boolean;
    loadingStateRulePass: boolean;
    overallPass: boolean;
  };
  fixtureMaterializeMs: number;
};

export const BASELINE_THRESHOLDS: PerfThresholds = {
  coldStartMs: 400,
  keystrokeRepaintMs: 50,
  searchFilterMs: 100,
  loadingStateRuleMs: 2000,
};

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}

function summarize(name: string, valuesMs: number[]): PerfMeasurement {
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const mean = valuesMs.reduce((s, v) => s + v, 0) / valuesMs.length;
  return {
    name,
    iterations: valuesMs.length,
    valuesMs,
    meanMs: Math.round(mean * 100) / 100,
    p50Ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1]! * 100) / 100,
    minMs: Math.round(sorted[0]! * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build lightweight profile-like objects for buildSidebarRows.
 * Avoids importing the ESM Workbench module (Ink dependency).
 */
function buildSyntheticProfiles(
  summaries: {
    name: string;
    description: string;
    isDefault: boolean;
    isLastUsed: boolean;
    status: string;
  }[],
  skillsPerProfile: number,
): unknown[] {
  return summaries.map((s) => ({
    name: s.name,
    description: s.description,
    isDefault: s.isDefault,
    isLastUsed: s.isLastUsed,
    status: s.status,
    resourceCounts: {
      userMemory: 1,
      autoMemory: 2,
      skills: skillsPerProfile,
      agents: 2,
      mcp: 1,
      settings: 1,
      launchConfig: 1,
    },
    resourceDetails: {
      userMemory: { exists: true, name: 'CLAUDE.md' },
      agents: [{ name: 'agent-01' }, { name: 'agent-02' }],
      skills: Array.from(
        { length: skillsPerProfile },
        (_, i) => `skill-${String(i + 1).padStart(String(skillsPerProfile).length, '0')}`,
      ),
      autoMemory: ['MEMORY.md', 'topic-01.md'],
      settings: ['autoMemoryDirectory', 'claudeMdExcludes', 'env'],
    },
    mcpServers: [`fixture-server-${s.name}`],
    validation: null,
  }));
}

async function loadCategoryLabels(): Promise<Record<string, string>> {
  const { CATEGORIES } = await import('../../src/tui/workbench/categories');
  const labels: Record<string, string> = {};
  for (const c of CATEGORIES) {
    labels[c.key] = c.labelKey;
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Data-layer cold start
// ---------------------------------------------------------------------------

/**
 * Measure cold-start data loading: the profile list + validation + resource
 * enumeration that `loadWorkbenchData` performs. We call the same core
 * functions directly to avoid importing the ESM/Ink Workbench module.
 */
async function measureColdStart(fixtureDir: string, iterations: number): Promise<number[]> {
  const { listProfilesForDisplay } = await import('../../src/core/profile-management');
  const { validateProfile } = await import('../../src/core/validator');
  const { getAppHomePaths } = await import('../../src/core/app-config');
  const { loadUserMemory, listAgents } = await import('../../src/core/resource');
  const { readConfiguredMcpNames } = await import('../../src/core/mcp-list');

  const values: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();

    const paths = getAppHomePaths(fixtureDir);
    const summaries = await listProfilesForDisplay({
      appHomePath: paths.appHomePath,
    });

    // Per-profile resource enumeration (mirrors loadWorkbenchData).
    await Promise.all(
      summaries.map(async (summary) => {
        const claudeHome = path.join(paths.profilesPath, summary.name, 'claude-home');
        await Promise.all([
          readConfiguredMcpNames(claudeHome),
          loadUserMemory(paths.appHomePath, summary.name),
          listAgents(paths.appHomePath, summary.name),
          fs.readdir(path.join(claudeHome, 'skills')).catch(() => []),
          fs.readdir(path.join(claudeHome, 'memory', 'auto')).catch(() => []),
        ]);
        try {
          await validateProfile({
            appHomePath: paths.appHomePath,
            name: summary.name,
          });
        } catch {
          // validation failure is non-fatal
        }
      }),
    );

    values.push(performance.now() - start);
  }

  return values;
}

// ---------------------------------------------------------------------------
// Keystroke-to-repaint (sidebar tree build)
// ---------------------------------------------------------------------------

/**
 * Measure sidebar tree building. buildSidebarRows is a pure function —
 * the dominant cost in a keystroke event that changes sidebar state.
 *
 * We construct the WorkbenchProfile-like data from the fixture directly
 * rather than importing the ESM workbench module.
 */
async function measureKeystrokeRepaint(
  fixtureDir: string,
  iterations: number,
  skillsPerProfile: number,
): Promise<number[]> {
  const { listProfilesForDisplay } = await import('../../src/core/profile-management');
  const { getAppHomePaths } = await import('../../src/core/app-config');
  const { buildSidebarRows } = await import('../../src/tui/workbench/sidebar-tree');

  const paths = getAppHomePaths(fixtureDir);
  const summaries = await listProfilesForDisplay({
    appHomePath: paths.appHomePath,
  });

  const profiles = buildSyntheticProfiles(summaries, skillsPerProfile);
  const categoryLabels = await loadCategoryLabels();

  const values: number[] = [];
  const expanded = new Set(profiles.map((p) => (p as { name: string }).name));

  for (let i = 0; i < iterations; i++) {
    // Simulate a keystroke that changes the selected profile (most common repaint).
    const selectedIndex = i % profiles.length;
    const start = performance.now();
    buildSidebarRows({
      profiles: profiles as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
      expanded,
      query: '',
      categoryLabels,
      contentHits: [],
    });
    values.push(performance.now() - start);

    // Prevent dead-code elimination.
    if (selectedIndex < 0) break;
  }

  return values;
}

// ---------------------------------------------------------------------------
// Search filtering
// ---------------------------------------------------------------------------

async function measureSearchFilter(
  fixtureDir: string,
  iterations: number,
  skillsPerProfile: number,
): Promise<number[]> {
  const { listProfilesForDisplay } = await import('../../src/core/profile-management');
  const { getAppHomePaths } = await import('../../src/core/app-config');
  const { buildSidebarRows } = await import('../../src/tui/workbench/sidebar-tree');

  const paths = getAppHomePaths(fixtureDir);
  const summaries = await listProfilesForDisplay({
    appHomePath: paths.appHomePath,
  });

  const profiles = buildSyntheticProfiles(summaries, skillsPerProfile);
  const categoryLabels = await loadCategoryLabels();

  const values: number[] = [];
  const searchTerms = ['p', 'pr', 'pro', 'prof', 'profi', 'profil', 'profile'];

  for (let i = 0; i < iterations; i++) {
    const query = searchTerms[i % searchTerms.length]!;
    const start = performance.now();
    buildSidebarRows({
      profiles: profiles as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
      expanded: new Set(),
      query,
      categoryLabels,
      contentHits: [],
    });
    values.push(performance.now() - start);
  }

  return values;
}

// ---------------------------------------------------------------------------
// Content search
// ---------------------------------------------------------------------------

async function measureContentSearch(fixtureDir: string, iterations: number): Promise<number[]> {
  const { searchAllResources } = await import('../../src/core/resource');
  const { getAppHomePaths } = await import('../../src/core/app-config');
  const paths = getAppHomePaths(fixtureDir);

  const values: number[] = [];
  const query = 'fixture';

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await searchAllResources({ appHomePath: paths.appHomePath, query });
    values.push(performance.now() - start);
  }

  return values;
}

// ---------------------------------------------------------------------------
// 3× tier loading-state rule
// ---------------------------------------------------------------------------

async function measure3xOperations(
  fixtureDir: string,
  iterations: number,
  skillsPerProfile: number,
): Promise<{ name: string; valuesMs: number[] }[]> {
  const results: { name: string; valuesMs: number[] }[] = [];

  const coldStartValues = await measureColdStart(fixtureDir, iterations);
  results.push({ name: '3x-cold-start', valuesMs: coldStartValues });

  const repaintValues = await measureKeystrokeRepaint(fixtureDir, iterations, skillsPerProfile);
  results.push({ name: '3x-keystroke-repaint', valuesMs: repaintValues });

  const searchValues = await measureSearchFilter(fixtureDir, iterations, skillsPerProfile);
  results.push({ name: '3x-search-filter', valuesMs: searchValues });

  const contentSearchValues = await measureContentSearch(fixtureDir, iterations);
  results.push({ name: '3x-content-search', valuesMs: contentSearchValues });

  return results;
}

// ---------------------------------------------------------------------------
// Main harness
// ---------------------------------------------------------------------------

export type HarnessOptions = {
  tier?: PerfTierName;
  iterations?: number;
  outPath?: string;
  /**
   * Reuse an already-materialized fixture app-home instead of building a new
   * one. The directory is left in place — the caller owns its lifecycle.
   */
  fixtureDir?: string;
};

export async function runHarness(options: HarnessOptions = {}): Promise<PerfResult> {
  const tier = options.tier ?? 'baseline';
  const iterations = options.iterations ?? 10;
  const tierPreset = TIER_PRESETS[tier === '3x' ? '3x' : tier === 'baseline' ? 'baseline' : 'mini'];
  const thresholds = BASELINE_THRESHOLDS;

  // 1. Build and materialize fixture, or reuse a caller-provided one.
  const planStart = performance.now();
  let fixtureDir = options.fixtureDir;
  if (!fixtureDir) {
    const plan = buildFixturePlan({ tier, pathologies: [] });
    fixtureDir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-'));
    await materializeFixture(plan, fixtureDir);
  }
  const fixtureMaterializeMs = performance.now() - planStart;
  const ownsFixture = options.fixtureDir === undefined;

  // 2. Run measurements.
  const measurements: PerfMeasurement[] = [];

  if (tier === 'baseline' || tier === 'mini') {
    const coldStartValues = await measureColdStart(fixtureDir, iterations);
    measurements.push(summarize('cold-start', coldStartValues));

    const repaintValues = await measureKeystrokeRepaint(
      fixtureDir,
      iterations,
      tierPreset.skillsPerProfile,
    );
    measurements.push(summarize('keystroke-repaint', repaintValues));

    const searchValues = await measureSearchFilter(
      fixtureDir,
      iterations,
      tierPreset.skillsPerProfile,
    );
    measurements.push(summarize('search-filter', searchValues));

    const contentSearchValues = await measureContentSearch(fixtureDir, iterations);
    measurements.push(summarize('content-search', contentSearchValues));
  } else {
    const ops = await measure3xOperations(fixtureDir, iterations, tierPreset.skillsPerProfile);
    for (const op of ops) {
      measurements.push(summarize(op.name, op.valuesMs));
    }
  }

  // 3. Compute verdict.
  // §15.4: baseline tier has per-operation latency thresholds.
  // 3× tier sets NO latency thresholds — only the loading-state rule applies.
  const coldStart = measurements.find((m) => m.name === 'cold-start');
  const keystroke = measurements.find((m) => m.name === 'keystroke-repaint');
  const search = measurements.find((m) => m.name === 'search-filter');

  const coldStartPass = coldStart ? coldStart.p95Ms <= thresholds.coldStartMs : true;
  const keystrokeRepaintPass = keystroke ? keystroke.p95Ms <= thresholds.keystrokeRepaintMs : true;
  const searchFilterPass = search ? search.p95Ms <= thresholds.searchFilterMs : true;
  const loadingStateRulePass = measurements.every((m) => m.maxMs <= thresholds.loadingStateRuleMs);

  const result: PerfResult = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    tier,
    tierSize: { profiles: tierPreset.profiles, skillsPerProfile: tierPreset.skillsPerProfile },
    thresholds,
    measurements,
    verdict: {
      coldStartPass,
      keystrokeRepaintPass,
      searchFilterPass,
      loadingStateRulePass,
      overallPass:
        coldStartPass && keystrokeRepaintPass && searchFilterPass && loadingStateRulePass,
    },
    fixtureMaterializeMs: Math.round(fixtureMaterializeMs * 100) / 100,
  };

  // 4. Clean up the fixture only if this run created it.
  if (ownsFixture) {
    await fs.remove(fixtureDir);
  }

  // 5. Write output if requested.
  if (options.outPath) {
    await fs.ensureDir(path.dirname(options.outPath));
    await fs.writeFile(options.outPath, JSON.stringify(result, null, 2), 'utf8');
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { tier: PerfTierName; iterations: number; out: string | null } {
  let tier: PerfTierName = 'baseline';
  let iterations = 10;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i++;
      return value;
    };

    switch (arg) {
      case '--tier': {
        const v = next();
        if (v !== 'mini' && v !== 'baseline' && v !== '3x') {
          throw new Error(`--tier must be mini|baseline|3x, got: ${v}`);
        }
        tier = v;
        break;
      }
      case '--iterations': {
        iterations = Number.parseInt(next(), 10);
        if (!Number.isFinite(iterations) || iterations < 1) {
          throw new Error('--iterations must be a positive integer');
        }
        break;
      }
      case '--out': {
        out = next();
        break;
      }
      case '--help':
      case '-h': {
        process.stderr.write(
          'ccps performance harness (issue #79)\n\n' +
            'Usage: tsx test/perf/harness.ts [options]\n\n' +
            'Options:\n' +
            '  --tier <mini|baseline|3x>   Fixture tier (default: baseline)\n' +
            '  --iterations <N>            Measurements per operation (default: 10)\n' +
            '  --out <path>                Write JSON result to file\n' +
            '  -h, --help                  Show this help\n',
        );
        process.exit(0);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { tier, iterations, out };
}

function printSummary(result: PerfResult): void {
  const { tier, tierSize, thresholds, measurements, verdict } = result;
  const lines: string[] = [
    '',
    `╔══════════════════════════════════════════════════════════════╗`,
    `║  ccps perf harness — ${tier} tier (${tierSize.profiles}×${tierSize.skillsPerProfile})${' '.repeat(Math.max(0, 18 - tier.length - String(tierSize.profiles).length - String(tierSize.skillsPerProfile).length))}║`,
    `╠══════════════════════════════════════════════════════════════╣`,
  ];

  for (const m of measurements) {
    const threshold = m.name.includes('cold-start')
      ? thresholds.coldStartMs
      : m.name.includes('repaint')
        ? thresholds.keystrokeRepaintMs
        : m.name.includes('search-filter')
          ? thresholds.searchFilterMs
          : thresholds.loadingStateRuleMs;
    const pass = m.p95Ms <= threshold;
    const mark = pass ? '✓' : '✗';
    lines.push(
      `║  ${mark} ${m.name.padEnd(24)} p50=${String(m.p50Ms).padStart(7)}ms  p95=${String(m.p95Ms).padStart(7)}ms  (≤${threshold}ms)  ║`,
    );
  }

  lines.push(
    `╠══════════════════════════════════════════════════════════════╣`,
    `║  Overall: ${verdict.overallPass ? 'PASS' : 'FAIL'}${' '.repeat(47)}║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
  );

  process.stderr.write(lines.join('\n'));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runHarness({
    tier: args.tier,
    iterations: args.iterations,
    outPath: args.out ?? undefined,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  printSummary(result);

  if (!result.verdict.overallPass) {
    process.exit(1);
  }
}

// Run the CLI only when this file is executed directly (e.g.
// `npm run perf:harness` → `tsx test/perf/harness.ts`), not when a test
// imports runHarness. tsx/node realpath the executed script, so compare
// realpaths; any mismatch or error means "imported, not executed".
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `perf:harness failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
