import { runCommand } from '../../lib/proc.ts';

export interface FileGitStatusInfo {
  statusMap: Map<string, string>; // relPath -> letter ('?', 'U', 'M', 'A', 'D', 'R', 'C')
  changedCounts: Map<string, number>; // dirRelPath -> count of changed files inside
  deletedFiles: string[]; // relPaths that have git: 'D'
}

interface CacheEntry {
  ts: number;
  info: FileGitStatusInfo;
}

const statusCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 3000; // 3 seconds per project

export function clearGitStatusCache(projectPath?: string): void {
  if (projectPath) {
    statusCache.delete(projectPath.toLowerCase().replace(/\\/g, '/'));
  } else {
    statusCache.clear();
  }
}

export async function getProjectGitStatus(projectPath: string): Promise<FileGitStatusInfo> {
  const cacheKey = projectPath.toLowerCase().replace(/\\/g, '/');
  const now = Date.now();
  const cached = statusCache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.info;
  }

  const statusMap = new Map<string, string>();
  const changedCounts = new Map<string, number>();
  const deletedFiles: string[] = [];

  const res = await runCommand('git', [
    '-C',
    projectPath,
    '-c',
    'core.quotepath=off',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules',
  ]);

  if (res.code === 0 && res.stdout) {
    const rawTokens = res.stdout.split('\0');
    let i = 0;
    while (i < rawTokens.length) {
      const token = rawTokens[i];
      if (!token) {
        i++;
        continue;
      }

      if (token.length >= 4) {
        const x = token[0]!;
        const y = token[1]!;
        const filePath = token.slice(3).replace(/\\/g, '/');

        // Check if conflict
        const xy = x + y;
        let letter = '';
        if (xy === '??') {
          letter = '?';
        } else if (['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'].includes(xy)) {
          letter = 'U';
        } else if (y !== ' ') {
          letter = y;
        } else if (x !== ' ') {
          letter = x;
        }

        statusMap.set(filePath, letter);

        if (letter === 'D') {
          deletedFiles.push(filePath);
        }

        if (letter) {
          // Increment changedCounts for every parent directory
          const parts = filePath.split('/');
          let curDir = '';
          for (let p = 0; p < parts.length - 1; p++) {
            curDir = curDir ? `${curDir}/${parts[p]!}` : parts[p]!;
            const count = changedCounts.get(curDir) ?? 0;
            changedCounts.set(curDir, count + 1);
          }
          // Also root directory
          const rootCount = changedCounts.get('') ?? 0;
          changedCounts.set('', rootCount + 1);
        }

        // If rename, git porcelain -z outputs R  newpath\0oldpath\0
        if (x === 'R' || y === 'R') {
          i++; // skip oldpath
        }
      }
      i++;
    }
  }

  const info: FileGitStatusInfo = {
    statusMap,
    changedCounts,
    deletedFiles,
  };

  statusCache.set(cacheKey, { ts: now, info });
  return info;
}
