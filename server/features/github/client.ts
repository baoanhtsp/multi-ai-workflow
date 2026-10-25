import type { ServerResponse } from 'node:http';
import { sendJson } from '../../http.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';

export type GhRunner = (
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
) => Promise<{ code: number; stdout: string; stderr: string }>;

let customGhRunner: GhRunner | null = null;
let customGitRunner: GhRunner | null = null;

export function setGhRunner(runner: GhRunner | null): void {
  customGhRunner = runner;
}

export function setGitRunner(runner: GhRunner | null): void {
  customGitRunner = runner;
}

export async function executeGit(
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (customGitRunner) {
    return customGitRunner(args, options);
  }
  return runCommand('git', args, {
    cwd: options?.cwd,
    timeoutMs: options?.timeoutMs ?? 30000,
    env: options?.env,
  });
}

export async function executeGh(
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (customGhRunner) {
    return customGhRunner(args, options);
  }
  return runCommand('gh', args, {
    cwd: options?.cwd,
    timeoutMs: options?.timeoutMs ?? 30000,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      NO_COLOR: '1',
      ...(options?.env ?? {}),
    },
  });
}

export function throwGhNotInstalled(res?: ServerResponse): never {
  if (res && !res.headersSent && !res.writableEnded) {
    sendJson(
      res,
      {
        ok: false,
        error: 'GitHub CLI (gh) is not installed.',
        gh: { installed: false },
      },
      409
    );
  }
  const err = new ApiValidationError('GitHub CLI (gh) is not installed.', 409) as unknown as Record<
    string,
    unknown
  >;
  err.gh = { installed: false };
  throw err;
}

export function throwGhNotLoggedIn(res?: ServerResponse): never {
  if (res && !res.headersSent && !res.writableEnded) {
    sendJson(
      res,
      {
        ok: false,
        error: 'gh is not logged in. Run: gh auth login',
        gh: { installed: true, logged_in: false },
      },
      409
    );
  }
  const err = new ApiValidationError('gh is not logged in. Run: gh auth login', 409) as unknown as Record<
    string,
    unknown
  >;
  err.gh = { installed: true, logged_in: false };
  throw err;
}

interface GhStatusCache {
  installed: boolean;
  version: string | null;
  logged_in: boolean;
  user: string | null;
  timestamp: number;
}

let statusCache: GhStatusCache | null = null;

export function clearGhStatusCache(): void {
  statusCache = null;
}

export async function checkGhStatus(
  projectPath?: string
): Promise<{ installed: boolean; version: string | null; logged_in: boolean; user: string | null }> {
  const now = Date.now();
  if (statusCache && now - statusCache.timestamp < 300000) {
    return {
      installed: statusCache.installed,
      version: statusCache.version,
      logged_in: statusCache.logged_in,
      user: statusCache.user,
    };
  }

  // 1. gh --version
  const verRes = await executeGh(['--version'], { cwd: projectPath });
  if (verRes.code !== 0 || verRes.stdout.trim() === '') {
    statusCache = {
      installed: false,
      version: null,
      logged_in: false,
      user: null,
      timestamp: now,
    };
    return statusCache;
  }

  let version: string | null = null;
  const verMatch = /gh version (\d+\.\d+\.\d+)/i.exec(verRes.stdout);
  if (verMatch) {
    version = verMatch[1]!;
  }

  // 2. gh auth status --hostname github.com
  const authRes = await executeGh(['auth', 'status', '--hostname', 'github.com'], {
    cwd: projectPath,
  });
  const loggedIn = authRes.code === 0;

  let user: string | null = null;
  const combinedAuthOutput = `${authRes.stdout}\n${authRes.stderr}`;
  const userMatch =
    /(?:account|as|user)\s+([a-zA-Z0-9_-]+)/i.exec(combinedAuthOutput) ??
    /Logged in to [^\s]+ account ([a-zA-Z0-9_-]+)/i.exec(combinedAuthOutput);
  if (userMatch) {
    user = userMatch[1]!;
  }

  statusCache = {
    installed: true,
    version,
    logged_in: loggedIn,
    user,
    timestamp: now,
  };

  return statusCache;
}

export async function ensureGhReady(
  projectPath?: string,
  res?: ServerResponse
): Promise<{ version: string | null; user: string | null }> {
  const status = await checkGhStatus(projectPath);
  if (!status.installed) {
    throwGhNotInstalled(res);
  }
  if (!status.logged_in) {
    throwGhNotLoggedIn(res);
  }
  return { version: status.version, user: status.user };
}
