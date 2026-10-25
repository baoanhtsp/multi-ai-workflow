import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../../../lib/proc.ts';

export function hasGitRepo(dirPath: string): boolean {
  if (!dirPath) return false;
  const gitMarker = path.win32.join(dirPath, '.git');
  try {
    return fs.existsSync(gitMarker);
  } catch {
    return false;
  }
}

export interface WorktreeChangedFilesResult {
  ok: boolean;
  files: string[];
  error?: string;
}

export async function getBaseCommit(worktreePath: string): Promise<string | null> {
  const res = await getBaseCommitResult(worktreePath);
  return res.commit;
}

export async function getBaseCommitResult(
  worktreePath: string
): Promise<{ ok: boolean; commit: string | null; error?: string }> {
  try {
    const res = await runCommand(
      'git.exe',
      ['-C', worktreePath, 'rev-parse', 'HEAD'],
      { timeoutMs: 5000 }
    );
    if (res.code === 0 && res.stdout) {
      const commit = res.stdout.trim();
      return { ok: true, commit: commit || null };
    }
    return { ok: false, commit: null, error: res.stderr || 'rev-parse failed' };
  } catch (err: unknown) {
    return { ok: false, commit: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface GitStatusEntry {
  newPath: string;
  oldPath?: string;
}

export function parsePorcelainV1Z(stdout: string): GitStatusEntry[] {
  if (!stdout) return [];
  const items = stdout.split('\0');
  const result: GitStatusEntry[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    // Format: XY <path>
    const statusCode = item.slice(0, 2);
    let filePath = item.slice(3);

    const isRenameOrCopy =
      statusCode[0] === 'R' || statusCode[1] === 'R' || statusCode[0] === 'C' || statusCode[1] === 'C';

    let oldPath: string | undefined;
    if (isRenameOrCopy && i + 1 < items.length) {
      oldPath = items[i + 1]?.replace(/\\/g, '/');
      i++; // advance past oldPath
    } else if (filePath.includes(' -> ')) {
      const parts = filePath.split(' -> ');
      oldPath = parts[0]?.trim().replace(/\\/g, '/');
      filePath = parts[1]?.trim() || filePath;
    }

    result.push({
      newPath: filePath.replace(/\\/g, '/'),
      oldPath,
    });
  }

  return result;
}

export async function getDirtyFilesWithHashes(
  worktreePath: string
): Promise<{ ok: boolean; files: Record<string, string>; error?: string }> {
  const result: Record<string, string> = {};

  try {
    const statusRes = await runCommand(
      'git.exe',
      ['-C', worktreePath, 'status', '--porcelain=v1', '-z', '-uall'],
      { timeoutMs: 8000 }
    );
    if (statusRes.code !== 0) {
      return { ok: false, files: {}, error: 'could not list changed files' };
    }

    if (!statusRes.stdout) {
      return { ok: true, files: {} };
    }

    const entries = parsePorcelainV1Z(statusRes.stdout);
    if (entries.length > 500) {
      return {
        ok: false,
        files: {},
        error: `too many uncommitted files to verify (${entries.length})`,
      };
    }

    for (const entry of entries) {
      const relPath = entry.newPath;

      const hashRes = await runCommand(
        'git.exe',
        ['-C', worktreePath, 'hash-object', relPath],
        { timeoutMs: 5000 }
      );
      if (hashRes.code === 0 && hashRes.stdout) {
        result[relPath] = hashRes.stdout.trim();
      } else {
        // Item 2 (Pass 7): A hash-object failure is a verification failure (needs_review), never a sentinel value.
        return {
          ok: false,
          files: {},
          error: `hash-object verification failed for ${relPath}`,
        };
      }
    }

    return { ok: true, files: result };
  } catch {
    return { ok: false, files: {}, error: 'could not list changed files' };
  }
}

export async function getWorktreeChangedFiles(
  worktreePath: string,
  baseCommit?: string | null
): Promise<WorktreeChangedFilesResult> {
  const changed = new Set<string>();

  // 1. git status --porcelain=v1 -z -uall for staged, unstaged, and untracked files
  try {
    const statusRes = await runCommand(
      'git.exe',
      ['-C', worktreePath, 'status', '--porcelain=v1', '-z', '-uall'],
      { timeoutMs: 8000 }
    );
    if (statusRes.code !== 0) {
      return { ok: false, files: [], error: 'could not list changed files' };
    }
    if (statusRes.stdout) {
      const entries = parsePorcelainV1Z(statusRes.stdout);
      for (const entry of entries) {
        if (entry.newPath) changed.add(entry.newPath);
        if (entry.oldPath) changed.add(entry.oldPath);
      }
    }
  } catch {
    return { ok: false, files: [], error: 'could not list changed files' };
  }

  // 2. git diff --name-only -z <base_commit>...HEAD for all commits made since start
  if (baseCommit) {
    try {
      const diffRes = await runCommand(
        'git.exe',
        ['-C', worktreePath, 'diff', '--name-only', '-z', `${baseCommit}...HEAD`],
        { timeoutMs: 8000 }
      );
      if (diffRes.code !== 0) {
        return { ok: false, files: [], error: 'could not list changed files' };
      }
      if (diffRes.stdout) {
        for (const line of diffRes.stdout.split('\0')) {
          const trimmed = line.trim();
          if (trimmed) changed.add(trimmed.replace(/\\/g, '/'));
        }
      }
    } catch {
      return { ok: false, files: [], error: 'could not list changed files' };
    }
  }

  return { ok: true, files: Array.from(changed) };
}

export async function getNonIsolatedChangedFiles(
  worktreePath: string,
  baseCommit?: string | null,
  baseline?: Record<string, string>
): Promise<WorktreeChangedFilesResult> {
  const changed = new Set<string>();

  // 1. Commits between baseCommit and HEAD
  if (baseCommit) {
    try {
      const diffRes = await runCommand(
        'git.exe',
        ['-C', worktreePath, 'diff', '--name-only', '-z', `${baseCommit}...HEAD`],
        { timeoutMs: 8000 }
      );
      if (diffRes.code !== 0) {
        return { ok: false, files: [], error: 'could not list changed files' };
      }
      if (diffRes.stdout) {
        for (const line of diffRes.stdout.split('\0')) {
          const trimmed = line.trim();
          if (trimmed) changed.add(trimmed.replace(/\\/g, '/'));
        }
      }
    } catch {
      return { ok: false, files: [], error: 'could not list changed files' };
    }
  }

  // 2. Working tree files dirty now that were clean at start or whose hash changed
  const current = await getDirtyFilesWithHashes(worktreePath);
  if (!current.ok) {
    return { ok: false, files: [], error: current.error };
  }

  const baseMap = baseline ?? {};
  for (const [file, hash] of Object.entries(current.files)) {
    if (!(file in baseMap)) {
      changed.add(file);
    } else if (baseMap[file] !== hash) {
      changed.add(file);
    }
  }

  // Item 2: Also count files that were dirty at baseline and became clean (reverted/deleted) as changed
  for (const file of Object.keys(baseMap)) {
    if (!(file in current.files)) {
      changed.add(file);
    }
  }

  return { ok: true, files: Array.from(changed) };
}
