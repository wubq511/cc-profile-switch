import fs from 'fs-extra';
import { join } from 'node:path';

import { getAppHomePaths } from '../../core/app-config';
import { listCustomTemplates } from '../../core/custom-template';
import {
  listProfilesForDisplay,
  type ProfileSummary,
} from '../../core/profile-management';
import { validateProfile, type ProfileValidationResult } from '../../core/validator';
import {
  loadUserMemory,
  listAgents,
  classifyReadError,
  type AgentEntry,
  type UserMemoryEntry,
  type ResourceCategoryState,
  type ResourceStates,
} from '../../core/resource';
import { readConfiguredMcpNames } from '../../core/mcp-list';

export type WorkbenchProfile = {
  name: string;
  description: string;
  isDefault: boolean;
  isLastUsed: boolean;
  status: string;
  resourceCounts: ResourceCounts;
  resourceDetails: ResourceDetails;
  /** Configured MCP server names (connection state is checked lazily, §5 nudge). */
  mcpServers: string[];
  validation: ProfileValidationResult | null;
  /** Explicit per-category read outcomes (issue #110): `ok` for the loaded
   *  details, `missing` for an absent resource, `unreadable` for EISDIR/
   *  EACCES/format failures that must never masquerade as an empty list.
   *  Optional so fixtures predating the field degrade to `ok` (readStateFor). */
  resourceStates?: ResourceStates;
};

export type ResourceCounts = {
  userMemory: number;
  autoMemory: number;
  skills: number;
  agents: number;
  mcp: number;
  settings: number;
  launchConfig: number;
  /** Installed plugins (0 until the delegated inventory read lands, §7.6). */
  plugins: number;
};

export type ResourceDetails = {
  userMemory: UserMemoryEntry;
  agents: AgentEntry[];
  /** Skill entry names under `claude-home/skills/`. */
  skills: string[];
  /** Auto Memory entry file names under `claude-home/memory/auto/`. */
  autoMemory: string[];
  /** Top-level keys of `claude-home/settings.json`. */
  settings: string[];
  /** Plugin ids (plugin@marketplace) from the delegated inventory read. */
  plugins: string[];
};

export type CustomTemplateSummary = {
  name: string;
  description?: string;
  sourceProfile: string;
};

export type WorkbenchData = {
  profiles: WorkbenchProfile[];
  defaultProfile: string | undefined;
  /** Custom templates listed alongside the built-ins in the create flow (§11.3). */
  customTemplates: CustomTemplateSummary[];
};

/** Read state for a nav category (`'user-memory' | 'agents'`); `ok` when the
 *  Profile fixture predates `resourceStates` (graceful degradation). */
export function readStateFor(
  profile: WorkbenchProfile,
  category: 'user-memory' | 'agents',
): ResourceCategoryState {
  const states = profile.resourceStates;
  if (!states) return { status: 'ok' };
  return category === 'agents' ? states.agents : states.userMemory;
}

export async function loadWorkbenchData(appHomePath?: string): Promise<WorkbenchData> {
  const paths = getAppHomePaths(appHomePath);
  const summaries: ProfileSummary[] = await listProfilesForDisplay({
    appHomePath: paths.appHomePath,
  });

  const profiles: WorkbenchProfile[] = await Promise.all(
    summaries.map(async (summary) => {
      const { profilesPath } = getAppHomePaths(appHomePath);
      const claudeHome = join(profilesPath, summary.name, 'claude-home');
      // One .claude.json read yields both the MCP count and the server names.
      const mcpServers = await readConfiguredMcpNames(claudeHome);
      // User Memory / Agents load with explicit read-state classification
      // (issue #110): a failed category read degrades that category to
      // `unreadable` instead of throwing away the whole Profile.
      const [userMemoryState, agentsState, skills, autoMemory, settings] = await Promise.all([
        loadCategoryState('user-memory', () => loadUserMemory(paths.appHomePath, summary.name)),
        loadCategoryState('agents', () => listAgents(paths.appHomePath, summary.name)),
        listEntryNames(join(claudeHome, 'skills')),
        listEntryNames(join(claudeHome, 'memory', 'auto'), true),
        listSettingKeys(join(claudeHome, 'settings.json')),
      ]);
      // Skills/Auto Memory counts derive from the item-name listings so each
      // directory is scanned once for both purposes.
      const counts = await countResources(paths.appHomePath, summary.name, mcpServers.length, {
        skills: skills.length,
        autoMemory: autoMemory.length,
      });
      let validation: ProfileValidationResult | null = null;
      try {
        validation = await validateProfile({
          appHomePath: paths.appHomePath,
          name: summary.name,
        });
      } catch {
        // validation failure is non-fatal for the workbench display
      }

      return {
        name: summary.name,
        description: summary.description,
        isDefault: summary.isDefault,
        isLastUsed: summary.isLastUsed,
        status: summary.status,
        resourceCounts: counts,
        resourceDetails: {
          userMemory: userMemoryState.loaded
            ? userMemoryState.value
            : {
                kind: 'user-memory' as const,
                name: 'CLAUDE.md',
                relativePath: 'claude-home/CLAUDE.md',
                exists: false,
                lineCount: 0,
                excerpt: '',
              },
          agents: agentsState.loaded ? agentsState.value : [],
          skills,
          autoMemory,
          settings,
          // Filled by the delegated plugin inventory read (issue #101 L4).
          plugins: [],
        },
        resourceStates: {
          userMemory: userMemoryState.state,
          agents: agentsState.state,
        },
        mcpServers,
        validation,
      };
    }),
  );

  const defaultProfile = profiles.find((p) => p.isDefault)?.name;

  let customTemplates: CustomTemplateSummary[] = [];
  try {
    customTemplates = await listCustomTemplates(paths.appHomePath);
  } catch {
    // custom-template listing failure is non-fatal for the workbench display
  }

  return { profiles, defaultProfile, customTemplates };
}

