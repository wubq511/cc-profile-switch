import React from 'react';

import { createI18nProvider, resolveLocale, type Locale, type LocaleKey } from './index';

const { I18nProvider, useI18n } = createI18nProvider(React);

export { I18nProvider, useI18n, resolveLocale, type Locale, type LocaleKey };
