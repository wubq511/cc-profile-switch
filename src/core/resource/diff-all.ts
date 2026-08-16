/**
 * Pairwise cross-Profile diff shell (issue #71, spec §12).
 *
 * A single Diff entry point opens a pairwise comparison between two Profiles;
 * each resource routes to its resolved presentation:
 *
 *   user-memory / agents → unified line diff (Agents add a per-file layer)
 *   settings             → redacted key table (key names + verdicts, values never)
 *   mcp                  → server inventory (name/transport/connection per Profile)
 *   skills               → hash-tree diff vs each Profile's own source
 *   launch-config        → key table with values + sensitive-field warnings
 *
 * The existing per-resource diff functions are composed here unchanged; this
 * module only routes and shapes the presentation data (no new comparison logic).
 * Redaction is inherited from the sources: Settings/MCP never carry values, so
 * nothing in this module can leak them.
 */

import { join } from 'node:path';

import { diffAgents, diffUserMemory } from './diff';
import type { AgentsDiff, UserMemoryDiff } from './diff';
import { diffProfileSettings } from '../settings-resource';
import { diffProfileLaunchConfig } from '../launch-config-resource';
import { inspectMcpServers } from '../mcp-servers';
import { diffSkillVsSource } from '../skills-update';
import type { SkillVsSourceDiff } from '../skills-update';
import { canDiffVsSource, inspectSkills } from '../skills-provenance';
import type { SkillProvenanceRecord } from '../../schemas/skills-provenance';
import type { McpConnectionState, McpTransport } from '../../schemas/mcp';
import type { LaunchConfigDiffEntry, SettingsDiffEntry } from '../diff';
import type { CaptureProcess } from '../../platform/process';
import { getAppHomePaths } from '../app-config';

// ─── Categories ───────────────────────────────────────────────────────────

/** Resource categories with a resolved diff presentation (spec §12). */
export type DiffCategory =
  | 'user-memory'
  | 'agents'
  | 'settings'
  | 'mcp'
  | 'skills'
  | 'launch-config';

export const DIFF_CATEGORIES: readonly DiffCategory[] = [
  'user-memory',
  'agents',
  'settings',
  'mcp',
  'skills',
  'launch-config',
] as const;

// ─── Presentation models ──────────────────────────────────────────────────

/** One MCP server row: per-Profile name/transport/connection cells. Config values never present. */
export type McpInventoryRow = {
  name: string;
  inA: boolean;
  inB: boolean;
  transportA: McpTransport | null;
  transportB: McpTransport | null;
  connectionA: McpConnectionState | null;
  connectionB: McpConnectionState | null;
};

export type McpInventoryDiff = {
  profileA: string;
  profileB: string;
  rows: McpInventoryRow[];
};

/** Why a per-Profile Skill tree diff is absent. `no-source`/`link-mode` come from
 *  the provenance capability gate; `error` marks an unexpected per-Skill failure
 *  (e.g. a remote re-acquisition outage) that must not kill the whole shell. */
export type SkillDisabledReason = 'no-source' | 'link-mode' | 'error';

/** One Skill row: per-Profile hash-tree diff vs that Profile's own source. */
export type SkillVsSourceRow = {
  name: string;
  inA: boolean;
  inB: boolean;
  aVsSource: SkillVsSourceDiff | null;
  /** Why the A-side tree diff is absent (capability reason or unexpected failure). */
  aDisabledReason: SkillDisabledReason | null;
  bVsSource: SkillVsSourceDiff | null;
  bDisabledReason: SkillDisabledReason | null;
};

export type CopiedSkillsDiff = {
  profileA: string;
  profileB: string;
  skills: SkillVsSourceRow[];
};

/** The resolved diff for any diffable category (spec §12 "format follows resource"). */
export type ResourceDiffResult =
  | { category: 'user-memory'; diff: UserMemoryDiff }
  | { category: 'agents'; diff: AgentsDiff }
  | { category: 'settings'; diff: SettingsDiffEntry[] }
  | { category: 'mcp'; diff: McpInventoryDiff }
  | { category: 'skills'; diff: CopiedSkillsDiff }
  | { category: 'launch-config'; diff: LaunchConfigDiffEntry[] };

export type DiffResourcesOptions = {
  /** Override the `claude mcp list` connection probe and remote re-acquisition (tests). */
  captureProcess?: CaptureProcess;
};

// ─── Dispatcher ───────────────────────────────────────────────────────────

