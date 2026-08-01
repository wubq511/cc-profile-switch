// Deterministic Profile fixture generator + Pathology Library (issue #77).
//
// CONTRACT (docs/Spec-profile-workbench.md §15.6): a checked-in deterministic
// generator turns a fixed seed + size parameters into a Profile fixture tree,
// plus the thirteen pathology shapes referenced by ID from the scenario matrix.
// Real Profiles are never checked in; every byte of fixture content is derived
// from the seed through the seeded PRNG (test/fixtures/prng.ts).
//
// Cross-platform byte-identity: the generator emits a serializable FixturePlan.
// Plans are produced without any platform, time, or filesystem input, and are
// serialized with stableStringify (recursively sorted keys). Two runs with the
// same seed + params on Windows/macOS/Linux therefore produce byte-identical
// plan bytes — the cross-platform determinism proof exercised in CI against a
// committed golden. The materializer then writes the plan to disk using
// explicit "\n" line endings and canonical JSON, so materialized regular-file
// content is also byte-identical across platforms. Symlink/junction/overlong
// pathologies are recorded as intent in the plan and materialized best-effort
// per platform capability, exactly like the existing canCreateSymlink probe.
//
// This module is test-only infrastructure. It lives under test/ and is never
// compiled into the shipped dist bundle (tsup builds src/index.ts only).

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import fs from 'fs-extra';
import path from 'node:path';

import { createRng, padIndex, stableStringify, widthFor } from './prng';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FixtureTierName = 'mini' | 'baseline' | '3x';

export type FixtureTier = {
  name: FixtureTierName;
  profiles: number;
  skillsPerProfile: number;
};

export type FixtureEntry =
  | { type: 'dir'; path: string }
  | { type: 'file'; path: string; content: string }
  | { type: 'symlink'; path: string; target: string; broken?: boolean; circular?: boolean }
  | { type: 'junction'; path: string; target: string };

export type FixtureSkillKind =
  | 'copy'
  | 'link'
  | 'broken-symlink'
  | 'circular-symlink'
  | 'junction-missing';

export type FixtureSkillSummary = {
  name: string;
  kind: FixtureSkillKind;
};

export type FixtureProfileSummary = {
  name: string;
  description: string;
  pathologyTags: string[];
  skills: FixtureSkillSummary[];
  agentCount: number;
  autoMemoryCount: number;
  // True when profile.json is intentionally corrupt/malformed (P1/P4) — readers
  // must not assume the file parses. Carried in the plan so consumers can skip
  // JSON parsing without trying and catching.
  profileJsonMalformed: boolean;
};

export type FixtureRecoveryItemSummary = {
  id: string;
  origin: 'remove' | 'update';
  expired: boolean;
};

export type FixturePlan = {
  version: 1;
  generatorVersion: 1;
  seed: number;
  tier: FixtureTier;
  pathologies: string[];
  notes: string;
  appHome: {
    config: unknown;
    apiSettings: unknown;
    state: unknown;
  };
  profiles: FixtureProfileSummary[];
  recoveryBin: FixtureRecoveryItemSummary[];
  entries: FixtureEntry[];
  summary: {
    profileCount: number;
    healthyProfileCount: number;
    pathologyProfileCount: number;
    skillCount: number;
    entryCount: number;
    pathologyTags: string[];
  };
};

export type BuildFixturePlanOptions = {
  seed?: number;
  tier?: FixtureTierName | FixtureTier;
  pathologies?: string[];
};

