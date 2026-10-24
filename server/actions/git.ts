import path from 'node:path';
import { isDirectorySafe, isFileSafe, resolveProjectPath, type ServerPaths } from '../lib/paths.ts';
import { runCommand } from '../lib/proc.ts';
import { ApiValidationError } from '../lib/validate.ts';

export interface GitBranchInfo {
  name: string;
  sha: string;
  is_current: boolean;
  updated: string;
}

export interface GitWorktreeInfo {
  path?: string;
  head?: string;
  branch?: string;
}

export interface GitCommitInfo {
  sha: string;
  subject: string;
  time: string;
  author: string;
}

export interface ProjectGitInfo {
  has_git: boolean;
  current_branch: string | null;
  modified_count: number;
  ahead: number;
  behind: number;
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
  recent_commits: GitCommitInfo[];
}

export async function getProjectGitInfo(projectPath: string): Promise<ProjectGitInfo> {
  const gitMarker = path.win32.join(projectPath, '.git');
  if (!isDirectorySafe(gitMarker) && !isFileSafe(gitMarker)) {
    return {
      has_git: false,
      current_branch: null,
      modified_count: 0,
      ahead: 0,
      behind: 0,
      branches: [],
      worktrees: [],
      recent_commits: [],
    };
  }

  const [branchRes, statusRes, abRes, brRes, wtRes, logRes] = await Promise.all([
    runCommand('git.exe', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeoutMs: 8000,
    }),
    runCommand('git.exe', ['-C', projectPath, 'status', '--porcelain'], { timeoutMs: 8000 }),
    runCommand(
      'git.exe',
      ['-C', projectPath, 'rev-list', '--left-right', '--count', 'HEAD...@{u}'],
      { timeoutMs: 8000 }
    ),
    runCommand(
      'git.exe',
      [
        '-C',
        projectPath,
        'branch',
        '--format=%(refname:short)|%(objectname:short)|%(HEAD)|%(committerdate:relative)',
      ],
      { timeoutMs: 8000 }
    ),
    runCommand('git.exe', ['-C', projectPath, 'worktree', 'list', '--porcelain'], {
      timeoutMs: 8000,
    }),
    runCommand('git.exe', ['-C', projectPath, 'log', '-n', '5', '--pretty=format:%h|%s|%cr|%an'], {
      timeoutMs: 8000,
    }),
  ]);

  const curBranch = branchRes.stdout.trim();
  const statusLines = statusRes.stdout
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');

  let ahead = 0;
  let behind = 0;
  const abMatch = /^(\d+)\s+(\d+)$/.exec(abRes.stdout.trim());
  if (abMatch) {
    ahead = Number.parseInt(abMatch[1]!, 10);
    behind = Number.parseInt(abMatch[2]!, 10);
  }

  const branches: GitBranchInfo[] = [];
  for (const rawLine of brRes.stdout.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/^[\s"]+|[ \t\n\r\0\x0B"]+$/g, '');
    if (!line) continue;
    const parts = line.split('|');
    branches.push({
      name: parts[0] ?? '',
      sha: parts[1] ?? '',
      is_current: (parts[2] ?? '') === '*',
      updated: parts[3] ?? '',
    });
  }

  const worktrees: GitWorktreeInfo[] = [];
  let curWt: GitWorktreeInfo = {};
  for (const rawLine of wtRes.stdout.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (curWt.path) {
        worktrees.push(curWt);
      }
      curWt = {};
      continue;
    }
    if (line.startsWith('worktree ')) {
      curWt.path = line.slice(9);
    } else if (line.startsWith('HEAD ')) {
      curWt.head = line.slice(5, 12);
    } else if (line.startsWith('branch ')) {
      curWt.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'detached') {
      curWt.branch = 'detached';
    }
  }
  if (curWt.path) {
    worktrees.push(curWt);
  }

  const commits: GitCommitInfo[] = [];
  for (const rawLine of logRes.stdout.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/^[\s"]+|[ \t\n\r\0\x0B"]+$/g, '');
    if (!line) continue;
    const parts = line.split('|');
    const sha = parts[0] ?? '';
    const subject = parts.length > 4 ? parts.slice(1, parts.length - 2).join('|') : (parts[1] ?? '');
    const time = parts.length > 4 ? (parts[parts.length - 2] ?? '') : (parts[2] ?? '');
    const author = parts.length > 4 ? (parts[parts.length - 1] ?? '') : (parts[3] ?? '');
    commits.push({ sha, subject, time, author });
  }

  return {
    has_git: true,
    current_branch: curBranch || 'HEAD',
    modified_count: statusLines.length,
    ahead,
    behind,
    branches,
    worktrees,
    recent_commits: commits,
  };
}

export async function handleGitInfo(
  url: URL,
  paths: ServerPaths
): Promise<Record<string, unknown>> {
  const rawPath = (url.searchParams.get('project_path') ?? paths.repoRoot).trim();
  const validPath = resolveProjectPath(rawPath, paths.projectsRoot);
  if (validPath === null) {
    throw new ApiValidationError('Invalid project_path.', 400);
  }
  const gitInfo = await getProjectGitInfo(validPath);
  return {
    ok: true,
    project_path: validPath,
    git_info: gitInfo,
  };
}