export async function diffResources(
  appHomePath: string,
  profileA: string,
  profileB: string,
  category: DiffCategory,
  options: DiffResourcesOptions = {},
): Promise<ResourceDiffResult> {
  switch (category) {
    case 'user-memory':
      return { category, diff: await diffUserMemory(appHomePath, profileA, profileB) };
    case 'agents':
      return { category, diff: await diffAgents(appHomePath, profileA, profileB) };
    case 'settings':
      return { category, diff: await diffProfileSettings(appHomePath, profileA, profileB) };
    case 'mcp':
      return { category, diff: await buildMcpInventory(appHomePath, profileA, profileB, options) };
    case 'skills':
      return { category, diff: await diffCopiedSkills(appHomePath, profileA, profileB, options) };
    case 'launch-config':
      return { category, diff: await diffProfileLaunchConfig(appHomePath, profileA, profileB) };
  }
}

// ─── MCP inventory (per-Profile cells, config values never compared) ───────

export async function buildMcpInventory(
  appHomePath: string,
  profileA: string,
  profileB: string,
  options: DiffResourcesOptions = {},
): Promise<McpInventoryDiff> {
  const [a, b] = await Promise.all([
    inspectMcpServers(profileRootOf(appHomePath, profileA), { captureProcess: options.captureProcess }),
    inspectMcpServers(profileRootOf(appHomePath, profileB), { captureProcess: options.captureProcess }),
  ]);

  const names = [...new Set([...a.servers.map((s) => s.name), ...b.servers.map((s) => s.name)])].sort();
  const aByName = new Map(a.servers.map((s) => [s.name, s]));
  const bByName = new Map(b.servers.map((s) => [s.name, s]));

  const rows: McpInventoryRow[] = names.map((name) => {
    const sa = aByName.get(name);
    const sb = bByName.get(name);
    return {
      name,
      inA: sa !== undefined,
      inB: sb !== undefined,
      transportA: sa?.transport ?? null,
      transportB: sb?.transport ?? null,
      connectionA: sa?.connection ?? null,
      connectionB: sb?.connection ?? null,
    };
  });

  return { profileA, profileB, rows };
}

// ─── Copied Skills (per-Profile hash-tree vs own source) ───────────────────

export async function diffCopiedSkills(
  appHomePath: string,
  profileA: string,
  profileB: string,
  options: DiffResourcesOptions = {},
): Promise<CopiedSkillsDiff> {
  const rootA = profileRootOf(appHomePath, profileA);
  const rootB = profileRootOf(appHomePath, profileB);
  const [a, b] = await Promise.all([inspectSkills(rootA), inspectSkills(rootB)]);
  const aByName = new Map(a.skills.map((s) => [s.name, s]));
  const bByName = new Map(b.skills.map((s) => [s.name, s]));
  const names = [...new Set([...aByName.keys(), ...bByName.keys()])].sort();

  const skills: SkillVsSourceRow[] = await Promise.all(
    names.map(async (name) => {
      const skillA = aByName.get(name);
      const skillB = bByName.get(name);
      const [aResult, bResult] = await Promise.all([
        diffVsSourceFor(rootA, name, skillA, appHomePath, options.captureProcess),
        diffVsSourceFor(rootB, name, skillB, appHomePath, options.captureProcess),
      ]);
      return {
        name,
        inA: skillA !== undefined,
        inB: skillB !== undefined,
        aVsSource: aResult.diff,
        aDisabledReason: aResult.disabledReason,
        bVsSource: bResult.diff,
        bDisabledReason: bResult.disabledReason,
      };
    }),
  );

  return { profileA, profileB, skills };
}

type VsSourceOutcome = {
  diff: SkillVsSourceDiff | null;
  disabledReason: SkillDisabledReason | null;
};

function diffVsSourceFor(
  profileRoot: string,
  name: string,
  skill: { record: SkillProvenanceRecord } | undefined,
  appHomePath: string,
  captureProcess: CaptureProcess | undefined,
): Promise<VsSourceOutcome> {
  if (!skill) {
    return Promise.resolve({ diff: null, disabledReason: null });
  }
  const capability = canDiffVsSource(skill.record);
  if (!capability.enabled) {
    return Promise.resolve({ diff: null, disabledReason: (capability.reason as SkillDisabledReason) ?? 'no-source' });
  }
  return diffSkillVsSource({ appHomePath, profileRootPath: profileRoot, name, captureProcess })
    .then((diff) => ({ diff, disabledReason: null }))
    .catch(() => ({ diff: null, disabledReason: 'error' as const }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function profileRootOf(appHomePath: string, profileName: string): string {
  const { profilesPath } = getAppHomePaths(appHomePath);
  return join(profilesPath, profileName);
}
