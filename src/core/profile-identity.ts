import fs from 'fs-extra';

import { resolveInside, validateProfileName } from '../platform/path';
import { CcpsError } from '../utils/errors';
import { isRecord } from '../utils/type-guards';
import {
  ensureCcpsProfileRule,
  getRealClaudeMdExcludePaths,
  type ProfileTemplatePaths,
} from './profile-template';

/**
 * Profile identity and managed-path repair (issue #108): the one small
 * operation that rebinds a restored Profile copy to the location it will
 * actually live at. Both restore-as-new-name flows — durable Backup restore
 * (./backup) and whole-Profile Recovery Item restore (./recovery-bin) — run it
 * on their staged copy before publishing, and Import (issue #109) reuses it
 * with the same contract.
 *
 * The operation distinguishes two locations: `stagingPath`, where the Profile
 * tree is being assembled right now (its paths are still whatever the source
 * recorded), and `finalPath`, the Profile directory it will publish to. Every
 * managed path is written as the FINAL location's path, so validation and
 * launch see the restored target, never the source identity.
 *
 * Repairs (spec Decision 5):
 * - profile.json `name` → the new Profile name; user fields (description,
 *   template, launch choices, createdAt, …) are preserved untouched.
 * - settings.json `autoMemoryDirectory` → the final location's memory/auto.
 * - MEMORY.md entrypoint heading → the new Profile name (existing content is
 *   preserved; a missing entrypoint is created through the template service).
 * - the managed `rules/ccps-profile.md` boundary block → canonical content
 *   via the same ensureCcpsProfileRule service that creates and backfills it.
 * - settings.json `claudeMdExcludes` → includes this machine's real-user
 *   CLAUDE.md exclusion (user-provided entries are preserved).
 *
 * Preserved by design: the recorded launch.mcpMode (a Backup restore never
 * resets a user's existing choice — only Import forces `none` on new
 * Profiles), every other settings.json key, and any Linked Skill reference
 * whose source points outside the Profile.
 */

export type RepairProfileIdentityInput = {
  /** Where the Profile tree is staged right now. */
  stagingPath: string;
  /** The Profile directory this copy will publish to. */
  finalPath: string;
  /** The Profile name the restored copy must carry. */
  profileName: string;
};

/**
 * Rebind the staged Profile copy to the final identity/paths. Idempotent:
 * running it twice yields the same tree. Throws before any write when the
 * staged tree is not structurally a Profile (missing profile.json), so the
 * caller's staging area stays disposable and the target name is never
 * occupied by a failed repair.
 */
export async function repairProfileIdentity(input: RepairProfileIdentityInput): Promise<void> {
  const finalPaths = getProfilePathsFromRoot(input.finalPath, input.profileName);
  const stagingPaths = getProfilePathsFromRoot(input.stagingPath, input.profileName);
  const profileConfigPath = stagingPaths.profileConfigPath;

  if (!(await fs.pathExists(profileConfigPath))) {
    throw identityRepairFailed(
      'The restore payload has no profile.json and cannot be published as a Profile.',
    );
  }

  await repairProfileName(profileConfigPath, input.profileName);
  await repairSettingsManagedPaths(stagingPaths.settingsPath, finalPaths);
  await repairAutoMemoryEntrypoint(stagingPaths, input.profileName);
  await ensureCcpsProfileRule(stagingPaths.ccpsProfileRulePath);
}

// ─── profile.json ────────────────────────────────────────────────────────

async function repairProfileName(profileConfigPath: string, profileName: string): Promise<void> {
  const raw: unknown = await fs.readJson(profileConfigPath);
  if (!isRecord(raw)) {
    throw identityRepairFailed('profile.json is not a JSON object.');
  }

  // Only the identity field changes; user description, template, launch
  // choices, and timestamps pass through untouched.
  await fs.writeJson(profileConfigPath, { ...raw, name: profileName }, { spaces: 2 });
}

// ─── settings.json ───────────────────────────────────────────────────────

