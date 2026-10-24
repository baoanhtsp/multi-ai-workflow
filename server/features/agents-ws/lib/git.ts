import { runCommand } from '../../../lib/proc.ts';

export async function getWorktreeChangedFiles(worktreePath: string): Promise<string[]> {
  const changed = new Set<string>();

  try {
    const diffRes = await runCommand(
      'git.exe',
      ['-C', worktreePath, 'diff', '--name-only', 'HEAD~1...HEAD'],
      { timeoutMs: 8000 }
    );
    if (diffRes.stdout) {
      for (const line of diffRes.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) changed.add(trimmed.replace(/\\/g, '/'));
      }
    }
  } catch {
    // If HEAD~1 does not exist, try diff --name-only alone
    try {
      const diffRes2 = await runCommand(
        'git.exe',
        ['-C', worktreePath, 'diff', '--name-only'],
        { timeoutMs: 8000 }
      );
      if (diffRes2.stdout) {
        for (const line of diffRes2.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) changed.add(trimmed.replace(/\\/g, '/'));
        }
      }
    } catch {
      // Ignore git diff error
    }
  }

  try {
    const statusRes = await runCommand(
      'git.exe',
      ['-C', worktreePath, 'status', '--porcelain'],
      { timeoutMs: 8000 }
    );
    if (statusRes.stdout) {
      for (const line of statusRes.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        // porcelain line is e.g. " M file.txt" or "?? new.txt" or "R  old -> new"
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
    // Ignore git status error
  }

  return Array.from(changed);
}
