import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { en } from '../src/tui/workbench/i18n/en';
import { mcpModeSchema } from '../src/schemas/profile';
import { LINK_KIND_LABEL_KEYS, SOURCE_KIND_LABEL_KEYS } from '../src/utils/i18n';
import type { LinkKind } from '../src/platform/link';
import type { ValidationStatus } from '../src/core/validator';

// Issue #93 follow-up: core services render workbench-visible text through the
// string-typed CoreTranslator, so a key typo or a new enum value without a
// catalog entry would fall back to the English default (rendered as stray
// English for a zh user) instead of being caught by the LocaleKey type. These
// tests pin every key core constructs to an `en` entry; the existing en↔zh
// parity test (test/workbench-i18n.test.ts) then guarantees zh coverage.

const CORE_I18N_FILES = [
  'launcher.ts',
  'validator.ts',
  'skills-install.ts',
  'skills-remote-install.ts',
];

/** Every `'dotted.Name'-shaped` single-quoted literal in a source file. */
async function keyShapedLiterals(relativePath: string): Promise<string[]> {
  const src = await readFile(join(process.cwd(), relativePath), 'utf8');
  return [...src.matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((s) => /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(s));
}

describe('core i18n catalog membership', () => {
  it('every static catalog key core renders resolves through the en catalog', async () => {
    const extracted = (
      await Promise.all([
        ...CORE_I18N_FILES.map((f) => keyShapedLiterals(join('src', 'core', f))),
        // The kind→key maps in utils/i18n.ts (link.kind.*, skill.source.kind.*).
        keyShapedLiterals(join('src', 'utils', 'i18n.ts')),
      ])
    ).flat();

    // Dotted literals that are filenames, not catalog keys. Add here (not to
    // the catalogs) when a new filename literal appears in a core file.
    const KNOWN_FILENAMES = ['mcp.json', 'profile.json', 'settings.json'];

    const missing = [...new Set(extracted)].filter(
      (key) => !(key in en) && !KNOWN_FILENAMES.includes(key),
    );
    expect(missing).toEqual([]);
  });

  it('every enum-driven dynamic key core constructs exists in the en catalog', () => {
    const validationStatuses: ValidationStatus[] = ['valid', 'warning', 'error'];
    const linkKinds: LinkKind[] = ['symlink', 'junction'];
    // skill.source.kind.* and link.kind.* keys travel through the label maps in
    // src/utils/i18n.ts (git-remote → skill.source.kind.gitRemote is not an
    // identity translation), so assert the maps' values rather than rebuilding
    // keys from the raw enum tokens.
    const dynamicKeys = [
      ...validationStatuses.map((v) => `launch.dryrun.status.${v}`),
      ...mcpModeSchema.options.map((m) => `launch.dryrun.mcpModeValue.${m}`),
      ...linkKinds.map((k) => `link.kind.${k}`),
      ...Object.values(LINK_KIND_LABEL_KEYS),
      ...Object.values(SOURCE_KIND_LABEL_KEYS),
    ];

    const missing = dynamicKeys.filter((key) => !(key in en));
    expect(missing).toEqual([]);
  });
});
