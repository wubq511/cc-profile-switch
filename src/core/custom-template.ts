import fs from 'fs-extra';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

import { getAppHomePaths, loadAppConfig, type Clock } from './app-config';
import { atomicWriteJson } from './versioned-json';
import { processSecrets, pruneRuntimeInternals } from './profile-export';
import {
  selectResourcesIntoStaging,
  sweepRuntimeEntriesFromStagedProfile,
  type ResourceCopyFailure,
} from './resource-policy';
import {
  clearNativeMcpServers,
  collectLegacyMcpEnvKeys,
  collectMcpHeaderKeys,
  collectSettingsSecretKeys,
  repairImportedProfile,
  reRegisterMcpServers,
  type ImportMcpServerResult,
} from './profile-import';
import { readMcpServersMap } from './mcp-servers';
import {
  ensureAutoMemoryEntrypoint,
  getProfileTemplatePaths,
  listProfileTemplates,
} from './profile-template';
import { validateProfile, type ProfileValidationResult } from './validator';
import { resolveInside, validateProfileName } from '../platform/path';
import type { CaptureProcess } from '../platform/process';
import { profileConfigSchema } from '../schemas/profile';
import type { BundleStrippedKeys } from '../schemas/profile-bundle';
import {
  CUSTOM_TEMPLATE_MANIFEST_VERSION,
  customTemplateManifestV2Schema,
  customTemplateV2OrV1Schema,
  type CustomTemplateManifest,
} from '../schemas/custom-template';
import { CcpsError } from '../utils/errors';

/**
 * Custom profile templates — save a Profile as a reusable template and create
 * new Profiles from it (spec §11.3, issue #75; boundary per issue #105).
 *
 * On-disk layout (mirrors the export bundle layout):
 *   templates/<name>/
 *     template.json   — zod-validated manifest (CustomTemplateManifest, v2)
 *     profile/        — resource-selected profile tree (same shape as profiles/<name>/)
 *
 * Safety contract:
 *   - Templates NEVER contain secrets. Env and MCP header values are always
 *     redacted at save time; unlike export there is no include-secrets opt-in
 *     (templates are plaintext at rest in app home). Key names are recorded in
 *     the manifest for guided re-entry on create (import experience).
 *   - The tree is selected into staging through the same shared resource
 *     pipeline as export (no whole-tree copy + prune): Auto Memory,
 *     runtime internals (sessions/history/projects/caches/credentials),
 *     Backups and the Recovery Bin are never captured. Linked Skills are
 *     kept as references — the template records their names in
 *     `linkedSkills` and the link itself is never materialized.
 *   - MCP servers are captured as inventory only; create re-registers them
 *     through the delegated `claude mcp add --scope user` path, never via
 *     direct `.claude.json` writes (import parity).
 *   - Management surface is Remove only — no editing, no template
 *     import/export. Built-in template names are reserved.
 *   - Never reads or touches the real ~/.claude or ~/.claude.json.
 */

const TEMPLATES_DIR = 'templates';
const TEMPLATE_MANIFEST_FILE = 'template.json';
const TEMPLATE_PROFILE_DIR = 'profile';

export type SaveTemplatePreview = {
  strippedKeys: BundleStrippedKeys[];
  strippedCount: number;
  autoMemoryExcluded: true;
};

export type SaveProfileAsTemplateOptions = {
  appHomePath?: string;
  profileName: string;
  templateName: string;
  clock?: Clock;
};

export type SaveProfileAsTemplateResult = {
  manifest: CustomTemplateManifest;
  strippedCount: number;
};

export type CreateProfileFromCustomTemplateOptions = {
  appHomePath?: string;
  templateName: string;
  name: string;
  clock?: Clock;
  captureProcess?: CaptureProcess;
};

/** Mirrors ImportResult minus the bundle manifest (templates are local). */
export type CreateProfileFromCustomTemplateResult = {
  profileName: string;
  profileRootPath: string;
  /** Per native `.claude.json` MCP server: delegated re-registration outcome. */
  mcpServers: ImportMcpServerResult[];
  /** settings.json `env.ANTHROPIC_*` placeholder keys needing re-entry. */
  settingsSecretKeysToReenter: string[];
  /** Legacy root `mcp.json` env key names needing re-entry, grouped by server. */
  legacyMcpEnvKeysToReenter: { server: string; keys: string[] }[];
  /** MCP HTTP header key names needing re-entry, grouped by server. */
  mcpHeaderKeysToReenter: { server: string; keys: string[] }[];
  validation: ProfileValidationResult;
};

