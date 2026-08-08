import { Readable } from 'node:stream';
import fs from 'fs-extra';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import React from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkbenchApp, resetWelcomeSessionForTests } from '../src/tui/workbench/app';
import { KEYMAP_GROUPS } from '../src/tui/workbench/keymap';
import { DiscoverView } from '../src/tui/workbench/skills/discover';
import { SkillsDiscoverySession } from '../src/core/skills-discovery';
import { createAppConfig, getAppHomePaths, loadAppConfig } from '../src/core/app-config';
import { createProfileFromTemplate } from '../src/core/profile-template';
import { createAgent, removeUserMemory } from '../src/core/resource';
import { createFileTreeItem, listRecoveryBinItems } from '../src/core/recovery-bin';
import { installLocalSkill } from '../src/core/skills-install';
import { loadSkillsProvenance, saveSkillsProvenance } from '../src/core/skills-provenance';
import { loadWorkbenchData } from '../src/tui/workbench/profile-data';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import type { CaptureProcess } from '../src/platform/process';
import { apiRepo, apiTree, makeHttp, rawSkill } from './fixtures/discovery-http';
import { FakeTtyStdout, flatten, setupSpawnSuccess, stripAnsi } from './render-helpers';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

/**
 * Help-sheet / handler consistency (issue #92, phase 2 of #90).
 *
 * The `?` sheet is the single source of truth for what each key does in each
 * context. `KEYMAP_GROUPS` documents every binding; this test drives each
 * documented keypress in its documented context and asserts the documented
 * effect, so the sheet fails on drift in either direction:
 *
 *   - a binding added to the sheet without a consistency scenario fails the
 *     completeness check below;
 *   - a key whose real behavior diverges from the documented effect fails the
 *     scenario itself;
 *   - a scenario that no longer matches any documented binding fails the
 *     orphan check (catches a rename/removal of the binding's stable id in the
 *     sheet; the display `key` stays free to change cosmetically).
 */
