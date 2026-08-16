import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppConfig } from '../src/core/app-config';
import { buildLaunchPlan } from '../src/core/launcher';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { validateProfile } from '../src/core/validator';
import { translate, type LocaleKey } from '../src/tui/workbench/i18n';

// Issue #93: validator finding messages render in the workbench pre-launch bar
// and sidebar. Core keeps the English default (frozen CLI contract) and the
// workbench passes its catalog-backed translator to localize them. These tests
// pin both behaviors end-to-end.

const zhTranslator = (key: string, params?: Record<string, string | number>): string =>
  translate('zh', key as LocaleKey, params);

describe('validator i18n', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-validator-i18n-'));
    tempRoots.push(root);
    return join(root, '.cc-profile-switch');
  }

  // A profile with its profile.json removed triggers a launch-blocking
  // REQUIRED_FILE_MISSING finding whose message names the file.
  async function makeMissingManifestProfile(): Promise<string> {
    const appHome = await makeAppHome();
    await createAppConfig(appHome);
    await createProfileFromTemplate({ appHomePath: appHome, name: 'coding', template: 'coding' });
    await rm(getProfileTemplatePaths(appHome, 'coding').profileConfigPath);
    return appHome;
  }

  it('defaults to English when no translator is supplied (CLI contract)', async () => {
    const appHome = await makeMissingManifestProfile();

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'REQUIRED_FILE_MISSING',
        message: 'Required file is missing: profile.json.',
      }),
    );
  });

  it('localizes finding messages for a zh translator', async () => {
    const appHome = await makeMissingManifestProfile();

    const result = await validateProfile({ appHomePath: appHome, name: 'coding' }, zhTranslator);

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'REQUIRED_FILE_MISSING',
        message: '缺少必需的文件：profile.json。',
      }),
    );
  });

  it('threads the translator through buildLaunchPlan (pre-launch bar path)', async () => {
    // A missing auto-repairable boundary rule is a warning — non-blocking, so
    // buildLaunchPlan returns the plan carrying the localized finding.
    const appHome = await makeAppHome();
    await createAppConfig(appHome);
    await createProfileFromTemplate({ appHomePath: appHome, name: 'coding', template: 'coding' });
    await rm(getProfileTemplatePaths(appHome, 'coding').ccpsProfileRulePath);

    const plan = await buildLaunchPlan({ appHomePath: appHome, profileName: 'coding' }, zhTranslator);

    expect(plan.validationFindings).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'CCPS_PROFILE_RULE_MISSING',
        message: '缺少 ccps 管理的配置边界规则。',
      }),
    );
  });
});
