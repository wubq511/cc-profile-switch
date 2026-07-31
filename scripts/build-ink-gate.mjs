/**
 * Bundles the Ink gate Workbench prototype (issue #36) into a single ESM file
 * at dist/ink-gate-workbench.mjs. Ink and React are bundled IN — the packed
 * tarball has no devDependencies — only Node builtins stay external.
 * Called by `npm run build` after tsup (tsup --clean wipes dist/).
 */
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// react-devtools-core is Ink's optional peer, reachable only when DEV=true
// (never set here). esbuild would hoist its import to the ESM bundle top and
// break module load, so stub it out — the guarded code path never runs.
const stubOptionalDevtools = {
  name: 'stub-optional-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub-optional-devtools',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-optional-devtools' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));
  },
};

await esbuild.build({
  entryPoints: [path.join(repoRoot, 'src', 'tui', 'prototype-ink-gate', 'index.mts')],
  outfile: path.join(repoRoot, 'dist', 'ink-gate-workbench.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  plugins: [stubOptionalDevtools],
  external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  // CJS deps with dynamic require() of Node builtins (e.g. ws → 'assert')
  // need a real require in ESM output.
  banner: {
    js: "import { createRequire as __inkGateCreateRequire } from 'node:module'; const require = __inkGateCreateRequire(import.meta.url);",
  },
});
