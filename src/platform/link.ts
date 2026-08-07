import fs from 'fs-extra';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CcpsError } from '../utils/errors';
import { isNodeError } from '../utils/type-guards';

// Cross-platform directory-link primitives for Linked Skill installation
// (spec §7.2). The physical primitive is a symlink on macOS/Linux and an
// absolute-path junction on Windows — both proven by issues #49/#50 and the
// `probe:linked-skill` harness. Junctions are always absolute and need no
// privilege; a privileged Windows directory symlink is never required.

export type LinkKind = 'symlink' | 'junction';

export type LinkProbeResult = {
  canCreate: boolean;
  kind: LinkKind;
  /** Surface why the platform cannot create links, for the confirm-step blocker. */
  reason?: string;
};

export function getPlatformLinkKind(platform: NodeJS.Platform = process.platform): LinkKind {
  return platform === 'win32' ? 'junction' : 'symlink';
}

// Probe whether this process can actually create the platform's link primitive.
// On Windows without Developer Mode / SeCreateSymbolicLinkPrivilege, directory
// symlinks fail — but junctions do not. We probe the exact primitive we use.
let cachedProbe: LinkProbeResult | null = null;

export function probeLinkCapability(): LinkProbeResult {
  if (cachedProbe) return cachedProbe;

  const kind = getPlatformLinkKind();
  const probeRoot = fs.mkdtempSync(path.join(tmpdir(), 'ccps-link-probe-'));
  const target = path.join(probeRoot, 'target');
  const link = path.join(probeRoot, 'link');

  try {
    fs.mkdirSync(target);
    fs.symlinkSync(path.resolve(target), link, kind === 'junction' ? 'junction' : 'dir');
    cachedProbe = { canCreate: true, kind };
  } catch (error) {
    cachedProbe = {
      canCreate: false,
      kind,
      reason:
        error instanceof Error ? error.message : `Failed to create a ${kind} in this environment.`,
    };
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }

  return cachedProbe;
}

/** Test-only: reset the cached probe so a subsequent call re-probes. */
export function _resetLinkProbeCacheForTests(): void {
  cachedProbe = null;
}

export type CreateSkillLinkOptions = {
  /** Absolute path to the source directory the link points at. */
  targetPath: string;
  /** Absolute path of the link itself (inside claude-home/skills/<name>). */
  linkPath: string;
};

// Create the platform link. The target MUST be absolute (junctions require it;
// absolute symlinks survive moves of claude-home). The link path's parent must
// already exist.
export async function createSkillLink(options: CreateSkillLinkOptions): Promise<void> {
  if (!path.isAbsolute(options.targetPath)) {
    throw new CcpsError(
      'LINK_TARGET_NOT_ABSOLUTE',
      'Linked Skill target must be an absolute path.',
      {
        guidance:
          'Linked Skills use absolute-target links so they survive moves of the Profile directory.',
      },
    );
  }

  const kind = getPlatformLinkKind();
  try {
    // fs-extra's ensureDir for the parent; symlink with the platform kind.
    await fs.ensureDir(path.dirname(options.linkPath));
    await fs.symlink(
      path.resolve(options.targetPath),
      options.linkPath,
      kind === 'junction' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new CcpsError('LINK_TARGET_EXISTS', 'A Skill entry already exists at the link path.', {
        guidance: 'Resolve the name collision before installing the Linked Skill.',
        cause: error,
      });
    }
    throw new CcpsError(
      'LINK_CREATE_FAILED',
      `Could not create the ${kind} for the Linked Skill.`,
      {
        guidance:
          kind === 'junction'
            ? 'Junctions need no privilege on Windows; check the link path and retry.'
            : 'On some platforms symlink creation needs Developer Mode or the right privilege.',
        cause: error,
      },
    );
  }
}

// Delete a Linked Skill entry. Only the link itself is removed — never the
// source tree (spec invariant 7). fs.remove handles both symlinks and
// junctions without following them.
export async function deleteSkillLink(linkPath: string): Promise<void> {
  let lstat: fs.Stats;
  try {
    lstat = await fs.lstat(linkPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }

  if (!lstat.isSymbolicLink()) {
    // Not a link — refuse to delete a real directory here. The caller must
    // route Copied Skill removal through the file-tree Bin path instead.
    throw new CcpsError(
      'LINK_PATH_NOT_A_LINK',
      'The Skill entry is not a link; Linked Skill removal refuses to delete a real directory.',
      {
        guidance: 'Use the Copied Skill removal path for non-link entries.',
      },
    );
  }

  await fs.remove(linkPath);
}

// Read the recorded target of a link without following it. Returns undefined
// when the link cannot be read (e.g. it was already removed).
export async function readLinkTarget(linkPath: string): Promise<string | undefined> {
  try {
    return await fs.readlink(linkPath);
  } catch {
    return undefined;
  }
}