/**
 * Rebind the staged settings to the final managed paths. The file lives in
 * staging (stagingPaths.settingsPath); every VALUE written points at the
 * final location, so validation and launch see the restored target after
 * publish.
 */
async function repairSettingsManagedPaths(
  stagingSettingsPath: string,
  finalPaths: ProfileTemplatePaths,
): Promise<void> {
  if (!(await fs.pathExists(stagingSettingsPath))) {
    // A Profile without settings.json is not launchable, but the identity
    // repair only rebinds what exists; validation reports the gap.
    return;
  }

  let raw: unknown;
  try {
    raw = await fs.readJson(stagingSettingsPath);
  } catch (error) {
    throw identityRepairFailed('claude-home/settings.json cannot be parsed.', error);
  }
  if (!isRecord(raw)) {
    throw identityRepairFailed('claude-home/settings.json is not a JSON object.');
  }

  const updated: Record<string, unknown> = {
    ...raw,
    autoMemoryDirectory: finalPaths.autoMemoryPath,
  };

  const excludes = mergeClaudeMdExcludes(raw.claudeMdExcludes);
  if (excludes !== undefined) {
    updated.claudeMdExcludes = excludes;
  }

  await fs.writeJson(stagingSettingsPath, updated, { spaces: 2 });
}

/**
 * Ensure this machine's real-user CLAUDE.md exclusion is present, preserving
 * every user-provided entry. Undefined stays undefined (a tree without the
 * field keeps its shape); non-array values are left untouched for validation
 * to report.
 */
function mergeClaudeMdExcludes(current: unknown): string[] | undefined {
  if (current === undefined) return undefined;
  if (!Array.isArray(current)) return current as string[];

  const required = getRealClaudeMdExcludePaths();
  const missing = required.filter((entry) => !current.includes(entry));
  return missing.length === 0 ? (current as string[]) : [...current, ...missing];
}

// ─── Auto Memory entrypoint ──────────────────────────────────────────────

/**
 * The staged MEMORY.md entrypoint heading carries the source Profile name, so
 * the first heading line is rewritten to the new name and the body preserved.
 * The heading format must match the template's autoMemoryEntrypoint
 * (./profile-template). All writes stay inside staging; only the heading
 * VALUE reflects the final identity.
 */
function autoMemoryEntrypointHeading(profileName: string): string {
  return `# ${profileName} Auto Memory`;
}

async function repairAutoMemoryEntrypoint(
  stagingPaths: ProfileTemplatePaths,
  profileName: string,
): Promise<void> {
  await fs.ensureDir(stagingPaths.autoMemoryPath);

  if (!(await fs.pathExists(stagingPaths.autoMemoryEntrypointPath))) {
    await fs.writeFile(
      stagingPaths.autoMemoryEntrypointPath,
      `${autoMemoryEntrypointHeading(profileName)}\n\nThis file is the entrypoint for Claude Code auto memory for the "${profileName}" ccps profile.\nClaude Code may update this file and create topic files in this directory during sessions.\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return;
  }

  const content = await fs.readFile(stagingPaths.autoMemoryEntrypointPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const body = lines[0]?.startsWith('# ') === true
    ? lines.slice(1).join('\n').replace(/^\n+/, '')
    : content;
  await fs.writeFile(
    stagingPaths.autoMemoryEntrypointPath,
    `${autoMemoryEntrypointHeading(profileName)}\n${body}`,
    'utf8',
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Path resolution against an explicit profile root. getProfileTemplatePaths
 * derives roots from the app home + name; restore flows already hold absolute
 * staging/final roots, so derive the same shape locally without assuming an
 * app home. The name is validated because callers derive paths from it.
 */
function getProfilePathsFromRoot(
  profileRootPath: string,
  profileName: string,
): ProfileTemplatePaths {
  validateProfileName(profileName);
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

function identityRepairFailed(message: string, cause?: unknown): CcpsError {
  return new CcpsError('PROFILE_IDENTITY_REPAIR_FAILED', message, {
    guidance: 'Nothing was published to the target name; the restore can be retried.',
    cause,
  });
}