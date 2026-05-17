import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openWithDefaultEditor } from '../src/platform/editor';

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

    expect(spawn).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        expect.stringContaining('Start-Process'),
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    const command = vi.mocked(spawn).mock.calls[0]?.[1]?.[3];
    expect(command).toContain('Get-Command code.cmd, code');
    expect(command).toContain("'-n'");
    expect(command).toContain("$target = 'C:\\Users\\h\\.cc-profile-switch\\profiles\\coding'");
    expect(command).not.toContain('Invoke-Item');
  });
});