describe('Workbench help-sheet / keymap consistency (issue #92)', () => {
  // ---------------------------------------------------------------- harness

  class KeymapTtyStdout extends FakeTtyStdout {
    public columns = 120;
    public rows = 40;
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

  async function waitForInputListener(stdin: FakeTtyStdin, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && stdin.listenerCount('readable') === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (stdin.listenerCount('readable') === 0) {
      throw new Error('Ink never attached a stdin readable listener');
    }
  }

  async function waitForOutputSettled(
    stdout: FakeTtyStdout,
    baseline: string,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && stdout.output === baseline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let last = stdout.output;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const current = stdout.output;
      if (current === last) return;
      last = current;
      if (Date.now() > deadline) return;
    }
  }

  /** Poll until the flattened output contains `needle`; returns the flattened output. */
  async function waitForOutput(
    stdout: FakeTtyStdout,
    needle: string,
    timeoutMs = 5000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = flatten(stripAnsi(stdout.output));
      if (current.includes(needle)) return current;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return flatten(stripAnsi(stdout.output));
  }

  class Harness {
    public instance: ReturnType<typeof render> | null = null;
    public stdout: FakeTtyStdout | null = null;
    public stdin: FakeTtyStdin | null = null;

    async renderApp(
      data: WorkbenchData,
      extraProps: Partial<React.ComponentProps<typeof WorkbenchApp>> = {},
    ): Promise<void> {
      resetWelcomeSessionForTests();
      const stdout = new KeymapTtyStdout();
      const stdin = new FakeTtyStdin();
      const instance = render(
        React.createElement(WorkbenchApp, {
          data,
          initialLocale: 'en',
          skipWelcome: true,
          ...extraProps,
        } as React.ComponentProps<typeof WorkbenchApp>),
        {
          stdout: stdout as unknown as NodeJS.WriteStream,
          stdin: stdin as unknown as NodeJS.ReadStream,
          exitOnCtrlC: false,
          patchConsole: false,
          interactive: true,
        },
      );
      await instance.waitUntilRenderFlush();
      await waitForInputListener(stdin);
      this.instance = instance;
      this.stdout = stdout;
      this.stdin = stdin;
    }

    async renderComponent(element: React.ReactElement): Promise<void> {
      const stdout = new KeymapTtyStdout();
      const stdin = new FakeTtyStdin();
      const instance = render(element, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      });
      await instance.waitUntilRenderFlush();
      await waitForInputListener(stdin);
      this.instance = instance;
      this.stdout = stdout;
      this.stdin = stdin;
    }

    async press(ch: string): Promise<void> {
      if (!this.stdout || !this.stdin) throw new Error('Harness not rendered');
      const baseline = this.stdout.output;
      this.stdin.press(ch);
      await waitForOutputSettled(this.stdout, baseline);
    }

    async waitFor(needle: string, timeoutMs = 5000): Promise<string> {
      if (!this.stdout) throw new Error('Harness not rendered');
      return waitForOutput(this.stdout, needle, timeoutMs);
    }

    /** Flattened text of all frames written since the last snapshot. */
    text(): string {
      if (!this.stdout) throw new Error('Harness not rendered');
      return flatten(stripAnsi(this.stdout.output));
    }

    snapshot(): string {
      if (!this.stdout) throw new Error('Harness not rendered');
      return this.stdout.snapshot();
    }

    async unmount(): Promise<void> {
      if (this.instance) {
        this.instance.unmount();
        await this.instance.waitUntilExit();
        this.instance = null;
      }
    }
  }

  // ---------------------------------------------------------------- fixtures

  const FIXED_CLOCK = () => new Date('2026-08-02T00:00:00Z');

  const KNOWN_TEMPLATES = new Set(['coding', 'study', 'work', 'research', 'general']);

  const tempRoots: string[] = [];
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    previousHome = undefined;
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    previousUserProfile = undefined;
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    vi.clearAllMocks();
  });

  /** Point HOME at a fresh temp dir; interactive renders never touch the real app home. */
  async function overrideHomeToTemp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-keymap-'));
    tempRoots.push(root);
    const home = join(root, 'home');
    await fs.ensureDir(home);
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return home;
  }

  /** Temp app home with real Profiles on disk (CLAUDE.md exists per template). */
  async function makeRealAppHome(profileNames: string[]): Promise<string> {
    await overrideHomeToTemp();
    const appHome = getAppHomePaths().appHomePath;
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    for (const name of profileNames) {
      await createProfileFromTemplate({
        appHomePath: appHome,
        name,
        // The Profile name doubles as its template when it is a known template
        // (so `study` carries study's description); unknown names use `coding`.
        template: KNOWN_TEMPLATES.has(name) ? (name as 'coding' | 'study') : 'coding',
        clock: FIXED_CLOCK,
      });
    }
    return appHome;
  }

  /** Install a copied local Skill into a Profile (mirrors the bulk-ops fixture). */
  async function installSkill(
    appHome: string,
    profileName: string,
    name: string,
    body = '# Test\n',
  ): Promise<void> {
    const { profilesPath } = getAppHomePaths(appHome);
    const root = await mkdtemp(join(tmpdir(), 'ccps-keymap-src-'));
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

  /** Real fixtures: named Profiles (coding template) plus optional agents/skills. */
  async function setupReal(
    profileNames: string[],
    opts: { agents?: string[]; skills?: string[] } = {},
  ): Promise<{ appHome: string; data: WorkbenchData }> {
    const appHome = await makeRealAppHome(profileNames);
    for (const agentName of opts.agents ?? []) {
      await createAgent(appHome, profileNames[0], agentName);
    }
    for (const skillName of opts.skills ?? []) {
      await installSkill(appHome, profileNames[0], skillName);
    }
    const data = await loadWorkbenchData(appHome);
    return { appHome, data };
  }

  /** Create a Recovery Bin file-tree item directly (recovery-view scenarios). */
  async function makeBinItem(
    appHome: string,
    profileName: string,
    kind: 'user-memory' | 'skill',
    targetRelativePath: string,
  ): Promise<void> {
    const src = await mkdtemp(join(tmpdir(), 'ccps-keymap-binsrc-'));
    tempRoots.push(src);
    const srcFile = join(src, 'payload');
    await fs.ensureDir(dirname(srcFile));
    await fs.writeFile(srcFile, '# payload\n', 'utf8');
    await createFileTreeItem({
      appHomePath: appHome,
      origin: 'remove',
      kind,
      profile: profileName,
      coordinates: { targetRelativePath },
      sourcePath: srcFile,
      clock: FIXED_CLOCK,
    });
  }

  // ---------------------------------------------------------------- key reaches

  /** Sidebar → `u` opens the selected Profile's User Memory resource list. */
  async function openUserMemory(h: Harness): Promise<void> {
    await h.press('u');
    await h.waitFor('coding › User Memory');
  }

  /** Tab (categories focus) → `a` drills the Agents resource list. */
  async function openAgentsList(h: Harness): Promise<void> {
    await h.press('\t');
    await h.press('a');
    await h.waitFor('coding › Agents');
  }

  /** Tab → Skills card (index 2) → Enter opens the bulk-ops surface. */
  async function openBulkSkills(h: Harness): Promise<void> {
    await h.press('\t');
    await h.press('\x1b[B');
    await h.press('\x1b[B');
    await h.press('\r');
    await h.waitFor('Bulk operations');
  }

  /** Discover session served entirely by a fake HTTP layer (browse only). */
  function browseSession(): { session: SkillsDiscoverySession; calls: string[] } {
    const { http, calls } = makeHttp([
      ['/repos/vercel-labs/skills', apiRepo('vercel-labs', 'skills')],
      ['/git/trees/main', apiTree(['skills/find-skills/SKILL.md'])],
      [
        'raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md',
        rawSkill('find-skills', 'Finds skills.'),
      ],
    ]);
    return {
      session: new SkillsDiscoverySession({
        http,
        experimentalEnabled: true,
        now: () => new Date('2026-08-01T12:00:00.000Z'),
        tokenProvider: async () => null,
        repoSkillLimit: 20,
      }),
      calls,
    };
  }

  async function renderDiscover(
    h: Harness,
    session: SkillsDiscoverySession,
    handlers: {
      onBack?: () => void;
      onInstallSource?: (source: string, skill?: string) => void;
      onOpenBrowser?: (url: string) => void;
    } = {},
  ): Promise<void> {
    await h.renderComponent(
      React.createElement(DiscoverView, {
        profileName: 'coding',
        session,
        width: 110,
        height: 32,
        headless: false,
        onBack: handlers.onBack ?? (() => {}),
        onInstallSource: handlers.onInstallSource ?? (() => {}),
        onOpenBrowser: handlers.onOpenBrowser ?? (() => {}),
      }),
    );
    // The curated browse must land before any documented key is exercised.
    await h.waitFor('find-skills');
  }

  /** Mock the `git pull --ff-only` local-update path (mirrors the bulk fixture). */
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

  // ---------------------------------------------------------------- registry

  type Scenario = { id: string; run: (h: Harness) => Promise<void> };
  const SCENARIOS = new Map<string, Scenario>();

  function scenario(id: string, run: (h: Harness) => Promise<void>): void {
    if (SCENARIOS.has(id)) throw new Error(`Duplicate scenario ${id}`);
    SCENARIOS.set(id, { id, run });
  }

  // ---------------------------------------------------------------- navigation group

  scenario('navigation:move', async (h) => {
    const { data } = await setupReal(['coding', 'study']);
    await h.renderApp(data);
    h.snapshot();
    await h.press('\x1b[B');
    const text = h.text();
    expect(text).toContain('Learning and note-taking profile.');
    expect(text).not.toContain('Focused software development profile.');
  });

  scenario('navigation:tree', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('\x1b[C'); // → expands the tree
    const expanded = h.text();
    expect(expanded).toContain('▾ coding');
    expect(expanded).toContain('User Memory');
    h.snapshot(); // drop the expanded frame so `collapsed` sees only post-← frames
    await h.press('\x1b[D'); // ← collapses it
    const collapsed = h.text();
    expect(collapsed).toContain('▸ coding');
    expect(collapsed).not.toContain('▾ coding');
  });

  scenario('navigation:enter', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('\x1b[C'); // expand so the category rows appear
    await h.press('\x1b[B'); // cursor to the first category row (User Memory)
    await h.press('\r'); // Enter drills into the focused category
    await h.waitFor('coding › User Memory');
  });

  scenario('navigation:search', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('/');
    expect(h.text()).toContain('/█');
  });

  scenario('navigation:help', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('?');
    await h.waitFor('Keyboard Shortcuts');
  });

  scenario('navigation:quit', async (h) => {
    const { data } = await setupReal(['coding']);
    // Both documented chords quit: Ctrl+C (app's own hard-quit handler,
    // reachable because the harness renders with exitOnCtrlC: false) and `q`.
    for (const ch of ['\x03', 'q']) {
      await h.renderApp(data);
      let exited = false;
      void h.instance!.waitUntilExit().then(() => {
        exited = true;
      });
      await h.press(ch);
      const deadline = Date.now() + 3000;
      while (!exited && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(exited).toBe(true);
      await h.unmount();
    }
  });

  scenario('navigation:escSidebar', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    // Search sub-state (§4.2): Esc clears the active search box and restores focus.
    await h.press('/');
    await h.press('c');
    await h.press('o');
    expect(h.text()).toContain('/co');
    h.snapshot(); // drop the search frame so `text()` sees only post-Esc frames
    await h.press('\x1b');
    expect(h.text()).not.toContain('/co');
    // Lifecycle prompt: Esc cancels the create flow back to the profile list.
    await h.press('n');
    await h.waitFor('Select template:');
    h.snapshot(); // drop the prompt frame so `text()` sees only post-Esc frames
    await h.press('\x1b');
    expect(h.text()).not.toContain('Select template:');
  });

  // ---------------------------------------------------------------- profile group

  scenario('profile:launch', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('l');
    await h.waitFor('Enter to launch');
  });

  scenario('profile:launchDir', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('L');
    await h.waitFor('Type a path:');
  });

  scenario('profile:addSkill', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('a');
    await h.waitFor('Skills › add local skill');
  });

  scenario('profile:create', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('n');
    await h.waitFor('Select template:');
  });

  scenario('profile:copy', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('c');
    await h.waitFor('Copy to:');
  });

  scenario('profile:rename', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('r');
    await h.waitFor('Rename to:');
  });

  scenario('profile:default', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('d');
    await h.waitFor('✓');
    const text = h.text();
    expect(text.includes('Set as default') || text.includes('Default cleared')).toBe(true);
  });

  scenario('profile:validate', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('v');
    await h.waitFor('Valid');
  });

  scenario('profile:backup', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('b');
    await h.waitFor('backed up');
  });

  scenario('profile:export', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('E');
    await h.waitFor('Export to:');
  });

  scenario('profile:import', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('i');
    await h.waitFor('Bundle path:');
  });

  scenario('profile:saveTemplate', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('s');
    await h.waitFor('Template name:');
  });

  scenario('profile:remove', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('x');
    await h.waitFor('Remove Profile "coding"?');
    await h.press('\x1b'); // cancel — the destructive panel must not run
  });

  scenario('profile:edit', async (h) => {
    setupSpawnSuccess();
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('e');
    await h.waitFor('watching');
  });

  scenario('profile:editDescription', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    h.snapshot();
    await h.press('D');
    const editing = h.text();
    // The inline edit opens with an input cursor and the draft pre-filled from
    // the card description (S5 inline edit, app.tsx startDescriptionEdit), so
    // the description text legitimately stays on screen inside the input row.
    expect(editing).toContain('Focused software development profile.█');
    // Complete the documented flow: type a name, Enter saves, flash confirms.
    await h.press('x');
    await h.press('\r');
    await h.waitFor('Description updated');
  });

  scenario('profile:userMemory', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('u');
    await h.waitFor('coding › User Memory');
  });

  scenario('profile:focusCategories', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('\t');
    await h.waitFor('▸ User Memory');
  });

  scenario('profile:recoveryOpen', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('B');
    await h.waitFor('Recovery Bin');
  });

  // ---------------------------------------------------------------- categories group

  scenario('categories:move', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('\t');
    await h.waitFor('▸ User Memory');
    h.snapshot(); // drop the focus frame so `text()` sees only post-↓ frames
    await h.press('\x1b[B');
    const text = h.text();
    expect(text).toContain('▸ Auto Memory');
    expect(text).not.toContain('▸ User Memory');
  });

  scenario('categories:agents', async (h) => {
    const { data } = await setupReal(['coding'], { agents: ['explore'] });
    await h.renderApp(data);
    await h.press('\t');
    await h.press('a');
    await h.waitFor('coding › Agents');
  });

  scenario('categories:userMemory', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('\t');
    await h.press('u');
    await h.waitFor('coding › User Memory');
  });

  scenario('categories:openBulk', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await openBulkSkills(h);
    await h.waitFor('Bulk operations');
  });

  scenario('categories:diff', async (h) => {
    const { data } = await setupReal(['coding', 'study']);
    await h.renderApp(data);
    await h.press('\t');
    await h.press('d');
    await h.waitFor('coding → study');
  });

  scenario('categories:back', async (h) => {
    const { data } = await setupReal(['coding']);
    // Both documented chords return to the sidebar: `←` and Esc.
    for (const ch of ['\x1b[D', '\x1b']) {
      await h.renderApp(data);
      await h.press('\t');
      await h.waitFor('▸ User Memory');
      h.snapshot(); // drop the focused frame so `text()` sees only post-back frames
      await h.press(ch);
      expect(h.text()).not.toContain('▸ User Memory');
      await h.unmount();
    }
  });

  // ---------------------------------------------------------------- resource group

  scenario('resource:move', async (h) => {
    const { data } = await setupReal(['coding'], { agents: ['explore', 'shell'] });
    await h.renderApp(data);
    await openAgentsList(h);
    expect(h.text()).toContain('▸ explore');
    h.snapshot(); // drop the pre-move frame so `text()` sees only post-↓ frames
    await h.press('\x1b[B');
    const text = h.text();
    expect(text).toContain('▸ shell');
    expect(text).not.toContain('▸ explore');
  });

  scenario('resource:preview', async (h) => {
    const { data } = await setupReal(['coding'], { agents: ['explore'] });
    await h.renderApp(data);
    await openAgentsList(h);
    await h.press('\r');
    await h.waitFor('Preview');
    expect(h.text()).toContain('coding › Agents › explore');
  });

  scenario('resource:search', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await openUserMemory(h);
    await h.press('/');
    await h.waitFor('Search ›');
  });

  scenario('resource:createAgent', async (h) => {
    const { data } = await setupReal(['coding'], { agents: ['explore'] });
    await h.renderApp(data);
    await openAgentsList(h);
    await h.press('a');
    await h.waitFor('Agent name:');
  });

  scenario('resource:recreateMemory', async (h) => {
    const { appHome } = await setupReal(['coding']);
    // Remove CLAUDE.md so the User Memory row shows the missing state that the
    // [n] recreate binding targets (advertised by the missing-state hint).
    await removeUserMemory(appHome, 'coding');
    const refreshed = await loadWorkbenchData(appHome);
    await h.renderApp(refreshed);
    await openUserMemory(h);
    await h.press('n');
    await h.waitFor('CLAUDE.md recreated');
    expect(fs.existsSync(join(appHome, 'profiles', 'coding', 'claude-home', 'CLAUDE.md'))).toBe(
      true,
    );
  });

  scenario('resource:edit', async (h) => {
    setupSpawnSuccess();
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await openUserMemory(h);
    await h.press('e');
    await h.waitFor('watching');
  });

  scenario('resource:remove', async (h) => {
    const { appHome, data } = await setupReal(['coding']);
    await h.renderApp(data);
    await openUserMemory(h);
    h.snapshot(); // only frames from the removal onward
    await h.press('x');
    await h.waitFor('moved to Recovery Bin');
    // The removal navigates back to the category grid once the reload lands
    // (the flash frames in between still show the resource header).
    await h.waitFor('Enter to drill in');
    // The resource is really gone: CLAUDE.md left the profile (moved to the bin).
    expect(fs.existsSync(join(appHome, 'profiles', 'coding', 'claude-home', 'CLAUDE.md'))).toBe(
      false,
    );
  });

  scenario('resource:copy', async (h) => {
    const { appHome } = await setupReal(['coding', 'study']);
    // Clear the target's CLAUDE.md so the copy lands cleanly (a pre-existing
    // target CLAUDE.md rejects with a collision).
    await removeUserMemory(appHome, 'study');
    const refreshed = await loadWorkbenchData(appHome);
    await h.renderApp(refreshed);
    await openUserMemory(h);
    await h.press('c'); // copy phase
    await h.press('\x1b[B'); // select the counterpart target
    await h.press('\r'); // confirm the copy
    await h.waitFor('Copied to study');
  });

  scenario('resource:diff', async (h) => {
    const { data } = await setupReal(['coding', 'study']);
    await h.renderApp(data);
    await openUserMemory(h);
    await h.press('d');
    await h.waitFor('coding → study');
  });

  scenario('resource:frontmatter', async (h) => {
    const { data } = await setupReal(['coding'], { agents: ['explore'] });
    await h.renderApp(data);
    await openAgentsList(h);
    await h.press('f');
    await h.waitFor('explore › Agent frontmatter');
  });

  scenario('resource:esc', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await openUserMemory(h);
    h.snapshot(); // drop the drill frame so `text()` sees only post-Esc frames
    await h.press('\x1b');
    expect(h.text()).not.toContain('coding › User Memory');
  });

  // ---------------------------------------------------------------- discover group

  scenario('discover:search', async (h) => {
    await renderDiscover(h, browseSession().session);
    await h.press('/');
    expect(h.text()).toContain('/ █');
  });

  scenario('discover:install', async (h) => {
    const onInstall = vi.fn();
    await renderDiscover(h, browseSession().session, { onInstallSource: onInstall });
    await h.press('\r');
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(String(onInstall.mock.calls[0][0])).toContain('vercel-labs/skills');
  });

  scenario('discover:source', async (h) => {
    await renderDiscover(h, browseSession().session);
    await h.press('s');
    expect(h.text()).toContain('Install from source:');
  });

  scenario('discover:browser', async (h) => {
    const onOpenBrowser = vi.fn();
    await renderDiscover(h, browseSession().session, { onOpenBrowser });
    await h.press('b');
    expect(onOpenBrowser).toHaveBeenCalledWith('https://skills.sh');
    expect(h.text()).toContain('Opened skills.sh');
  });

  scenario('discover:refresh', async (h) => {
    const { session, calls } = browseSession();
    await renderDiscover(h, session);
    const initialCalls = calls.length;
    expect(initialCalls).toBeGreaterThan(0);
    await h.press('r');
    const deadline = Date.now() + 3000;
    while (calls.length <= initialCalls && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(calls.length).toBeGreaterThan(initialCalls);
  });

  scenario('discover:esc', async (h) => {
    const onBack = vi.fn();
    await renderDiscover(h, browseSession().session, { onBack });
    await h.press('\x1b');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------- bulk group

  scenario('bulk:select', async (h) => {
    const { data } = await setupReal(['coding'], { skills: ['skill-a', 'skill-b'] });
    await h.renderApp(data);
    await openBulkSkills(h);
    await h.press(' ');
    await h.waitFor('1 selected');
  });

  scenario('bulk:selectAll', async (h) => {
    const { data } = await setupReal(['coding'], { skills: ['skill-a', 'skill-b'] });
    await h.renderApp(data);
    await openBulkSkills(h);
    await h.press('a');
    await h.waitFor('2 selected');
  });

  scenario('bulk:remove', async (h) => {
    const { data } = await setupReal(['coding'], { skills: ['skill-a', 'skill-b'] });
    await h.renderApp(data);
    await openBulkSkills(h);
    await h.press('a');
    await h.waitFor('2 selected');
    await h.press('x');
    await h.waitFor('Removed 2 to the Recovery Bin');
  });

  scenario('bulk:copy', async (h) => {
    const { data } = await setupReal(['coding', 'study'], { skills: ['skill-a'] });
    await h.renderApp(data);
    await openBulkSkills(h);
    await h.press('a');
    await h.waitFor('1 selected');
    await h.press('c');
    await h.waitFor('Copy to profiles:');
  });

  scenario('bulk:update', async (h) => {
    const { appHome, data } = await setupReal(['coding'], {
      skills: ['updatable-skill', 'frozen-skill'],
    });
    // Shape each Skill's update capability (mirrors S96): updatable has a
    // recorded local repo with newer content; frozen has an unknown source.
    const profileRoot = join(appHome, 'profiles', 'coding');
    const updatedSource = await mkdtemp(join(tmpdir(), 'ccps-keymap-new-'));
    tempRoots.push(updatedSource);
    await fs.ensureDir(updatedSource);
    await fs.writeFile(
      join(updatedSource, 'SKILL.md'),
      '---\nname: updatable-skill\n---\n# Newer\n',
      'utf8',
    );
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

    await h.renderApp(data, { captureProcess: cleanGitCapture() });
    await openBulkSkills(h);
    await h.press('a');
    await h.waitFor('2 selected');
    await h.press('u');
    await h.waitFor('Updated "updatable-skill"');
    expect(h.text()).toContain('frozen-skill');
  });

  scenario('bulk:discover', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data, {
      discoverySessionFactory: () => browseSession().session,
      configLoader: async () => ({
        version: 2,
        recovery: { retentionDays: 30 },
        workbench: { skillsDiscoveryExperimental: true },
      }),
    });
    await openBulkSkills(h);
    await h.press('d');
    await h.waitFor('Discover');
  });

  scenario('bulk:esc', async (h) => {
    const { data } = await setupReal(['coding'], { skills: ['skill-a'] });
    await h.renderApp(data);
    await openBulkSkills(h);
    // The bulk header renders before the async skill load lands — wait for the
    // loaded list so the loaded frame is consumed by the snapshot, not emitted
    // into the post-Esc window.
    await h.waitFor('skill-a');
    expect(h.text()).toContain('Bulk operations');
    h.snapshot(); // drop the bulk frame so `text()` sees only post-Esc frames
    await h.press('\x1b');
    expect(h.text()).not.toContain('Bulk operations');
  });

  // ---------------------------------------------------------------- recovery group

  scenario('recovery:move', async (h) => {
    const { appHome, data } = await setupReal(['coding']);
    await makeBinItem(appHome, 'coding', 'skill', 'claude-home/skills/pdf/SKILL.md');
    await removeUserMemory(appHome, 'coding', FIXED_CLOCK);
    await h.renderApp(data);
    await h.press('B');
    // Both items share the fixed clock; CLAUDE-md sorts before SKILL-md, so the
    // cursor opens on CLAUDE.md.
    await h.waitFor('CLAUDE.md');
    h.snapshot(); // drop the loaded frame so `text()` sees only post-↓ frames
    await h.press('\x1b[B');
    const text = h.text();
    expect(text).toContain('▸ SKILL.md');
    expect(text).not.toContain('▸ CLAUDE.md');
  });

  scenario('recovery:restore', async (h) => {
    const { appHome, data } = await setupReal(['coding']);
    await removeUserMemory(appHome, 'coding', FIXED_CLOCK);
    await h.renderApp(data);
    await h.press('B');
    await h.waitFor('CLAUDE.md');
    await h.press('\r');
    await h.waitFor('Restored "CLAUDE.md"');
    // The consumed item came back as the Profile's CLAUDE.md.
    expect(fs.existsSync(join(appHome, 'profiles', 'coding', 'claude-home', 'CLAUDE.md'))).toBe(
      true,
    );
  });

  scenario('recovery:delete', async (h) => {
    const { appHome, data } = await setupReal(['coding']);
    await makeBinItem(appHome, 'coding', 'skill', 'claude-home/skills/pdf/SKILL.md');
    await h.renderApp(data);
    await h.press('B');
    await h.waitFor('SKILL.md');
    await h.press('x');
    await h.waitFor('Permanently delete "SKILL.md"?');
    await h.press('y');
    await h.waitFor('Permanently deleted "SKILL.md"');
    expect(await listRecoveryBinItems(appHome)).toHaveLength(0);
  });

  scenario('recovery:emptyBin', async (h) => {
    const { appHome, data } = await setupReal(['coding']);
    await makeBinItem(appHome, 'coding', 'skill', 'claude-home/skills/pdf/SKILL.md');
    await removeUserMemory(appHome, 'coding', FIXED_CLOCK);
    await h.renderApp(data);
    await h.press('B');
    await h.waitFor('CLAUDE.md');
    await h.press('E');
    await h.waitFor('Permanently delete 2 item(s)');
    await h.press('y');
    await h.waitFor('Recovery Bin emptied');
    expect(await listRecoveryBinItems(appHome)).toHaveLength(0);
  });

  scenario('recovery:retention', async (h) => {
    const { appHome, data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('B');
    await h.waitFor('Recovery Bin');
    await h.press('r');
    await h.waitFor('Recovery Bin retention');
    await h.press('1'); // 7 days
    await h.waitFor('Recovery Bin retention set to 7 days.');
    // The §9.4 change is persisted, not cosmetic.
    const config = await loadAppConfig(appHome);
    expect(config.recovery.retentionDays).toBe(7);
  });

  scenario('recovery:esc', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('B');
    await h.waitFor('Recovery Bin');
    h.snapshot(); // drop the open frame so `text()` sees only post-Esc frames
    await h.press('\x1b');
    expect(h.text()).not.toContain('Recovery Bin');
  });

  // ---------------------------------------------------------------- help group

  scenario('help:language', async (h) => {
    const { data } = await setupReal(['coding']);
    await h.renderApp(data);
    await h.press('?');
    await h.waitFor('Keyboard Shortcuts');
    await h.press('l');
    await h.waitFor('键盘快捷键');
  });

  scenario('help:close', async (h) => {
    const { data } = await setupReal(['coding']);
    // Both documented chords close the sheet: `?` (toggle) and Esc.
    for (const ch of ['?', '\x1b']) {
      await h.renderApp(data);
      await h.press('?');
      await h.waitFor('Keyboard Shortcuts');
      h.snapshot(); // drop the open-help frame so `text()` sees only post-close frames
      await h.press(ch);
      expect(h.text()).not.toContain('Keyboard Shortcuts');
      await h.unmount();
    }
  });

  // ---------------------------------------------------------------- driver

  it('every documented binding has a consistency scenario and every scenario is documented', () => {
    const documented = new Set(
      KEYMAP_GROUPS.flatMap((g) => g.bindings.map((b) => `${g.id}:${b.id}`)),
    );
    for (const group of KEYMAP_GROUPS) {
      for (const binding of group.bindings) {
        const id = `${group.id}:${binding.id}`;
        expect(
          SCENARIOS.has(id),
          `help sheet documents ${id} but no consistency scenario covers it`,
        ).toBe(true);
      }
    }
    for (const id of SCENARIOS.keys()) {
      expect(
        documented.has(id),
        `consistency scenario ${id} does not match any documented binding`,
      ).toBe(true);
    }
  });

  for (const group of KEYMAP_GROUPS) {
    describe(`context: ${group.id}`, () => {
      for (const binding of group.bindings) {
        const id = `${group.id}:${binding.id}`;
        const sc = SCENARIOS.get(id);
        if (!sc) continue; // covered by the completeness check above
        it(`[${binding.key}] acts as documented`, async () => {
          const h = new Harness();
          try {
            await sc.run(h);
          } finally {
            await h.unmount();
          }
        }, 15000);
      }
    });
  }
});
