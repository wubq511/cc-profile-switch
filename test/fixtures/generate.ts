// CLI entry for the deterministic fixture generator (issue #77).
//
//   tsx test/fixtures/generate.ts [--tier mini|baseline|3x] [--seed N]
//     [--pathologies P1,P2,...|none|all] [--out <dir>] [--golden]
//
// --out writes a materialized fixture app-home tree to <dir> (gitignored by
// default; see .gitignore). Without --out, the plan is serialized to stdout.
// --golden rewrites the committed golden plan at test/fixtures/golden/mini.plan.json
// using the canonical mini tier + all pathologies; run this only when the
// generator intentionally changes, then commit the result.
//
// This is a developer/CI tool, not a shipped command. It is not added to the
// ccps CLI surface.

import fs from 'fs-extra';
import path from 'node:path';

import {
  buildFixturePlan,
  materializeFixture,
  PATHOLOGY_IDS,
  serializePlan,
  TIER_PRESETS,
  type FixtureTierName,
} from './generator';

type Args = {
  tier: FixtureTierName;
  seed: number;
  pathologies: string[] | null;
  out: string | null;
  golden: boolean;
};

const DEFAULT_GOLDEN_TIER: FixtureTierName = 'mini';

function parseArgs(argv: string[]): Args {
  const args: Args = {
    tier: 'baseline',
    seed: 0x0707cc77,
    pathologies: null,
    out: null,
    golden: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      i++;
      return value;
    };

    switch (arg) {
      case '--tier':
        args.tier = parseTier(next());
        break;
      case '--seed':
        args.seed = parseSeed(next());
        break;
      case '--pathologies':
        args.pathologies = parsePathologies(next());
        break;
      case '--out':
        args.out = next();
        break;
      case '--golden':
        args.golden = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseTier(value: string): FixtureTierName {
  if (value === 'mini' || value === 'baseline' || value === '3x') {
    return value;
  }
  throw new Error(`--tier must be mini|baseline|3x, got: ${value}`);
}

function parseSeed(value: string): number {
  const parsed = Number.parseInt(value, value.startsWith('0x') ? 16 : 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--seed must be a non-negative integer, got: ${value}`);
  }
  return parsed >>> 0;
}

function parsePathologies(value: string): string[] {
  if (value === 'none') {
    return [];
  }
  if (value === 'all') {
    return [...PATHOLOGY_IDS];
  }
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const valid = new Set<string>(PATHOLOGY_IDS);
  const unknown = ids.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown pathology IDs: ${unknown.join(', ')}`);
  }
  return ids;
}

function printHelp(): void {
  const message = `ccps deterministic fixture generator (issue #77)

Usage:
  tsx test/fixtures/generate.ts [options]

Options:
  --tier <mini|baseline|3x>   Fixture size tier (default: baseline)
  --seed <N>                  Deterministic seed (default: 0x0707cc77)
  --pathologies <list|none|all>  Comma-separated pathology IDs (default: all)
  --out <dir>                 Materialize the fixture tree into <dir>
  --golden                    Rewrite the committed golden plan (mini + all pathologies)
  -h, --help                  Show this help

Tiers:
  mini      ${TIER_PRESETS.mini.profiles} profiles x ${TIER_PRESETS.mini.skillsPerProfile} skills (golden + unit tests)
  baseline  ${TIER_PRESETS.baseline.profiles} profiles x ${TIER_PRESETS.baseline.skillsPerProfile} skills (performance gate)
  3x        ${TIER_PRESETS['3x'].profiles} profiles x ${TIER_PRESETS['3x'].skillsPerProfile} skills (stress tier)

Pathology IDs: ${PATHOLOGY_IDS.join(', ')}
`;
  process.stdout.write(message);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.golden) {
    const plan = buildFixturePlan({
      seed: args.seed,
      tier: DEFAULT_GOLDEN_TIER,
      pathologies: [...PATHOLOGY_IDS],
    });
    const goldenPath = path.join(__dirname, 'golden', 'mini.plan.json');
    await fs.ensureDir(path.dirname(goldenPath));
    await fs.writeFile(goldenPath, serializePlan(plan), 'utf8');
    process.stdout.write(`Wrote golden plan: ${goldenPath}\n`);
    return;
  }

  const pathologies = args.pathologies ?? [...PATHOLOGY_IDS];
  const plan = buildFixturePlan({
    seed: args.seed,
    tier: args.tier,
    pathologies,
  });

  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.remove(outPath);
    await fs.ensureDir(outPath);
    const report = await materializeFixture(plan, outPath);
    process.stdout.write(
      `Materialized ${report.created} entries to ${outPath}\n` +
        `  profiles:   ${plan.summary.profileCount} (${plan.summary.healthyProfileCount} healthy + ${plan.summary.pathologyProfileCount} pathology)\n` +
        `  skills:     ${plan.summary.skillCount}\n` +
        `  entries:    ${plan.summary.entryCount}\n` +
        `  symlinks:   ${report.symlinkCapable ? 'supported' : 'unsupported'}\n` +
        `  skipped:    ${report.skipped.length}\n` +
        (report.skipped.length > 0
          ? report.skipped.map((s) => `    - ${s.path} (${s.reason})`).join('\n') + '\n'
          : ''),
    );
    return;
  }

  process.stdout.write(serializePlan(plan));
}

main().catch((error) => {
  process.stderr.write(
    `fixtures:generate failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
