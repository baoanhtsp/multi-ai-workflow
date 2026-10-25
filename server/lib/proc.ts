import { execFile } from 'node:child_process';

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Executes a binary with an explicit argument array (shell: false, windowsHide: true).
 * Never passes a command string to a shell (SPEC §1).
 */
export function runCommand(
  file: string,
  args: readonly string[],
  options?: RunCommandOptions
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        windowsHide: true,
        timeout: options?.timeoutMs ?? 30000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        cwd: options?.cwd,
        env: options?.env,
      },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          const anyErr = error as { code?: number | string };
          code = typeof anyErr.code === 'number' ? anyErr.code : 1;
        }
        resolve({
          code,
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        });
      }
    );
  });
}

/**
 * Checks whether a process with the given PID is still alive using signal 0 (no child process spawned).
 */
export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    return code === 'EPERM';
  }
}
