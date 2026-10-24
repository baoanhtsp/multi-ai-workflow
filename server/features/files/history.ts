import { runCommand } from '../../lib/proc.ts';
import { validateSafeRelativePath } from '../review/git.ts';

export interface FileCommitHistoryEntry {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  additions: number;
  deletions: number;
}

export async function getFilesHistory(options: {
  projectPath: string;
  relPath?: string;
  limit?: number;
}): Promise<FileCommitHistoryEntry[]> {
  const { projectPath } = options;
  const rawLimit = options.limit ?? 30;
  const limit = Math.max(1, Math.min(200, rawLimit));

  const filterPath = options.relPath ? validateSafeRelativePath(projectPath, options.relPath) : '';

  const gitArgs = [
    '-C',
    projectPath,
    '-c',
    'core.quotepath=off',
    'log',
    `-n`,
    String(limit),
    '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s',
    '--numstat',
  ];

  if (filterPath) {
    gitArgs.splice(5, 0, '--follow');
    gitArgs.push('--', filterPath);
  }

  const res = await runCommand('git', gitArgs);
  if (res.code !== 0 || !res.stdout.trim()) {
    return [];
  }

  const rawCommits = res.stdout.split('\x1e');
  const commits: FileCommitHistoryEntry[] = [];

  for (const rawBlock of rawCommits) {
    const trimmedBlock = rawBlock.trim();
    if (!trimmedBlock) continue;

    const lines = trimmedBlock.split(/\r?\n/);
    if (lines.length === 0) continue;

    const header = lines[0]!;
    const headerParts = header.split('\x1f');
    if (headerParts.length < 5) continue;

    const sha = headerParts[0]!;
    const short = headerParts[1]!;
    const author = headerParts[2]!;
    const date = headerParts[3]!;
    const subject = headerParts[4]!;

    let totalAdditions = 0;
    let totalDeletions = 0;

    for (let i = 1; i < lines.length; i++) {
      const numstatLine = lines[i]!.trim();
      if (!numstatLine) continue;

      const numParts = numstatLine.split('\t');
      if (numParts.length >= 2) {
        const addStr = numParts[0]!;
        const delStr = numParts[1]!;

        const adds = addStr === '-' ? 0 : Number.parseInt(addStr, 10);
        const dels = delStr === '-' ? 0 : Number.parseInt(delStr, 10);

        if (!Number.isNaN(adds)) totalAdditions += adds;
        if (!Number.isNaN(dels)) totalDeletions += dels;
      }
    }

    commits.push({
      sha,
      short,
      author,
      date,
      subject,
      additions: totalAdditions,
      deletions: totalDeletions,
    });
  }

  return commits;
}
