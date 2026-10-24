import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerPaths {
  repoRoot: string;
  projectsRoot: string;
  dashboardDir: string;
  userProfile: string;
  antigravityDir: string;
  bridgeFile: string;
  auditFile: string;
  notifyCfgFile: string;
  presenceDir: string;
  brainDir: string;
  tempDir: string;
  jobsDir: string;
  scriptsDir: string;
}

export function getTempDir(): string {
  const raw = process.env.TEMP || process.env.TMP || os.tmpdir();
  return raw.replace(/[\\/]+$/, '');
}

export function resolveServerPaths(options?: {
  repoRoot?: string;
  projectsRoot?: string;
  userProfile?: string;
}): ServerPaths {
  let repoRoot = options?.repoRoot ?? path.resolve(import.meta.dirname, '..', '..');
  try {
    repoRoot = fs.realpathSync(repoRoot);
  } catch {
    // Keep resolved path if realpath fails
  }

  const rawProjectsRoot =
    options?.projectsRoot ||
    process.env.MAW_PROJECTS_ROOT ||
    path.dirname(repoRoot);
  let projectsRoot = rawProjectsRoot;
  try {
    projectsRoot = fs.realpathSync(rawProjectsRoot);
  } catch {
    // Keep rawProjectsRoot if realpath fails
  }

  let userProfile = (options?.userProfile ?? process.env.USERPROFILE ?? '').trim();
  if (!userProfile || !isDirectorySafe(userProfile)) {
    userProfile = 'C:\\Users\\Admin';
  }
  userProfile = userProfile.replace(/[\\/]+$/, '');

  const antigravityDir = path.win32.join(userProfile, '.gemini', 'antigravity');
  const bridgeFile = path.win32.join(antigravityDir, 'agentapi-bridge.json');
  const auditFile = path.win32.join(antigravityDir, 'multi-ai-audit.jsonl');
  const notifyCfgFile = path.win32.join(antigravityDir, 'notify-config.json');
  const presenceDir = path.win32.join(antigravityDir, 'presence');
  const brainDir = path.win32.join(antigravityDir, 'brain');
  const tempDir = getTempDir();
  const jobsDir = path.win32.join(tempDir, 'maw_jobs');

  const installedScriptsDir = path.win32.join(
    userProfile,
    '.gemini',
    'config',
    'skills',
    'claude-leader',
    'scripts'
  );
  const scriptsDir = isDirectorySafe(installedScriptsDir)
    ? installedScriptsDir
    : path.win32.join(repoRoot, 'antigravity', 'skills', 'claude-leader', 'scripts');

  const dashboardDir = path.win32.join(repoRoot, 'dashboard');

  return {
    repoRoot,
    projectsRoot,
    dashboardDir,
    userProfile,
    antigravityDir,
    bridgeFile,
    auditFile,
    notifyCfgFile,
    presenceDir,
    brainDir,
    tempDir,
    jobsDir,
    scriptsDir,
  };
}

export function isDirectorySafe(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function isFileSafe(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves and validates that candidatePath is an existing directory strictly inside projectsRoot (v2.2 parity).
 */
export function resolveProjectPath(candidatePath: string, projectsRoot: string): string | null {
  const trimmed = candidatePath.trim();
  if (!trimmed) {
    return null;
  }
  let realTarget: string;
  let realBase: string;
  try {
    realTarget = fs.realpathSync(trimmed);
    realBase = fs.realpathSync(projectsRoot);
    if (!fs.statSync(realTarget).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const normTarget = realTarget.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const normBase = realBase.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  if (!normTarget.startsWith(normBase + '\\')) {
    return null;
  }
  return realTarget;
}

/**
 * Ensures a raw byte chunk never ends in the middle of a multi-byte UTF-8 character (SPEC §3.7 & §3.11).
 */
export function trimIncompleteUtf8Tail(bytes: Buffer): Buffer {
  const len = bytes.length;
  if (len === 0) {
    return bytes;
  }
  // Fast path: last byte is ASCII (0xxxxxxx)
  if ((bytes[len - 1]! & 0x80) === 0) {
    return bytes;
  }
  // Scan backwards up to 4 bytes to find the UTF-8 lead byte (11xxxxxx)
  for (let back = 1; back <= 4 && back <= len; back++) {
    const idx = len - back;
    const b = bytes[idx]!;
    if ((b & 0xc0) === 0x80) {
      // Continuation byte (10xxxxxx), keep scanning back
      continue;
    }
    let expected = 0;
    if ((b & 0xe0) === 0xc0) {
      expected = 2;
    } else if ((b & 0xf0) === 0xe0) {
      expected = 3;
    } else if ((b & 0xf8) === 0xf0) {
      expected = 4;
    } else {
      return bytes.subarray(0, idx);
    }
    return back < expected ? bytes.subarray(0, idx) : bytes;
  }
  return bytes;
}
