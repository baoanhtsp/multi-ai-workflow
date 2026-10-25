import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerPaths {
  repoRoot: string;
  projectsRoot: string;
  dashboardDir: string;
  userProfile: string;
  mawHome: string;
  antigravityDir: string;
  bridgeFile: string;
  auditFile: string;
  notifyCfgFile: string;
  presenceDir: string;
  brainDir: string;
  tempDir: string;
  jobsDir: string;
  scriptsDir: string;
  featureDataDir: (name: string) => string;
}

const FEATURE_NAME_REGEX = /^[a-z][a-z0-9-]{1,31}$/;

export function resolveLongWinPath(rawPath: string): string {
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) return '';
  let cur = path.win32.resolve(trimmed).replace(/[\\/]+$/, '');
  const tail: string[] = [];
  while (cur && !/^[A-Za-z]:\\?$/.test(cur) && !fs.existsSync(cur)) {
    tail.unshift(path.win32.basename(cur));
    const parent = path.win32.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  if (cur && fs.existsSync(cur)) {
    try {
      cur = fs.realpathSync.native(cur);
    } catch {
      try {
        cur = fs.realpathSync(cur);
      } catch {
        // Keep resolved cur
      }
    }
  }
  const joined = tail.length > 0 ? path.win32.join(cur, ...tail) : cur;
  return joined.replace(/\//g, '\\').replace(/\\+$/, '');
}

const REAL_USER_PROFILE = resolveLongWinPath(
  process.env.MAW_REAL_USERPROFILE ||
    (process.env.LOCALAPPDATA
      ? path.win32.resolve(process.env.LOCALAPPDATA, '..', '..')
      : process.env.APPDATA
        ? path.win32.resolve(process.env.APPDATA, '..', '..')
        : process.env.USERPROFILE || os.homedir() || 'C:\\Users\\Admin')
);

const REAL_MAW_HOME = path.win32.join(REAL_USER_PROFILE, '.maw');
const REAL_TEMP_DIR = resolveLongWinPath(
  process.env.MAW_REAL_TEMP ||
    (process.env.LOCALAPPDATA
      ? path.win32.join(process.env.LOCALAPPDATA, 'Temp')
      : os.tmpdir())
);
const REAL_JOBS_DIR = path.win32.join(REAL_TEMP_DIR, 'maw_jobs');
const REAL_INSTALLED_SCRIPTS_DIR = path.win32.join(
  REAL_USER_PROFILE,
  '.gemini',
  '.config_placeholder'
).replace('\\.config_placeholder', '\\config\\skills\\claude-leader\\scripts');

export function isTestContext(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.MAW_TEST === '1';
}

export function sameWinPath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const normA = resolveLongWinPath(a).toLowerCase();
  const normB = resolveLongWinPath(b).toLowerCase();
  return Boolean(normA) && normA === normB;
}

export function getRealSystemPaths() {
  return {
    userProfile: REAL_USER_PROFILE,
    mawHome: REAL_MAW_HOME,
    tempDir: REAL_TEMP_DIR,
    jobsDir: REAL_JOBS_DIR,
    installedScriptsDir: REAL_INSTALLED_SCRIPTS_DIR,
  };
}

export function getTempDir(): string {
  const raw = process.env.TEMP || process.env.TMP || os.tmpdir();
  return raw.replace(/[\\/]+$/, '');
}

