import { describe, expect, it } from 'vitest';
import { en } from '../src/tui/workbench/i18n/en';
import { zh } from '../src/tui/workbench/i18n/zh';

describe('launch i18n completeness', () => {
  const launchKeys = Object.keys(en).filter((k) => k.startsWith('launch.') || k === 'lifecycle.launch' || k === 'lifecycle.launchDir' || k === 'lifecycle.dryRun');

  it('every launch i18n key has a Chinese translation', () => {
    for (const key of launchKeys) {
      expect(zh).toHaveProperty(key);
    }
  });

  it('launch i18n keys are non-empty in both locales', () => {
    for (const key of launchKeys) {
      expect((en as Record<string, string>)[key].length).toBeGreaterThan(0);
      expect((zh as Record<string, string>)[key].length).toBeGreaterThan(0);
    }
  });
});