export type MaterializeReport = {
  rootPath: string;
  created: number;
  skipped: { path: string; reason: string }[];
  symlinkCapable: boolean;
  platform: NodeJS.Platform;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Issue #77 marker seed. Stable across runs and platforms.
export const DEFAULT_SEED = 0x0707cc77 >>> 0;

export const PATHOLOGY_IDS = [
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'P11',
  'P12',
  'P13',
] as const;
export type PathologyId = (typeof PATHOLOGY_IDS)[number];

export const TIER_PRESETS: Record<FixtureTierName, FixtureTier> = {
  // mini: fast golden + unit tests.
  mini: { name: 'mini', profiles: 3, skillsPerProfile: 4 },
  // baseline: the §15.4 performance-gate tier.
  baseline: { name: 'baseline', profiles: 20, skillsPerProfile: 50 },
  // 3x: the §15.4 stress tier (no latency thresholds).
  '3x': { name: '3x', profiles: 60, skillsPerProfile: 150 },
};

// Fixed synthetic epoch for all timestamps. Real profiles carry real times;
// fixtures never do, so trees stay byte-identical across runs and platforms.
const FIXED_EPOCH = '2026-01-01T00:00:00.000Z';
// Fixed "always expired" timestamp for P10 Recovery Items: older than any
// configured retention window (7/30/90) evaluated against any contemporary now.
const EXPIRED_EPOCH = '2020-01-01T00:00:00.000Z';

const NAMED_TEMPLATES = ['coding', 'study', 'work', 'research', 'general'] as const;

// Canonical placeholder tokens for paths that would be absolute in a real
// profile. Real absolute paths differ per machine and would break byte-identity;
// fixtures use these deterministic tokens instead. Consumers treat them opaquely.
const USERHOME_TOKEN = '<userhome>';
const APPHOME_TOKEN = '<apphome>';

// A clearly-synthetic credential placeholder. Matches no real credential shape
// (verified by the repo credential-insulation test), so redaction tests have a
// value to redact without introducing real-secret risk.
function anthropicPlaceholder(seed: number, index: number): string {
  return `fixture-placeholder-${seed.toString(16)}-${padIndex(index, 3)}`;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export function buildFixturePlan(options: BuildFixturePlanOptions = {}): FixturePlan {
  const seed = options.seed ?? DEFAULT_SEED;
  const tier = resolveTier(options.tier ?? 'mini');
  const requestedPathologies = options.pathologies ?? [...PATHOLOGY_IDS];
  const pathologies = normalizePathologies(requestedPathologies);

  const entries: FixtureEntry[] = [];
  const profileSummaries: FixtureProfileSummary[] = [];
  const recoverySummaries: FixtureRecoveryItemSummary[] = [];

  // App-home scaffold.
  entries.push(
    { type: 'dir', path: 'profiles' },
    { type: 'dir', path: 'backups' },
    { type: 'dir', path: 'recovery-bin' },
    { type: 'file', path: 'config.json', content: stableStringify(buildAppHomeConfig(seed)) },
    { type: 'file', path: 'api-settings.json', content: stableStringify(buildApiSettings(seed)) },
    { type: 'file', path: 'state.json', content: stableStringify(buildAppState(seed)) },
  );

  // Healthy tier profiles.
  let skillCount = 0;
  for (let i = 0; i < tier.profiles; i++) {
    const name = `profile-${padIndex(i + 1, widthFor(tier.profiles))}`;
    const summary = buildHealthyProfile({
      name,
      index: i,
      skillsPerProfile: tier.skillsPerProfile,
      entries,
    });
    profileSummaries.push(summary);
    skillCount += summary.skills.length;
  }

  // Pathology profiles (one per requested pathology ID).
  const usedPathologyNames = new Set(profileSummaries.map((p) => p.name));
  for (const id of pathologies) {
    const profile = buildPathologyProfile({ id, entries, usedNames: usedPathologyNames });
    profileSummaries.push(profile);
    usedPathologyNames.add(profile.name);
    skillCount += profile.skills.filter((s) => s.kind === 'copy' || s.kind === 'link').length;

    if (id === 'P10') {
      recoverySummaries.push(...buildExpiredRecoveryItems(entries));
    }
  }

  sortEntries(entries);

  return {
    version: 1,
    generatorVersion: 1,
    seed,
    tier,
    pathologies: [...pathologies],
    notes:
      'Deterministic ccps Profile fixture. All content is synthetic and derived from the seed. ' +
      'No real credentials or user data. Path-absolute fields use canonical placeholder tokens.',
    appHome: {
      config: buildAppHomeConfig(seed),
      apiSettings: buildApiSettings(seed),
      state: buildAppState(seed),
    },
    profiles: profileSummaries,
    recoveryBin: recoverySummaries,
    entries,
    summary: {
      profileCount: profileSummaries.length,
      healthyProfileCount: tier.profiles,
      pathologyProfileCount: profileSummaries.length - tier.profiles,
      skillCount,
      entryCount: entries.length,
      pathologyTags: [...pathologies],
    },
  };
}

function resolveTier(tier: FixtureTierName | FixtureTier): FixtureTier {
  if (typeof tier === 'string') {
    return TIER_PRESETS[tier];
  }
  return tier;
}

function normalizePathologies(ids: string[]): string[] {
  const valid = new Set<string>(PATHOLOGY_IDS);
  const unknown = ids.filter((id) => !valid.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown pathology IDs: ${unknown.join(', ')}. Valid: ${PATHOLOGY_IDS.join(', ')}`,
    );
  }
  // De-duplicate while preserving canonical order.
  return PATHOLOGY_IDS.filter((id) => ids.includes(id));
}

// ---------------------------------------------------------------------------
// App-home files
// ---------------------------------------------------------------------------

function buildAppHomeConfig(seed: number): unknown {
  return {
    version: 2,
    defaultProfile: 'profile-001',
    lastUsedProfile: 'profile-001',
    createdAt: FIXED_EPOCH,
    updatedAt: FIXED_EPOCH,
    recovery: { retentionDays: 30 },
    workbench: { skillsDiscoveryExperimental: true },
    _fixtureSeed: seed,
  };
}

function buildApiSettings(seed: number): unknown {
  return {
    env: {
      ANTHROPIC_API_KEY: anthropicPlaceholder(seed, 1),
      ANTHROPIC_AUTH_TOKEN: anthropicPlaceholder(seed, 2),
    },
  };
}

function buildAppState(seed: number): unknown {
  return {
    version: 1,
    recentProjectDirs: [
      { path: `${USERHOME_TOKEN}/fixture/project-a`, lastUsedAt: FIXED_EPOCH },
      { path: `${USERHOME_TOKEN}/fixture/project-b`, lastUsedAt: FIXED_EPOCH },
    ],
    _fixtureSeed: seed,
  };
}

// ---------------------------------------------------------------------------
// Skill content + provenance
// ---------------------------------------------------------------------------

type SkillFile = { relPath: string; content: string };

type SkillDescriptor = {
  name: string;
  kind: FixtureSkillKind;
  files: SkillFile[];
  contentHash: string;
  // Whether to materialize the skill's own tree under skills/<name>.
  materializeTree: boolean;
  // Whether the provenance manifest records this skill.
  inManifest: boolean;
};

// A deterministic secondary seed per (seed basis, skill name, offset) so each
// skill's body content is a deterministic function of its identity, independent
// of iteration order or the tier it lives in.
function skillSeed(seedBasis: number, skillName: string, offset: number): number {
  const hash = createHash('sha256');
  hash.update(`${seedBasis}:${skillName}:${offset}`);
  return parseInt(hash.digest('hex').slice(0, 8), 16) >>> 0;
}

function buildCopySkill(
  seedBasis: number,
  skillName: string,
  profileName: string,
  offset: number,
  opts: { materializeTree?: boolean; inManifest?: boolean } = {},
): SkillDescriptor {
  const files = skillFiles(skillName, profileName, skillSeed(seedBasis, skillName, offset));
  return {
    name: skillName,
    kind: 'copy',
    files,
    contentHash: hashSkillTree(files),
    materializeTree: opts.materializeTree ?? true,
    inManifest: opts.inManifest ?? true,
  };
}

function skillFiles(skillName: string, profileName: string, seed: number): SkillFile[] {
  const rng = createRng(seed);
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) {
    lines.push(`- ${rng.nextString(8, 'abcdefghijklmnopqrstuvwxyz')} item ${i + 1}`);
  }
  return [
    {
      relPath: 'SKILL.md',
      content:
        `---\nname: ${skillName}\ndescription: Deterministic fixture skill for ${profileName}.\nversion: 1.0.0\n---\n\n` +
        `# ${skillName}\n\nSynthetic fixture skill derived from seed. No real credentials.\n\n## Notes\n${lines.join('\n')}\n`,
    },
    {
      relPath: 'references/detail.md',
      content: `# ${skillName} reference\n\nDeterministic reference content.\n`,
    },
  ];
}

function writeSkillFiles(entries: FixtureEntry[], skillDir: string, files: SkillFile[]): void {
  entries.push({ type: 'dir', path: skillDir });
  for (const file of files) {
    const dirParts = file.relPath.split('/');
    dirParts.pop();
    let acc = skillDir;
    for (const part of dirParts) {
      acc = `${acc}/${part}`;
      entries.push({ type: 'dir', path: acc });
    }
    entries.push({ type: 'file', path: `${skillDir}/${file.relPath}`, content: file.content });
  }
}

function provenanceRecord(input: {
  mode: 'copy' | 'link';
  source: unknown;
  contentHash: string;
  linkTargetPath?: string;
}): unknown {
  const record: Record<string, unknown> = {
    mode: input.mode,
    source: input.source,
    contentHash: input.contentHash,
    installedAt: FIXED_EPOCH,
    updatedAt: FIXED_EPOCH,
    sourceCheckedAt: FIXED_EPOCH,
  };
  if (input.linkTargetPath) {
    record.link = { targetPath: input.linkTargetPath };
  }
  return record;
}

// Materialize skill trees and emit the provenance manifest for a set of skill
// descriptors. Shared by the healthy profile builder and the pathology profile
// builder so the skill→entry→manifest shape stays in one place.
function emitSkillsAndManifest(
  entries: FixtureEntry[],
  descriptors: SkillDescriptor[],
  claudeHome: string,
  root: string,
): void {
  const provenanceSkills: Record<string, unknown> = {};
  for (const descriptor of descriptors) {
    if (descriptor.materializeTree) {
      writeSkillFiles(entries, `${claudeHome}/skills/${descriptor.name}`, descriptor.files);
    }
    if (descriptor.inManifest) {
      provenanceSkills[descriptor.name] = provenanceRecord({
        mode: 'copy',
        source: {
          kind: 'git-remote',
          url: `https://example.invalid/skills/${descriptor.name}.git`,
          ref: 'main',
        },
        contentHash: descriptor.contentHash,
      });
    }
  }
  entries.push({
    type: 'file',
    path: `${root}/skills-provenance.json`,
    content: stableStringify({ version: 1, skills: provenanceSkills }),
  });
}

// Full-tree sha256 matching src/core/skills-provenance.ts computeContentHash:
// regular files sorted by posix rel path, per-file sha256 of utf8 bytes,
// concat `${relPath}\n${hash}\n`, sha256 of the concatenation. Parity is pinned
// by a dedicated test against the real implementation over a materialized tree.
export function hashSkillTree(files: SkillFile[]): string {
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const concat = sorted.map((f) => `${f.relPath}\n${sha256Hex(f.content)}\n`).join('');
  return sha256Hex(concat);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function agentContent(agentName: string): string {
  return `---\nname: ${agentName}\ndescription: Deterministic fixture agent.\ntools: Read, Grep\n---\n\n# ${agentName}\n\nSynthetic fixture agent body.\n`;
}

function autoMemoryEntry(profileName: string): string {
  return `# ${profileName} Auto Memory (fixture)\n\nSynthetic auto memory entry. No real user data.\n`;
}

function buildClaudeJson(profileName: string, malformed: boolean): unknown {
  if (malformed) {
    // P12: malformed MCP entries. The mcpServers container is a valid object,
    // but individual server entries are malformed — one is a string instead of
    // an object, one is missing the required `command` field. Consumers must
    // treat each entry as untrusted, not just the top-level value.
    return {
      mcpServers: {
        [`fixture-server-${profileName}`]: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@fixture/server'],
          env: { FIXTURE_MODE: 'demo' },
        },
        'malformed-string-entry': 'not-a-server-object',
        'missing-command-entry': {
          type: 'stdio',
          args: ['-y', '@fixture/missing-command'],
        },
      },
      _fixtureNote: `malformed MCP entries for ${profileName}`,
    };
  }
  return {
    mcpServers: {
      [`fixture-server-${profileName}`]: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@fixture/server'],
        env: { FIXTURE_MODE: 'demo' },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Healthy profile
// ---------------------------------------------------------------------------

type BuildHealthyProfileOptions = {
  name: string;
  index: number;
  skillsPerProfile: number;
  entries: FixtureEntry[];
};

function buildHealthyProfile(options: BuildHealthyProfileOptions): FixtureProfileSummary {
  const { name, index, skillsPerProfile, entries } = options;
  const root = `profiles/${name}`;
  const claudeHome = `${root}/claude-home`;
  const seedBasis = index + 1;
  const template = NAMED_TEMPLATES[index % NAMED_TEMPLATES.length]!;
  const description = `${capitalize(template)} profile fixture ${index + 1}.`;

  ensureProfileScaffold(entries, root, claudeHome, {
    profileJson: stableStringify(profileConfig(name, description, template)),
    claudeMd: claudeMd(name, description),
    settings: stableStringify(healthySettings(root)),
  });

  // Skills (all copy-mode with full provenance and matching contentHash).
  const skillWidth = widthFor(skillsPerProfile);
  const descriptors: SkillDescriptor[] = [];
  for (let i = 0; i < skillsPerProfile; i++) {
    const skillName = `skill-${padIndex(i + 1, skillWidth)}`;
    descriptors.push(buildCopySkill(seedBasis, skillName, name, i));
  }
  emitSkillsAndManifest(entries, descriptors, claudeHome, root);
  const skills: FixtureSkillSummary[] = descriptors.map((d) => ({ name: d.name, kind: d.kind }));

  // Agents.
  const agentCount = 2;
  for (let i = 0; i < agentCount; i++) {
    entries.push({
      type: 'file',
      path: `${claudeHome}/agents/agent-${padIndex(i + 1, 2)}.md`,
      content: agentContent(`agent-${padIndex(i + 1, 2)}`),
    });
  }

  // Auto memory.
  const autoMemoryTopics = 2;
  entries.push({
    type: 'file',
    path: `${claudeHome}/memory/auto/MEMORY.md`,
    content: autoMemoryEntry(name),
  });
  for (let i = 0; i < autoMemoryTopics; i++) {
    entries.push({
      type: 'file',
      path: `${claudeHome}/memory/auto/topic-${padIndex(i + 1, 2)}.md`,
      content: autoMemoryEntry(name),
    });
  }

  // MCP servers (non-secret) in .claude.json.
  entries.push({
    type: 'file',
    path: `${claudeHome}/.claude.json`,
    content: stableStringify(buildClaudeJson(name, false)),
  });

  return {
    name,
    description,
    pathologyTags: [],
    skills,
    agentCount,
    autoMemoryCount: autoMemoryTopics + 1, // entrypoint + topics
    profileJsonMalformed: false,
  };
}

type ScaffoldContent = {
  profileJson: string;
  claudeMd: string | null; // null = absent (P2)
  settings: string;
};

function ensureProfileScaffold(
  entries: FixtureEntry[],
  root: string,
  claudeHome: string,
  content: ScaffoldContent,
): void {
  entries.push(
    { type: 'dir', path: root },
    { type: 'dir', path: claudeHome },
    { type: 'dir', path: `${claudeHome}/rules` },
    { type: 'dir', path: `${claudeHome}/memory` },
    { type: 'dir', path: `${claudeHome}/memory/auto` },
    { type: 'dir', path: `${claudeHome}/skills` },
    { type: 'dir', path: `${claudeHome}/agents` },
    { type: 'dir', path: `${claudeHome}/plugins` },
    { type: 'file', path: `${root}/profile.json`, content: content.profileJson },
    { type: 'file', path: `${claudeHome}/settings.json`, content: content.settings },
    { type: 'file', path: `${claudeHome}/rules/ccps-profile.md`, content: ccpsProfileRule() },
  );
  if (content.claudeMd !== null) {
    entries.push({ type: 'file', path: `${claudeHome}/CLAUDE.md`, content: content.claudeMd });
  }
}

function profileConfig(name: string, description: string, template: string): unknown {
  return {
    name,
    description,
    template,
    launch: {
      mcpMode: 'none',
      pluginDirs: [],
      disableAutoMemory: false,
      skipPermissions: true,
      claudeArgs: [],
    },
    createdAt: FIXED_EPOCH,
    updatedAt: FIXED_EPOCH,
  };
}

function healthySettings(profileRoot: string): unknown {
  return {
    autoMemoryDirectory: `${APPHOME_TOKEN}/${profileRoot}/claude-home/memory/auto`,
    claudeMdExcludes: [`${USERHOME_TOKEN}/.claude/CLAUDE.md`],
    env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
  };
}

function claudeMd(name: string, description: string): string {
  return `# ${name} Profile\n\n${description}\n\nThis is a synthetic ccps fixture profile. Content is deterministic and contains no real user data.\n`;
}

function ccpsProfileRule(): string {
  return `<!-- ccps-managed-profile-boundary:start:v2 -->\n# CCPS Profile Boundary\n\nFixture-managed boundary rule.\n<!-- ccps-managed-profile-boundary:end:v2 -->\n`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ---------------------------------------------------------------------------
// Pathology Library (P1-P13)
// ---------------------------------------------------------------------------

type BuildPathologyProfileOptions = {
  id: PathologyId;
  entries: FixtureEntry[];
  usedNames: Set<string>;
};

function buildPathologyProfile(options: BuildPathologyProfileOptions): FixtureProfileSummary {
  const { id, entries, usedNames } = options;
  const name = uniquePathologyName(id, usedNames);
  const root = `profiles/${name}`;
  const claudeHome = `${root}/claude-home`;
  const description = `Pathology ${id} fixture profile.`;
  const seedBasis = 1000 + PATHOLOGY_IDS.indexOf(id);

  // Start from two healthy copy skills; pathologies mutate the set below.
  const skills: SkillDescriptor[] = [
    buildCopySkill(seedBasis, 'skill-alpha', name, 0),
    buildCopySkill(seedBasis, 'skill-beta', name, 1),
  ];
  const extraEntries: FixtureEntry[] = [];

  let profileJsonContent = stableStringify(profileConfig(name, description, 'coding'));
  let profileJsonMalformed = false;
  let claudeJsonContent = stableStringify(buildClaudeJson(name, false));
  let settingsContent = stableStringify(healthySettings(root));
  let claudeMdContent: string | null = claudeMd(name, description);

  switch (id) {
    case 'P1': {
      // corrupt/missing-field profile.json. The materialized shape is corrupt
      // JSON (trailing comma after an unfinished value).
      profileJsonContent = `{\n  "name": "${name}",\n  "broken":\n}\n`;
      profileJsonMalformed = true;
      break;
    }
    case 'P2': {
      // deleted User Memory: CLAUDE.md absent.
      claudeMdContent = null;
      break;
    }
    case 'P3': {
      // Settings missing managed fields (no autoMemoryDirectory / claudeMdExcludes / env attribution).
      settingsContent = stableStringify({ someOtherField: 'value' });
      break;
    }
    case 'P4': {
      // malformed settings.json (invalid JSON: trailing comma after a value).
      settingsContent = `{\n  "env": "not-an-object",\n}\n`;
      break;
    }
    case 'P5': {
      // pre-manifest Skill: skill dir present but the manifest does not record it.
      const premanifest = buildCopySkill(seedBasis, 'skill-premanifest', name, 2);
      premanifest.inManifest = false;
      skills.push(premanifest);
      break;
    }
    case 'P6': {
      // broken symlink + circular symlink Skill entries (no manifest record; not real skills).
      skills.push(
        {
          name: 'skill-broken-link',
          kind: 'broken-symlink',
          files: [],
          contentHash: '',
          materializeTree: false,
          inManifest: false,
        },
        {
          name: 'skill-circular-link',
          kind: 'circular-symlink',
          files: [],
          contentHash: '',
          materializeTree: false,
          inManifest: false,
        },
      );
      extraEntries.push({
        type: 'symlink',
        path: `${claudeHome}/skills/skill-broken-link`,
        target: `${claudeHome}/skills/does-not-exist`,
        broken: true,
      });
      extraEntries.push({
        type: 'symlink',
        path: `${claudeHome}/skills/skill-circular-link`,
        target: `${claudeHome}/skills/skill-circular-link`,
        circular: true,
      });
      break;
    }
    case 'P7': {
      // missing junction target (Windows). Recorded as junction intent; on
      // non-Windows the materializer falls back to a broken symlink so the
      // entry is observable everywhere.
      skills.push({
        name: 'skill-missing-junction',
        kind: 'junction-missing',
        files: [],
        contentHash: '',
        materializeTree: false,
        inManifest: false,
      });
      extraEntries.push({
        type: 'junction',
        path: `${claudeHome}/skills/skill-missing-junction`,
        target: `${root}/claude-home/skills/missing-junction-target`,
      });
      break;
    }
    case 'P8': {
      // CJK/emoji/space-containing resource names + CJK description. Profile
      // directory name stays ASCII (profile-name contract); CJK lives in skill
      // names, agent names, and auto-memory filenames.
      skills.push(
        buildCopySkill(seedBasis, 'スキル-機能', name, 2),
        buildCopySkill(seedBasis, '✨-emoji-skill', name, 3),
        buildCopySkill(seedBasis, 'skill with spaces', name, 4),
      );
      break;
    }
    case 'P9': {
      // overlong path: a deeply nested skill whose path approaches OS limits.
      const overlong = buildCopySkill(seedBasis, 'overlong-skill', name, 2, {
        materializeTree: false,
      });
      skills.push(overlong);
      const segment = 'x'.repeat(40);
      const nested = Array.from({ length: 20 }, () => segment).join('/');
      extraEntries.push(
        { type: 'dir', path: `${claudeHome}/skills/overlong-skill/${nested}` },
        {
          type: 'file',
          path: `${claudeHome}/skills/overlong-skill/${nested}/SKILL.md`,
          content: '# overlong\n\nDeeply nested fixture skill.\n',
        },
      );
      break;
    }
    case 'P10': {
      // Expired Recovery Items live at app-home level (buildExpiredRecoveryItems).
      // The profile carries a skill whose removal produced the expired item.
      skills.push(buildCopySkill(seedBasis, 'skill-expired-removal', name, 2));
      break;
    }
    case 'P11': {
      // malformed env values in settings.json (non-string env values).
      settingsContent = stableStringify({
        ...healthySettings(root),
        env: {
          CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
          ANTHROPIC_API_KEY: 12345,
          ANTHROPIC_AUTH_TOKEN: { nested: 'invalid' },
        },
      });
      break;
    }
    case 'P12': {
      // malformed MCP entries in .claude.json.
      claudeJsonContent = stableStringify(buildClaudeJson(name, true));
      break;
    }
    case 'P13': {
      // apply-crash residue (three transaction states of §7.1).
      // (a) tmp residue only — no final tree.
      skills.push({
        name: 'skill-crash-tmp',
        kind: 'copy',
        files: [],
        contentHash: '',
        materializeTree: false,
        inManifest: false,
      });
      // (b) old + final both present — final tree exists, old left behind.
      const oldAndFinal = buildCopySkill(seedBasis, 'skill-crash-old-and-final', name, 2, {
        inManifest: false,
      });
      skills.push(oldAndFinal);
      // (c) old present without final — no final tree.
      skills.push({
        name: 'skill-crash-old-no-final',
        kind: 'copy',
        files: [],
        contentHash: '',
        materializeTree: false,
        inManifest: false,
      });

      extraEntries.push(
        { type: 'dir', path: `${claudeHome}/skills/.ccps-tmp-skill-crash-tmp` },
        {
          type: 'file',
          path: `${claudeHome}/skills/.ccps-tmp-skill-crash-tmp/SKILL.md`,
          content: '# crash tmp\n\nStaged tree from an interrupted apply.\n',
        },
        { type: 'dir', path: `${claudeHome}/skills/.ccps-old-skill-crash-old-and-final` },
        {
          type: 'file',
          path: `${claudeHome}/skills/.ccps-old-skill-crash-old-and-final/SKILL.md`,
          content: '# crash old\n\nPre-swap tree left behind after a successful apply.\n',
        },
        { type: 'dir', path: `${claudeHome}/skills/.ccps-old-skill-crash-old-no-final` },
        {
          type: 'file',
          path: `${claudeHome}/skills/.ccps-old-skill-crash-old-no-final/SKILL.md`,
          content: '# crash old no final\n\nOld tree awaiting rename-back reconciliation.\n',
        },
      );
      break;
    }
  }

  // Scaffold (with pathology-mutated content).
  ensureProfileScaffold(entries, root, claudeHome, {
    profileJson: profileJsonContent,
    claudeMd: claudeMdContent,
    settings: settingsContent,
  });

  // Materialize skill trees + build provenance manifest.
  emitSkillsAndManifest(entries, skills, claudeHome, root);

  // Agents + auto memory + .claude.json.
  entries.push(
    { type: 'file', path: `${claudeHome}/agents/agent-01.md`, content: agentContent('agent-01') },
    { type: 'file', path: `${claudeHome}/memory/auto/MEMORY.md`, content: autoMemoryEntry(name) },
    { type: 'file', path: `${claudeHome}/.claude.json`, content: claudeJsonContent },
  );

  entries.push(...extraEntries);

  // P8: also give the profile a CJK description in addition to CJK skill names.
  const finalDescription = id === 'P8' ? `病态 ${id} 测试配置 (CJK/emoji/spaces).` : description;

  return {
    name,
    description: finalDescription,
    pathologyTags: [id],
    skills: skills.map((s) => ({ name: s.name, kind: s.kind })),
    agentCount: 1,
    autoMemoryCount: 1,
    profileJsonMalformed,
  };
}

function uniquePathologyName(id: string, usedNames: Set<string>): string {
  const base = `pathology-${id.toLowerCase()}`;
  let name = base;
  let counter = 2;
  while (usedNames.has(name)) {
    name = `${base}-${counter}`;
    counter++;
  }
  return name;
}

// ---------------------------------------------------------------------------
// P10: expired Recovery Items
// ---------------------------------------------------------------------------

function buildExpiredRecoveryItems(entries: FixtureEntry[]): FixtureRecoveryItemSummary[] {
  const summaries: FixtureRecoveryItemSummary[] = [];
  const ids = ['20200101T000000-pathology-p10-skill', '20200102T000000-pathology-p10-agent'];
  for (const id of ids) {
    const dir = `recovery-bin/${id}`;
    const isAgent = id.includes('agent');
    entries.push(
      { type: 'dir', path: dir },
      {
        type: 'file',
        path: `${dir}/item.json`,
        content: stableStringify({
          version: 1,
          id,
          origin: 'remove',
          kind: isAgent ? 'agent' : 'skill',
          shape: 'file-tree',
          profile: 'pathology-p10',
          coordinates: {
            targetRelativePath: isAgent
              ? 'claude-home/agents/agent-01.md'
              : 'claude-home/skills/skill-expired-removal',
          },
          removedAt: EXPIRED_EPOCH,
          sizeBytes: 0,
          secretBearing: false,
        }),
      },
      { type: 'dir', path: `${dir}/payload` },
      {
        type: 'file',
        path: `${dir}/payload/SKILL.md`,
        content: '# expired recovery payload\n\nSynthetic payload for an expired Recovery Item.\n',
      },
    );
    summaries.push({ id, origin: 'remove', expired: true });
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Entry ordering + serialization
// ---------------------------------------------------------------------------

function sortEntries(entries: FixtureEntry[]): void {
  const typeRank: Record<FixtureEntry['type'], number> = {
    dir: 0,
    file: 1,
    symlink: 2,
    junction: 3,
  };
  entries.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path < b.path ? -1 : 1;
    }
    return typeRank[a.type] - typeRank[b.type];
  });
}

export function serializePlan(plan: FixturePlan): string {
  return stableStringify(plan);
}

// ---------------------------------------------------------------------------
// Materializer
// ---------------------------------------------------------------------------

export async function materializeFixture(
  plan: FixturePlan,
  rootPath: string,
): Promise<MaterializeReport> {
  const symlinkCapable = await probeSymlinkCapability();
  const report: MaterializeReport = {
    rootPath,
    created: 0,
    skipped: [],
    symlinkCapable,
    platform: process.platform,
  };

  for (const entry of plan.entries) {
    try {
      await materializeEntry(entry, rootPath, symlinkCapable, report);
      report.created++;
    } catch (error) {
      report.skipped.push({
        path: entry.path,
        reason: isNodeError(error) ? (error.code ?? String(error)) : String(error),
      });
    }
  }

  return report;
}

async function materializeEntry(
  entry: FixtureEntry,
  rootPath: string,
  symlinkCapable: boolean,
  report: MaterializeReport,
): Promise<void> {
  const abs = resolveEntryPath(rootPath, entry.path);

  switch (entry.type) {
    case 'dir':
      await fs.ensureDir(abs);
      return;
    case 'file':
      await fs.ensureDir(path.dirname(abs));
      await fs.writeFile(abs, entry.content, { encoding: 'utf8' });
      return;
    case 'symlink': {
      if (!symlinkCapable) {
        report.skipped.push({ path: entry.path, reason: 'symlink-unsupported' });
        return;
      }
      await fs.ensureDir(path.dirname(abs));
      const target = resolveEntryPath(rootPath, entry.target);
      // Fixture materialization into a fresh root: removing a stale entry is safe.
      await fs.remove(abs);
      await fs.symlink(target, abs, 'dir');
      return;
    }
    case 'junction': {
      // Junctions are a Windows directory-link concept. On Windows we create a
      // junction to the (possibly absent) target. On other platforms we fall
      // back to a broken symlink so the entry is observable in CI; if symlinks
      // are also unavailable, the entry is skipped with a recorded reason.
      await fs.ensureDir(path.dirname(abs));
      if (process.platform === 'win32') {
        await fs.remove(abs);
        await fs.symlink(resolveEntryPath(rootPath, entry.target), abs, 'junction');
        return;
      }
      if (symlinkCapable) {
        await fs.remove(abs);
        await fs.symlink(resolveEntryPath(rootPath, entry.target), abs, 'dir');
        return;
      }
      report.skipped.push({ path: entry.path, reason: 'junction-unsupported' });
      return;
    }
  }
}

function resolveEntryPath(rootPath: string, posixPath: string): string {
  // Plan paths are posix; convert to the platform path. Entry paths are always
  // relative to the fixture root. Absolute-looking tokens (<apphome>,
  // <userhome>) never appear as entry paths — only inside JSON content strings.
  const parts = posixPath.split('/').filter((p) => p.length > 0);
  // Block traversal: every entry path must stay inside the fixture root, even
  // though all inputs are generator-controlled today (AGENTS.md: "resolve
  // absolute paths and block traversal").
  if (parts.includes('..')) {
    throw new Error(`fixture entry path escapes the fixture root: ${posixPath}`);
  }
  return path.resolve(rootPath, ...parts);
}

async function probeSymlinkCapability(): Promise<boolean> {
  const probeDir = await fs.mkdtemp(path.join(tmpdir(), 'ccps-fixture-symlink-'));
  const probeTarget = path.join(probeDir, 'target');
  const probeLink = path.join(probeDir, 'link');
  try {
    await fs.mkdir(probeTarget);
    await fs.symlink(probeTarget, probeLink, 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await fs.remove(probeDir);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