/**
 * Run one resource category load and classify its outcome (issue #110): a
 * resolution that reports itself absent becomes `missing`; a resolution with
 * content becomes `ok` with the value; a rejection is classified as `missing`
 * (absent path) or `unreadable` (EISDIR/EACCES/format) with a diagnostic,
 * never as a successful empty list.
 */
async function loadCategoryState<T>(
  category: 'user-memory' | 'agents',
  load: () => Promise<T>,
): Promise<{ loaded: true; value: T; state: ResourceCategoryState } | { loaded: false; state: ResourceCategoryState }> {
  try {
    const value = await load();
    // A user-memory entry with exists=false is an explicit `missing`, not a
    // successful read of an empty resource.
    if (
      category === 'user-memory' &&
      typeof value === 'object' &&
      value !== null &&
      (value as { exists?: unknown }).exists === false
    ) {
      return { loaded: true, value, state: { status: 'missing' } };
    }
    return { loaded: true, value, state: { status: 'ok' } };
  } catch (error) {
    const classified = classifyReadError(error);
    return {
      loaded: false,
      state:
        classified.status === 'unreadable'
          ? {
              status: 'unreadable',
              code: classified.code,
              detail: `${category}: ${classified.detail}`,
            }
          : { status: 'missing' },
    };
  }
}

async function countResources(
  appHomePath: string,
  profileName: string,
  mcpCount: number,
  listed: { skills: number; autoMemory: number },
): Promise<ResourceCounts> {
  const { profilesPath } = getAppHomePaths(appHomePath);
  const profileRoot = join(profilesPath, profileName);
  const claudeHome = join(profileRoot, 'claude-home');

  const countEntries = async (dir: string, predicate: (e: fs.Dirent) => boolean): Promise<number> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter(predicate).length;
    } catch {
      return 0;
    }
  };

  const userMemory = (await fs.pathExists(join(claudeHome, 'CLAUDE.md'))) ? 1 : 0;
  const autoMemory = listed.autoMemory;
  const skills = listed.skills;
  const agents = await countEntries(join(claudeHome, 'agents'), (e) => e.isFile());
  const mcp = mcpCount;
  const settings = (await fs.pathExists(join(claudeHome, 'settings.json'))) ? 1 : 0;
  const launchConfig = 1; // profile.json always counts as 1
  // Plugins merge in when the delegated inventory read lands (app.tsx); the
  // data load itself stays off the CLI probe.
  const plugins = 0;

  return { userMemory, autoMemory, skills, agents, mcp, settings, launchConfig, plugins };
}

/** Entry names in a directory (sidebar tree item rows); [] when absent. */
async function listEntryNames(dir: string, filesOnly = false): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => !filesOnly || e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Top-level keys of a settings.json; [] when absent or unparseable. */
async function listSettingKeys(settingsPath: string): Promise<string[]> {
  try {
    if (!(await fs.pathExists(settingsPath))) return [];
    const parsed: unknown = await fs.readJson(settingsPath);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    return Object.keys(parsed).sort();
  } catch {
    return [];
  }
}
