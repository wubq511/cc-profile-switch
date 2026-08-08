import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBrowserOpenCommand, buildEditorSpawnCommand, buildSystemOpenCommand, openUrlInBrowser, openWithDefaultEditor, openWithSystemEditor } from '../src/platform/editor';

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

describe('browser handoff (spec §7.4)', () => {
  it('builds a macOS open command for a URL', () => {
    expect(buildBrowserOpenCommand('https://skills.sh', 'darwin')).toEqual({
      command: 'open',
      args: ['https://skills.sh'],
      options: { stdio: 'ignore', shell: false },
    });
  });

  it('builds a Linux xdg-open command for a URL', () => {
    expect(buildBrowserOpenCommand('https://skills.sh', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://skills.sh'],
      options: { stdio: 'ignore', shell: false },
    });
  });

  it('builds a Windows Start-Process command that quotes the URL', () => {
    expect(buildBrowserOpenCommand('https://skills.sh', 'win32')).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Start-Process 'https://skills.sh'",
      ],
      options: { stdio: 'ignore', windowsHide: true, shell: false },
    });
  });

  it('escapes an embedded quote in a Windows URL', () => {
    const command = buildBrowserOpenCommand("https://skills.sh/skill?q=it's", 'win32');
    expect(command.args[3]).toBe("Start-Process 'https://skills.sh/skill?q=it''s'");
  });

  it('rejects an unsupported platform', () => {
    expect(() => buildBrowserOpenCommand('https://skills.sh', 'sunos' as never)).toThrow(
      /Windows, macOS, and Linux/,
    );
  });

  it('opens a URL via the platform command, ignoring the exit code', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    vi.mocked(spawn).mockReturnValue(child as never);

    const opening = openUrlInBrowser('https://skills.sh');
    child.emit('spawn');
    child.emit('close', 1); // browsers may exit non-zero; the handoff still succeeds
    await opening;

    const expected = buildBrowserOpenCommand('https://skills.sh');
    expect(spawn).toHaveBeenCalledWith(expected.command, expected.args, expected.options);
  });
});

describe('system editor fallback (spec §8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a macOS open command for the OS default editor', () => {
    expect(buildSystemOpenCommand('/tmp/notes.md', 'darwin')).toEqual({
      command: 'open',
      args: ['/tmp/notes.md'],
      options: { stdio: 'ignore', shell: false },
    });
  });

  it('builds a Linux xdg-open command for the OS default editor', () => {
    expect(buildSystemOpenCommand('/home/robert/notes.md', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/home/robert/notes.md'],
      options: { stdio: 'ignore', shell: false },
    });
  });

  it('builds a Windows Start-Process command that quotes the path', () => {
    expect(buildSystemOpenCommand("C:\\Users\\h\\it's.md", 'win32')).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Start-Process 'C:\\Users\\h\\it''s.md'",
      ],
      options: { stdio: 'ignore', windowsHide: true, shell: false },
    });
  });

  it('rejects an unsupported platform', () => {
    expect(() => buildSystemOpenCommand('/tmp/notes.md', 'sunos' as never)).toThrow(
      /Windows, macOS, and Linux/,
    );
  });

  it('openWithSystemEditor resolves on a clean exit and spawns the arg-array command', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    vi.mocked(spawn).mockReturnValue(child as never);

    const opening = openWithSystemEditor('/tmp/notes.md');
    child.emit('spawn');
    child.emit('close', 0);
    await opening;

    const expected = buildSystemOpenCommand('/tmp/notes.md');
    expect(spawn).toHaveBeenCalledWith(expected.command, expected.args, expected.options);
  });

  it('openWithSystemEditor rejects on spawn error so the UI can surface it', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    vi.mocked(spawn).mockReturnValue(child as never);

    const opening = openWithSystemEditor('/tmp/notes.md');
    child.emit('error', new Error('spawn xdg-open ENOENT'));
    await expect(opening).rejects.toMatchObject({ code: 'EDITOR_OPEN_FAILED' });
  });

  it('openWithSystemEditor rejects on a non-zero exit', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    vi.mocked(spawn).mockReturnValue(child as never);

    const opening = openWithSystemEditor('/tmp/notes.md');
    child.emit('spawn');
    child.emit('close', 1);
    await expect(opening).rejects.toMatchObject({ code: 'EDITOR_OPEN_FAILED' });
  });
});
