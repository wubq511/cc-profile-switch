import { spawn } from 'node:child_process';

import { CcpsError } from '../utils/errors';

export type OpenTarget = (targetPath: string) => Promise<void>;

export const openWithDefaultEditor: OpenTarget = async (targetPath) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildVsCodeOpenCommand(targetPath)],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );

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
          guidance: `Install the VS Code "code" command or open the path manually: ${targetPath}`,
        }),
      );
    });
  });
};

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
