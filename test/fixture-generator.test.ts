import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { computeContentHash } from '../src/core/skills-provenance';
import { assertNoRealCredentials } from './fixtures/credentials';
import {
  buildFixturePlan,
  materializeFixture,
  PATHOLOGY_IDS,
  serializePlan,
  TIER_PRESETS,
} from './fixtures/generator';

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

function findProfile(plan: ReturnType<typeof buildFixturePlan>, tag: string) {
  return plan.profiles.find((p) => p.pathologyTags.includes(tag));
}

function readEntry(
  plan: ReturnType<typeof buildFixturePlan>,
  predicate: (e: (typeof plan.entries)[number]) => boolean,
): string | undefined {
  const entry = plan.entries.find((e) => e.type === 'file' && predicate(e));
  return entry && entry.type === 'file' ? entry.content : undefined;
}

// ---------------------------------------------------------------------------
// Cross-platform byte-identity (the core acceptance criterion)
// ---------------------------------------------------------------------------

describe('fixture generator: cross-platform determinism', () => {
  it('rebuilds the committed golden plan byte-for-byte', async () => {
    // This runs on Ubuntu/macOS/Windows in CI. If the generator output drifts
    // by even one byte on any platform, this fails. Regenerate with
    // `npm run fixtures:golden`.
    const plan = buildFixturePlan();
    const goldenPath = path.join(__dirname, 'fixtures', 'golden', 'mini.plan.json');
    const golden = await fs.readFile(goldenPath, 'utf8');
    expect(serializePlan(plan)).toBe(golden);
  });

  it('produces identical plans for the same seed + params', () => {
    const a = buildFixturePlan({ seed: 42, tier: 'mini', pathologies: ['P1', 'P6', 'P13'] });
    const b = buildFixturePlan({ seed: 42, tier: 'mini', pathologies: ['P1', 'P6', 'P13'] });
    expect(serializePlan(a)).toBe(serializePlan(b));
  });

  it('produces different plans for different seeds', () => {
    const a = serializePlan(buildFixturePlan({ seed: 1, tier: 'mini', pathologies: [] }));
    const b = serializePlan(buildFixturePlan({ seed: 2, tier: 'mini', pathologies: [] }));
    expect(a).not.toBe(b);
  });

  it('normalizes pathology ordering to canonical P1..P13', () => {
    const plan = buildFixturePlan({ tier: 'mini', pathologies: ['P13', 'P1', 'P5'] });
    expect(plan.pathologies).toEqual(['P1', 'P5', 'P13']);
  });

  it('rejects unknown pathology IDs', () => {
    expect(() => buildFixturePlan({ tier: 'mini', pathologies: ['PX'] })).toThrowError(
      /Unknown pathology/,
    );
  });
});

// ---------------------------------------------------------------------------
// Size tiers (both tiers generate)
// ---------------------------------------------------------------------------

describe('fixture generator: size tiers', () => {
  it('mini tier has the documented counts', () => {
    const plan = buildFixturePlan({ tier: 'mini', pathologies: [] });
    expect(plan.summary.healthyProfileCount).toBe(TIER_PRESETS.mini.profiles);
    expect(plan.profiles).toHaveLength(TIER_PRESETS.mini.profiles);
    for (const profile of plan.profiles) {
      expect(profile.skills).toHaveLength(TIER_PRESETS.mini.skillsPerProfile);
    }
  });

  it('baseline tier (20x50) generates with correct counts', () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    expect(plan.summary.healthyProfileCount).toBe(20);
    expect(plan.profiles).toHaveLength(20);
    for (const profile of plan.profiles) {
      expect(profile.skills).toHaveLength(50);
    }
    expect(plan.summary.skillCount).toBe(20 * 50);
  });

  it('3x tier (60x150) generates with correct counts', () => {
    // Plan-only generation: the 3x tier is the §15.4 stress tier. Building the
    // plan proves the generator scales; full materialization is exercised via
    // `npm run fixtures:generate -- --tier 3x --out .fixtures-out` for the
    // real-machine performance gate, not in CI to stay within timeout budget.
    const plan = buildFixturePlan({ tier: '3x', pathologies: [] });
    expect(plan.summary.healthyProfileCount).toBe(60);
    expect(plan.profiles).toHaveLength(60);
    let total = 0;
    for (const profile of plan.profiles) {
      expect(profile.skills).toHaveLength(150);
      total += profile.skills.length;
    }
    expect(total).toBe(60 * 150);
  });
});

// ---------------------------------------------------------------------------
// Materialization + contentHash parity
// ---------------------------------------------------------------------------

