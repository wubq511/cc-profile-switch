import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Issue #77 acceptance: "No real Profile data exists anywhere in the repo
// (credential-insulation check in CI)". This test scans every tracked file for
// real credential shapes and for real Profile data paths. It runs in CI on
// every PR/push as part of `npm run check`.

// Real credential shapes are assembled from fragments so this test file does
// not itself contain a real-shape literal. Each pattern requires a high-entropy
// tail so synthetic placeholders (fixture-placeholder-..., sk-ant-REDACTED-a,
// <apphome>, etc.) never match.
const CREDENTIAL_PATTERNS = [
  new RegExp('sk-ant-' + 'api03-' + '[A-Za-z0-9_-]{20,}'),
  new RegExp('sk-ant-' + '[A-Za-z0-9_-]{30,}'),
  new RegExp('ghp_' + '[A-Za-z0-9]{36}'),
  new RegExp('github_pat_' + '[A-Za-z0-9_]{20,}'),
  new RegExp('AKIA' + '[0-9A-Z]{16}'),
  new RegExp('xox' + '[bpoa]-' + '[A-Za-z0-9-]{10,}'),
];

const REPO_ROOT = process.cwd();

function gitLsFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isBinary(buffer: Buffer): boolean {
  // Heuristic: a NUL byte in the first 8 KiB means binary.
  return buffer.subarray(0, 8192).includes(0);
}

async function readTextIfSafe(filePath: string): Promise<string | null> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return null;
  }
  if (buffer.length > 2 * 1024 * 1024) {
    // Skip unusually large files; source/docs in this repo are all small.
    return null;
  }
  if (isBinary(buffer)) {
    return null;
  }
  return buffer.toString('utf8');
}

describe('repo credential insulation', () => {
  it('no tracked file contains a real credential shape', async () => {
    const files = gitLsFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const relativePath of files) {
      const content = await readTextIfSafe(path.join(REPO_ROOT, relativePath));
      if (content === null) {
        continue;
      }
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${relativePath} matched ${pattern}`);
        }
      }
    }

    expect(
      offenders,
      `real credential shapes found in tracked files:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no tracked file is a real Profile data tree (profiles/ or recovery-bin/ at repo root)', () => {
    // Real Profile data must never be checked in. The built-in profile-creator
    // skill template lives under src/templates/ and is allowed; only repo-root
    // profiles/<name>/... or recovery-bin/<id>/... would be real data.
    const offenders = gitLsFiles().filter(
      (p) => p.startsWith('profiles/') || p.startsWith('recovery-bin/'),
    );
    expect(offenders, `real Profile data committed at repo root:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('generated fixture output dir is gitignored', () => {
    // `git check-ignore` exits 0 when the path is ignored.
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '.fixtures-out/'], { cwd: REPO_ROOT, stdio: 'ignore' });
      ignored = true;
    } catch {
      ignored = false;
    }
    expect(
      ignored,
      '.fixtures-out/ must be gitignored so generated fixtures are never committed',
    ).toBe(true);
  });

  it('committed golden fixture plan contains no real credential shapes', async () => {
    const goldenPath = path.join(REPO_ROOT, 'test', 'fixtures', 'golden', 'mini.plan.json');
    const content = await readTextIfSafe(goldenPath);
    expect(content, 'golden plan must exist').not.toBeNull();
    for (const pattern of CREDENTIAL_PATTERNS) {
      expect(pattern.test(content!), `golden plan matched ${pattern}`).toBe(false);
    }
  });
});
