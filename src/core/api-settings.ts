import fs from 'fs-extra';

import { apiSettingsSchema, profileSettingsApiSchema } from '../schemas/api-settings';
import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';
import { getAppHomePaths } from './app-config';
import { REDACTED } from './profile-export';
import { getProfileTemplatePaths } from './profile-template';

export type ApiSettingsSource = {
  path: string;
  present: boolean;
  keys: string[];
};

export type ResolvedApiSettings = {
  common: ApiSettingsSource;
  profile: ApiSettingsSource;
  keys: string[];
  env: Record<string, string>;
};

type ApiSettingsLoadResult = ApiSettingsSource & {
  env: Record<string, string>;
};

export async function resolveApiSettings(options: {
  appHomePath: string;
  profileName: string;
}): Promise<ResolvedApiSettings> {
  const appPaths = getAppHomePaths(options.appHomePath);
  const profilePaths = getProfileTemplatePaths(options.appHomePath, options.profileName);
  const common = await loadApiSettingsFile(appPaths.apiSettingsPath);
  const profile = await loadProfileSettingsEnv(profilePaths.settingsPath);
  const env = {
    ...common.env,
    ...profile.env,
  };

  return {
    common: publicSource(common),
    profile: publicSource(profile),
    keys: sortedKeys(env),
    env,
  };
}

async function loadApiSettingsFile(filePath: string): Promise<ApiSettingsLoadResult> {
  let raw: string;

  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { path: filePath, present: false, keys: [], env: {} };
    }

    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw invalidApiSettings(filePath, error);
  }

  const parsed = apiSettingsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw invalidApiSettings(filePath, parsed.error);
  }

  const env = dropRedactedPlaceholders(parsed.data.env);
  return {
    path: filePath,
    present: true,
    keys: sortedKeys(env),
    env,
  };
}

async function loadProfileSettingsEnv(filePath: string): Promise<ApiSettingsLoadResult> {
  let raw: string;

  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { path: filePath, present: false, keys: [], env: {} };
    }

    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw invalidApiSettings(filePath, error);
  }

  const parsed = profileSettingsApiSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw invalidApiSettings(filePath, parsed.error);
  }

  const env = dropRedactedPlaceholders(parsed.data.env ?? {});

  return {
    path: filePath,
    present: hasOwnEnv(parsedJson),
    keys: sortedKeys(env),
    env,
  };
}

/**
 * Imported profiles carry `<redacted>` placeholders for stripped secrets until
 * the user re-enters them. Injecting the literal marker as a launch env value
 * would hand Claude a garbage key — drop placeholders from the injectable env.
 */
function dropRedactedPlaceholders(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== REDACTED));
}

function publicSource(source: ApiSettingsLoadResult): ApiSettingsSource {
  return {
    path: source.path,
    present: source.present,
    keys: source.keys,
  };
}

function sortedKeys(value: Record<string, string>): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function invalidApiSettings(filePath: string, cause: unknown): CcpsError {
  return new CcpsError('API_SETTINGS_INVALID', 'API settings file is invalid.', {
    guidance: `Fix ${filePath}. Expected env shape: { "env": { "ANTHROPIC_AUTH_TOKEN": "..." } }.`,
    cause,
  });
}

function hasOwnEnv(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'env');
}
