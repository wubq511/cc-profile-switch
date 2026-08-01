import fs from 'fs-extra';
import { join } from 'node:path';

import { getAppHomePaths } from '../../core/app-config';
import { listCustomTemplates } from '../../core/custom-template';
import {
  listProfilesForDisplay,
  type ProfileSummary,
} from '../../core/profile-management';
import { validateProfile, type ProfileValidationResult } from '../../core/validator';
import { loadUserMemory, listAgents, type AgentEntry, type UserMemoryEntry } from '../../core/resource';
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
};

export type ResourceCounts = {
  userMemory: number;
  autoMemory: number;
  skills: number;
  agents: number;
  mcp: number;
  settings: number;
  launchConfig: number;
};

export type ResourceDetails = {
  userMemory: UserMemoryEntry;
  agents: AgentEntry[];
  /** Skill entry names under `claude-home/skills/` (sidebar tree item rows). */
  skills: string[];
  /** Auto Memory entry file names under `claude-home/memory/auto/`. */
  autoMemory: string[];
  /** Top-level keys of `claude-home/settings.json`. */
  settings: string[];
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
      const [userMemory, agents, skills, autoMemory, settings] = await Promise.all([
        loadUserMemory(paths.appHomePath, summary.name),
        listAgents(paths.appHomePath, summary.name),
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
          userMemory,
          agents,
          skills,
          autoMemory,
          settings,
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

  return { userMemory, autoMemory, skills, agents, mcp, settings, launchConfig };
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
