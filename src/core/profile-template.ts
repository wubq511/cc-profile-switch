import fs from 'fs-extra';
import { dirname } from 'node:path';

import {
  getAppHomePath,
  resolveFilesystemPath,
  resolveInside,
  resolveUserHome,
  validateProfileName,
} from '../platform/path';
import { profileConfigSchema, profileTemplateSchema, type ProfileConfig } from '../schemas/profile';
import { CcpsError } from '../utils/errors';
import { isNodeError, isRecord } from '../utils/type-guards';
import { type Clock, writeJsonFile } from './app-config';

export type ProfileTemplateName = 'coding' | 'study' | 'work' | 'research' | 'general' | 'blank';
type TemplateEnum = ProfileTemplateName | 'none';

type TemplateDefinition = {
  description: string;
  claudeMd: string;
};

const defaultAttributionEnvKey = 'CLAUDE_CODE_ATTRIBUTION_HEADER';
const legacyCcpsProfileRuleMarker = '<!-- ccps-managed-profile-boundary:v1 -->';
const ccpsProfileRuleStartMarker = '<!-- ccps-managed-profile-boundary:start:v2 -->';
const ccpsProfileRuleEndMarker = '<!-- ccps-managed-profile-boundary:end:v2 -->';
const ccpsProfileRuleHeading = '# CCPS Profile Boundary';

export const defaultProfileSettingsEnv = {
  [defaultAttributionEnvKey]: '0',
} as const;

export type ProfileTemplatePaths = {
  profileRootPath: string;
  profileConfigPath: string;
  claudeHomePath: string;
  claudeMdPath: string;
  settingsPath: string;
  memoryPath: string;
  autoMemoryPath: string;
  autoMemoryEntrypointPath: string;
  skillsPath: string;
  agentsPath: string;
  rulesPath: string;
  ccpsProfileRulePath: string;
  claudeUserConfigPath: string;
  /** Legacy ccps MCP config. New profiles use Claude Code's native user scope. */
  mcpConfigPath: string;
  pluginsPath: string;
};

export type CreateProfileFromTemplateOptions = {
  appHomePath?: string;
  name: string;
  template?: ProfileTemplateName;
  description?: string;
  clock?: Clock;
};

export const profileTemplates: Record<TemplateEnum, TemplateDefinition> = {
  coding: {
    description: 'Focused software development profile.',
    claudeMd: profileClaudeMd(
      'Coding',
      'Use this profile for implementation, refactoring, and code review work.',
    ),
  },
  study: {
    description: 'Learning and note-taking profile.',
    claudeMd: profileClaudeMd(
      'Study',
      'Use this profile for structured learning, exercises, and explanation-heavy work.',
    ),
  },
  work: {
    description: 'Professional project execution profile.',
    claudeMd: profileClaudeMd(
      'Work',
      'Use this profile for planning, coordination, and delivery work.',
    ),
  },
  research: {
    description: 'Research and synthesis profile.',
    claudeMd: profileClaudeMd(
      'Research',
      'Use this profile for source review, synthesis, and exploratory analysis.',
    ),
  },
  general: {
    description: 'General purpose Claude Code profile.',
    claudeMd: profileClaudeMd(
      'General',
      'Use this profile when no specialized workflow is needed.',
    ),
  },
  blank: {
    description: 'Minimal empty profile.',
    claudeMd: profileClaudeMd('Blank', 'This profile is intentionally minimal.'),
  },
  none: {
    description: 'Minimal empty profile.',
    claudeMd: profileClaudeMd('Blank', 'This profile is intentionally minimal.'),
  },
};

const namedTemplates: ProfileTemplateName[] = ['coding', 'study', 'work', 'research', 'general'];

export function listProfileTemplates(): ProfileTemplateName[] {
  return [...namedTemplates];
}

function resolveTemplateName(template?: ProfileTemplateName): TemplateEnum {
  if (template === undefined || template === 'blank') {
    return 'none';
  }
  return template;
}

