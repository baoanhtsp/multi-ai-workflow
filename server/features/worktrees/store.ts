import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getTempDir, isDirectorySafe, isFileSafe, resolveProjectPath } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { gitRun, validateRefName, validateWorktreeName, WORKTREE_NAME_REGEX } from '../checkpoints/snapshot.ts';

export interface WorktreeRecord {
  id: string; // = name
  project_path: string; // main repo root
  worktree_path: string;
  branch: string; // maw/<name>
  base: string; // base branch name (or commit when detached)
  base_commit: string; // sha at creation
  start_point?: string; // optional start point commit/ref (W4)
  port: number; // MAW_PORT, unique among active records, 4400–4999
  origin: 'manual' | 'job' | 'fork' | 'bestof' | 'handoff';
  job_id?: string; // job running in it
  source_job_id?: string; // fork source
  bestof_id?: string;
  owner?: string; // registry agent id, used by SPEC Guard
  status: 'creating' | 'active' | 'merged' | 'discarded' | 'missing';
  created_at: string;
  updated_at: string;
  merged?: { strategy: string; commit: string; at: string; branch_tip?: string };
  setup?: { ran: boolean; exit_code: number | null; log: string };
  [key: string]: unknown;
}

export interface WorktreesStoreFile {
  version: 1;
  worktrees: WorktreeRecord[];
}

export interface WorktreeLiveStats {
  exists: boolean;
  head: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  files: number;
  job_status: string | null;
}

export interface WorktreeWithLive extends WorktreeRecord {
  live: WorktreeLiveStats;
}

// In-process mutex for atomic store file operations
let storeLockPromise = Promise.resolve();

export async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const current = storeLockPromise;
  storeLockPromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  await current;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function getWorktreesStorePath(dataDir: string): string {
  return path.win32.join(dataDir, 'worktrees.json');
}

export async function loadWorktreesStore(dataDir: string): Promise<WorktreesStoreFile> {
  const storePath = getWorktreesStorePath(dataDir);
  if (!isFileSafe(storePath)) {
    return { version: 1, worktrees: [] };
  }
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw) as WorktreesStoreFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.worktrees)) {
      return parsed;
    }
  } catch {
    // Return empty on corrupt file
  }
  return { version: 1, worktrees: [] };
}

