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
import { getClaudeJsonPath } from '../src/core/mcp-servers';
import type { WorkbenchData } from '../src/tui/workbench/profile-data';
import { loadWorkbenchData } from '../src/tui/workbench/profile-data';

class FakeTtyStdout extends Writable {
  public readonly isTTY = true;
  public columns = 100;
  public rows = 30;
  private readonly chunks: Buffer[] = [];

  public override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  public get output(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function dummyStdin(): Readable {
  return new Readable({ read() {} });
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

const FIXED_CLOCK = () => new Date('2026-08-01T00:00:00Z');

describe('BulkOpsView headless render', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeAppHome(profileNames: string[]): Promise<{ appHome: string; data: WorkbenchData }> {
    const root = await mkdtemp(join(tmpdir(), 'ccps-bulk-view-'));
    tempRoots.push(root);
    const appHome = join(root, '.cc-profile-switch');
    await createAppConfig(appHome, { clock: FIXED_CLOCK });
    for (const name of profileNames) {
      await createProfileFromTemplate({ appHomePath: appHome, name, template: 'coding', clock: FIXED_CLOCK });
    }
    const data = await loadWorkbenchData(appHome);
    return { appHome, data };
  }

  async function installSkill(appHome: string, profileName: string, name: string, body = '# Test\n'): Promise<void> {
    const { profilesPath } = getAppHomePaths(appHome);
    const root = await mkdtemp(join(tmpdir(), 'ccps-bulk-src-'));
    tempRoots.push(root);
    const skillDir = join(root, name);
    await fs.ensureDir(skillDir);
    await fs.writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n${body}`, 'utf8');
    const profileRoot = join(profilesPath, profileName);
    await installLocalSkill({
      appHomePath: appHome,
      profileName,
      profileRootPath: profileRoot,
      sourcePath: skillDir,
      mode: 'copy',
      name,
      clock: FIXED_CLOCK,
    });
  }

  async function writeMcpServer(appHome: string, profileName: string, serverName: string, transport: 'stdio' | 'http' = 'stdio'): Promise<void> {
    const { profilesPath } = getAppHomePaths(appHome);
    const profileRoot = join(profilesPath, profileName);
    const filePath = getClaudeJsonPath(profileRoot);
    const existing = (await fs.pathExists(filePath)) ? await fs.readJson(filePath) : {};
    const mcpServers = existing.mcpServers ?? {};
    mcpServers[serverName] =
      transport === 'http'
        ? { type: 'http', url: `https://example.com/${serverName}` }
        : { type: 'stdio', command: '/usr/bin/example', args: ['--serve'] };
    await fs.writeJson(filePath, { ...existing, mcpServers }, { spaces: 2 });
  }

  async function writeAutoMemory(appHome: string, profileName: string, entry: string, content = 'note\n'): Promise<void> {
    const paths = getProfileTemplatePaths(appHome, profileName);
    await fs.ensureDir(paths.autoMemoryPath);
    await fs.writeFile(join(paths.autoMemoryPath, entry), content, 'utf8');
  }

  async function renderView(appHome: string, data: WorkbenchData, category: 'skills' | 'agents' | 'mcp' | 'autoMemory'): Promise<string> {
    const profile = data.profiles[0];
    const stdout = new FakeTtyStdout();
    const instance = render(
      React.createElement(BulkOpsView, {
        profile,
        appHomePath: appHome,
        profileRootPath: getProfileTemplatePaths(appHome, profile.name).profileRootPath,
        profileNames: data.profiles.map((p) => p.name),
        category,
        width: 60,
        height: 24,
        onBack: () => {},
        headless: true,
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: dummyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    return stripAnsi(stdout.output);
  }

  it('skills category lists installed skills with copy/link detail', async () => {
    const { appHome, data } = await makeAppHome(['coding']);
    await installSkill(appHome, 'coding', 'commit-helper');
    await installSkill(appHome, 'coding', 'review-bot');

    const output = await renderView(appHome, data, 'skills');

    expect(output).toContain('commit-helper');
    expect(output).toContain('review-bot');
    // Copy-mode installed skills show `copy` and no update-off reason.
    expect(output).toContain('copy · none');
    // Bulk-ops chrome renders.
    expect(output).toContain('[space] select');
  });

  it('agents category lists agents with their description detail', async () => {
    const { appHome } = await makeAppHome(['coding']);
    await createAgent(appHome, 'coding', 'planner');

    // Re-read so resourceDetails.agents reflects the on-disk agent.
    const fresh = await loadWorkbenchData(appHome);
    const output = await renderView(appHome, fresh, 'agents');

    expect(output).toContain('planner');
  });

  it('mcp category lists configured servers without spawning claude mcp', async () => {
    const { appHome } = await makeAppHome(['coding']);
    await writeMcpServer(appHome, 'coding', 'fetch-srv', 'http');

    const fresh = await loadWorkbenchData(appHome);
    const output = await renderView(appHome, fresh, 'mcp');

    expect(output).toContain('fetch-srv');
    expect(output).toContain('transport http');
  });

  it('autoMemory category lists entries with size and date', async () => {
    const { appHome } = await makeAppHome(['coding']);
    await writeAutoMemory(appHome, 'coding', 'topics.md', '# topics\n');

    const fresh = await loadWorkbenchData(appHome);
    const output = await renderView(appHome, fresh, 'autoMemory');

    expect(output).toContain('topics.md');
  });

  it('renders an empty state when the category has nothing', async () => {
    const { appHome, data } = await makeAppHome(['coding']);
    const output = await renderView(appHome, data, 'skills');
    expect(output).toContain('Nothing to manage here.');
  });
});
