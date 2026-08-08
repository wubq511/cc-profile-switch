import fs from 'fs-extra';
import { dirname } from 'node:path';

import { createFileTreeItem, type RecoveryBinItem } from '../recovery-bin';
import { getProfileTemplatePaths } from '../profile-template';
import { validateProfileName } from '../../platform/path';
import { CcpsError } from '../../utils/errors';
import type { Clock } from '../types';
import type { UserMemoryEntry } from './types';

const CLAUDE_MD_FILENAME = 'CLAUDE.md';
const CLAUDE_MD_RELATIVE = 'claude-home/CLAUDE.md';
const EXCERPT_MAX_LINES = 3;

export async function loadUserMemory(
  appHomePath: string,
  profileName: string,
): Promise<UserMemoryEntry> {
  const safeName = validateProfileName(profileName);
  const paths = getProfileTemplatePaths(appHomePath, safeName);
  const claudeMdPath = paths.claudeMdPath;
  const exists = await fs.pathExists(claudeMdPath);

  if (!exists) {
    return {
      kind: 'user-memory',
      name: CLAUDE_MD_FILENAME,
      relativePath: CLAUDE_MD_RELATIVE,
      exists: false,
      lineCount: 0,
      excerpt: '',
    };
  }

  const content = await fs.readFile(claudeMdPath, 'utf8');
  const lines = content.split('\n');
  const nonEmptyLines = lines.filter((l) => l.trim() !== '');
  const excerpt = nonEmptyLines.slice(0, EXCERPT_MAX_LINES).join('\n');

  return {
    kind: 'user-memory',
    name: CLAUDE_MD_FILENAME,
    relativePath: CLAUDE_MD_RELATIVE,
    exists: true,
    lineCount: lines.length,
    excerpt,
  };
}

export async function readUserMemoryContent(
  appHomePath: string,
  profileName: string,
): Promise<string | null> {
  const safeName = validateProfileName(profileName);
  const paths = getProfileTemplatePaths(appHomePath, safeName);
  const claudeMdPath = paths.claudeMdPath;

  if (!(await fs.pathExists(claudeMdPath))) {
    return null;
  }

  return fs.readFile(claudeMdPath, 'utf8');
}

export async function createUserMemory(
  appHomePath: string,
  profileName: string,
  content?: string,
): Promise<void> {
  const safeName = validateProfileName(profileName);
  const paths = getProfileTemplatePaths(appHomePath, safeName);
  const claudeMdPath = paths.claudeMdPath;

  if (await fs.pathExists(claudeMdPath)) {
    throw new CcpsError(
      'USER_MEMORY_ALREADY_EXISTS',
      'CLAUDE.md already exists in this profile.',
      { guidance: 'Use edit to modify the existing file.' },
    );
  }

  await fs.ensureDir(dirname(claudeMdPath));
  await fs.writeFile(claudeMdPath, content ?? '', 'utf8');
}

export async function removeUserMemory(
  appHomePath: string,
  profileName: string,
  clock?: Clock,
): Promise<RecoveryBinItem> {
  const safeName = validateProfileName(profileName);
  const paths = getProfileTemplatePaths(appHomePath, safeName);
  const claudeMdPath = paths.claudeMdPath;

  if (!(await fs.pathExists(claudeMdPath))) {
    throw new CcpsError(
      'USER_MEMORY_NOT_FOUND',
      'CLAUDE.md does not exist in this profile.',
      { guidance: 'Nothing to remove.' },
    );
  }

  const binItem = await createFileTreeItem({
    appHomePath,
    origin: 'remove',
    kind: 'user-memory',
    profile: safeName,
    coordinates: { targetRelativePath: CLAUDE_MD_RELATIVE },
    sourcePath: claudeMdPath,
    clock,
  });

  await fs.remove(claudeMdPath);

  return binItem;
}

export async function copyUserMemoryToProfile(
  appHomePath: string,
  fromProfile: string,
  toProfile: string,
): Promise<void> {
  const fromName = validateProfileName(fromProfile);
  const toName = validateProfileName(toProfile);

  if (fromName === toName) {
    throw new CcpsError(
      'RESOURCE_COPY_SAME_PROFILE',
      'Source and target profile are the same.',
      { guidance: 'Choose a different target profile.' },
    );
  }

  const fromPaths = getProfileTemplatePaths(appHomePath, fromName);
  const toPaths = getProfileTemplatePaths(appHomePath, toName);

  const sourcePath = fromPaths.claudeMdPath;
  const targetPath = toPaths.claudeMdPath;

  if (!(await fs.pathExists(sourcePath))) {
    throw new CcpsError(
      'USER_MEMORY_NOT_FOUND',
      'CLAUDE.md does not exist in the source profile.',
      { guidance: 'The source profile has no User Memory to copy.' },
    );
  }

  if (!(await fs.pathExists(toPaths.profileRootPath))) {
    throw new CcpsError(
      'PROFILE_NOT_FOUND',
      'Target profile does not exist.',
      { guidance: `Create the target profile first: ccps create ${toName}` },
    );
  }

  if (await fs.pathExists(targetPath)) {
    throw new CcpsError(
      'RESOURCE_COPY_COLLISION',
      'CLAUDE.md already exists in the target profile.',
      { guidance: 'Remove the existing file from the target profile first.' },
    );
  }

  await fs.ensureDir(dirname(targetPath));
  await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: true });
}
