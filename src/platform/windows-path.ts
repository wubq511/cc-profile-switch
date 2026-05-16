import path from 'node:path';

import { CcpsError } from '../utils/errors';

const appHomeName = '.cc-profile-switch';
const reservedProfileNames = new Set([
  '.',
  '..',
  'profiles',
  'backups',
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

export function resolveUserHome(env: NodeJS.ProcessEnv = process.env): string {
  const userProfile = env.USERPROFILE;
  if (userProfile) {
    return path.win32.resolve(userProfile);
  }

  if (env.HOMEDRIVE && env.HOMEPATH) {
    return path.win32.resolve(`${env.HOMEDRIVE}${env.HOMEPATH}`);
  }

  throw new CcpsError('USER_HOME_NOT_FOUND', 'Unable to resolve the Windows user home.', {
    guidance: 'Set USERPROFILE or HOMEDRIVE/HOMEPATH before running ccps.',
  });
}

export function getAppHomePath(userHome = resolveUserHome()): string {
  return path.win32.resolve(userHome, appHomeName);
}

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const base = path.win32.resolve(basePath).toLowerCase();
  const candidate = path.win32.resolve(candidatePath).toLowerCase();
  const relative = path.win32.relative(base, candidate);

  return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
}

export function resolveInside(basePath: string, ...segments: string[]): string {
  const candidate = path.win32.resolve(basePath, ...segments);

  if (!isPathInside(basePath, candidate)) {
    throw new CcpsError('PATH_OUTSIDE_BASE', 'Resolved path escapes the expected base directory.', {
      guidance: 'Use a path that stays inside the ccps-managed directory.',
    });
  }

  return candidate;
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
    guidance: 'Use letters, numbers, hyphen, or underscore. Do not use path separators or reserved names.',
  });
}
