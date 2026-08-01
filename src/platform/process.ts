import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';

import { resolveFilesystemPath } from './path';

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

export type ResolvedSpawnCommand = {
  command: string;
  args: string[];
};

export type ProcessCaptureOptions = {
  cwd: string;
  shell: false;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type ProcessCaptureResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CaptureProcess = (
  command: string,
  args: string[],
  options: ProcessCaptureOptions,
) => Promise<ProcessCaptureResult>;

export const captureProcess: CaptureProcess = async (command, args, options) => {
  const resolved = await resolveSpawnCommand(command, args, options.env);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolved.command, resolved.args, {
        cwd: options.cwd,
        shell: options.shell,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.once('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
      });
    });
  });
};

export async function resolveSpawnCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedSpawnCommand> {
  const resolvedCommand =
    platform === 'win32' ? await resolveWindowsCommand(command, env) : undefined;

  return {
    command: resolvedCommand ?? command,
    args,
  };
}

export const spawnProcess: SpawnProcess = async (command, args, options) => {
  const resolved = await resolveSpawnCommand(command, args, options.env);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolved.command, resolved.args, options);
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ exitCode });
    });
  });
};

async function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (hasPathSeparator(command)) {
    return (await resolveWindowsCandidate(command)) ?? undefined;
  }

  for (const candidate of windowsPathCandidates(command, env)) {
    const resolved = await resolveWindowsCandidate(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function windowsPathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathValue = getEnvValue(env, 'PATH');
  if (!pathValue) {
    return [];
  }

  const hasExtension = path.win32.extname(command).length > 0;
  const extensions = hasExtension ? [''] : windowsPathExtensions(env);
  const candidates: string[] = [];

  for (const searchDir of pathValue.split(path.win32.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      candidates.push(resolveFilesystemPath(searchDir, `${command}${extension}`));
    }
  }

  return [...new Set(candidates)];
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = getEnvValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
  const configured = raw
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  const preferred = ['.exe', '.com', '.cmd', '.bat'];

  return [...new Set([...preferred, ...configured, ''])];
}

async function resolveWindowsCandidate(candidate: string): Promise<string | undefined> {
  if (!(await isFile(candidate))) {
    return undefined;
  }

  const extension = fileExtension(candidate);
  if (extension === '.exe' || extension === '.com') {
    return candidate;
  }

  if (extension === '.cmd' || extension === '.bat') {
    return parseCmdShimExecutable(candidate);
  }

  if (extension === '') {
    return parseShellShimExecutable(candidate);
  }

  return undefined;
}

async function parseCmdShimExecutable(shimPath: string): Promise<string | undefined> {
  const raw = await fs.readFile(shimPath, 'utf8');
  const shimDir = resolveFilesystemPath(shimPath, '..');
  const pattern = /"(%dp0%|%~dp0)[\\/]?([^"]+?\.exe)"/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const resolved = resolveFilesystemPath(shimDir, match[2].replace(/^[\\/]+/, ''));
    if (await isFile(resolved)) {
      return resolved;
    }
  }

  return undefined;
}

async function parseShellShimExecutable(shimPath: string): Promise<string | undefined> {
  const raw = await fs.readFile(shimPath, 'utf8');
  const shimDir = resolveFilesystemPath(shimPath, '..');
  const pattern = /"\$basedir\/([^"]+?\.exe)"/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const resolved = resolveFilesystemPath(shimDir, match[1]);
    if (await isFile(resolved)) {
      return resolved;
    }
  }

  return undefined;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);

  return key ? env[key] : undefined;
}

function hasPathSeparator(value: string): boolean {
  return value.includes('\\') || value.includes('/');
}

function fileExtension(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dotIndex = basename.lastIndexOf('.');

  return dotIndex === -1 ? '' : basename.slice(dotIndex).toLowerCase();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
