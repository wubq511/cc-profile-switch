/**
 * Bundles the Profile Workbench (issue #54) into a single ESM file
 * at dist/workbench.mjs. Ink and React are bundled IN — the packed
 * tarball has no devDependencies — only Node builtins stay external.
 * Called by `npm run build` after tsup and before copy-templates.
 */
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// react-devtools-core is Ink's optional peer, reachable only when DEV=true
// (never set here). esbuild would hoist its import to the ESM bundle top and
// break module load, so stub it out.
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
  entryPoints: [path.join(repoRoot, 'src', 'tui', 'workbench', 'index.mts')],
  outfile: path.join(repoRoot, 'dist', 'workbench.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  plugins: [stubOptionalDevtools],
  external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  banner: {
    js: "import { createRequire as __workbenchCreateRequire } from 'node:module'; const require = __workbenchCreateRequire(import.meta.url);",
  },
});
