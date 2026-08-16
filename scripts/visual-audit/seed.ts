// Seed the visual-audit fixture home (issue #97). Uses real core code paths so
// all on-disk shapes match production. Run via reset-home.sh, or directly:
//   HOME=<fixture home> npx tsx scripts/visual-audit/seed.ts
import fs from 'fs-extra';
import path from 'node:path';

import { getAppHomePaths } from '../../src/core/app-config';
import { createFileTreeItem } from '../../src/core/recovery-bin';
import { saveProfileAsTemplate } from '../../src/core/custom-template';
import { exportProfile } from '../../src/core/profile-export';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_OUT = path.join(REPO_ROOT, '.fixtures-out');

async function main(): Promise<void> {
  const { appHomePath } = getAppHomePaths();
  const profilesDir = path.join(appHomePath, 'profiles');

  // ── Recovery Bin items ────────────────────────────────────────────────
  // A removed profile (kind: profile); the live profile-019 remains, so an
  // in-session restore triggers the collision dialog.
  await createFileTreeItem({
    appHomePath,
    profile: 'profile-019',
    kind: 'profile',
    origin: 'remove',
    sourcePath: path.join(profilesDir, 'profile-019'),
    coordinates: { targetRelativePath: 'profiles/profile-019' },
  });
  // A removed skill from an extant profile.
  await createFileTreeItem({
    appHomePath,
    profile: 'profile-002',
    kind: 'skill',
    origin: 'remove',
    sourcePath: path.join(profilesDir, 'profile-002', 'claude-home', 'skills', 'skill-001'),
    coordinates: { targetRelativePath: 'claude-home/skills/skill-001' },
  });
  // Auto-memory items for profile-001: one whose name collides with the live
  // entry topic-01.md (restore → collision dialog), one with a free name.
  await createFileTreeItem({
    appHomePath,
    profile: 'profile-001',
    kind: 'auto-memory',
    origin: 'remove',
    sourcePath: path.join(profilesDir, 'profile-001', 'claude-home', 'memory', 'auto', 'topic-01.md'),
    coordinates: { targetRelativePath: 'claude-home/memory/auto/topic-01.md' },
  });
  await fs.copy(
    path.join(profilesDir, 'profile-001', 'claude-home', 'memory', 'auto', 'topic-02.md'),
    path.join(FIXTURES_OUT, 'archived-topic.md'),
  );
  await createFileTreeItem({
    appHomePath,
    profile: 'profile-001',
    kind: 'auto-memory',
    origin: 'remove',
    sourcePath: path.join(FIXTURES_OUT, 'archived-topic.md'),
    coordinates: { targetRelativePath: 'claude-home/memory/auto/archived-topic.md' },
  });

  // ── Custom template (create picker's custom section) ─────────────────
  await saveProfileAsTemplate({
    appHomePath,
    profileName: 'profile-002',
    templateName: 'audit-template',
  });

  // ── Broken profile for validation findings / blocked launch / missing
  // CLAUDE.md drill ─────────────────────────────────────────────────────
  const broken = path.join(profilesDir, 'profile-018', 'claude-home');
  await fs.remove(path.join(broken, 'settings.json'));
  await fs.remove(path.join(broken, 'CLAUDE.md'));

  // ── Export bundles for the import flow ────────────────────────────────
  // bundle-source: name NOT present among live profiles → clean preview.
  // profile-001: name present → collision preview.
  const bundlesDir = path.join(FIXTURES_OUT, 'bundles');
  await fs.ensureDir(bundlesDir);
  const sourceProfile = path.join(profilesDir, 'bundle-source');
  await fs.copy(path.join(profilesDir, 'profile-003'), sourceProfile);
  const manifestPath = path.join(sourceProfile, 'profile.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.name = 'bundle-source';
  manifest.description = 'Throwaway profile exported for the import audit.';
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await exportProfile({
    appHomePath,
    name: 'bundle-source',
    outputPath: path.join(bundlesDir, 'bundle-source.tar.gz'),
  });
  await fs.remove(sourceProfile);
  await exportProfile({
    appHomePath,
    name: 'profile-001',
    outputPath: path.join(bundlesDir, 'profile-001.tar.gz'),
  });

  // ── Local skill source for the install wizard ─────────────────────────
  const skillSource = path.join(FIXTURES_OUT, 'skill-source');
  await fs.ensureDir(skillSource);
  await fs.writeFile(
    path.join(skillSource, 'SKILL.md'),
    [
      '---',
      'name: audit-skill',
      'description: Local skill source for the visual audit install flow.',
      'version: 1.0.0',
      '---',
      '',
      '# audit-skill',
      '',
      'Synthetic skill used by the issue #97 capture harness.',
      '',
    ].join('\n'),
  );

  // ── Zero-resource profile for the install wizard (empty source list) ──
  const sandbox = path.join(profilesDir, 'sandbox');
  await fs.copy(path.join(profilesDir, 'profile-003'), sandbox);
  const sandboxManifestPath = path.join(sandbox, 'profile.json');
  const sandboxManifest = await fs.readJson(sandboxManifestPath);
  sandboxManifest.name = 'sandbox';
  sandboxManifest.description = 'Empty scratch profile for wizard captures.';
  await fs.writeJson(sandboxManifestPath, sandboxManifest, { spaces: 2 });
  const sandboxHome = path.join(sandbox, 'claude-home');
  for (const dir of ['skills', 'agents']) {
    await fs.emptyDir(path.join(sandboxHome, dir));
  }
  await fs.emptyDir(path.join(sandboxHome, 'memory', 'auto'));

  console.log('seed complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
