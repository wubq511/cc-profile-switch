import { en, type LocaleKey } from './en';
import { zh } from './zh';
import { interpolate } from '../../../utils/i18n';

export type Locale = 'zh' | 'en';

const ALL_LOCALES: Record<Locale, Record<LocaleKey, string>> = { en, zh };

function detectSystemLocale(): Locale {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale.startsWith('zh')) return 'zh';
  } catch {
    // Intl not available
  }
  return 'en';
}

export function resolveLocale(configLanguage?: Locale): Locale {
  if (configLanguage === 'zh' || configLanguage === 'en') return configLanguage;
  return detectSystemLocale();
}

/** Interpolation values for `{placeholder}` tokens in locale strings. */
export type I18nParams = Record<string, string | number>;

export function translate(locale: Locale, key: LocaleKey, params?: I18nParams): string {
  const template = ALL_LOCALES[locale][key] ?? en[key];
  if (!params) return template;
  return interpolate(template, params);
}

// React-dependent provider — imported separately by components that need it.
// This file stays React-free so the i18n resolution and locale data can be
// tested without installing react/ink at test time.
export function createI18nProvider(React: typeof import('react')) {
  const { createContext, useCallback, useContext, useMemo, useState } = React;

  type I18nContextValue = {
    locale: Locale;
    t: (key: LocaleKey, params?: I18nParams) => string;
    switchLocale: (locale: Locale) => void;
  };

  const I18nContext = createContext<I18nContextValue>({
    locale: 'en',
    t: (key, params) => translate('en', key, params),
    switchLocale: () => {},
  });

  function useI18n(): I18nContextValue {
    return useContext(I18nContext);
  }

  type I18nProviderProps = {
    initialLocale?: Locale;
    onLocaleChange?: (locale: Locale) => void;
    children: React.ReactNode;
  };

  function I18nProvider({
    initialLocale,
    onLocaleChange,
    children,
  }: I18nProviderProps): React.ReactElement {
    const [locale, setLocale] = useState<Locale>(() => initialLocale ?? resolveLocale());

    const t = useCallback(
      (key: LocaleKey, params?: I18nParams): string => translate(locale, key, params),
      [locale],
    );

    const switchLocale = useCallback(
      (next: Locale) => {
        setLocale(next);
        onLocaleChange?.(next);
      },
      [onLocaleChange],
    );

    const value = useMemo(() => ({ locale, t, switchLocale }), [locale, t, switchLocale]);

    return React.createElement(I18nContext.Provider, { value }, children);
  }

  return { I18nProvider, useI18n, I18nContext };
}

export { en, zh, type LocaleKey };
