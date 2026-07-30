import fs from 'fs-extra';
import path from 'node:path';

import { getAppHomePath, resolveInside, validateProfileName } from '../platform/path';
import { type Clock, writeJsonFile } from './app-config';
import { importClaudeApiSettings } from './claude-settings';
import { ensureCcpsProfileRule, getProfileTemplatePaths } from './profile-template';

const PROFILE_CREATOR_NAME = 'profile-creator';
// Dev mode: __dirname = src/core/ -> ../templates/ = src/templates/
// Bundled:  __dirname = dist/     -> templates/  = dist/templates/
const TEMPLATES_DIR = fs.existsSync(path.resolve(__dirname, 'templates', 'profile-creator'))
  ? path.resolve(__dirname, 'templates', 'profile-creator')
  : path.resolve(__dirname, '..', 'templates', 'profile-creator');

export type EnsureProfileCreatorOptions = {
  appHomePath?: string;
  clock?: Clock;
};

/**
 * Ensure the built-in _profile-creator profile exists with the ccps-create-profile skill.
 * Creates it on first run, updates skill files on subsequent runs.
 */
export async function ensureProfileCreator(
  options: EnsureProfileCreatorOptions = {},
): Promise<string> {
  const appHomePath = options.appHomePath ?? getAppHomePath();
  const profileName = validateProfileName(PROFILE_CREATOR_NAME);
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  const clock = options.clock ?? (() => new Date());

  if (!(await fs.pathExists(paths.profileRootPath))) {
    await createProfileCreatorProfile(appHomePath, paths, clock);
  }

  // Sync latest ANTHROPIC_* env vars from real ~/.claude/settings.json
  await importClaudeApiSettings({ appHomePath });

  // Always update skill files to latest version
  await copySkillFiles(paths.skillsPath);
  await ensureCcpsProfileRule(paths.ccpsProfileRulePath);

  return profileName;
}

async function createProfileCreatorProfile(
  appHomePath: string,
  paths: ReturnType<typeof getProfileTemplatePaths>,
  clock: Clock,
): Promise<void> {
  const profileCreatorDir = TEMPLATES_DIR;
  const templateClaudeMd = path.join(profileCreatorDir, 'CLAUDE.md');

  const timestamp = clock().toISOString();
  const config = {
    name: PROFILE_CREATOR_NAME,
    description: 'Built-in profile creator wizard. Use `ccps create-profile` to launch.',
    template: 'general' as const,
    launch: {
      mcpMode: 'none' as const,
      pluginDirs: [] as string[],
      disableAutoMemory: false,
      skipPermissions: true,
      claudeArgs: [] as string[],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  // Create directory structure
  await fs.ensureDir(paths.profileRootPath);
  await fs.ensureDir(paths.claudeHomePath);
  await fs.ensureDir(paths.memoryPath);
  await fs.ensureDir(paths.autoMemoryPath);
  await fs.ensureDir(paths.skillsPath);
  await fs.ensureDir(paths.agentsPath);
  await fs.ensureDir(paths.rulesPath);
  await fs.ensureDir(paths.pluginsPath);

  // Write config files
  await writeJsonFile(paths.profileConfigPath, config, { overwrite: false });
  await writeJsonFile(paths.settingsPath, createProfileCreatorSettings(paths), {
    overwrite: false,
  });
  await ensureCcpsProfileRule(paths.ccpsProfileRulePath);

  // Write CLAUDE.md
  if (await fs.pathExists(templateClaudeMd)) {
    await fs.copy(templateClaudeMd, paths.claudeMdPath, { overwrite: false });
  } else {
    await fs.writeFile(paths.claudeMdPath, defaultCreatorClaudeMd(), {
      encoding: 'utf8',
      flag: 'wx',
    });
  }

  // Write MEMORY.md entrypoint
  await fs.writeFile(
    paths.autoMemoryEntrypointPath,
    `# ${PROFILE_CREATOR_NAME} Auto Memory

This file is the entrypoint for Claude Code auto memory for the "${PROFILE_CREATOR_NAME}" ccps profile.
Claude Code may update this file and create topic files in this directory during sessions.
`,
    { encoding: 'utf8', flag: 'wx' },
  );
}

async function copySkillFiles(skillsPath: string): Promise<void> {
  const sourceSkillsDir = path.join(TEMPLATES_DIR, 'skills');

  if (!(await fs.pathExists(sourceSkillsDir))) {
    return;
  }

  const skillName = 'ccps-create-profile';
  const targetSkillDir = resolveInside(skillsPath, skillName);
  const sourceSkillDir = path.join(sourceSkillsDir, skillName);

  if (!(await fs.pathExists(sourceSkillDir))) {
    return;
  }

  // Always overwrite to ensure latest version
  await fs.copy(sourceSkillDir, targetSkillDir, { overwrite: true });
}

function createProfileCreatorSettings(
  paths: ReturnType<typeof getProfileTemplatePaths>,
): Record<string, unknown> {
  return {
    autoMemoryDirectory: paths.autoMemoryPath,
    env: {
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    },
  };
}

function defaultCreatorClaudeMd(): string {
  return `# Profile Creator Wizard

You are a ccps profile creation wizard. Guide the user through creating a complete, high-quality Claude Code profile.

Use the \`ccps-create-profile\` skill (pre-installed) to complete all work.

## Workflow

1. Understand the user's needs
2. Follow the skill's 8-stage workflow
3. Present the result

Use the user's language. Be concise. Act when requirements are clear.
`;
}
