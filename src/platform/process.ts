import { spawn } from 'node:child_process';

export type ProcessSpawnOptions = {
  cwd: string;
  stdio: 'inherit';
  shell: false;
  env: NodeJS.ProcessEnv;
};

export type ProcessSpawnResult = {
  exitCode: number | null;
};

export type SpawnProcess = (
  command: string,
  args: string[],
  options: ProcessSpawnOptions,
) => Promise<ProcessSpawnResult>;

export const spawnProcess: SpawnProcess = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, options);

    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ exitCode });
    });
  });