export function resolveServerPaths(options?: {
  repoRoot?: string;
  projectsRoot?: string;
  userProfile?: string;
  mawHome?: string;
  tempDir?: string;
  jobsDir?: string;
  scriptsDir?: string;
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

  const inTest = isTestContext();

  const explicitUserProfile = options?.userProfile?.trim();
  if (explicitUserProfile && sameWinPath(explicitUserProfile, REAL_USER_PROFILE) && inTest) {
    throw new Error(
      `Test isolation guard: resolveServerPaths refused real userProfile (${explicitUserProfile}) in test context.`
    );
  }

  const explicitMawHome = options?.mawHome?.trim();
  if (explicitMawHome && sameWinPath(explicitMawHome, REAL_MAW_HOME) && inTest) {
    throw new Error(
      `Test isolation guard: resolveServerPaths refused real MAW_HOME (${explicitMawHome}) in test context.`
    );
  }

  const explicitJobsDir = options?.jobsDir?.trim();
  if (explicitJobsDir && sameWinPath(explicitJobsDir, REAL_JOBS_DIR) && inTest) {
    throw new Error(
      `Test isolation guard: resolveServerPaths refused real jobsDir (${explicitJobsDir}) in test context.`
    );
  }

  const explicitScriptsDir = options?.scriptsDir?.trim();
  if (explicitScriptsDir && sameWinPath(explicitScriptsDir, REAL_INSTALLED_SCRIPTS_DIR) && inTest) {
    throw new Error(
      `Test isolation guard: resolveServerPaths refused real installed scriptsDir (${explicitScriptsDir}) in test context.`
    );
  }

  let rawMawHome = (options?.mawHome ?? process.env.MAW_HOME ?? '').trim().replace(/[\\/]+$/, '');
  let userProfile = (options?.userProfile ?? process.env.USERPROFILE ?? '').trim().replace(/[\\/]+$/, '');

  if (inTest) {
    // If test caller passed isolated mawHome without userProfile, derive isolated userProfile inside mawHome
    if (!explicitUserProfile && (!userProfile || sameWinPath(userProfile, REAL_USER_PROFILE))) {
      if (rawMawHome && !sameWinPath(rawMawHome, REAL_MAW_HOME)) {
        userProfile = path.win32.join(rawMawHome, '_user_profile');
      }
    }
    if (userProfile && !sameWinPath(userProfile, REAL_USER_PROFILE) && !fs.existsSync(userProfile)) {
      try {
        fs.mkdirSync(userProfile, { recursive: true });
      } catch {
        // Ignore mkdir errors if parent does not exist
      }
    }
  } else {
    if (!userProfile || !isDirectorySafe(userProfile)) {
      userProfile = REAL_USER_PROFILE || 'C:\\Users\\Admin';
    }
  }
  userProfile = userProfile.replace(/[\\/]+$/, '');

  const mawHome = rawMawHome || path.win32.join(userProfile, '.maw');

  const antigravityDir = path.win32.join(userProfile, '.gemini', 'antigravity');
  const bridgeFile = path.win32.join(antigravityDir, 'agentapi-bridge.json');
  const auditFile = path.win32.join(antigravityDir, 'multi-ai-audit.jsonl');
  const notifyCfgFile = path.win32.join(antigravityDir, 'notify-config.json');
  const presenceDir = path.win32.join(antigravityDir, 'presence');
  const brainDir = path.win32.join(antigravityDir, 'brain');

  let tempDir = (options?.tempDir ?? '').trim().replace(/[\\/]+$/, '') || getTempDir();
  if (inTest && !options?.tempDir && sameWinPath(tempDir, REAL_TEMP_DIR)) {
    const baseIso = explicitUserProfile && !sameWinPath(userProfile, REAL_USER_PROFILE)
      ? userProfile
      : !sameWinPath(mawHome, REAL_MAW_HOME)
        ? mawHome
        : '';
    if (baseIso) {
      tempDir = path.win32.join(baseIso, '_temp');
      try {
        fs.mkdirSync(path.win32.join(tempDir, 'maw_jobs'), { recursive: true });
      } catch {}
    }
  }

  let jobsDir =
    (options?.jobsDir ?? process.env.MAW_JOBS_DIR ?? '').trim().replace(/[\\/]+$/, '') ||
    path.win32.join(tempDir, 'maw_jobs');
  if (inTest && !options?.jobsDir && sameWinPath(jobsDir, REAL_JOBS_DIR) && !sameWinPath(tempDir, REAL_TEMP_DIR)) {
    jobsDir = path.win32.join(tempDir, 'maw_jobs');
  }
  if (inTest && jobsDir && !sameWinPath(jobsDir, REAL_JOBS_DIR)) {
    try {
      fs.mkdirSync(jobsDir, { recursive: true });
    } catch {
      // Ignore mkdir errors
    }
  }

  const repoScriptsDir = path.win32.join(
    repoRoot,
    'antigravity',
    'skills',
    'claude-leader',
    'scripts'
  );
  const installedScriptsDir = path.win32.join(
    userProfile,
    '.gemini',
    'config',
    'skills',
    'claude-leader',
    'scripts'
  );

  let scriptsDir = (options?.scriptsDir ?? process.env.MAW_SCRIPTS_DIR ?? '').trim().replace(/[\\/]+$/, '');
  if (!scriptsDir) {
    if (inTest && sameWinPath(installedScriptsDir, REAL_INSTALLED_SCRIPTS_DIR)) {
      scriptsDir = repoScriptsDir;
    } else {
      scriptsDir = isDirectorySafe(installedScriptsDir) ? installedScriptsDir : repoScriptsDir;
    }
  }

  if (inTest) {
    if (!userProfile || sameWinPath(userProfile, REAL_USER_PROFILE)) {
      throw new Error(
        `Test isolation guard: resolveServerPaths refused real userProfile (${userProfile || REAL_USER_PROFILE}) in test context.`
      );
    }
    if (!mawHome || sameWinPath(mawHome, REAL_MAW_HOME)) {
      throw new Error(
        `Test isolation guard: resolveServerPaths refused real MAW_HOME (${mawHome || REAL_MAW_HOME}) in test context.`
      );
    }
    if (!jobsDir || sameWinPath(jobsDir, REAL_JOBS_DIR)) {
      throw new Error(
        `Test isolation guard: resolveServerPaths refused real jobsDir (${jobsDir || REAL_JOBS_DIR}) in test context.`
      );
    }
    if (!scriptsDir || sameWinPath(scriptsDir, REAL_INSTALLED_SCRIPTS_DIR)) {
      throw new Error(
        `Test isolation guard: resolveServerPaths refused real installed scriptsDir (${scriptsDir || REAL_INSTALLED_SCRIPTS_DIR}) in test context.`
      );
    }
  }

  const dashboardDir = path.win32.join(repoRoot, 'dashboard');

  const featureDataDir = (name: string): string => {
    const trimmed = String(name ?? '').trim();
    if (!FEATURE_NAME_REGEX.test(trimmed)) {
      throw new Error(
        `Invalid feature name '${trimmed}' for featureDataDir (must match ^[a-z][a-z0-9-]{1,31}$).`
      );
    }
    const dir = path.win32.join(mawHome, 'data', trimmed);
    if (!isDirectorySafe(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  };

  return {
    repoRoot,
    projectsRoot,
    dashboardDir,
    userProfile,
    mawHome,
    antigravityDir,
    bridgeFile,
    auditFile,
    notifyCfgFile,
    presenceDir,
    brainDir,
    tempDir,
    jobsDir,
    scriptsDir,
    featureDataDir,
  };
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export interface ServerLockInfo {
  pid: number;
  port: number | null;
  started_at: string;
}

export function acquireServerLock(mawHome: string, options?: { port?: number; pid?: number }): string {
  const dir = mawHome.replace(/[\\/]+$/, '');
  if (!isDirectorySafe(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const lockFile = path.win32.join(dir, 'server.lock');
  const myPid = options?.pid ?? process.pid;

  if (fs.existsSync(lockFile)) {
    let existing: Partial<ServerLockInfo> | null = null;
    try {
      const raw = fs.readFileSync(lockFile, 'utf8').replace(/^\uFEFF/, '').trim();
      if (raw.startsWith('{')) {
        existing = JSON.parse(raw) as Partial<ServerLockInfo>;
      } else {
        const parsedPid = Number.parseInt(raw, 10);
        if (Number.isInteger(parsedPid)) {
          existing = { pid: parsedPid };
        }
      }
    } catch {
      existing = null;
    }

    const holderPid = typeof existing?.pid === 'number' ? existing.pid : 0;
    if (holderPid > 0 && holderPid !== myPid && isPidAlive(holderPid)) {
      const portHint = existing?.port ? ` on port ${existing.port}` : '';
      throw new Error(
        `Another MAW dashboard server is already running for MAW_HOME '${dir}' (PID ${holderPid}${portHint}). Only one server per MAW_HOME is allowed.`
      );
    }

    try {
      fs.unlinkSync(lockFile);
    } catch {
      // Ignore unlink race
    }
  }

  const payload: ServerLockInfo = {
    pid: myPid,
    port: options?.port ?? null,
    started_at: new Date().toISOString(),
  };
  fs.writeFileSync(lockFile, JSON.stringify(payload, null, 2), 'utf8');
  return lockFile;
}

export function releaseServerLock(mawHome: string, expectedPid: number = process.pid): void {
  const dir = mawHome.replace(/[\\/]+$/, '');
  const lockFile = path.win32.join(dir, 'server.lock');
  if (!fs.existsSync(lockFile)) {
    return;
  }
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').replace(/^\uFEFF/, '').trim();
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Partial<ServerLockInfo>;
      if (parsed.pid && parsed.pid !== expectedPid) {
        return;
      }
    }
    fs.unlinkSync(lockFile);
  } catch {
    // Ignore errors during lock cleanup
  }
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

  const normTarget = resolveLongWinPath(realTarget).toLowerCase();
  const normBase = resolveLongWinPath(realBase).toLowerCase();
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
