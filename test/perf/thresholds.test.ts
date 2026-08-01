// Performance threshold tests for the Profile Workbench (issue #79).
//
// These tests exercise the perf harness against the fixture tiers and assert
// the §15.4 thresholds. They run in CI alongside the rest of the test suite.
//
// Note: CI runners are noisy — the spec explicitly says "hosted-runner noise
// produces false alarms" and thresholds are measured "at the real-machine
// release gate". These tests therefore use generous CI multipliers and
// primarily validate that the measurement infrastructure works and that
// the data layer is in the right ballpark. Real-machine acceptance uses
// the CLI harness (tsx test/perf/harness.ts) directly.

import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import fs from 'fs-extra';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildFixturePlan,
  materializeFixture,
} from '../fixtures/generator';

// ---------------------------------------------------------------------------
// Fixture generation tests
// ---------------------------------------------------------------------------

describe('fixture tier sizes (issue #79)', () => {
  it('baseline tier produces 20 profiles × 50 skills', () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    expect(plan.tier.profiles).toBe(20);
    expect(plan.tier.skillsPerProfile).toBe(50);
    expect(plan.summary.healthyProfileCount).toBe(20);
    expect(plan.summary.pathologyProfileCount).toBe(0);
  });

  it('3× tier produces 60 profiles × 150 skills', () => {
    const plan = buildFixturePlan({ tier: '3x', pathologies: [] });
    expect(plan.tier.profiles).toBe(60);
    expect(plan.tier.skillsPerProfile).toBe(150);
    expect(plan.summary.healthyProfileCount).toBe(60);
    expect(plan.summary.pathologyProfileCount).toBe(0);
  });

  it('baseline plan has correct total skill count', () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    expect(plan.summary.skillCount).toBe(20 * 50);
  });

  it('3× plan has correct total skill count', () => {
    const plan = buildFixturePlan({ tier: '3x', pathologies: [] });
    expect(plan.summary.skillCount).toBe(60 * 150);
  });
});

// ---------------------------------------------------------------------------
// Fixture materialization performance
// ---------------------------------------------------------------------------

