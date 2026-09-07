import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';

import { createProgram } from '../src/cli';
import { createAppConfig, loadAppConfigSync, saveAppConfig } from '../src/core/app-config';

/**
 * Issue #111: the real entry (createProgram's help/version) reads the banner
 * switch from the schema location `workbench.welcomeBanner` — through a real
 * synthetic config file, not by passing `false` to a component. A saved
 * `false` suppresses the banner in the built program; `true` or a default
 * config keeps it.
 */

const tempRoots: string[] = [];
const fixedClock = () => new Date('2026-08-01T00:00:00Z');

/** Force a TTY-looking stdout for the duration of `run` so createProgram
 *  embeds the banner when (and only when) the config enables it. Vitest's
 *  stdout is not a TTY, which would mask the config difference. `CI` is also
 *  cleared: resolveBannerOptions deliberately downgrades to the plain tier
 *  under CI (pinned by welcome-banner-options/cli-banner tests), and hosted
 *  runners always set CI=true — these cases target the full-tier art. */
async function withTtyStdout(run: () => void): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  const originalLevel = chalk.level;
  const savedNoColor = process.env.NO_COLOR;
  const savedCi = process.env.CI;
  delete process.env.NO_COLOR;
  delete process.env.CI;
  chalk.level = 3;
  try {
    run();
  } finally {
    if (descriptor === undefined) {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stdout, 'isTTY', descriptor);
    }
    chalk.level = originalLevel;
    if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor;
    if (savedCi !== undefined) process.env.CI = savedCi;
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
  if (savedHome.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome.HOME;
  if (savedHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedHome.USERPROFILE;
});

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

/** Point HOME at a temp dir whose app home already holds a config with
 *  `workbench.welcomeBanner` set to `enabled`; resolveUserHome reads
 *  USERPROFILE on win32 and HOME elsewhere. */
async function withBannerConfig(enabled: boolean): Promise<void> {
  const appHome = await makeAppHome();
  await createAppConfig(appHome, { clock: fixedClock });
  const config = loadAppConfigSync(appHome);
  await saveAppConfig(
    appHome,
    { ...config, workbench: { ...config.workbench, welcomeBanner: enabled } },
    { clock: fixedClock },
  );

  const root = appHome.replace(/[/\\]\.cc-profile-switch$/, '');
  process.env.HOME = root;
  process.env.USERPROFILE = root;
}

async function makeAppHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ccps-banner-config-'));
  tempRoots.push(root);
  return join(root, '.cc-profile-switch');
}

function configPath(): string {
  return join(process.env.USERPROFILE ?? '', '.cc-profile-switch', 'config.json');
}

function helpOutput(program: ReturnType<typeof createProgram>): string {
  // addHelpText('beforeAll') emits through the beforeAllHelp event during
  // outputHelp() — helpInformation() alone never carries it.
  const output: string[] = [];
  program.configureOutput({ writeOut: (value) => output.push(value) });
  program.outputHelp();
  return output.join('');
}

describe('welcome banner config in the real CLI entry (issue #111)', () => {
  it('saved workbench.welcomeBanner=false keeps the banner out of help and version', async () => {
    await withBannerConfig(false);
    // The config file on disk really holds the disabled switch.
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8')) as {
      workbench: { welcomeBanner: boolean };
    };
    expect(raw.workbench.welcomeBanner).toBe(false);

    await withTtyStdout(() => {
      const program = createProgram();
      expect(helpOutput(program)).not.toContain('C C - P r o f i l e - S w i t c h');
      expect(helpOutput(program)).not.toContain('█');
      // The version string stays the bare CLI version (no banner above it).
      expect(program.version()).toBe('0.1.0');
    });
  });

  it('saved workbench.welcomeBanner=true shows the banner in help and version', async () => {
    await withBannerConfig(true);
    expect((await fs.readJson(configPath())).workbench.welcomeBanner).toBe(true);

    await withTtyStdout(() => {
      const program = createProgram();
      const help = helpOutput(program);
      expect(help).toContain('C C - P r o f i l e - S w i t c h');
      expect(help).toContain('█');
      // The version string carries the banner above the CLI version.
      expect(program.version()).toContain('0.1.0');
      expect(program.version()).toContain('█');
    });
  });

  it('a default config (schema default welcomeBanner=true) keeps the banner on', async () => {
    const appHome = await makeAppHome();
    await createAppConfig(appHome, { clock: fixedClock });
    const root = appHome.replace(/[/\\]\.cc-profile-switch$/, '');
    process.env.HOME = root;
    process.env.USERPROFILE = root;

    // Schema default: workbench.welcomeBanner defaults to enabled.
    expect(loadAppConfigSync(appHome).workbench.welcomeBanner).toBe(true);

    await withTtyStdout(() => {
      const program = createProgram();
      expect(helpOutput(program)).toContain('C C - P r o f i l e - S w i t c h');
    });
  });

  it('a corrupt config fails open (banner stays enabled, program still builds)', async () => {
    const appHome = await makeAppHome();
    await fs.ensureDir(appHome);
    await fs.writeFile(join(appHome, 'config.json'), '{not json', 'utf8');
    const root = appHome.replace(/[/\\]\.cc-profile-switch$/, '');
    process.env.HOME = root;
    process.env.USERPROFILE = root;

    await withTtyStdout(() => {
      const program = createProgram();
      expect(program.name()).toBe('ccps');
      expect(helpOutput(program)).toContain('C C - P r o f i l e - S w i t c h');
    });
  });
});

describe('Workbench entry resolves the same schema location (issue #111)', () => {
  // The Workbench app reads `workbench.welcomeBanner` through the same core
  // read (loadAppConfigSync) inside app.tsx; this pins the shared field path
  // against the old top-level read without booting Ink.
  it('saved false disables; saved true and default enable', async () => {
    await withBannerConfig(false);
    const disabledHome = join(process.env.USERPROFILE ?? '', '.cc-profile-switch');
    expect(loadAppConfigSync(disabledHome).workbench.welcomeBanner).toBe(false);
    // The Workbench-side resolution: `loadAppConfigSync(...).workbench.welcomeBanner !== false`
    const disabled = loadAppConfigSync(disabledHome).workbench.welcomeBanner !== false;
    expect(disabled).toBe(false);

    await withBannerConfig(true);
    const enabledHome = join(process.env.USERPROFILE ?? '', '.cc-profile-switch');
    const enabled = loadAppConfigSync(enabledHome).workbench.welcomeBanner !== false;
    expect(enabled).toBe(true);
  });
});
