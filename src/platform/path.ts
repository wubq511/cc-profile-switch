import path from 'node:path';

import { CcpsError } from '../utils/errors';

const appHomeName = '.cc-profile-switch';
const reservedProfileNames = new Set([
  '.',
  '..',
  'profiles',
  'backups',
  'recovery-bin',
  'claude-home',
  'plugins',
  'mcp',
  'config',
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

type PathPlatform = 'win32' | 'posix';
type SupportedRuntimePlatform = 'win32' | 'darwin' | 'linux';
type PathApi = typeof path.win32;

export function resolveUserHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const supportedPlatform = assertSupportedPlatform(platform);

  if (supportedPlatform === 'win32') {
    const userProfile = env.USERPROFILE;
    if (userProfile) {
      return resolveFilesystemPath(userProfile);
    }

    if (env.HOMEDRIVE && env.HOMEPATH) {
      return resolveFilesystemPath(`${env.HOMEDRIVE}${env.HOMEPATH}`);
    }

    throw new CcpsError('USER_HOME_NOT_FOUND', 'Unable to resolve the Windows user home.', {
      guidance: 'Set USERPROFILE or HOMEDRIVE/HOMEPATH before running ccps.',
    });
  }

  const home = env.HOME;
  if (home) {
    return resolveFilesystemPath(home);
  }

  throw new CcpsError('USER_HOME_NOT_FOUND', 'Unable to resolve the POSIX user home.', {
    guidance: 'Set HOME before running ccps.',
  });
}

export function getAppHomePath(userHome = resolveUserHome()): string {
  return resolveFilesystemPath(userHome, appHomeName);
}

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const pathApi = pathApiFor(basePath, candidatePath);
  const [normalizedBasePath, normalizedCandidatePath] = normalizeSegments(
    pathApi,
    basePath,
    candidatePath,
  );
  const base = normalizeForComparison(pathApi, pathApi.resolve(normalizedBasePath));
  const candidate = normalizeForComparison(pathApi, pathApi.resolve(normalizedCandidatePath));
  const relative = pathApi.relative(base, candidate);

  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

export function resolveInside(basePath: string, ...segments: string[]): string {
  const candidate = resolveFilesystemPath(basePath, ...segments);

  if (!isPathInside(basePath, candidate)) {
    throw new CcpsError('PATH_OUTSIDE_BASE', 'Resolved path escapes the expected base directory.', {
      guidance: 'Use a path that stays inside the ccps-managed directory.',
    });
  }

  return candidate;
}

export function resolveFilesystemPath(...segments: string[]): string {
  const pathApi = pathApiFor(...segments);
  return pathApi.resolve(...normalizeSegments(pathApi, ...segments));
}

export function relativeFilesystemPath(basePath: string, candidatePath: string): string {
  const pathApi = pathApiFor(basePath, candidatePath);
  const [normalizedBasePath, normalizedCandidatePath] = normalizeSegments(
    pathApi,
    basePath,
    candidatePath,
  );

  return pathApi.relative(
    pathApi.resolve(normalizedBasePath),
    pathApi.resolve(normalizedCandidatePath),
  );
}

export function areSameFilesystemPath(left: string, right: string): boolean {
  const pathApi = pathApiFor(left, right);
  const [normalizedLeft, normalizedRight] = normalizeSegments(pathApi, left, right);

  return (
    normalizeForComparison(pathApi, pathApi.resolve(normalizedLeft)) ===
    normalizeForComparison(pathApi, pathApi.resolve(normalizedRight))
  );
}

export function getPathPlatform(...segments: string[]): PathPlatform {
  return pathApiFor(...segments) === path.win32 ? 'win32' : 'posix';
}

export function validateProfileName(name: string): string {
  if (name.length === 0 || name !== name.trim()) {
    throw invalidProfileName();
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw invalidProfileName();
  }

  if (reservedProfileNames.has(name.toLowerCase())) {
    throw invalidProfileName();
  }

  return name;
}

function invalidProfileName(): CcpsError {
  return new CcpsError('INVALID_PROFILE_NAME', 'Profile name is not safe.', {
    guidance:
      'Use letters, numbers, hyphen, or underscore. Do not use path separators or reserved names.',
  });
}

function assertSupportedPlatform(platform: NodeJS.Platform): SupportedRuntimePlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
    return platform;
  }

  throw new CcpsError('PLATFORM_NOT_SUPPORTED', 'ccps supports Windows, macOS, and Linux only.', {
    guidance: 'Run ccps on Windows, macOS, or Linux.',
  });
}

function pathApiFor(...segments: string[]): PathApi {
  for (const segment of segments) {
    if (isWindowsAbsolutePath(segment)) {
      return path.win32;
    }

    if (path.posix.isAbsolute(segment)) {
      return path.posix;
    }
  }

  if (segments.some((segment) => segment.includes('\\'))) {
    return path.win32;
  }

  return process.platform === 'win32' ? path.win32 : path.posix;
}

function normalizeSegments(pathApi: PathApi, ...segments: string[]): string[] {
  if (pathApi === path.posix) {
    return segments.map((segment) => segment.replace(/\\/g, '/'));
  }

  return segments;
}

function normalizeForComparison(pathApi: PathApi, value: string): string {
  return pathApi === path.win32 ? value.toLowerCase() : value;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
}
