import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../../lib/proc.ts';
import { validateSafeRelativePath } from '../review/git.ts';
import { getProjectGitStatus } from './gitStatus.ts';

export interface FileTreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: string;
  git: string;
  changed_inside: number;
  deleted?: boolean;
}

export interface FileTreeResult {
  [key: string]: unknown;
  ok: true;
  dir: string;
  is_git: boolean;
  truncated: boolean;
  entries: FileTreeEntry[];
}

export async function getFilesTree(options: {
  projectPath: string;
  dir?: string;
  dotfiles?: boolean;
}): Promise<FileTreeResult> {
  const { projectPath } = options;
  const showDotfiles = Boolean(options.dotfiles);
  const rawDir = (options.dir ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const relDir = rawDir ? validateSafeRelativePath(projectPath, rawDir) : '';

  const realProject = fs.realpathSync(projectPath);
  const targetDir = relDir ? path.win32.join(realProject, relDir.replace(/\//g, '\\')) : realProject;

  // Check git repo
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

  const rawEntries: FileTreeEntry[] = [];
  const existingNames = new Set<string>();

  if (fs.existsSync(targetDir)) {
    const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const d of dirents) {
      const name = d.name;
      if (name === '.git') {
        continue;
      }
      if (!showDotfiles && name.startsWith('.')) {
        continue;
      }

      const itemRelPath = relDir ? `${relDir}/${name}` : name;
      existingNames.add(name);

      let type: 'dir' | 'file' | 'link' = 'file';
      let size = 0;
      let mtime = '';

      if (d.isSymbolicLink()) {
        type = 'link';
        try {
          const st = fs.lstatSync(path.win32.join(targetDir, name));
          mtime = new Date(st.mtimeMs).toISOString();
        } catch {
          // Ignore stat error
        }
      } else if (d.isDirectory()) {
        type = 'dir';
        try {
          const st = fs.statSync(path.win32.join(targetDir, name));
          mtime = new Date(st.mtimeMs).toISOString();
        } catch {
          // Ignore stat error
        }
      } else {
        type = 'file';
        try {
          const st = fs.statSync(path.win32.join(targetDir, name));
          size = st.size;
          mtime = new Date(st.mtimeMs).toISOString();
        } catch {
          // Ignore stat error
        }
      }

      const gitLetter = gitStatus.statusMap.get(itemRelPath) ?? '';
      const changedInside = type === 'dir' ? (gitStatus.changedCounts.get(itemRelPath) ?? 0) : 0;

      rawEntries.push({
        name,
        path: itemRelPath,
        type,
        size,
        mtime,
        git: gitLetter,
        changed_inside: changedInside,
      });
    }
  }

  // Include tracked files deleted from disk directly inside this directory
  if (isGit) {
    for (const delPath of gitStatus.deletedFiles) {
      const parentDir = path.posix.dirname(delPath);
      const normalizedParent = parentDir === '.' ? '' : parentDir;
      if (normalizedParent.toLowerCase() === relDir.toLowerCase()) {
        const baseName = path.posix.basename(delPath);
        if (!existingNames.has(baseName)) {
          if (!showDotfiles && baseName.startsWith('.')) {
            continue;
          }
          rawEntries.push({
            name: baseName,
            path: delPath,
            type: 'file',
            size: 0,
            mtime: '',
            git: 'D',
            changed_inside: 0,
            deleted: true,
          });
        }
      }
    }
  }

  // Sort: Dirs first, then files; case-insensitive name order
  rawEntries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const MAX_ENTRIES = 2000;
  const truncated = rawEntries.length > MAX_ENTRIES;
  const entries = truncated ? rawEntries.slice(0, MAX_ENTRIES) : rawEntries;

  return {
    ok: true,
    dir: relDir,
    is_git: isGit,
    truncated,
    entries,
  };
}
