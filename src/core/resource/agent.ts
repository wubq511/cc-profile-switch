import fs from 'fs-extra';
import path from 'node:path';

import { getProfileTemplatePaths } from '../profile-template';
import { createFileTreeItem, type RecoveryBinItem } from '../recovery-bin';
import { resolveInside } from '../../platform/path';
import { CcpsError } from '../../utils/errors';
import type { Clock } from '../types';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import type { AgentEntry, AgentFrontmatter } from './types';

const AGENTS_DIR_RELATIVE = 'claude-home/agents';
const BODY_EXCERPT_MAX_LINES = 3;

export function validateNewAgentName(name: string): string {
  if (name.length === 0 || name !== name.trim()) {
    throw new CcpsError('INVALID_AGENT_NAME', 'Agent name cannot be empty or have leading/trailing whitespace.', {
      guidance: 'Provide a non-empty agent name.',
    });
  }

  const trimmed = name.trim();
  if (trimmed === '.' || trimmed === '..') {
    throw new CcpsError('INVALID_AGENT_NAME', 'Agent name is not a valid filename.', {
      guidance: 'Provide a different agent name.',
    });
  }

  // Reject path separators and control characters so the name becomes a
  // single safe filename segment. CJK and spaces are allowed (spec §14.8).
  if (hasUnsafeFilenameChars(trimmed)) {
    throw new CcpsError('INVALID_AGENT_NAME', 'Agent name contains unsafe characters.', {
      guidance: 'Use letters, digits, dashes, underscores, CJK, or spaces.',
    });
  }

  return trimmed;
}

function hasUnsafeFilenameChars(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || ch === '/' || ch === '\\') return true;
  }
  return false;
}

function agentFilePath(appHomePath: string, profileName: string, agentName: string): string {
  const safeName = validateNewAgentName(agentName);
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  return resolveInside(paths.agentsPath, `${safeName}.md`);
}

export async function listAgents(appHomePath: string, profileName: string): Promise<AgentEntry[]> {
  const paths = getProfileTemplatePaths(appHomePath, profileName);
  const agentsDir = paths.agentsPath;

  if (!(await fs.pathExists(agentsDir))) {
    return [];
  }

  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));

  const agents = await Promise.all(
    mdFiles.map(async (e): Promise<AgentEntry> => {
      const name = e.name.slice(0, -'.md'.length);
      const fullPath = path.join(agentsDir, e.name);
      const content = await fs.readFile(fullPath, 'utf8');
      return entryFromContent(name, content);
    }),
  );

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadAgent(
  appHomePath: string,
  profileName: string,
  agentName: string,
): Promise<AgentEntry | null> {
  const filePath = agentFilePath(appHomePath, profileName, agentName);

  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  const content = await fs.readFile(filePath, 'utf8');
  return entryFromContent(agentName, content);
}

export async function readAgentContent(
  appHomePath: string,
  profileName: string,
  agentName: string,
): Promise<string | null> {
  const filePath = agentFilePath(appHomePath, profileName, agentName);

  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  return fs.readFile(filePath, 'utf8');
}

export async function createAgent(
  appHomePath: string,
  profileName: string,
  agentName: string,
): Promise<string> {
  const safeName = validateNewAgentName(agentName);
  const filePath = agentFilePath(appHomePath, profileName, safeName);

  if (await fs.pathExists(filePath)) {
    throw new CcpsError(
      'AGENT_ALREADY_EXISTS',
      `An agent named "${safeName}" already exists.`,
      { guidance: 'Choose a different name or edit the existing agent.' },
    );
  }

  const paths = getProfileTemplatePaths(appHomePath, profileName);
  await fs.ensureDir(paths.agentsPath);

  const scaffold = serializeFrontmatter({ name: safeName, description: '' }, '');
  await fs.writeFile(filePath, scaffold, 'utf8');

  return filePath;
}