describe('fixture materialization timing (issue #79)', () => {
  it('baseline tier materializes in < 5 s', async () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      const start = performance.now();
      await materializeFixture(plan, dir);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await fs.remove(dir);
    }
  });

  it('3× tier materializes in < 30 s', async () => {
    const plan = buildFixturePlan({ tier: '3x', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      const start = performance.now();
      await materializeFixture(plan, dir);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(30000);
    } finally {
      await fs.remove(dir);
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Data-layer performance (baseline tier)
// ---------------------------------------------------------------------------

describe('data-layer performance — baseline tier (issue #79)', () => {
  // CI multiplier: CI runners are 3-10× slower than real machines for I/O.
  // The spec thresholds are for real machines; we use generous bounds here
  // to catch regressions without CI false alarms.
  const CI_MULTIPLIER = 10;

  it('loadWorkbenchData completes within threshold', async () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      await materializeFixture(plan, dir);

      // Measure the same core functions that loadWorkbenchData calls.
      const { listProfilesForDisplay } = await import('../../src/core/profile-management');
      const { validateProfile } = await import('../../src/core/validator');
      const { getAppHomePaths } = await import('../../src/core/app-config');
      const { loadUserMemory, listAgents } = await import('../../src/core/resource');
      const { readConfiguredMcpNames } = await import('../../src/core/mcp-list');

      const start = performance.now();
      const paths = getAppHomePaths(dir);
      const summaries = await listProfilesForDisplay({ appHomePath: paths.appHomePath });
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
            await validateProfile({ appHomePath: paths.appHomePath, name: summary.name });
          } catch {
            // non-fatal
          }
        }),
      );
      const elapsed = performance.now() - start;

      // Real-machine threshold: 400 ms. CI: 400 × 10 = 4000 ms.
      expect(elapsed).toBeLessThan(400 * CI_MULTIPLIER);
    } finally {
      await fs.remove(dir);
    }
  });

  it('buildSidebarRows completes within keystroke-repaint threshold', async () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      await materializeFixture(plan, dir);

      const { loadWorkbenchData } = await import('../../src/tui/workbench/profile-data');
      const { buildSidebarRows } = await import('../../src/tui/workbench/sidebar-tree');
      const { CATEGORIES } = await import('../../src/tui/workbench/categories');

      const data = await loadWorkbenchData(dir);
      const categoryLabels: Record<string, string> = {};
      for (const c of CATEGORIES) {
        categoryLabels[c.key] = c.labelKey;
      }
      const expanded = new Set(data.profiles.map((p) => p.name));

      const start = performance.now();
      buildSidebarRows({
        profiles: data.profiles,
        expanded,
        query: '',
        categoryLabels,
        contentHits: [],
      });
      const elapsed = performance.now() - start;

      // Real-machine threshold: 50 ms. CI: 50 × 10 = 500 ms.
      expect(elapsed).toBeLessThan(50 * CI_MULTIPLIER);
    } finally {
      await fs.remove(dir);
    }
  });

  it('buildSidebarRows with search query completes within threshold', async () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      await materializeFixture(plan, dir);

      const { loadWorkbenchData } = await import('../../src/tui/workbench/profile-data');
      const { buildSidebarRows } = await import('../../src/tui/workbench/sidebar-tree');
      const { CATEGORIES } = await import('../../src/tui/workbench/categories');

      const data = await loadWorkbenchData(dir);
      const categoryLabels: Record<string, string> = {};
      for (const c of CATEGORIES) {
        categoryLabels[c.key] = c.labelKey;
      }

      const start = performance.now();
      buildSidebarRows({
        profiles: data.profiles,
        expanded: new Set(),
        query: 'profile',
        categoryLabels,
        contentHits: [],
      });
      const elapsed = performance.now() - start;

      // Real-machine threshold: 100 ms. CI: 100 × 10 = 1000 ms.
      expect(elapsed).toBeLessThan(100 * CI_MULTIPLIER);
    } finally {
      await fs.remove(dir);
    }
  });

  it('searchAllResources completes within threshold', async () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      await materializeFixture(plan, dir);

      const { searchAllResources } = await import('../../src/core/resource');
      const { getAppHomePaths } = await import('../../src/core/app-config');
      const paths = getAppHomePaths(dir);

      const start = performance.now();
      await searchAllResources({ appHomePath: paths.appHomePath, query: 'fixture' });
      const elapsed = performance.now() - start;

      // Content search is async I/O; generous CI bound.
      expect(elapsed).toBeLessThan(100 * CI_MULTIPLIER);
    } finally {
      await fs.remove(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 3× tier loading-state rule
// ---------------------------------------------------------------------------

describe('3× tier loading-state rule (issue #79)', () => {
  // The 3× tier sets no latency thresholds; any single operation must
  // complete ≤ 2 s or show an explicit loading state. We verify the
  // data layer completes within 2 s × CI multiplier.

  const LOADING_STATE_THRESHOLD_MS = 2000;
  const CI_MULTIPLIER = 10;

  it('loadWorkbenchData completes within 2 s × CI multiplier', async () => {
    const plan = buildFixturePlan({ tier: '3x', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      await materializeFixture(plan, dir);

      const { listProfilesForDisplay } = await import('../../src/core/profile-management');
      const { validateProfile } = await import('../../src/core/validator');
      const { getAppHomePaths } = await import('../../src/core/app-config');
      const { loadUserMemory, listAgents } = await import('../../src/core/resource');
      const { readConfiguredMcpNames } = await import('../../src/core/mcp-list');

      const start = performance.now();
      const paths = getAppHomePaths(dir);
      const summaries = await listProfilesForDisplay({ appHomePath: paths.appHomePath });
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
            await validateProfile({ appHomePath: paths.appHomePath, name: summary.name });
          } catch {
            // non-fatal
          }
        }),
      );
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(LOADING_STATE_THRESHOLD_MS * CI_MULTIPLIER);
    } finally {
      await fs.remove(dir);
    }
  }, 30000);

  it('buildSidebarRows completes within 2 s × CI multiplier', async () => {
    const plan = buildFixturePlan({ tier: '3x', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      await materializeFixture(plan, dir);

      const { listProfilesForDisplay } = await import('../../src/core/profile-management');
      const { getAppHomePaths } = await import('../../src/core/app-config');
      const { buildSidebarRows } = await import('../../src/tui/workbench/sidebar-tree');
      const { CATEGORIES } = await import('../../src/tui/workbench/categories');

      const paths = getAppHomePaths(dir);
      const summaries = await listProfilesForDisplay({ appHomePath: paths.appHomePath });
      const profiles = summaries.map((s) => ({
        name: s.name, description: s.description, isDefault: s.isDefault,
        isLastUsed: s.isLastUsed, status: s.status,
        resourceCounts: { userMemory: 1, autoMemory: 2, skills: 150, agents: 2, mcp: 1, settings: 1, launchConfig: 1 },
        resourceDetails: {
          userMemory: { exists: true, name: 'CLAUDE.md' },
          agents: [{ name: 'agent-01' }, { name: 'agent-02' }],
          skills: Array.from({ length: 150 }, (_, i) => `skill-${String(i + 1).padStart(3, '0')}`),
          autoMemory: ['MEMORY.md', 'topic-01.md'],
          settings: ['autoMemoryDirectory', 'claudeMdExcludes', 'env'],
        },
        mcpServers: [`fixture-server-${s.name}`],
        validation: null,
      }));
      const categoryLabels: Record<string, string> = {};
      for (const c of CATEGORIES) { categoryLabels[c.key] = c.labelKey; }
      const expanded = new Set(profiles.map((p) => p.name));

      const start = performance.now();
      buildSidebarRows({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        profiles: profiles as any, expanded, query: '', categoryLabels, contentHits: [],
      });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(LOADING_STATE_THRESHOLD_MS * CI_MULTIPLIER);
    } finally {
      await fs.remove(dir);
    }
  }, 30000);

  it('search filtering completes within 2 s × CI multiplier', async () => {
    const plan = buildFixturePlan({ tier: '3x', pathologies: [] });
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-perf-test-'));
    try {
      await materializeFixture(plan, dir);

      const { listProfilesForDisplay } = await import('../../src/core/profile-management');
      const { getAppHomePaths } = await import('../../src/core/app-config');
      const { buildSidebarRows } = await import('../../src/tui/workbench/sidebar-tree');
      const { CATEGORIES } = await import('../../src/tui/workbench/categories');

      const paths = getAppHomePaths(dir);
      const summaries = await listProfilesForDisplay({ appHomePath: paths.appHomePath });
      const profiles = summaries.map((s) => ({
        name: s.name, description: s.description, isDefault: s.isDefault,
        isLastUsed: s.isLastUsed, status: s.status,
        resourceCounts: { userMemory: 1, autoMemory: 2, skills: 150, agents: 2, mcp: 1, settings: 1, launchConfig: 1 },
        resourceDetails: {
          userMemory: { exists: true, name: 'CLAUDE.md' },
          agents: [{ name: 'agent-01' }, { name: 'agent-02' }],
          skills: Array.from({ length: 150 }, (_, i) => `skill-${String(i + 1).padStart(3, '0')}`),
          autoMemory: ['MEMORY.md', 'topic-01.md'],
          settings: ['autoMemoryDirectory', 'claudeMdExcludes', 'env'],
        },
        mcpServers: [`fixture-server-${s.name}`],
        validation: null,
      }));
      const categoryLabels: Record<string, string> = {};
      for (const c of CATEGORIES) { categoryLabels[c.key] = c.labelKey; }

      const start = performance.now();
      buildSidebarRows({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        profiles: profiles as any, expanded: new Set(), query: 'profile', categoryLabels, contentHits: [],
      });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(LOADING_STATE_THRESHOLD_MS * CI_MULTIPLIER);
    } finally {
      await fs.remove(dir);
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Harness infrastructure tests
// ---------------------------------------------------------------------------

describe('perf harness infrastructure (issue #79)', () => {
  it('runHarness returns valid result structure', async () => {
    const { runHarness } = await import('./harness');
    const result = await runHarness({ tier: 'mini', iterations: 2 });

    expect(result.platform).toBe(process.platform);
    expect(result.nodeVersion).toBe(process.version);
    expect(result.tier).toBe('mini');
    expect(result.measurements.length).toBeGreaterThan(0);
    expect(result.verdict).toBeDefined();
    expect(result.fixtureMaterializeMs).toBeGreaterThan(0);

    for (const m of result.measurements) {
      expect(m.iterations).toBe(2);
      expect(m.valuesMs.length).toBe(2);
      expect(m.meanMs).toBeGreaterThanOrEqual(0);
      expect(m.p50Ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('runHarness baseline tier returns all four measurements', async () => {
    const { runHarness } = await import('./harness');
    const result = await runHarness({ tier: 'baseline', iterations: 2 });

    const names = result.measurements.map((m) => m.name);
    expect(names).toContain('cold-start');
    expect(names).toContain('keystroke-repaint');
    expect(names).toContain('search-filter');
    expect(names).toContain('content-search');
  });

  it('runHarness 3× tier returns all four measurements', async () => {
    const { runHarness } = await import('./harness');
    const result = await runHarness({ tier: '3x', iterations: 2 });

    const names = result.measurements.map((m) => m.name);
    expect(names).toContain('3x-cold-start');
    expect(names).toContain('3x-keystroke-repaint');
    expect(names).toContain('3x-search-filter');
    expect(names).toContain('3x-content-search');
  }, 30000);
});
