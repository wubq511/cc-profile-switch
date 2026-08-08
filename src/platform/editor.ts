import { spawn } from 'node:child_process';

import { CcpsError } from '../utils/errors';

export type OpenTarget = (targetPath: string) => Promise<void>;

export type EditorSpawnCommand = {
  command: string;
  args: string[];
  options: {
    stdio: 'ignore';
    windowsHide?: true;
  };
  failureGuidance: string;
};

export const openWithDefaultEditor: OpenTarget = async (targetPath) => {
  const editorCommand = buildEditorSpawnCommand(targetPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(editorCommand.command, editorCommand.args, editorCommand.options);

    child.once('error', (error) => {
      reject(
        new CcpsError('EDITOR_OPEN_FAILED', 'Failed to open the profile target.', {
          guidance: `Open the path manually: ${targetPath}`,
          cause: error,
        }),
      );
    });

    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }

      reject(
        new CcpsError('EDITOR_OPEN_FAILED', 'Failed to open the profile target in VS Code.', {
          guidance: editorCommand.failureGuidance,
        }),
      );
    });
  });
};

export function buildEditorSpawnCommand(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): EditorSpawnCommand {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', buildVsCodeOpenCommand(targetPath)],
      options: {
        stdio: 'ignore',
        windowsHide: true,
      },
      failureGuidance: `Install the VS Code "code" command or open the path manually: ${targetPath}`,
    };
  }

  if (platform === 'darwin') {
    return {
      command: 'open',
      args: ['-n', '-a', 'Visual Studio Code', targetPath],
      options: {
        stdio: 'ignore',
      },
      failureGuidance: `Install Visual Studio Code.app or open the path manually: ${targetPath}`,
    };
  }

  if (platform === 'linux') {
    return {
      command: 'code',
      args: ['-n', targetPath],
      options: {
        stdio: 'ignore',
      },
      failureGuidance: `Install Visual Studio Code and its "code" command or open the path manually: ${targetPath}`,
    };
  }

  throw new CcpsError('PLATFORM_NOT_SUPPORTED', 'ccps supports Windows, macOS, and Linux only.', {
    guidance: 'Run ccps edit on Windows, macOS, or Linux.',
  });
}

export type SystemOpenCommand = {
  command: string;
  args: string[];
  options: { stdio: 'ignore'; windowsHide?: true; shell: false };
};

export type BrowserOpenCommand = SystemOpenCommand;

/** The platform command that opens a URL in the default browser (spec §7.4
 * "browser handoff": the Discover surface opens skills.sh so the user can paste
 * a source back). */
export function buildBrowserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserOpenCommand {
  return buildSystemOpenCommand(url, platform);
}

/** The platform command that opens a file in the OS default editor (the file
 *  association) — the "system editor" fallback when VS Code is unavailable
 *  (spec §8). Spawn arg-array style, shell: false. */
export function buildSystemOpenCommand(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): SystemOpenCommand {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process ${quotePowerShellString(targetPath)}`],
      options: { stdio: 'ignore', windowsHide: true, shell: false },
    };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [targetPath], options: { stdio: 'ignore', shell: false } };
  }
  if (platform === 'linux') {
    return { command: 'xdg-open', args: [targetPath], options: { stdio: 'ignore', shell: false } };
  }
  throw new CcpsError('PLATFORM_NOT_SUPPORTED', 'ccps supports Windows, macOS, and Linux only.', {
    guidance: 'Run ccps on Windows, macOS, or Linux.',
  });
}

/** Open a URL in the default browser (non-blocking, ignores the exit code). */
export function openUrlInBrowser(url: string): Promise<void> {
  const plan = buildBrowserOpenCommand(url);
  return new Promise<void>((resolve) => {
    const child = spawn(plan.command, plan.args, plan.options);
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

/**
 * Open a file in the OS default editor — the §8 fallback when VS Code is
 * unavailable. Resolves on a clean exit; rejects on spawn failure or non-zero
 * exit so the Workbench can surface the error instead of a silent dead-end.
 */
export function openWithSystemEditor(targetPath: string): Promise<void> {
  const plan = buildSystemOpenCommand(targetPath);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, plan.options);

    child.once('error', (error) => {
      reject(
        new CcpsError('EDITOR_OPEN_FAILED', 'Failed to open the file in the system editor.', {
          guidance: `Open the path manually: ${targetPath}`,
          cause: error,
        }),
      );
    });

    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new CcpsError('EDITOR_OPEN_FAILED', 'The system editor exited with a non-zero status.', {
          guidance: `Open the path manually: ${targetPath}`,
        }),
      );
    });
  });
}

function buildVsCodeOpenCommand(targetPath: string): string {
  const target = quotePowerShellString(targetPath);

  return [
    `$target = ${target}`,
    '$code = (Get-Command code.cmd, code -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source',
    "Start-Process -FilePath $code -ArgumentList @('-n', $target)",
  ].join('; ');
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