export function getProfileTemplate(name: string): TemplateDefinition {
  const templateName = profileTemplateSchema.parse(name);
  return profileTemplates[resolveTemplateName(templateName)];
}

export function getProfileTemplateForCreate(template?: ProfileTemplateName): TemplateDefinition {
  return profileTemplates[resolveTemplateName(template)];
}

export function getProfileTemplatePaths(
  appHomePath: string,
  profileName: string,
): ProfileTemplatePaths {
  const safeName = validateProfileName(profileName);
  const profileRootPath = resolveInside(appHomePath, 'profiles', safeName);
  const claudeHomePath = resolveInside(profileRootPath, 'claude-home');
  const memoryPath = resolveInside(claudeHomePath, 'memory');
  const autoMemoryPath = resolveInside(memoryPath, 'auto');

  return {
    profileRootPath,
    profileConfigPath: resolveInside(profileRootPath, 'profile.json'),
    claudeHomePath,
    claudeMdPath: resolveInside(claudeHomePath, 'CLAUDE.md'),
    settingsPath: resolveInside(claudeHomePath, 'settings.json'),
    memoryPath,
    autoMemoryPath,
    autoMemoryEntrypointPath: resolveInside(autoMemoryPath, 'MEMORY.md'),
    skillsPath: resolveInside(claudeHomePath, 'skills'),
    agentsPath: resolveInside(claudeHomePath, 'agents'),
    rulesPath: resolveInside(claudeHomePath, 'rules'),
    ccpsProfileRulePath: resolveInside(claudeHomePath, 'rules', 'ccps-profile.md'),
    claudeUserConfigPath: resolveInside(claudeHomePath, '.claude.json'),
    mcpConfigPath: resolveInside(profileRootPath, 'mcp.json'),
    pluginsPath: resolveInside(claudeHomePath, 'plugins'),
  };
}

