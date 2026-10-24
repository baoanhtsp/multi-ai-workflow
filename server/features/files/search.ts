import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { getProjectGitStatus } from './gitStatus.ts';

export interface FileSearchResult {
  path: string;
  name: string;
  type: 'dir' | 'file';
  git: string;
}

export async function searchProjectFiles(options: {
  projectPath: string;
  query: string;
  dotfiles?: boolean;
  limit?: number;
}): Promise<{ [key: string]: unknown; ok: true; results: FileSearchResult[]; truncated: boolean }> {
  const { projectPath } = options;
  const rawQ = String(options.query ?? '').trim();
  if (!rawQ || rawQ.length > 200) {
    throw new ApiValidationError('Query must be between 1 and 200 characters.', 400);
  }

  const showDotfiles = Boolean(options.dotfiles);
  const rawLimit = options.limit ?? 200;
  const limit = Math.max(1, Math.min(500, rawLimit));

  const terms = rawQ.toLowerCase().split(/\s+/).filter(Boolean);

  const realProject = fs.realpathSync.native(projectPath);
  const revParseRes = await runCommand('git', ['-C', realProject, 'rev-parse', '--is-inside-work-tree']);
  const isGit = revParseRes.code === 0 && revParseRes.stdout.trim() === 'true';

  let gitStatus = {
    statusMap: new Map<string, string>(),
    changedCounts: new Map<string, number>(),
    deletedFiles: [] as string[],
  };
  if (isGit) {
    gitStatus = await getProjectGitStatus(realProject);
  }

  interface Candidate {
    path: string;
    name: string;
    type: 'dir' | 'file';
  }

  const candidateMap = new Map<string, Candidate>();

  if (isGit) {
    // git ls-files -co --exclude-standard -z
    const lsRes = await runCommand('git', [
      '-C',
      realProject,
      '-c',
      'core.quotepath=off',
      'ls-files',
      '-co',
      '--exclude-standard',
      '-z',
    ]);
    if (lsRes.code === 0 && lsRes.stdout) {
      const files = lsRes.stdout.split('\0').filter(Boolean);
      for (const f of files) {
        const normPath = f.replace(/\\/g, '/');
        const parts = normPath.split('/');
        if (parts.some((p) => p.toLowerCase() === '.git')) {
          continue;
        }
        const fileName = path.posix.basename(normPath);
        candidateMap.set(normPath, {
          path: normPath,
          name: fileName,
          type: 'file',
        });

        // Derive parent directories
        let cur = '';
        for (let p = 0; p < parts.length - 1; p++) {
          cur = cur ? `${cur}/${parts[p]!}` : parts[p]!;
          if (!candidateMap.has(cur)) {
            candidateMap.set(cur, {
              path: cur,
              name: path.posix.basename(cur),
              type: 'dir',
            });
          }
        }
      }
    }
  } else {
    // Directory walk <= 50000 entries skipping .git and node_modules
    let count = 0;
    const walk = (relDir: string): void => {
      if (count >= 50000) return;
      const targetDir = relDir ? path.win32.join(realProject, relDir.replace(/\//g, '\\')) : realProject;
      let dirents: fs.Dirent[] = [];
      try {
        dirents = fs.readdirSync(targetDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const d of dirents) {
        if (count >= 50000) return;
        const name = d.name;
        const lowerName = name.toLowerCase();
        if (lowerName === '.git' || lowerName === 'node_modules') {
          continue;
        }
        const rel = relDir ? `${relDir}/${name}` : name;
        count++;

        if (d.isDirectory()) {
          candidateMap.set(rel, { path: rel, name, type: 'dir' });
          walk(rel);
        } else {
          candidateMap.set(rel, { path: rel, name, type: 'file' });
        }
      }
    };
    walk('');
  }

  // Filter candidates
  const matching: FileSearchResult[] = [];

  for (const candidate of candidateMap.values()) {
    // Dotfiles filter
    if (!showDotfiles) {
      const parts = candidate.path.split('/');
      if (parts.some((p) => p.startsWith('.'))) {
        continue;
      }
    }

    const normPathLower = candidate.path.toLowerCase();
    const nameLower = candidate.name.toLowerCase();

    // Every term must occur in the path
    const matchesAll = terms.every((t) => normPathLower.includes(t));
    if (!matchesAll) {
      continue;
    }

    const gitLetter = gitStatus.statusMap.get(candidate.path) ?? '';
    matching.push({
      path: candidate.path,
      name: candidate.name,
      type: candidate.type,
      git: gitLetter,
    });
  }

  // Ranking:
  // 1. If name matches all terms -> rank first
  // 2. Shorter path length
  // 3. Alphabetical path
  matching.sort((a, b) => {
    const aNameMatches = terms.every((t) => a.name.toLowerCase().includes(t));
    const bNameMatches = terms.every((t) => b.name.toLowerCase().includes(t));
    if (aNameMatches && !bNameMatches) return -1;
    if (!aNameMatches && bNameMatches) return 1;

    if (a.path.length !== b.path.length) {
      return a.path.length - b.path.length;
    }
    return a.path.localeCompare(b.path);
  });

  const truncated = matching.length > limit;
  const results = matching.slice(0, limit);

  return {
    ok: true,
    results,
    truncated,
  };
}
