// Minimal translator surface for core services that render user-visible text
// consumed by the Workbench. Core must stay i18n-agnostic (the scriptable CLI
// output contracts are frozen English), so these services accept an optional
// translator and fall back to their embedded English literal when it is absent.
// The Workbench passes its catalog-backed `t` (wrapped with a string-key cast).

export type CoreTranslator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Interpolate `{name}` placeholders in `template` from `params`. */
export function interpolate(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Translate `key` when a translator is present; otherwise interpolate `en`. */
export function coreTx(
  t: CoreTranslator | undefined,
  key: string,
  en: string,
  params?: Record<string, string | number>,
): string {
  if (t) return t(key, params);
  if (!params) return en;
  return interpolate(en, params);
}

// SkillSource.kind values (git-remote/url/local/unknown) rendered in preview
// lines. Catalog keys use camelCase; the raw kind is the hyphenated token.
const SOURCE_KIND_LABEL_KEYS: Record<string, string> = {
  'git-remote': 'skill.source.kind.gitRemote',
  url: 'skill.source.kind.url',
  local: 'skill.source.kind.local',
  unknown: 'skill.source.kind.unknown',
};

/** Localize a SkillSource.kind token; falls back to the raw token. */
export function sourceKindLabelCore(t: CoreTranslator | undefined, kind: string): string {
  const key = SOURCE_KIND_LABEL_KEYS[kind];
  return key ? coreTx(t, key, kind) : kind;
}

// Platform link kinds (symlink/junction) rendered in the can-link health check.
const LINK_KIND_LABEL_KEYS: Record<string, string> = {
  symlink: 'link.kind.symlink',
  junction: 'link.kind.junction',
};

/** Localize a LinkKind token; falls back to the raw token. */
export function linkKindLabelCore(t: CoreTranslator | undefined, kind: string): string {
  const key = LINK_KIND_LABEL_KEYS[kind];
  return key ? coreTx(t, key, kind) : kind;
}
