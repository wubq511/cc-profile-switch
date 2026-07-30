import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEditorSpawnCommand, openWithDefaultEditor } from '../src/platform/editor';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('editor integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the target in a new VS Code window', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    vi.mocked(spawn).mockReturnValue(child as never);

    const opening = openWithDefaultEditor('C:\\Users\\h\\.cc-profile-switch\\profiles\\coding');

    child.emit('spawn');
    child.emit('close', 0);
    await opening;

    const expected = buildEditorSpawnCommand('C:\\Users\\h\\.cc-profile-switch\\profiles\\coding');
    expect(spawn).toHaveBeenCalledWith(expected.command, expected.args, expected.options);
  });

  it('builds a macOS open command for a new VS Code window', () => {
    expect(
      buildEditorSpawnCommand('/Users/robert/.cc-profile-switch/profiles/coding', 'darwin'),
    ).toEqual({
      command: 'open',
      args: ['-n', '-a', 'Visual Studio Code', '/Users/robert/.cc-profile-switch/profiles/coding'],
      options: {
        stdio: 'ignore',
      },
      failureGuidance:
        'Install Visual Studio Code.app or open the path manually: /Users/robert/.cc-profile-switch/profiles/coding',
    });
  });

  it('builds a Linux code command for a new VS Code window', () => {
    expect(
      buildEditorSpawnCommand('/home/robert/.cc-profile-switch/profiles/coding', 'linux'),
    ).toEqual({
      command: 'code',
      args: ['-n', '/home/robert/.cc-profile-switch/profiles/coding'],
      options: {
        stdio: 'ignore',
      },
      failureGuidance:
        'Install Visual Studio Code and its "code" command or open the path manually: /home/robert/.cc-profile-switch/profiles/coding',
    });
  });

  it('keeps the Windows PowerShell editor command explicit', () => {
    const command = buildEditorSpawnCommand(
      'C:\\Users\\h\\.cc-profile-switch\\profiles\\coding',
      'win32',
    );

    expect(command.command).toBe('powershell.exe');
    expect(command.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expect.stringContaining('Start-Process'),
    ]);
    expect(command.options).toEqual({
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(command.failureGuidance).toBe(
      'Install the VS Code "code" command or open the path manually: C:\\Users\\h\\.cc-profile-switch\\profiles\\coding',
    );
  });
});