export async function removeAgent(
  appHomePath: string,
  profileName: string,
  agentName: string,
  clock?: Clock,
): Promise<RecoveryBinItem> {
  const safeName = validateNewAgentName(agentName);
  const filePath = agentFilePath(appHomePath, profileName, safeName);

  if (!(await fs.pathExists(filePath))) {
    throw new CcpsError(
      'AGENT_NOT_FOUND',
      `Agent "${safeName}" does not exist.`,
      { guidance: 'Nothing to remove.' },
    );
  }

  const binItem = await createFileTreeItem({
    appHomePath,
    origin: 'remove',
    kind: 'agent',
    profile: profileName,
    coordinates: { targetRelativePath: `${AGENTS_DIR_RELATIVE}/${safeName}.md` },
    sourcePath: filePath,
    clock,
  });

  await fs.remove(filePath);

  return binItem;
}

export async function copyAgentToProfile(
  appHomePath: string,
  fromProfile: string,
  toProfile: string,
  agentName: string,
): Promise<void> {
  const safeName = validateNewAgentName(agentName);
  const sourcePath = agentFilePath(appHomePath, fromProfile, safeName);

  if (!(await fs.pathExists(sourcePath))) {
    throw new CcpsError(
      'AGENT_NOT_FOUND',
      `Agent "${safeName}" does not exist in the source profile.`,
      { guidance: 'The source profile has no such agent to copy.' },
    );
  }

  const targetPaths = getProfileTemplatePaths(appHomePath, toProfile);
  if (!(await fs.pathExists(targetPaths.profileRootPath))) {
    throw new CcpsError(
      'PROFILE_NOT_FOUND',
      'Target profile does not exist.',
      { guidance: `Create the target profile first: ccps create ${toProfile}` },
    );
  }

  const targetPath = resolveInside(targetPaths.agentsPath, `${safeName}.md`);
  if (await fs.pathExists(targetPath)) {
    throw new CcpsError(
      'RESOURCE_COPY_COLLISION',
      `An agent named "${safeName}" already exists in the target profile.`,
      { guidance: 'Choose a different agent or remove the existing one from the target profile first.' },
    );
  }

  await fs.ensureDir(targetPaths.agentsPath);
  await fs.copy(sourcePath, targetPath, { overwrite: false, errorOnExist: true });
}

export async function updateAgentFrontmatter(
  appHomePath: string,
  profileName: string,
  agentName: string,
  updates: Partial<AgentFrontmatter>,
): Promise<void> {
  const safeName = validateNewAgentName(agentName);
  const filePath = agentFilePath(appHomePath, profileName, safeName);

  if (!(await fs.pathExists(filePath))) {
    throw new CcpsError(
      'AGENT_NOT_FOUND',
      `Agent "${safeName}" does not exist.`,
      { guidance: 'Create the agent first.' },
    );
  }

  const content = await fs.readFile(filePath, 'utf8');
  const { frontmatter, body, parseError } = parseFrontmatter(content);

  if (parseError !== null) {
    throw new CcpsError(
      'AGENT_FRONTMATTER_INVALID',
      'Agent frontmatter is malformed and cannot be edited structurally.',
      { guidance: 'Fix the frontmatter manually or open the file in VS Code.' },
    );
  }

  const merged = { ...(frontmatter ?? {}), ...updates };
  const updated = serializeFrontmatter(merged, body);
  await fs.writeFile(filePath, updated, 'utf8');
}

// ─── Internal helpers ───────────────────────────────────────────────────

function entryFromContent(agentName: string, content: string): AgentEntry {
  const { frontmatter, body, parseError } = parseFrontmatter(content);

  return {
    kind: 'agents',
    name: agentName,
    relativePath: `${AGENTS_DIR_RELATIVE}/${agentName}.md`,
    exists: true,
    frontmatter,
    frontmatterParseError: parseError,
    bodyExcerpt: nonEmptyLines(body).slice(0, BODY_EXCERPT_MAX_LINES).join('\n'),
  };
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '');
}