export async function saveWorktreesStore(dataDir: string, store: WorktreesStoreFile): Promise<void> {
  const storePath = getWorktreesStorePath(dataDir);
  if (!isDirectorySafe(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const tempDir = getTempDir();
  const tmpFile = path.win32.join(tempDir, `maw-wt-store-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
  try {
    fs.renameSync(tmpFile, storePath);
  } catch (err) {
    try {
      fs.copyFileSync(tmpFile, storePath);
      fs.unlinkSync(tmpFile);
    } catch {
      throw err;
    }
  }
}

export function allocateWorktreePortFromStore(store: WorktreesStoreFile): number {
  const usedPorts = new Set<number>();
  for (const wt of store.worktrees) {
    if ((wt.status === 'active' || wt.status === 'creating') && typeof wt.port === 'number') {
      usedPorts.add(wt.port);
    }
  }

  for (let port = 4400; port <= 4999; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  throw new ApiValidationError('No free worktree port available in range 4400-4999.', 500);
}

export async function allocateWorktreePort(dataDir: string): Promise<number> {
  const store = await loadWorktreesStore(dataDir);
  return allocateWorktreePortFromStore(store);
}

export async function resolveMainRepoRoot(projectPath: string): Promise<string> {
  const listRes = await gitRun(['worktree', 'list', '--porcelain'], { cwd: projectPath });
  const lines = listRes.stdout.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      let mainPath = line.slice('worktree '.length).trim().replace(/\//g, '\\');
      try {
        mainPath = fs.realpathSync(mainPath);
      } catch {
        // Keep raw
      }
      return mainPath;
    }
  }
  // Fallback: rev-parse --show-toplevel
  const topRes = await gitRun(['rev-parse', '--show-toplevel'], { cwd: projectPath });
  return topRes.stdout.trim().replace(/\//g, '\\');
}

export function generateWorktreeName(prefix = 'wt'): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(2).toString('hex');
  return `${prefix}-${ts}-${hex}`;
}

export function parseWorktreeInclude(repoRoot: string): string[] {
  const incFile = path.win32.join(repoRoot, '.worktreeinclude');
  if (!isFileSafe(incFile)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(incFile, 'utf8');
    const lines = raw.split(/\r?\n/);
    const patterns: string[] = [];
    for (const l of lines) {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (
        trimmed.includes('..') ||
        path.win32.isAbsolute(trimmed) ||
        /^[A-Za-z]:/.test(trimmed) ||
        trimmed.startsWith('/') ||
        trimmed.startsWith('\\')
      ) {
        continue;
      }
      patterns.push(trimmed.replace(/\\/g, '/'));
    }
    return patterns;
  } catch {
    return [];
  }
}

function matchSimpleGlob(relPath: string, pattern: string): boolean {
  const normPath = relPath.replace(/\\/g, '/');
  const normPattern = pattern.replace(/\\/g, '/');

  if (normPattern === normPath) return true;
  if (normPattern === '*') return !normPath.includes('/');
  if (normPattern === '**') return true;

  if (normPattern.endsWith('/*')) {
    const dir = normPattern.slice(0, -2);
    return normPath.startsWith(dir + '/') && !normPath.slice(dir.length + 1).includes('/');
  }
  if (normPattern.endsWith('/**')) {
    const dir = normPattern.slice(0, -3);
    return normPath.startsWith(dir + '/');
  }

  // Regex fallback for simple wildcard patterns
  const escaped = normPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(normPath);
}

const FORBIDDEN_DIRS = new Set([
  '.git',
  '.maw-wt',
  'node_modules',
  'vendor',
  '.venv',
  'dist',
]);

export function copyWorktreeIncludeFiles(repoRoot: string, wtPath: string): string[] {
  const patterns = parseWorktreeInclude(repoRoot);
  if (patterns.length === 0) {
    return [];
  }

  const copied: string[] = [];
  const copiedSet = new Set<string>();
  let totalBytes = 0;
  const MAX_FILES = 200;
  const MAX_BYTES = 50 * 1024 * 1024;

  const directPatterns: string[] = [];
  const globPatterns: string[] = [];

  for (const pat of patterns) {
    if (pat.includes('*') || pat.includes('?')) {
      globPatterns.push(pat);
    } else {
      directPatterns.push(pat);
    }
  }

  // 1. Direct copy non-glob files without traversal (W12)
  for (const relPath of directPatterns) {
    if (copied.length >= MAX_FILES || totalBytes >= MAX_BYTES) break;
    if (copiedSet.has(relPath)) continue;

    const fullPath = path.win32.join(repoRoot, relPath.replace(/\//g, '\\'));
    if (isFileSafe(fullPath)) {
      try {
        const st = fs.statSync(fullPath);
        if (totalBytes + st.size <= MAX_BYTES) {
          const destPath = path.win32.join(wtPath, relPath.replace(/\//g, '\\'));
          const destDir = path.dirname(destPath);
          if (!isDirectorySafe(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
          }
          fs.copyFileSync(fullPath, destPath);
          copied.push(relPath);
          copiedSet.add(relPath);
          totalBytes += st.size;
        }
      } catch {
        // Ignore single file copy errors
      }
    }
  }

  // 2. Optimized glob search
  if (globPatterns.length > 0 && copied.length < MAX_FILES && totalBytes < MAX_BYTES) {
    function scanDir(dir: string, relBase: string): void {
      if (copied.length >= MAX_FILES || totalBytes >= MAX_BYTES) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (copied.length >= MAX_FILES || totalBytes >= MAX_BYTES) break;
        const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
        const fullPath = path.win32.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (FORBIDDEN_DIRS.has(entry.name)) {
            continue;
          }
          // Only traverse if some glob pattern could match inside this directory
          const couldMatch = globPatterns.some((pat) => {
            if (pat === '**' || pat.startsWith('**/')) return true;
            const prefix = pat.split(/[*?]/)[0] ?? '';
            const dirPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : path.posix.dirname(prefix);
            if (!dirPrefix || dirPrefix === '.') return true;
            return (
              dirPrefix.startsWith(relPath) ||
              relPath.startsWith(dirPrefix) ||
              matchSimpleGlob(relPath, pat)
            );
          });

          if (couldMatch) {
            scanDir(fullPath, relPath);
          }
        } else if (entry.isFile()) {
          if (copiedSet.has(relPath)) continue;
          const matches = globPatterns.some((pat) => matchSimpleGlob(relPath, pat));
          if (matches) {
            try {
              const st = fs.statSync(fullPath);
              if (totalBytes + st.size <= MAX_BYTES) {
                const destPath = path.win32.join(wtPath, relPath.replace(/\//g, '\\'));
                const destDir = path.dirname(destPath);
                if (!isDirectorySafe(destDir)) {
                  fs.mkdirSync(destDir, { recursive: true });
                }
                fs.copyFileSync(fullPath, destPath);
                copied.push(relPath);
                copiedSet.add(relPath);
                totalBytes += st.size;
              }
            } catch {
              // Ignore individual file copy error
            }
          }
        }
      }
    }

    scanDir(repoRoot, '');
  }

  return copied;
}

export async function runWorktreeSetupScript(
  repoRoot: string,
  wtPath: string,
  wtName: string,
  port: number,
  logsDir: string
): Promise<{ ran: boolean; exit_code: number | null; log: string }> {
  const setupScript = path.win32.join(repoRoot, '.maw', 'setup.ps1');
  if (!isFileSafe(setupScript)) {
    return { ran: false, exit_code: null, log: '' };
  }

  if (!isDirectorySafe(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const logFile = path.win32.join(logsDir, `${wtName}.setup.log`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKTREE_PATH: wtPath,
    REPO_PATH: repoRoot,
    MAW_PORT: String(port),
  };

  const res = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript],
    {
      cwd: wtPath,
      timeoutMs: 300000,
      env,
    }
  );

  const fullOutput = `${res.stdout}\n${res.stderr}`.trim();
  try {
    fs.writeFileSync(logFile, fullOutput, 'utf8');
  } catch {
    // Ignore log file write failure
  }

  const logTail = fullOutput.slice(-2000);
  return {
    ran: true,
    exit_code: res.code,
    log: logTail,
  };
}