/**
 * Scan-only stripping preview for the save-as-template confirmation panel.
 * Runs the same resource selection + redact pipeline a real save would run
 * into a throwaway staging dir, and reports what would be stripped. Writes
 * nothing under `templates/` and never mutates the source profile.
 */
export async function previewSaveProfileAsTemplate(options: {
  appHomePath?: string;
  profileName: string;
}): Promise<SaveTemplatePreview> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const profilePaths = getProfileTemplatePaths(appHomePath, options.profileName);
  if (!(await fs.pathExists(profilePaths.profileRootPath))) {
    throw new CcpsError('PROFILE_NOT_FOUND', 'Profile does not exist.', {
      guidance: `Create the profile first: ccps create ${options.profileName}`,
    });
  }

  return withStrippedStaging(
    appHomePath,
    '.ccps-template-preview-',
    profilePaths.profileRootPath,
    async ({ strippedKeys }) => ({
      strippedKeys,
      strippedCount: countStripped(strippedKeys),
      autoMemoryExcluded: true as const,
    }),
  );
}

export async function saveProfileAsTemplate(
  options: SaveProfileAsTemplateOptions,
): Promise<SaveProfileAsTemplateResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  await loadAppConfig(appHomePath);

  const templateName = validateProfileName(options.templateName);
  if (reservedTemplateNames().has(templateName)) {
    throw new CcpsError(
      'TEMPLATE_NAME_RESERVED',
      'This name is reserved for a built-in template.',
      { guidance: 'Choose a different template name.' },
    );
  }
  const profilePaths = getProfileTemplatePaths(appHomePath, options.profileName);
  if (!(await fs.pathExists(profilePaths.profileRootPath))) {
    throw new CcpsError('PROFILE_NOT_FOUND', 'Profile does not exist.', {
      guidance: `Create the profile first: ccps create ${options.profileName}`,
    });
  }
  const templatesPath = resolveInside(appHomePath, TEMPLATES_DIR);
  const targetPath = resolveInside(templatesPath, templateName);
  if (await fs.pathExists(targetPath)) {
    throw new CcpsError(
      'TEMPLATE_ALREADY_EXISTS',
      'A custom template with this name already exists.',
      {
        guidance: `Remove the existing template first or choose a different name: ${templateName}`,
      },
    );
  }

  // Stage under templates/ so the final move is a same-volume rename —
  // atomic on POSIX (spec §15.3 invariant 6).
  await fs.ensureDir(templatesPath);
  return withStrippedStaging(
    templatesPath,
    '.ccps-tmp-',
    profilePaths.profileRootPath,
    async ({ stagingRoot, stagingProfile, strippedKeys, linkedSkills, selection }) => {
      const manifest = customTemplateManifestV2Schema.parse({
        version: CUSTOM_TEMPLATE_MANIFEST_VERSION,
        name: templateName,
        ...(await readSourceDescription(stagingProfile)),
        sourceProfile: options.profileName,
        createdAt: (options.clock ?? (() => new Date()))().toISOString(),
        strippedKeys,
        mcpServerNames: await readTemplateMcpServerNames(stagingProfile),
        linkedSkills,
        excludedTopLevelEntries: selection.skipped,
      });
      await atomicWriteJson(path.join(stagingRoot, TEMPLATE_MANIFEST_FILE), manifest);

      await fs.move(stagingRoot, targetPath, { overwrite: false });
      return { manifest, strippedCount: countStripped(strippedKeys) };
    },
  );
}

/**
 * List saved custom templates sorted by name. A missing `templates/` dir is an
 * empty list. An entry whose template.json is unreadable or fails schema
 * validation is skipped — listing must never crash, and nothing is silently
 * deleted.
 */
