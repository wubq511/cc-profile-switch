/**
 * Cross-platform script to copy template files into dist/ after tsup build.
 * Called by `npm run build`.
 */
/* global __dirname */
const path = require('node:path');
const fs = require('fs-extra');

const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'src', 'templates', 'profile-creator');
const destDir = path.join(repoRoot, 'dist', 'templates', 'profile-creator');

// tsup only cleans its generated bundle files, so remove the copied template
// subtree explicitly. Otherwise repeated builds can nest profile-creator inside
// itself and leave stale Skill files in the distributable.
fs.removeSync(destDir);
fs.copySync(srcDir, destDir, {
  filter: (sourcePath) => path.basename(sourcePath) !== '.DS_Store',
});
