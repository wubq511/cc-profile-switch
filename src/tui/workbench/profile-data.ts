import fs from 'fs-extra';
import { join } from 'node:path';

import { getAppHomePaths } from '../../core/app-config';
import {
  listProfilesForDisplay,
  type ProfileSummary,
} from '../../core/profile-management';
import { validateProfile, type ProfileValidationResult } from '../../core/validator';

export type WorkbenchProfile = {
  name: string;
  description: string;
  isDefault: boolean;
  isLastUsed: boolean;
  status: string;
  resourceCounts: ResourceCounts;
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

export type WorkbenchData = {
  profiles: WorkbenchProfile[];
  defaultProfile: string | undefined;
};

export async function loadWorkbenchData(appHomePath?: string): Promise<WorkbenchData> {
  const paths = getAppHomePaths(appHomePath);
  const summaries: ProfileSummary[] = await listProfilesForDisplay({
    appHomePath: paths.appHomePath,
  });

  const profiles: WorkbenchProfile[] = await Promise.all(
    summaries.map(async (summary) => {
      const counts = await countResources(paths.appHomePath, summary.name);
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
        validation,
      };
    }),
  );

  const defaultProfile = profiles.find((p) => p.isDefault)?.name;

  return { profiles, defaultProfile };
}

async function countResources(appHomePath: string, profileName: string): Promise<ResourceCounts> {
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
  const mcp = await countMcpServers(claudeHome);
  const settings = (await fs.pathExists(join(claudeHome, 'settings.json'))) ? 1 : 0;
  const launchConfig = 1; // profile.json always counts as 1

  return { userMemory, autoMemory, skills, agents, mcp, settings, launchConfig };
}

async function countMcpServers(claudeHome: string): Promise<number> {
  try {
    const claudeJson = await fs.readJson(join(claudeHome, '.claude.json'));
    const mcpServers = (claudeJson as Record<string, unknown>)?.mcpServers;
    if (typeof mcpServers === 'object' && mcpServers !== null) {
      return Object.keys(mcpServers).length;
    }
    return 0;
  } catch {
    return 0;
  }
}
