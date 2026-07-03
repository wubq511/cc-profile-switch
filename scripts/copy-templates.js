/**
 * Cross-platform script to copy template files into dist/ after tsup build.
 * Called by `npm run build`.
 */
const path = require('node:path');
const fs = require('fs-extra');

const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'src', 'templates', 'profile-creator');
const destDir = path.join(repoRoot, 'dist', 'templates', 'profile-creator');

fs.copySync(srcDir, destDir);
