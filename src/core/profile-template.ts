import fs from 'fs-extra';

import { getAppHomePath, resolveInside, validateProfileName } from '../platform/windows-path';
import { profileConfigSchema, profileTemplateSchema, type ProfileConfig } from '../schemas/profile';
import { CcpsError } from '../utils/errors';
import { type Clock, writeJsonFile } from './app-config';

export type ProfileTemplateName = 'coding' | 'study' | 'work' | 'research' | 'general' | 'blank';

type TemplateDefinition = {
  description: string;
  claudeMd: string;
};

export type ProfileTemplatePaths = {
  profileRootPath: string;
  profileConfigPath: string;
  claudeHomePath: string;
  claudeMdPath: string;
  settingsPath: string;
  skillsPath: string;
  agentsPath: string;
  mcpConfigPath: string;
  pluginsPath: string;
};

export type CreateProfileFromTemplateOptions = {
  appHomePath?: string;
  name: string;
  template: ProfileTemplateName;
  description?: string;
  clock?: Clock;
};

export const profileTemplates: Record<ProfileTemplateName, TemplateDefinition> = {
  coding: {
    description: 'Focused software development profile.',
    claudeMd: profileClaudeMd('Coding', 'Use this profile for implementation, refactoring, and code review work.'),
  },
  study: {
    description: 'Learning and note-taking profile.',
    claudeMd: profileClaudeMd('Study', 'Use this profile for structured learning, exercises, and explanation-heavy work.'),
  },
  work: {
    description: 'Professional project execution profile.',
    claudeMd: profileClaudeMd('Work', 'Use this profile for planning, coordination, and delivery work.'),
  },
  research: {
    description: 'Research and synthesis profile.',
    claudeMd: profileClaudeMd('Research', 'Use this profile for source review, synthesis, and exploratory analysis.'),
  },
  general: {
    description: 'General purpose Claude Code profile.',
    claudeMd: profileClaudeMd('General', 'Use this profile when no specialized workflow is needed.'),
  },
  blank: {
    description: 'Minimal empty profile.',
    claudeMd: profileClaudeMd('Blank', 'This profile is intentionally minimal.'),
  },
};

export function listProfileTemplates(): ProfileTemplateName[] {
  return Object.keys(profileTemplates) as ProfileTemplateName[];
}

export function getProfileTemplate(name: string): TemplateDefinition {
  const templateName = profileTemplateSchema.parse(name);
  return profileTemplates[templateName];
}

export function getProfileTemplatePaths(appHomePath: string, profileName: string): ProfileTemplatePaths {
  const safeName = validateProfileName(profileName);
  const profileRootPath = resolveInside(appHomePath, 'profiles', safeName);
  const claudeHomePath = resolveInside(profileRootPath, 'claude-home');

  return {
    profileRootPath,
    profileConfigPath: resolveInside(profileRootPath, 'profile.json'),
    claudeHomePath,
    claudeMdPath: resolveInside(claudeHomePath, 'CLAUDE.md'),
    settingsPath: resolveInside(claudeHomePath, 'settings.json'),
    skillsPath: resolveInside(claudeHomePath, 'skills'),
    agentsPath: resolveInside(claudeHomePath, 'agents'),
    mcpConfigPath: resolveInside(profileRootPath, 'mcp.json'),
    pluginsPath: resolveInside(profileRootPath, 'plugins'),
  };
}

export async function createProfileFromTemplate(
  options: CreateProfileFromTemplateOptions,
): Promise<{ config: ProfileConfig; paths: ProfileTemplatePaths }> {
  const appHomePath = options.appHomePath ?? getAppHomePath();
  const profileName = validateProfileName(options.name);
  const templateName = profileTemplateSchema.parse(options.template);
  const template = profileTemplates[templateName];
  const paths = getProfileTemplatePaths(appHomePath, profileName);

  if (await fs.pathExists(paths.profileRootPath)) {
    throw new CcpsError('PROFILE_ALREADY_EXISTS', 'Refusing to overwrite an existing profile.', {
      guidance: `Choose a different profile name or back up and remove the existing profile: ${profileName}`,
    });
  }

  const timestamp = (options.clock ?? (() => new Date()))().toISOString();
  const config = profileConfigSchema.parse({
    name: profileName,
    description: options.description ?? template.description,
    template: templateName,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await fs.ensureDir(paths.profileRootPath);
  await fs.ensureDir(paths.claudeHomePath);
  await fs.ensureDir(paths.skillsPath);
  await fs.ensureDir(paths.agentsPath);
  await fs.ensureDir(paths.pluginsPath);

  await writeJsonFile(paths.profileConfigPath, config, { overwrite: false });
  await fs.writeFile(paths.claudeMdPath, template.claudeMd, { encoding: 'utf8', flag: 'wx' });
  await writeJsonFile(paths.settingsPath, {}, { overwrite: false });
  await writeJsonFile(paths.mcpConfigPath, { mcpServers: {} }, { overwrite: false });

  return { config, paths };
}

function profileClaudeMd(title: string, usage: string): string {
  return `# ${title} Profile

This file belongs to a ccps-managed Claude Code user-level global profile.
ccps loads it through CLAUDE_CONFIG_DIR when launching Claude Code.
Project-level CLAUDE.md and project settings remain active separately.

${usage}
`;
}