describe('fixture generator: materialization', () => {
  it('materializes the mini tier and writes byte-identical content', async () => {
    const root = await makeTempRoot('ccps-fixture-mini-');
    const plan = buildFixturePlan({ tier: 'mini', pathologies: ['P1', 'P8'] });
    const report = await materializeFixture(plan, root);

    // P1/P8 carry no symlinks/junctions; nothing should be skipped except
    // possibly P9-style overlong (not present here).
    expect(report.created).toBeGreaterThan(0);
    expect(report.skipped.filter((s) => !s.reason.includes('unsupported'))).toHaveLength(0);

    // A healthy profile's profile.json parses and matches the plan content.
    const profileJsonPath = path.join(root, 'profiles', 'profile-001', 'profile.json');
    const parsed = JSON.parse(await fs.readFile(profileJsonPath, 'utf8'));
    expect(parsed.name).toBe('profile-001');

    // A skill's SKILL.md exists and its content hash matches the manifest.
    const skillDir = path.join(
      root,
      'profiles',
      'profile-001',
      'claude-home',
      'skills',
      'skill-001',
    );
    const manifestPath = path.join(root, 'profiles', 'profile-001', 'skills-provenance.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const expectedHash = manifest.skills['skill-001'].contentHash;
    expect(await computeContentHash(skillDir)).toBe(expectedHash);
  });

  it('generator hashSkillTree matches src computeContentHash over a materialized tree', async () => {
    // Parity invariant: the generator's in-memory hash must equal the real
    // implementation's hash over the materialized tree. If this drifts, healthy
    // fixtures would falsely report local drift.
    const root = await makeTempRoot('ccps-fixture-parity-');
    const plan = buildFixturePlan({ tier: 'mini', pathologies: [] });
    await materializeFixture(plan, root);

    const skillDir = path.join(
      root,
      'profiles',
      'profile-001',
      'claude-home',
      'skills',
      'skill-001',
    );
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(root, 'profiles', 'profile-001', 'skills-provenance.json'),
        'utf8',
      ),
    );
    const realHash = await computeContentHash(skillDir);
    expect(realHash).toBe(manifest.skills['skill-001'].contentHash);

    // And the sha256 of a known string is stable (sanity for the hash pipeline).
    expect(createHash('sha256').update('hello\n', 'utf8').digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('materializes the baseline tier (both size tiers generate on disk)', async () => {
    const root = await makeTempRoot('ccps-fixture-baseline-');
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    const report = await materializeFixture(plan, root);
    // Clean baseline has no platform-gated entries -> every entry materializes.
    expect(report.skipped).toHaveLength(0);
    expect(report.created).toBe(plan.summary.entryCount);
    expect(
      await fs.pathExists(
        path.join(
          root,
          'profiles',
          'profile-020',
          'claude-home',
          'skills',
          'skill-050',
          'SKILL.md',
        ),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pathology Library (all thirteen producible by ID)
// ---------------------------------------------------------------------------

describe('fixture generator: Pathology Library P1-P13', () => {
  // Each pathology is producible on its own.
  for (const id of PATHOLOGY_IDS) {
    it(`${id} is producible by ID and carries its specific shape`, () => {
      const plan = buildFixturePlan({ tier: 'mini', pathologies: [id] });
      expect(plan.pathologies).toContain(id);
      const profile = findProfile(plan, id);
      expect(profile, `${id} should have a dedicated profile`).toBeDefined();

      switch (id) {
        case 'P1': {
          expect(profile!.profileJsonMalformed).toBe(true);
          const content = readEntry(plan, (e) => e.path.endsWith('pathology-p1/profile.json'));
          expect(() => JSON.parse(content!)).toThrowError();
          break;
        }
        case 'P2': {
          const claudeMd = plan.entries.find(
            (e) => e.type === 'file' && e.path === 'profiles/pathology-p2/claude-home/CLAUDE.md',
          );
          expect(claudeMd).toBeUndefined();
          break;
        }
        case 'P3': {
          const content = readEntry(plan, (e) =>
            e.path.endsWith('pathology-p3/claude-home/settings.json'),
          );
          const parsed = JSON.parse(content!);
          expect(parsed).not.toHaveProperty('autoMemoryDirectory');
          expect(parsed).not.toHaveProperty('claudeMdExcludes');
          // Managed attribution env must also be absent.
          expect(parsed.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined();
          break;
        }
        case 'P4': {
          const content = readEntry(plan, (e) =>
            e.path.endsWith('pathology-p4/claude-home/settings.json'),
          );
          expect(() => JSON.parse(content!)).toThrowError();
          break;
        }
        case 'P5': {
          // skill-premanifest dir present, manifest does not record it.
          const hasDir = plan.entries.some(
            (e) =>
              e.type === 'dir' &&
              e.path === 'profiles/pathology-p5/claude-home/skills/skill-premanifest',
          );
          const manifest = JSON.parse(
            readEntry(plan, (e) => e.path.endsWith('pathology-p5/skills-provenance.json'))!,
          );
          expect(hasDir).toBe(true);
          expect(manifest.skills).not.toHaveProperty('skill-premanifest');
          break;
        }
        case 'P6': {
          const symlinks = plan.entries.filter((e) => e.type === 'symlink');
          expect(symlinks).toHaveLength(2);
          expect(symlinks.some((s) => s.type === 'symlink' && s.broken)).toBe(true);
          expect(symlinks.some((s) => s.type === 'symlink' && s.circular)).toBe(true);
          break;
        }
        case 'P7': {
          const junctions = plan.entries.filter((e) => e.type === 'junction');
          expect(junctions).toHaveLength(1);
          break;
        }
        case 'P8': {
          const cjkSkills = profile!.skills.filter((s) => /[\u3000-\u9fff]|[✨]| /.test(s.name));
          expect(cjkSkills.length).toBeGreaterThan(0);
          break;
        }
        case 'P9': {
          const overlong = plan.entries
            .filter((e) => e.path.includes('overlong-skill/'))
            .map((e) => e.path.length);
          expect(Math.max(...overlong)).toBeGreaterThan(260);
          break;
        }
        case 'P10': {
          expect(plan.recoveryBin.length).toBeGreaterThan(0);
          for (const item of plan.recoveryBin) {
            expect(item.expired).toBe(true);
          }
          // The recovery-bin item.json files exist in the plan.
          const items = plan.entries.filter(
            (e) =>
              e.type === 'file' && e.path.includes('recovery-bin/') && e.path.endsWith('item.json'),
          );
          expect(items.length).toBeGreaterThan(0);
          break;
        }
        case 'P11': {
          const content = readEntry(plan, (e) =>
            e.path.endsWith('pathology-p11/claude-home/settings.json'),
          );
          const parsed = JSON.parse(content!);
          expect(typeof parsed.env.ANTHROPIC_API_KEY).not.toBe('string');
          break;
        }
        case 'P12': {
          const content = readEntry(plan, (e) =>
            e.path.endsWith('pathology-p12/claude-home/.claude.json'),
          );
          const parsed = JSON.parse(content!);
          // The container is a valid object; individual entries are malformed.
          expect(typeof parsed.mcpServers).toBe('object');
          expect(parsed.mcpServers['malformed-string-entry']).toBe('not-a-server-object');
          const missingCommand = parsed.mcpServers['missing-command-entry'];
          expect(missingCommand).not.toHaveProperty('command');
          break;
        }
        case 'P13': {
          const paths = plan.entries.map((e) => e.path);
          // Three transaction crash states of §7.1.
          expect(paths.some((p) => p.includes('.ccps-tmp-'))).toBe(true);
          expect(paths.some((p) => p.includes('.ccps-old-skill-crash-old-and-final'))).toBe(true);
          expect(paths.some((p) => p.includes('.ccps-old-skill-crash-old-no-final'))).toBe(true);
          break;
        }
      }
    });
  }

  it('all thirteen pathologies are producible together', () => {
    const plan = buildFixturePlan({ tier: 'mini', pathologies: [...PATHOLOGY_IDS] });
    expect(plan.summary.pathologyTags).toEqual([...PATHOLOGY_IDS]);
    expect(plan.summary.pathologyProfileCount).toBe(13);
  });

  it('pathology profile directory names stay ASCII-safe (profile-name contract)', () => {
    const plan = buildFixturePlan({ tier: 'mini', pathologies: [...PATHOLOGY_IDS] });
    for (const profile of plan.profiles) {
      expect(profile.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Credential insulation of generated fixtures
// ---------------------------------------------------------------------------

describe('fixture generator: no real credentials in generated fixtures', () => {
  it('mini+all pathologies plan contains no real credential shapes', () => {
    const plan = buildFixturePlan({ tier: 'mini', pathologies: [...PATHOLOGY_IDS] });
    assertNoRealCredentials(serializePlan(plan), 'mini+all plan');
  });

  it('baseline plan contains no real credential shapes', () => {
    const plan = buildFixturePlan({ tier: 'baseline', pathologies: [] });
    assertNoRealCredentials(serializePlan(plan), 'baseline plan');
  });

  it('uses synthetic placeholder credential values', () => {
    const plan = buildFixturePlan({ tier: 'mini', pathologies: [] });
    const apiSettings = plan.appHome.apiSettings as { env: Record<string, string> };
    for (const value of Object.values(apiSettings.env)) {
      expect(value).toMatch(/^fixture-placeholder-/);
    }
  });
});