export async function listCustomTemplates(appHomePath?: string): Promise<CustomTemplateManifest[]> {
  const home = appHomePath ?? getAppHomePaths().appHomePath;
  const templatesPath = resolveInside(home, TEMPLATES_DIR);
  if (!(await fs.pathExists(templatesPath))) {
    return [];
  }
  const entries = await fs.readdir(templatesPath, { withFileTypes: true });
  const manifests: CustomTemplateManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    try {
      const raw = await fs.readJson(path.join(templatesPath, entry.name, TEMPLATE_MANIFEST_FILE));
      manifests.push(parseTemplateManifest(raw));
    } catch {
      // skip — never delete, never crash
    }
  }
  return manifests.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a template manifest of any supported version (v1, v2); a newer
 * version fails schema validation (rejected upstream, never silently read).
 */
export function parseTemplateManifest(raw: unknown): CustomTemplateManifest {
  return customTemplateV2OrV1Schema.parse(raw);
}

/**
 * Create a new Profile from a custom template. Reuses the import experience:
 * the stripped tree lands, managed fields are repaired for the new name, MCP
 * servers are re-registered through the delegated `claude mcp add` path, and
 * the result lists every secret key name needing guided re-entry (env and
 * HTTP header key names alike).
 */
export async function createProfileFromCustomTemplate(
  options: CreateProfileFromCustomTemplateOptions,
): Promise<CreateProfileFromCustomTemplateResult> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  await loadAppConfig(appHomePath);

  const templateName = validateProfileName(options.templateName);
  const templatesPath = resolveInside(appHomePath, TEMPLATES_DIR);
  const templateDir = resolveInside(templatesPath, templateName);
  const manifestPath = path.join(templateDir, TEMPLATE_MANIFEST_FILE);
  const templateProfile = path.join(templateDir, TEMPLATE_PROFILE_DIR);
  if (
    !(await fs.pathExists(templateDir)) ||
    !(await fs.pathExists(manifestPath)) ||
    !(await fs.pathExists(templateProfile))
  ) {
    throw new CcpsError('TEMPLATE_NOT_FOUND', 'Custom template does not exist.', {
      guidance: `Pick a template from the create list, or save one first: ${templateName}`,
    });
  }
  const manifest = await readTemplateManifest(manifestPath);

  const profileName = validateProfileName(options.name);
  const targetPaths = getProfileTemplatePaths(appHomePath, profileName);
  if (await fs.pathExists(targetPaths.profileRootPath)) {
    throw new CcpsError('PROFILE_ALREADY_EXISTS', 'Refusing to overwrite an existing profile.', {
      guidance: `Choose a different profile name or back up and remove the existing profile: ${profileName}`,
    });
  }

  await fs.copy(templateProfile, targetPaths.profileRootPath, {
    overwrite: false,
    errorOnExist: true,
  });

  // Defense in depth for templates saved by older ccps versions (v1 era,
  // pre-policy): a legacy template tree may still carry runtime entries.
  // The staged copy is swept with the same runtime-entry rule as imports;
  // the stored template artifact itself is never rewritten.
  await sweepRuntimeEntriesFromStagedProfile(targetPaths.profileRootPath);

  // Linked Skills travel as references only: re-create the symlink (if the
  // source target still exists) rather than materializing the external dir.
  const linkedSkills = manifest.version >= 2 ? manifest.linkedSkills : [];
  for (const skillName of linkedSkills) {
    const linkPath = path.join(targetPaths.claudeHomePath, 'skills', skillName);
    const linkedTarget = await readTemplateLinkedSkillTarget(templateDir, skillName);
    if (linkedTarget === undefined) {
      // Source tree unavailable from this machine/template — the new profile
      // simply lacks the skill; re-link is a manual step.
      continue;
    }
    await fs.remove(linkPath).catch(() => undefined);
    await fs.symlink(linkedTarget, linkPath, 'dir').catch(async () => {
      await fs.symlink(linkedTarget, linkPath, 'junction').catch(() => undefined);
    });
  }

  // Capture the MCP inventory, then reset .claude.json — the only writes that
  // populate it come from delegated `claude mcp add --scope user`.
  const servers = await readMcpServersMap(targetPaths.profileRootPath);
  await clearNativeMcpServers(targetPaths.profileRootPath);

  // Repair managed fields so the profile points at its own locations (the
  // template's settings.json still references the source profile's paths).
  await repairImportedProfile(targetPaths, profileName, options.clock);
  // Auto Memory was excluded from the template; recreate the empty dir and
  // its entrypoint so the new profile is complete.
  await ensureAutoMemoryEntrypoint(targetPaths, profileName);

  // Failures are collected, never aborting the rest or the Validate.
  const mcpServers = await reRegisterMcpServers(
    targetPaths.profileRootPath,
    servers,
    options.captureProcess,
  );

  const validation = await validateProfile({ appHomePath, name: profileName });

  return {
    profileName,
    profileRootPath: targetPaths.profileRootPath,
    mcpServers,
    settingsSecretKeysToReenter: collectSettingsSecretKeys(manifest.strippedKeys),
    legacyMcpEnvKeysToReenter: collectLegacyMcpEnvKeys(manifest.strippedKeys),
    mcpHeaderKeysToReenter: collectMcpHeaderKeys(manifest.strippedKeys),
    validation,
  };
}

