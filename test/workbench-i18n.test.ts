import { describe, expect, it } from 'vitest';

import { en, type LocaleKey } from '../src/tui/workbench/i18n/en';
import { zh } from '../src/tui/workbench/i18n/zh';
import { resolveLocale } from '../src/tui/workbench/i18n/index';

describe('i18n locale parity', () => {
  it('zh has every key that en has', () => {
    const enKeys = Object.keys(en) as LocaleKey[];
    const zhKeys = new Set(Object.keys(zh));
    const missing = enKeys.filter((key) => !zhKeys.has(key));
    expect(missing).toEqual([]);
  });

  it('en has every key that zh has', () => {
    const zhKeys = Object.keys(zh);
    const enKeys = new Set(Object.keys(en));
    const missing = zhKeys.filter((key) => !enKeys.has(key));
    expect(missing).toEqual([]);
  });

  it('no empty translation values', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, `en.${key} is empty`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(zh)) {
      expect(value.length, `zh.${key} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('i18n locale resolution', () => {
  it('resolves explicit config language', () => {
    expect(resolveLocale('zh')).toBe('zh');
    expect(resolveLocale('en')).toBe('en');
  });

  it('falls back to system locale when config is undefined', () => {
    const result = resolveLocale(undefined);
    expect(result === 'zh' || result === 'en').toBe(true);
  });
});

describe('i18n translate function', () => {
  it('returns English values for en locale', async () => {
    const { translate } = await import('../src/tui/workbench/i18n/index');
    expect(translate('en', 'app.title')).toBe('Profile Workbench');
    expect(translate('en', 'sidebar.title')).toBe('Profiles');
  });

  it('returns Chinese values for zh locale', async () => {
    const { translate } = await import('../src/tui/workbench/i18n/index');
    expect(translate('zh', 'app.title')).toBe('配置工作台');
    expect(translate('zh', 'sidebar.title')).toBe('配置');
  });
});
