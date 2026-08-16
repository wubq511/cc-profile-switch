import fs from 'fs-extra';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

import { getAppHomePaths, loadAppConfig, type Clock } from './app-config';
import { atomicWriteJson } from './versioned-json';
import { processSecrets, pruneRuntimeInternals } from './profile-export';
import {
  clearNativeMcpServers,
  collectLegacyMcpEnvKeys,
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
  customTemplateManifestSchema,
  type CustomTemplateManifest,
} from '../schemas/custom-template';
import { CcpsError } from '../utils/errors';

/**
 * Custom profile templates — save a Profile as a reusable template and create
 * new Profiles from it (spec §11.3, issue #75).
 *
 * On-disk layout (mirrors the export bundle layout):
 *   templates/<name>/
 *     template.json   — zod-validated manifest (CustomTemplateManifest)
 *     profile/        — stripped profile tree (same shape as profiles/<name>/)
 *
 * Safety contract:
 *   - Templates NEVER contain secrets. Secret-class env values are always
 *     redacted at save time; unlike export there is no include-secrets opt-in
 *     (templates are plaintext at rest in app home). Key names are recorded in
 *     the manifest for guided re-entry on create (import experience).
 *   - Auto Memory (session-derived), runtime internals (sessions/projects/
 *     OAuth), Backups and the Recovery Bin are never captured.
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
  validation: ProfileValidationResult;
};

/**
 * Scan-only stripping preview for the save-as-template confirmation panel.
 * Copies the profile to a throwaway staging dir, runs the same prune + redact
 * pipeline a real save would run, and reports what would be stripped. Writes
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
      strippedCount: countStrippedKeys(strippedKeys),
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
      { guidance: `Remove the existing template first or choose a different name: ${templateName}` },
    );
  }

  // Stage under templates/ so the final move is a same-volume rename —
  // atomic on POSIX (spec §15.3 invariant 6).
  await fs.ensureDir(templatesPath);
  return withStrippedStaging(
    templatesPath,
    '.ccps-tmp-',
    profilePaths.profileRootPath,
    async ({ stagingRoot, stagingProfile, strippedKeys }) => {
      const manifest = customTemplateManifestSchema.parse({
        version: 1,
        name: templateName,
        ...(await readSourceDescription(stagingProfile)),
        sourceProfile: options.profileName,
        createdAt: (options.clock ?? (() => new Date()))().toISOString(),
        strippedKeys,
        mcpServerNames: await readTemplateMcpServerNames(stagingProfile),
      });
      await atomicWriteJson(path.join(stagingRoot, TEMPLATE_MANIFEST_FILE), manifest);

      await fs.move(stagingRoot, targetPath, { overwrite: false });
      return { manifest, strippedCount: countStrippedKeys(strippedKeys) };
    },
  );
}

/**
 * List saved custom templates sorted by name. A missing `templates/` dir is an
 * empty list. An entry whose template.json is unreadable or fails schema
 * validation is skipped — listing must never crash, and nothing is silently
 * deleted.
 */
export async function listCustomTemplates(
  appHomePath?: string,
): Promise<CustomTemplateManifest[]> {
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
      manifests.push(customTemplateManifestSchema.parse(raw));
    } catch {
      // skip — never delete, never crash
    }
  }
  return manifests.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create a new Profile from a custom template. Reuses the import experience:
 * the stripped tree lands, managed fields are repaired for the new name, MCP
 * servers are re-registered through the delegated `claude mcp add` path, and
 * the result lists every secret key name needing guided re-entry.
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
    validation,
  };
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

/**
 * Shared staging pipeline for preview and save: mkdtemp a staging dir under
 * `stagingParent`, copy the profile tree into staging/profile/, strip it down
 * to what a template captures (no Auto Memory, no runtime internals), and
 * redact every secret-class value. The callback receives the staged paths and
 * the harvested strippedKeys; staging is always removed afterwards (a no-op
 * once the callback has renamed it away, as save does).
 */
async function withStrippedStaging<T>(
  stagingParent: string,
  prefix: string,
  profileRootPath: string,
  fn: (staging: {
    stagingRoot: string;
    stagingProfile: string;
    strippedKeys: BundleStrippedKeys[];
  }) => Promise<T>,
): Promise<T> {
  const stagingRoot = await mkdtemp(path.join(stagingParent, prefix));
  try {
    const stagingProfile = path.join(stagingRoot, TEMPLATE_PROFILE_DIR);
    // The source profile is never mutated; all stripping happens on the copy.
    await fs.copy(profileRootPath, stagingProfile, {
      overwrite: false,
      errorOnExist: true,
    });
    await prepareStrippedTree(stagingProfile);
    // Always redact: templates never contain secrets — there is no
    // include-secrets opt-in (§11.3).
    const { strippedKeys } = await processSecrets(stagingProfile, { redact: true });
    return await fn({ stagingRoot, stagingProfile, strippedKeys });
  } finally {
    await fs.remove(stagingRoot);
  }
}

/**
 * Strip a staged profile tree down to what a template captures: drop Auto
 * Memory (session-derived) and runtime internals (sessions/projects/OAuth).
 */
async function prepareStrippedTree(stagingProfile: string): Promise<void> {
  await fs.remove(path.join(stagingProfile, 'claude-home', 'memory', 'auto'));
  await pruneRuntimeInternals(stagingProfile);
}

async function readTemplateManifest(manifestPath: string): Promise<CustomTemplateManifest> {
  try {
    const raw = await fs.readJson(manifestPath);
    return customTemplateManifestSchema.parse(raw);
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
async function readSourceDescription(
  stagingProfile: string,
): Promise<{ description?: string }> {
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

function countStrippedKeys(strippedKeys: BundleStrippedKeys[]): number {
  return strippedKeys.reduce((total, entry) => total + entry.keys.length, 0);
}