export async function createProfileFromTemplate(
  options: CreateProfileFromTemplateOptions,
): Promise<{ config: ProfileConfig; paths: ProfileTemplatePaths }> {
  const appHomePath = options.appHomePath ?? getAppHomePath();
  const profileName = validateProfileName(options.name);
  const templateName = resolveTemplateName(options.template);
  const template = getProfileTemplateForCreate(options.template);
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
    template: templateName === 'none' ? undefined : templateName,
    launch: {
      mcpMode: 'none',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await fs.ensureDir(paths.profileRootPath);
  await fs.ensureDir(paths.claudeHomePath);
  await fs.ensureDir(paths.memoryPath);
  await fs.ensureDir(paths.autoMemoryPath);
  await fs.ensureDir(paths.skillsPath);
  await fs.ensureDir(paths.agentsPath);
  await fs.ensureDir(paths.rulesPath);
  await fs.ensureDir(paths.pluginsPath);

  await writeJsonFile(paths.profileConfigPath, config, { overwrite: false });
  await fs.writeFile(paths.claudeMdPath, template.claudeMd, { encoding: 'utf8', flag: 'wx' });
  await writeJsonFile(paths.settingsPath, createInitialProfileSettings(paths), {
    overwrite: false,
  });
  await fs.writeFile(paths.autoMemoryEntrypointPath, autoMemoryEntrypoint(profileName), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await ensureCcpsProfileRule(paths.ccpsProfileRulePath);

  return { config, paths };
}

/**
 * Ensure the Auto Memory directory and its MEMORY.md entrypoint exist.
 * The entrypoint is written only when missing — session-derived content is
 * never overwritten (used by create-from-custom-template, where Auto Memory
 * was excluded from the template; spec §11.3).
 */
export async function ensureAutoMemoryEntrypoint(
  paths: ProfileTemplatePaths,
  profileName: string,
): Promise<void> {
  await fs.ensureDir(paths.autoMemoryPath);
  if (await fs.pathExists(paths.autoMemoryEntrypointPath)) {
    return;
  }
  await fs.writeFile(paths.autoMemoryEntrypointPath, autoMemoryEntrypoint(profileName), {
    encoding: 'utf8',
    flag: 'wx',
  });
}

export async function ensureCcpsProfileRule(rulePath: string): Promise<boolean> {
  const desired = ccpsProfileRule();

  if (await fs.pathExists(rulePath)) {
    const current = await fs.readFile(rulePath, 'utf8');
    if (current === desired) {
      return false;
    }

    if (current.includes(legacyCcpsProfileRuleMarker)) {
      await fs.writeFile(rulePath, desired, 'utf8');
      return true;
    }

    const startIndexes = markerIndexes(current, ccpsProfileRuleStartMarker);
    const endIndexes = markerIndexes(current, ccpsProfileRuleEndMarker);
    if (startIndexes.length === 1 && endIndexes.length === 1 && endIndexes[0] >= startIndexes[0]) {
      const startIndex = startIndexes[0];
      const endIndex = endIndexes[0];
      const afterEnd = endIndex + ccpsProfileRuleEndMarker.length;
      const prefix = withoutLegacyV2Heading(current.slice(0, startIndex));
      const updated = `${prefix}${desired.trimEnd()}${current.slice(afterEnd)}`;
      await fs.writeFile(rulePath, updated, 'utf8');
      return true;
    }

    if (startIndexes.length === 1 && endIndexes.length === 0) {
      const preserved = withoutLegacyV2Heading(current.slice(0, startIndexes[0])).trimEnd();
      const updated = preserved.length === 0 ? desired : `${preserved}\n\n${desired}`;
      await fs.writeFile(rulePath, updated, 'utf8');
      return true;
    }

    if (hasUnrepairableCcpsProfileRuleMarkers(current)) {
      throw new CcpsError(
        'CCPS_PROFILE_RULE_CORRUPT',
        'The ccps-managed profile boundary markers are malformed.',
        {
          guidance: `Repair or remove the malformed managed markers in ${rulePath}, then run ccps init.`,
        },
      );
    }

    const preserved = current.trimEnd();
    const updated = preserved.length === 0 ? desired : `${preserved}\n\n${desired}`;
    await fs.writeFile(rulePath, updated, 'utf8');
    return true;
  }

  await fs.ensureDir(dirname(rulePath));
  await fs.writeFile(rulePath, desired, { encoding: 'utf8', flag: 'wx' });
  return true;
}

export function hasUnrepairableCcpsProfileRuleMarkers(content: string): boolean {
  const startIndexes = markerIndexes(content, ccpsProfileRuleStartMarker);
  const endIndexes = markerIndexes(content, ccpsProfileRuleEndMarker);

  if (startIndexes.length === 0 && endIndexes.length === 0) {
    return false;
  }

  if (startIndexes.length === 1 && endIndexes.length === 0) {
    return false;
  }

  return !(
    startIndexes.length === 1 &&
    endIndexes.length === 1 &&
    endIndexes[0] >= startIndexes[0]
  );
}

export async function ensureDefaultProfileSettingsEnv(settingsPath: string): Promise<boolean> {
  let settingsJson: unknown;

  try {
    settingsJson = await fs.readJson(settingsPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }

    if (error instanceof SyntaxError) {
      return false;
    }

    throw error;
  }

  if (!isRecord(settingsJson)) {
    return false;
  }

  const currentEnv = settingsJson.env;
  if (currentEnv !== undefined && !isRecord(currentEnv)) {
    return false;
  }

  const env = currentEnv ?? {};
  if (Object.hasOwn(env, defaultAttributionEnvKey)) {
    return false;
  }

  await writeJsonFile(
    settingsPath,
    {
      ...settingsJson,
      env: {
        ...env,
        ...defaultProfileSettingsEnv,
      },
    },
    { overwrite: true },
  );

  return true;
}

export function getRealClaudeMdExcludePaths(userHomePath?: string): string[] {
  const home = userHomePath ?? resolveUserHome();
  return [resolveFilesystemPath(home, '.claude', 'CLAUDE.md')];
}

export async function ensureProfileClaudeMdExcludes(settingsPath: string): Promise<boolean> {
  let settingsJson: unknown;

  try {
    settingsJson = await fs.readJson(settingsPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }

    if (error instanceof SyntaxError) {
      return false;
    }

    throw error;
  }

  if (!isRecord(settingsJson)) {
    return false;
  }

  const currentExcludes = settingsJson.claudeMdExcludes;
  if (currentExcludes !== undefined && !Array.isArray(currentExcludes)) {
    return false;
  }

  const excludePaths = getRealClaudeMdExcludePaths();
  const existing = (currentExcludes ?? []) as string[];

  const missing = excludePaths.filter((p) => !existing.includes(p));
  if (missing.length === 0) {
    return false;
  }

  await writeJsonFile(
    settingsPath,
    {
      ...settingsJson,
      claudeMdExcludes: [...existing, ...missing],
    },
    { overwrite: true },
  );

  return true;
}

function createInitialProfileSettings(paths: ProfileTemplatePaths): Record<string, unknown> {
  return {
    autoMemoryDirectory: paths.autoMemoryPath,
    claudeMdExcludes: getRealClaudeMdExcludePaths(),
    env: {
      ...defaultProfileSettingsEnv,
    },
  };
}

function profileClaudeMd(title: string, usage: string): string {
  return `# ${title} Profile

This file belongs to a ccps-managed Claude Code user-level global profile.
ccps loads it through CLAUDE_CONFIG_DIR when launching Claude Code.
This is the profile-scoped user memory file for this profile.
Project-level CLAUDE.md and project settings remain active separately.
The ccps-managed rules/ccps-profile.md file defines the profile configuration boundary,
including the correct Claude Code user-scope MCP workflow.

${usage}
`;
}

function ccpsProfileRule(): string {
  return `${ccpsProfileRuleStartMarker}
${ccpsProfileRuleHeading}

This Claude Code session runs inside a ccps-managed user profile.
\`CLAUDE_CONFIG_DIR\` is the authoritative user configuration directory for this session.

## MCP configuration

- For an MCP server that should belong to this profile across projects, use \`claude mcp add --scope user ...\`.
- Let \`claude mcp\` manage user-scope MCP state in \`$CLAUDE_CONFIG_DIR/.claude.json\`.
- Never add \`mcpServers\` to \`$CLAUDE_CONFIG_DIR/settings.json\`; Claude Code does not load MCP servers from that field.
- A project-root \`.mcp.json\` is project scope only. Create or edit it only when the user explicitly asks for project-shared MCP configuration.
- Never write profile-specific MCP configuration to the real \`~/.claude\`, real \`~/.claude.json\`, or a \`.mcp.json\` inside \`$CLAUDE_CONFIG_DIR\`.
- A sibling \`mcp.json\` at the ccps profile root may exist on older profiles. It is legacy compatibility state, not the destination for new MCP configuration.

Use \`claude mcp list\` to verify the active profile after changes. Do not run \`claude mcp get\`
in an agent-visible terminal because current Claude Code versions may print stored secret values.
${ccpsProfileRuleEndMarker}
`;
}

function markerIndexes(content: string, marker: string): number[] {
  const indexes: number[] = [];
  let nextIndex = content.indexOf(marker);

  while (nextIndex >= 0) {
    indexes.push(nextIndex);
    nextIndex = content.indexOf(marker, nextIndex + marker.length);
  }

  return indexes;
}

function withoutLegacyV2Heading(prefix: string): string {
  const legacyHeading = `${ccpsProfileRuleHeading}\n\n`;
  return prefix.endsWith(legacyHeading) ? prefix.slice(0, -legacyHeading.length) : prefix;
}

function autoMemoryEntrypoint(profileName: string): string {
  return `# ${profileName} Auto Memory

This file is the entrypoint for Claude Code auto memory for the "${profileName}" ccps profile.
Claude Code may update this file and create topic files in this directory during sessions.
`;
}
