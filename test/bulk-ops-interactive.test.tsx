import { Readable, Writable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { BulkOpsView } from '../src/tui/workbench/resources/bulk-ops-view';
import { createAppConfig, getAppHomePaths } from '../src/core/app-config';
import { createProfileFromTemplate, getProfileTemplatePaths } from '../src/core/profile-template';
import { installLocalSkill } from '../src/core/skills-install';
import { createAgent } from '../src/core/resource';
import { listRecoveryBinItems } from '../src/core/recovery-bin';
import { loadSkillsProvenance, saveSkillsProvenance } from '../src/core/skills-provenance';
import { loadWorkbenchData } from '../src/tui/workbench/profile-data';
import type { WorkbenchProfile } from '../src/tui/workbench/profile-data';
import type { CaptureProcess } from '../src/platform/process';

class FakeTtyStdout extends Writable {
  public readonly isTTY = true;
  public columns = 110;
  public rows = 32;
  private readonly chunks: Buffer[] = [];

  public override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  public get output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

class FakeTtyStdin extends Readable {
  public readonly isTTY = true;
  public override _read(): void {}
  public setRawMode(): this {
    return this;
  }
  public ref(): this {
    return this;
  }
  public unref(): this {
    return this;
  }
  public press(ch: string): void {
    this.push(Buffer.from(ch, 'utf8'));
    this.emit('readable');
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');

describe('BulkOpsView interactive journeys (S95/S96/S97)', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(profileNames: string[]): Promise<{ appHome: string; userHome: string }> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-bulk-inter-'));
    tempRoots.push(root);
    const userHome = join(root, 'userhome');
    const appHome = join(userHome, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    for (const name of profileNames) {
      await createProfileFromTemplate({ appHomePath: appHome, name, template: 'coding', clock: FIXED_CLOCK });
    }
    return { appHome, userHome };
  }

  async function withHome<T>(userHome: string, fn: () => Promise<T>): Promise<T> {
    const originalHome = process.env.HOME;
    process.env.HOME = userHome;
    try {
      return await fn();
    } finally {
      process.env.HOME = originalHome;
    }
  }

  async function installSkill(appHome: string, profileName: string, name: string, body = '# Test\n'): Promise<void> {
    const { profilesPath } = getAppHomePaths(appHome);
    const root = await mkdtemp(join(tmpdir(), 'ccps-bulk-src-'));
    tempRoots.push(root);
    const skillDir = join(root, name);
    await fs.ensureDir(skillDir);
    await fs.writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n${body}`, 'utf8');
    await installLocalSkill({
      appHomePath: appHome,
      profileName,
      profileRootPath: join(profilesPath, profileName),
      sourcePath: skillDir,
      mode: 'copy',
      name,
      clock: FIXED_CLOCK,
    });
  }

  /** Render BulkOpsView interactively and wait for the Ink stdin listener. */
  async function renderView(
    appHome: string,
    profile: WorkbenchProfile,
    category: 'skills' | 'agents' | 'mcp' | 'autoMemory',
    captureProcess?: CaptureProcess,
  ): Promise<{ instance: ReturnType<typeof render>; stdout: FakeTtyStdout; stdin: FakeTtyStdin }> {
    const stdout = new FakeTtyStdout();
    const stdin = new FakeTtyStdin();
    const instance = render(
      React.createElement(BulkOpsView, {
        profile,
        appHomePath: appHome,
        profileRootPath: getProfileTemplatePaths(appHome, profile.name).profileRootPath,
        profileNames: [profile.name, 'study', 'writing'],
        category,
        width: 80,
        height: 24,
        onBack: () => {},
        captureProcess,
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      },
    );
    await instance.waitUntilRenderFlush();
    // Wait until Ink attaches its stdin listener, else early keypresses drop.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && stdin.listenerCount('readable') === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { instance, stdout, stdin };
  }

  async function waitForOutputContaining(stdout: FakeTtyStdout, marker: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (stripAnsi(stdout.output).includes(marker)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for output containing: ${marker}`);
  }

  it('S95: multi-select 3 Skills → x → one action lands each in the Recovery Bin, zero confirms', async () => {
    const { appHome, userHome } = await makeAppHome(['coding']);
    await installSkill(appHome, 'coding', 'skill-a');
    await installSkill(appHome, 'coding', 'skill-b');
    await installSkill(appHome, 'coding', 'skill-c');

    await withHome(userHome, async () => {
      const data = await loadWorkbenchData(appHome);
      const { instance, stdout, stdin } = await renderView(appHome, data.profiles[0], 'skills');

      // Wait for the list to render, then select all and remove.
      await waitForOutputContaining(stdout, 'skill-a');
      stdin.press('a');
      await waitForOutputContaining(stdout, '3 selected');
      stdin.press('x');
      await waitForOutputContaining(stdout, 'Removed 3 to the Recovery Bin');

      const binItems = await listRecoveryBinItems(appHome);
      const skillItems = binItems.filter((i) => i.kind === 'skill' && i.profile === 'coding');
      expect(skillItems).toHaveLength(3);
      const names = skillItems.map((i) => i.coordinates.targetRelativePath ?? '').sort();
      expect(names.join()).toContain('skill-a');
      expect(names.join()).toContain('skill-b');
      expect(names.join()).toContain('skill-c');

      instance.unmount();
      await instance.waitUntilExit();
    });
  });

  it('S97: fan-out copy of one Skill to two target Profiles lands in both', async () => {
    const { appHome, userHome } = await makeAppHome(['coding', 'study', 'writing']);
    await installSkill(appHome, 'coding', 'fan-skill');

    await withHome(userHome, async () => {
      const data = await loadWorkbenchData(appHome);
      const { instance, stdout, stdin } = await renderView(appHome, data.profiles[0], 'skills');

      await waitForOutputContaining(stdout, 'fan-skill');
      stdin.press(' '); // select fan-skill
      await waitForOutputContaining(stdout, '1 selected');
      stdin.press('c'); // fan-out copy → targets phase
      await waitForOutputContaining(stdout, 'Copy to profiles:');
      stdin.press('a'); // select all targets
      // Wait for the target selection to commit before confirming, so the
      // fan-out copy sees both targets selected.
      await waitForOutputContaining(stdout, '[x] study');
      await waitForOutputContaining(stdout, '[x] writing');
      stdin.press('\r');
      await waitForOutputContaining(stdout, 'Copied "fan-skill" → study');
      await waitForOutputContaining(stdout, 'Copied "fan-skill" → writing');

      const { profilesPath } = getAppHomePaths(appHome);
      for (const target of ['study', 'writing']) {
        const landed = join(profilesPath, target, 'claude-home', 'skills', 'fan-skill', 'SKILL.md');
        expect(await fs.pathExists(landed)).toBe(true);
        expect(await fs.readFile(landed, 'utf8')).toContain('name: fan-skill');
      }

      instance.unmount();
      await instance.waitUntilExit();
    });
  });

  it('S97 (agent leg): fan-out copy of Agents to two target Profiles lands in both', async () => {
    const { appHome, userHome } = await makeAppHome(['coding', 'study', 'writing']);
    await createAgent(appHome, 'coding', 'planner');
    await createAgent(appHome, 'coding', 'reviewer');

    await withHome(userHome, async () => {
      const data = await loadWorkbenchData(appHome);
      const { instance, stdout, stdin } = await renderView(appHome, data.profiles[0], 'agents');

      await waitForOutputContaining(stdout, 'planner');
      await waitForOutputContaining(stdout, 'reviewer');
      stdin.press('a'); // select all agents
      await waitForOutputContaining(stdout, '2 selected');
      stdin.press('c'); // fan-out copy → targets phase
      await waitForOutputContaining(stdout, 'Copy to profiles:');
      stdin.press('a'); // select all targets
      await waitForOutputContaining(stdout, '[x] study');
      await waitForOutputContaining(stdout, '[x] writing');
      stdin.press('\r');
      await waitForOutputContaining(stdout, 'Copied "planner" → study');
      await waitForOutputContaining(stdout, 'Copied "reviewer" → writing');

      const { profilesPath } = getAppHomePaths(appHome);
      for (const target of ['study', 'writing']) {
        expect(await fs.pathExists(join(profilesPath, target, 'claude-home', 'agents', 'planner.md'))).toBe(true);
        expect(await fs.pathExists(join(profilesPath, target, 'claude-home', 'agents', 'reviewer.md'))).toBe(true);
      }

      instance.unmount();
      await instance.waitUntilExit();
    });
  });

  it('bulk remove covers Auto Memory entries in one action', async () => {
    const { appHome, userHome } = await makeAppHome(['coding']);
    const paths = getProfileTemplatePaths(appHome, 'coding');
    // The coding template seeds a MEMORY.md entrypoint; clear it so the test
    // controls exactly which entries exist.
    await fs.remove(paths.autoMemoryPath);
    await fs.ensureDir(paths.autoMemoryPath);
    await fs.writeFile(join(paths.autoMemoryPath, 'topics.md'), '# topics\n', 'utf8');
    await fs.writeFile(join(paths.autoMemoryPath, 'notes.md'), '# notes\n', 'utf8');

    await withHome(userHome, async () => {
      const data = await loadWorkbenchData(appHome);
      const { instance, stdout, stdin } = await renderView(appHome, data.profiles[0], 'autoMemory');

      await waitForOutputContaining(stdout, 'topics.md');
      stdin.press('a'); // select all
      await waitForOutputContaining(stdout, '2 selected');
      stdin.press('x');
      await waitForOutputContaining(stdout, 'Removed 2 to the Recovery Bin');

      const binItems = await listRecoveryBinItems(appHome);
      const autoItems = binItems.filter((i) => i.kind === 'auto-memory' && i.profile === 'coding');
      expect(autoItems).toHaveLength(2);
      expect(await fs.pathExists(join(paths.autoMemoryPath, 'topics.md'))).toBe(false);

      instance.unmount();
      await instance.waitUntilExit();
    });
  });

  it('S96: bulk update runs each Skill per its mode; disabled/failed ones are listed and others proceed', async () => {
    const { appHome, userHome } = await makeAppHome(['coding']);
    await installSkill(appHome, 'coding', 'updatable-skill');
    await installSkill(appHome, 'coding', 'frozen-skill');

    // Reopen the manifest to shape each Skill's update capability:
    // - updatable-skill: local source with a recorded repo → update runs the
    //   git-pull local path. The source now has NEW content (a second file),
    //   so the apply replaces the installed tree.
    // - frozen-skill: unknown source → update is disabled with a stated reason.
    const { profilesPath } = getAppHomePaths(appHome);
    const profileRoot = join(profilesPath, 'coding');
    const updatedSource = await mkdtemp(join(tmpdir(), 'ccps-bulk-src-new-'));
    tempRoots.push(updatedSource);
    await fs.ensureDir(updatedSource);
    await fs.writeFile(join(updatedSource, 'SKILL.md'), '---\nname: updatable-skill\n---\n# Newer\n', 'utf8');
    await fs.writeFile(join(updatedSource, 'extra.txt'), 'new content\n', 'utf8');

    const manifest = await loadSkillsProvenance(profileRoot);
    manifest.skills['updatable-skill'].source = {
      kind: 'local',
      path: updatedSource,
      repo: {
        root: updatedSource,
        skillPathInRepo: 'updatable-skill',
        remoteUrl: 'https://example.com/updatable.git',
        ref: 'main',
      },
    };
    manifest.skills['frozen-skill'].source = { kind: 'unknown' };
    await saveSkillsProvenance(profileRoot, manifest);

    await withHome(userHome, async () => {
      const data = await loadWorkbenchData(appHome);
      const { instance, stdout, stdin } = await renderView(appHome, data.profiles[0], 'skills', cleanGitCapture());

      await waitForOutputContaining(stdout, 'updatable-skill');
      stdin.press('a'); // select all
      await waitForOutputContaining(stdout, '2 selected');
      stdin.press('u');

      // updatable-skill succeeds (source gained a file); frozen-skill is
      // listed as a failure, and the batch completes without aborting the rest.
      await waitForOutputContaining(stdout, 'Updated "updatable-skill"');
      const output = stripAnsi(stdout.output);
      expect(output).toMatch(/frozen-skill/);
      expect(output).toMatch(/no recorded source|no-source|unknown/i);
      // The disabled Skill's tree is untouched.
      expect(await fs.pathExists(join(profileRoot, 'claude-home', 'skills', 'frozen-skill', 'SKILL.md'))).toBe(true);

      instance.unmount();
      await instance.waitUntilExit();
    });
  });
});

// Mock the `git pull --ff-only` local-update path: clean repo, upstream set,
// pull succeeds — no real git required.
function cleanGitCapture(): CaptureProcess {
  return async (_command, args) => {
    const joined = args.join(' ');
    if (joined.includes('status --porcelain')) {
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (joined.includes('rev-parse --abbrev-ref --symbolic-full-name')) {
      return { exitCode: 0, stdout: 'refs/remotes/origin/main', stderr: '', timedOut: false };
    }
    if (joined.includes('pull')) {
      return { exitCode: 0, stdout: 'Already up to date.', stderr: '', timedOut: false };
    }
    return { exitCode: 1, stdout: '', stderr: 'no mock matched', timedOut: false };
  };
}
