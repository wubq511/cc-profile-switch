import { spawn } from 'node:child_process';

import { CcpsError } from '../utils/errors';

export type OpenTarget = (targetPath: string) => Promise<void>;

export const openWithDefaultEditor: OpenTarget = async (targetPath) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $args[0]', targetPath],
      {
        detached: true,
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

    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};
