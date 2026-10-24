import { runCommand } from '../../../lib/proc.ts';

export interface WorktreeChangedFilesResult {
  ok: boolean;
  files: string[];
  error?: string;
}

export async function getBaseCommit(worktreePath: string): Promise<string | null> {
  try {
    const res = await runCommand(
      'git.exe',
      ['-C', worktreePath, 'rev-parse', 'HEAD'],
      { timeoutMs: 5000 }
    );
    if (res.code === 0 && res.stdout) {
      const commit = res.stdout.trim();
      return commit || null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getWorktreeChangedFiles(
  worktreePath: string,
  baseCommit?: string | null
): Promise<WorktreeChangedFilesResult> {
  const changed = new Set<string>();

  // 1. git status --porcelain for staged, unstaged, and untracked files
  try {
    const statusRes = await runCommand(
      'git.exe',
      ['-C', worktreePath, 'status', '--porcelain'],
      { timeoutMs: 8000 }
    );
    if (statusRes.code !== 0) {
      return { ok: false, files: [], error: 'could not list changed files' };
    }
    if (statusRes.stdout) {
      for (const line of statusRes.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const filePart = line.slice(3).trim();
        if (filePart.includes(' -> ')) {
          const parts = filePart.split(' -> ');
          if (parts[1]) changed.add(parts[1].trim().replace(/\\/g, '/'));
        } else if (filePart) {
          changed.add(filePart.replace(/\\/g, '/'));
        }
      }
    }
  } catch {
    return { ok: false, files: [], error: 'could not list changed files' };
  }

  // 2. git diff --name-only <base_commit>...HEAD for all commits made since start
  if (baseCommit) {
    try {
      const diffRes = await runCommand(
        'git.exe',
        ['-C', worktreePath, 'diff', '--name-only', `${baseCommit}...HEAD`],
        { timeoutMs: 8000 }
      );
      if (diffRes.code !== 0) {
        return { ok: false, files: [], error: 'could not list changed files' };
      }
      if (diffRes.stdout) {
        for (const line of diffRes.stdout.split(/\r?\n/)) {
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
