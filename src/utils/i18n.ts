// Minimal translator surface for core services that render user-visible text
// consumed by the Workbench. Core must stay i18n-agnostic (the scriptable CLI
// output contracts are frozen English), so these services accept an optional
// translator and fall back to their embedded English literal when it is absent.
// The Workbench passes its catalog-backed `t` (wrapped with a string-key cast).

import type { LinkKind } from '../platform/link';
import type { SkillSourceKind } from '../schemas/skills-provenance';

export type CoreTranslator = (key: string, params?: Record<string, string | number>) => string;

/** Interpolate `{name}` placeholders in `template` from `params`. */
export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Translate `key` when a translator is present; otherwise interpolate `en`.
 * A missing catalog key must degrade to the English default, never crash a
 * render: the workbench translator throws on a missing key with params and
 * returns undefined without.
 */
export function coreTx(
  t: CoreTranslator | undefined,
  key: string,
  en: string,
  params?: Record<string, string | number>,
): string {
  if (t) {
    try {
      const localized = t(key, params);
      if (localized !== undefined) return localized;
    } catch {
      // fall through to the English default
    }
  }
  if (!params) return en;
  return interpolate(en, params);
}

// SkillSource.kind values (git-remote/url/local/unknown) rendered in preview
// lines. Catalog keys use camelCase; the raw kind is the hyphenated token.
// Exported so the catalog-membership guard test can assert every mapped value
// resolves (the enum→key translation is not identity for `git-remote`).
export const SOURCE_KIND_LABEL_KEYS: Record<SkillSourceKind, string> = {
  'git-remote': 'skill.source.kind.gitRemote',
  url: 'skill.source.kind.url',
  local: 'skill.source.kind.local',
  unknown: 'skill.source.kind.unknown',
};

/** Localize a SkillSource.kind token; falls back to the raw token. */
export function sourceKindLabelCore(t: CoreTranslator | undefined, kind: SkillSourceKind): string {
  return coreTx(t, SOURCE_KIND_LABEL_KEYS[kind], kind);
}

// Platform link kinds (symlink/junction) rendered in the can-link health check.
// Exported for the same catalog-membership guard as the skill map above.
export const LINK_KIND_LABEL_KEYS: Record<LinkKind, string> = {
  symlink: 'link.kind.symlink',
  junction: 'link.kind.junction',
};

/** Localize a LinkKind token; falls back to the raw token. */
export function linkKindLabelCore(t: CoreTranslator | undefined, kind: LinkKind): string {
  return coreTx(t, LINK_KIND_LABEL_KEYS[kind], kind);
}