/** Read the recorded target for a template Linked Skill entry, if present. */
async function readTemplateLinkedSkillTarget(
  templateDir: string,
  skillName: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.readJson(path.join(templateDir, TEMPLATE_LINKED_SKILLS_FILE));
    if (isRecordShape(raw) && typeof raw[skillName] === 'string') {
      return raw[skillName];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecordShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Remove a custom template. Built-in template names are reserved and can
 * never be removed through this path (S104). Zero-confirm is a UI concern.
 */
export async function removeCustomTemplate(options: {
  appHomePath?: string;
  templateName: string;
}): Promise<void> {
  const appHomePath = options.appHomePath ?? getAppHomePaths().appHomePath;
  const templateName = validateProfileName(options.templateName);
  if (reservedTemplateNames().has(templateName)) {
    throw new CcpsError('TEMPLATE_NAME_RESERVED', 'Built-in templates cannot be removed.', {
      guidance: 'Only custom templates can be removed.',
    });
  }
  const targetPath = resolveInside(appHomePath, TEMPLATES_DIR, templateName);
  if (!(await fs.pathExists(targetPath))) {
    throw new CcpsError('TEMPLATE_NOT_FOUND', 'Custom template does not exist.', {
      guidance: `Nothing to remove: ${templateName}`,
    });
  }
  await fs.remove(targetPath);
}

/**
 * Names a custom template may never take. listProfileTemplates() covers the
 * five named picker seeds; 'blank' is the sixth built-in — the minimal empty
 * profile offered as the create default — and 'none' is its internal alias in
 * profileTemplates (resolveTemplateName maps both to the same seed). Reserving
 * all of them keeps the combined picker unambiguous (§11.3) and blocks
 * "remove a built-in" through the custom-template path (S104).
 */
function reservedTemplateNames(): Set<string> {
  return new Set([...listProfileTemplates(), 'blank', 'none']);
}

/** Sidecar recording Linked Skill symlink targets (relative to the source). */
const TEMPLATE_LINKED_SKILLS_FILE = 'linked-skills.json';

/**
 * Shared staging pipeline for preview and save: run the shared resource
 * selection into a staging dir under `stagingParent` (no Auto Memory, no
 * runtime internals, no whole-tree copy), keep Linked Skill references, and
 * redact every secret-class value. The callback receives the staged paths,
 * the harvested strippedKeys, and the selection summary; staging is always
 * removed afterwards (a no-op once the callback has renamed it away, as save
 * does).
 */
async function withStrippedStaging<T>(
  stagingParent: string,
  prefix: string,
  profileRootPath: string,
  fn: (staging: {
    stagingRoot: string;
    stagingProfile: string;
    strippedKeys: BundleStrippedKeys[];
    linkedSkills: string[];
    selection: { skipped: string[] };
  }) => Promise<T>,
): Promise<T> {
  const stagingRoot = await mkdtemp(path.join(stagingParent, prefix));
  try {
    const stagingProfile = path.join(stagingRoot, TEMPLATE_PROFILE_DIR);
    const selection = await selectResourcesIntoStaging({
      sourceProfileRoot: profileRootPath,
      stagingProfileRoot: stagingProfile,
      includeAutoMemory: false,
      // Linked Skills are kept as references (recorded in the manifest +
      // sidecar), never materialized — template-specific policy (§11.3).
      keepLinkedSkillReferences: true,
    });
    if (selection.failures.length > 0) {
      throwOnSelectionFailure(selection.failures);
    }
    // Linked Skills cannot pass the selection's symlink refusal; templates
    // keep them as references. Read the target strings from the SOURCE links
    // (only the link itself, never the external content) so the manifest and
    // sidecar agree on exactly the links create can re-create.
    const linkedSkillTargets = await collectLinkedSkillTargets(profileRootPath);
    await writeLinkedSkillSidecar(stagingRoot, linkedSkillTargets);

    // Defense in depth on the staged copy: drop any runtime entry that could
    // not be selected (the allowlist already prevents them) and prune
    // .claude.json to the MCP inventory — OAuth/account fields never enter a
    // template. These calls never touch the source profile.
    await sweepRuntimeEntriesFromStagedProfile(stagingProfile);
    await pruneRuntimeInternals(stagingProfile);

    // Always redact: templates never contain secrets — there is no
    // include-secrets opt-in (§11.3). The redaction pass also prunes
    // .claude.json to the MCP inventory (env/header values stripped,
    // OAuth/account fields dropped) and strips settings/mcp.json env values.
    const { strippedKeys } = await processSecrets(stagingProfile, { redact: true });
    return await fn({
      stagingRoot,
      stagingProfile,
      strippedKeys,
      linkedSkills: [...linkedSkillTargets.keys()],
      selection: { skipped: selection.skipped },
    });
  } finally {
    await fs.remove(stagingRoot);
  }
}

function throwOnSelectionFailure(failures: ResourceCopyFailure[]): void {
  const first = failures[0];
  if (first === undefined) {
    return;
  }
  throw new CcpsError(first.code, first.message, { guidance: first.guidance });
}

/**
 * Targets of Linked Skills (symlinks directly under claude-home/skills/), keyed
 * by skill name. Only the link itself is read — the external directory is
 * never entered. A link whose target cannot be read records nothing: the
 * manifest then omits it rather than promising a reference it cannot keep.
 */
async function collectLinkedSkillTargets(profileRootPath: string): Promise<Map<string, string>> {
  const skillsDir = path.join(profileRootPath, 'claude-home', 'skills');
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
  const targets = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const linkPath = path.join(skillsDir, entry.name);
    try {
      targets.set(entry.name, await fs.readlink(linkPath));
    } catch {
      // unreadable link — record nothing for it
    }
  }
  return targets;
}

/**
 * Record Linked Skill targets in a sidecar so create can re-create the
 * references. Only the target path string is stored — the external directory
 * itself is never read or copied into the template.
 */
async function writeLinkedSkillSidecar(
  stagingRoot: string,
  targets: Map<string, string>,
): Promise<void> {
  if (targets.size === 0) {
    return;
  }
  await fs.writeJson(
    path.join(stagingRoot, TEMPLATE_LINKED_SKILLS_FILE),
    Object.fromEntries(targets),
    { spaces: 2 },
  );
}

async function readTemplateManifest(manifestPath: string): Promise<CustomTemplateManifest> {
  try {
    const raw = await fs.readJson(manifestPath);
    return parseTemplateManifest(raw);
  } catch (error) {
    throw new CcpsError(
      'TEMPLATE_INVALID',
      'Template manifest is invalid or from an incompatible ccps version.',
      {
        guidance: 'Remove the template and save it again from its source profile.',
        cause: error,
      },
    );
  }
}

/** Carry the source profile's description into the manifest, when present. */
async function readSourceDescription(stagingProfile: string): Promise<{ description?: string }> {
  try {
    const raw = await fs.readJson(path.join(stagingProfile, 'profile.json'));
    const parsed = profileConfigSchema.safeParse(raw);
    const description = parsed.success ? parsed.data.description : undefined;
    return description ? { description } : {};
  } catch {
    return {};
  }
}

async function readTemplateMcpServerNames(stagingProfile: string): Promise<string[]> {
  const servers = await readMcpServersMap(stagingProfile);
  return [...servers.keys()].sort((a, b) => a.localeCompare(b));
}

function countStripped(strippedKeys: BundleStrippedKeys[]): number {
  return strippedKeys.reduce((total, entry) => total + entry.keys.length, 0);
}
