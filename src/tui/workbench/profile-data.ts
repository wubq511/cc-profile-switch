import fs from 'fs-extra';

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
  plugins: number;
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
  const profileRoot = `${profilesPath}/${profileName}`;
  const claudeHome = `${profileRoot}/claude-home`;

  const countDir = async (dir: string): Promise<number> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile() || e.isDirectory()).length;
    } catch {
      return 0;
    }
  };

  const countFiles = async (dir: string): Promise<number> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).length;
    } catch {
      return 0;
    }
  };

  const userMemory = (await fs.pathExists(`${claudeHome}/CLAUDE.md`)) ? 1 : 0;
  const autoMemory = await countFiles(`${claudeHome}/memory/auto`);
  const skills = await countDir(`${claudeHome}/skills`);
  const agents = await countFiles(`${claudeHome}/agents`);
  const mcp = await countMcpServers(claudeHome);
  const settings = (await fs.pathExists(`${claudeHome}/settings.json`)) ? 1 : 0;
  const plugins = await countDir(`${claudeHome}/plugins`);

  return { userMemory, autoMemory, skills, agents, mcp, settings, plugins };
}

async function countMcpServers(claudeHome: string): Promise<number> {
  try {
    const claudeJson = await fs.readJson(`${claudeHome}/.claude.json`);
    const mcpServers = (claudeJson as Record<string, unknown>)?.mcpServers;
    if (typeof mcpServers === 'object' && mcpServers !== null) {
      return Object.keys(mcpServers).length;
    }
    return 0;
  } catch {
    return 0;
  }
}
