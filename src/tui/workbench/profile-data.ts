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
  autoMemory: number;
  skills: number;
  mcp: number;
  settings: number;
  launchConfig: number;
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
      const counts = await countResources(paths.appHomePath, summary.name, mcpServers.length);
      const [userMemory, agents] = await Promise.all([
        loadUserMemory(paths.appHomePath, summary.name),
        listAgents(paths.appHomePath, summary.name),
      ]);
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
          autoMemory: counts.autoMemory,
          skills: counts.skills,
          mcp: counts.mcp,
          settings: counts.settings,
          launchConfig: counts.launchConfig,
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

async function countResources(appHomePath: string, profileName: string, mcpCount: number): Promise<ResourceCounts> {
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
  const autoMemory = await countEntries(join(claudeHome, 'memory', 'auto'), (e) => e.isFile());
  const skills = await countEntries(join(claudeHome, 'skills'), (e) => e.isFile() || e.isDirectory());
  const agents = await countEntries(join(claudeHome, 'agents'), (e) => e.isFile());
  const mcp = mcpCount;
  const settings = (await fs.pathExists(join(claudeHome, 'settings.json'))) ? 1 : 0;
  const launchConfig = 1; // profile.json always counts as 1

  return { userMemory, autoMemory, skills, agents, mcp, settings, launchConfig };
}
