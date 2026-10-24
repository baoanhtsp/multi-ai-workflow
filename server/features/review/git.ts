import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  buildHunkPatch,
  parseUnifiedDiff,
  type DiffFile,
  type ParsedDiffResult,
} from './diff.ts';

export function validateSafeRelativePath(projectPath: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    throw new ApiValidationError('Invalid path.', 400);
  }
  const trimmed = relPath.trim();
  if (!trimmed) {
    throw new ApiValidationError('Invalid path.', 400);
  }
  if (
    path.win32.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed) ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    throw new ApiValidationError('Invalid path.', 400);
  }

  const normalized = trimmed.replace(/\//g, '\\');
  const parts = normalized.split('\\');
  if (parts.includes('..') || parts.includes('.git')) {
    throw new ApiValidationError('Invalid path.', 400);
  }

  let realProject: string;
  try {
    realProject = fs.realpathSync(projectPath);
  } catch {
    throw new ApiValidationError('Invalid project_path.', 400);
  }

  const normBase = realProject.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const targetCandidate = path.win32.resolve(realProject, normalized);

  // Check if file exists, test its realpath
  try {
    const realTarget = fs.realpathSync(targetCandidate);
    const normTarget = realTarget.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if (!normTarget.startsWith(normBase + '\\') && normTarget !== normBase) {
      throw new ApiValidationError('Invalid path.', 400);
    }
  } catch {
    // If file does not exist (e.g. deleted file), check nearest existing ancestor
    let cur = path.win32.dirname(targetCandidate);
    let ancestorFound = false;
    while (cur.length >= realProject.length) {
      try {
        const realCur = fs.realpathSync(cur);
        const normRealCur = realCur.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        if (!normRealCur.startsWith(normBase + '\\') && normRealCur !== normBase) {
          throw new ApiValidationError('Invalid path.', 400);
        }
        ancestorFound = true;
        break;
      } catch {
        const parent = path.win32.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
    if (!ancestorFound) {
      const normCandidate = targetCandidate.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      if (!normCandidate.startsWith(normBase + '\\')) {
        throw new ApiValidationError('Invalid path.', 400);
      }
    }
  }

  return trimmed.replace(/\\/g, '/');
}

export function isValidGitRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9._/@{}^~-]{1,200}$/.test(ref) &&
    !ref.startsWith('-') &&
    !ref.includes('..')
  );
}

export function isValidSha(sha: string): boolean {
  return /^[0-9a-fA-F]{4,40}$/.test(sha);
}

export function isValidJobId(jobId: string): boolean {
  return /^job_\d{8}_\d{6}_[0-9a-f]{6}$/.test(jobId);
}

export async function isGitRepo(projectPath: string): Promise<boolean> {
  const res = await runCommand('git', ['-C', projectPath, 'rev-parse', '--is-inside-work-tree']);
  return res.code === 0 && res.stdout.trim() === 'true';
}

export async function getDefaultBase(projectPath: string): Promise<string> {
  const candidates = ['origin/HEAD', 'main', 'master'];
  for (const cand of candidates) {
    const res = await runCommand('git', ['-C', projectPath, 'rev-parse', '--verify', cand]);
    if (res.code === 0) {
      return cand;
    }
  }
  return '';
}

export async function getReviewSources(
  projectPath: string,
  paths: ServerPaths,
  readJobs: () => Promise<Array<Record<string, unknown>>>
): Promise<Record<string, unknown>> {
  const isGit = await isGitRepo(projectPath);
  if (!isGit) {
    return {
      ok: true,
      is_git: false,
      current_branch: '',
      default_base: '',
      branches: [],
      jobs: [],
      commits: [],
    };
  }

  // 1. Current branch
  const branchRes = await runCommand('git', ['-C', projectPath, 'branch', '--show-current']);
  let currentBranch = branchRes.stdout.trim();
  if (!currentBranch) {
    const headRes = await runCommand('git', ['-C', projectPath, 'rev-parse', '--short', 'HEAD']);
    currentBranch = headRes.code === 0 ? headRes.stdout.trim() : '';
  }

  // 2. Default base
  const defaultBase = await getDefaultBase(projectPath);

  // 3. Worktrees map
  const wtMap = new Map<string, string>();
  const wtRes = await runCommand('git', ['-C', projectPath, 'worktree', 'list', '--porcelain']);
  if (wtRes.code === 0) {
    const blocks = wtRes.stdout.split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const lines = b.split(/\r?\n/);
      let wtPath = '';
      let branchName = '';
      for (const l of lines) {
        if (l.startsWith('worktree ')) {
          wtPath = l.slice(9).trim();
        } else if (l.startsWith('branch refs/heads/')) {
          branchName = l.slice(18).trim();
        }
      }
      if (wtPath && branchName) {
        wtMap.set(branchName, wtPath);
      }
    }
  }

  // 4. Branches
  const branchesListRes = await runCommand('git', [
    '-C',
    projectPath,
    'branch',
    '-a',
    '--format=%(refname:short)',
  ]);
  const branches: Array<{ name: string; worktree_path: string | null; current: boolean }> = [];
  const seenBranches = new Set<string>();

  if (branchesListRes.code === 0) {
    const rawBranches = branchesListRes.stdout
      .split(/\r?\n/)
      .map((b) => b.trim())
      .filter(Boolean);
    for (const b of rawBranches) {
      const clean = b.replace(/^origin\//, '');
      if (seenBranches.has(clean)) continue;
      seenBranches.add(clean);
      branches.push({
        name: clean,
        worktree_path: wtMap.get(clean) ?? null,
        current: clean === currentBranch,
      });
    }
  }

  // 5. Jobs for this project
  const allJobs = await readJobs();
  const normProject = projectPath.toLowerCase().replace(/\\/g, '/');
  const matchingJobs = allJobs.filter((j) => {
    const p = String(j.project_path ?? '').toLowerCase().replace(/\\/g, '/');
    return p === normProject;
  });

  const jobs: Array<{
    job_id: string;
    agent?: string;
    role: string;
    status: string;
    started_at: string;
    has_checkpoint: boolean;
  }> = [];

  for (const j of matchingJobs) {
    const jobId = String(j.job_id ?? '');
    if (!jobId) continue;
    const cpRes = await runCommand('git', [
      '-C',
      projectPath,
      'for-each-ref',
      `refs/maw/checkpoints/${jobId}`,
    ]);
    const hasCheckpoint = cpRes.code === 0 && cpRes.stdout.trim() !== '';
    jobs.push({
      job_id: jobId,
      agent: typeof j.agent === 'string' ? j.agent : undefined,
      role: String(j.role ?? 'backend'),
      status: String(j.status ?? 'UNKNOWN'),
      started_at: String(j.started_at ?? ''),
      has_checkpoint: hasCheckpoint,
    });
  }

  // 6. Commits (last 30)
  const commits: Array<{
    sha: string;
    short: string;
    author: string;
    date: string;
    subject: string;
  }> = [];

  const logRes = await runCommand('git', [
    '-C',
    projectPath,
    'log',
    '-n',
    '30',
    '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s',
  ]);
  if (logRes.code === 0 && logRes.stdout.trim()) {
    const lines = logRes.stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const parts = line.split('\x1f');
      if (parts.length >= 5) {
        commits.push({
          sha: parts[0]!,
          short: parts[1]!,
          author: parts[2]!,
          date: parts[3]!,
          subject: parts[4]!,
        });
      }
    }
  }

  return {
    ok: true,
    is_git: true,
    current_branch: currentBranch,
    default_base: defaultBase,
    branches,
    jobs,
    commits,
  };
}

export interface ReviewDiffParams {
  project_path: string;
  source: 'worktree' | 'branch' | 'job' | 'commit';
  ref?: string;
  base?: string;
  context?: number;
  ignore_ws?: boolean;
  path?: string;
  full?: boolean;
}

export interface ResolvedReviewDiff {
  diffResult: ParsedDiffResult;
  target_path: string | null;
  base: string;
  ref: string;
  beforeRef?: string;
}

export async function runReviewDiff(
  params: ReviewDiffParams,
  paths: ServerPaths,
  readJobs: () => Promise<Array<Record<string, unknown>>>
): Promise<ResolvedReviewDiff> {
  const { project_path, source, ignore_ws, full } = params;
  const ctx = typeof params.context === 'number' && params.context >= 0 && params.context <= 20
    ? params.context
    : 3;
  const filterPath = params.path ? validateSafeRelativePath(project_path, params.path) : '';
  const ref = String(params.ref ?? '').trim();
  let base = String(params.base ?? '').trim();

  let target_path: string | null = null;
  let rawDiff = '';
  let beforeRef: string | undefined;

  if (source === 'worktree') {
    target_path = project_path;
    const hasHeadRes = await runCommand('git', ['-C', project_path, 'rev-parse', '--verify', 'HEAD']);
    const headTarget = hasHeadRes.code === 0 ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

    const diffArgs = [
      '-C',
      project_path,
      '-c',
      'core.quotepath=off',
      'diff',
      '--no-color',
      '--no-ext-diff',
      `-U${ctx}`,
    ];
    if (ignore_ws) diffArgs.push('-w');
    diffArgs.push(headTarget);
    if (filterPath) {
      diffArgs.push('--', filterPath);
    }

    const diffRes = await runCommand('git', diffArgs);
    rawDiff = diffRes.stdout;

    // Untracked files
    const untrackedArgs = [
      '-C',
      project_path,
      '-c',
      'core.quotepath=off',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ];
    if (filterPath) {
      untrackedArgs.push('--', filterPath);
    }
    const untrackedRes = await runCommand('git', untrackedArgs);
    if (untrackedRes.code === 0 && untrackedRes.stdout) {
      const untrackedFiles = untrackedRes.stdout.split('\0').filter(Boolean);
      for (const uFile of untrackedFiles) {
        const uDiffArgs = [
          '-C',
          project_path,
          '-c',
          'core.quotepath=off',
          'diff',
          '--no-color',
          '--no-ext-diff',
          `-U${ctx}`,
        ];
        if (ignore_ws) uDiffArgs.push('-w');
        uDiffArgs.push('--no-index', '--', '/dev/null', uFile);
        const uDiffRes = await runCommand('git', uDiffArgs);
        if (uDiffRes.stdout) {
          rawDiff += (rawDiff ? '\n' : '') + uDiffRes.stdout;
        }
      }
    }
  } else if (source === 'branch') {
    if (!ref || !isValidGitRef(ref)) {
      throw new ApiValidationError('Invalid branch ref.', 400);
    }
    if (!base) {
      base = await getDefaultBase(project_path);
    }
    if (!base || !isValidGitRef(base)) {
      throw new ApiValidationError('Invalid base branch.', 400);
    }

    // Target path: the worktree that has ref checked out
    const wtRes = await runCommand('git', ['-C', project_path, 'worktree', 'list', '--porcelain']);
    if (wtRes.code === 0) {
      const blocks = wtRes.stdout.split(/\r?\n\r?\n/);
      for (const b of blocks) {
        const lines = b.split(/\r?\n/);
        let wtPath = '';
        let bName = '';
        for (const l of lines) {
          if (l.startsWith('worktree ')) wtPath = l.slice(9).trim();
          else if (l.startsWith('branch refs/heads/')) bName = l.slice(18).trim();
        }
        if (wtPath && bName === ref) {
          try {
            target_path = fs.realpathSync(wtPath);
          } catch {
            target_path = wtPath;
          }
          break;
        }
      }
    }

    const diffArgs = [
      '-C',
      project_path,
      '-c',
      'core.quotepath=off',
      'diff',
      '--no-color',
      '--no-ext-diff',
      `-U${ctx}`,
    ];
    if (ignore_ws) diffArgs.push('-w');
    diffArgs.push(`${base}...${ref}`);
    if (filterPath) {
      diffArgs.push('--', filterPath);
    }
    const diffRes = await runCommand('git', diffArgs);
    rawDiff = diffRes.stdout;
  } else if (source === 'job') {
    if (!isValidJobId(ref)) {
      throw new ApiValidationError('Invalid job id.', 400);
    }

    // Lowest-numbered ref under refs/maw/checkpoints/<job_id>/
    const cpRes = await runCommand('git', [
      '-C',
      project_path,
      'for-each-ref',
      '--format=%(refname)',
      `refs/maw/checkpoints/${ref}/`,
    ]);
    if (cpRes.code !== 0 || !cpRes.stdout.trim()) {
      throw new ApiValidationError('No checkpoint for this job.', 404);
    }
    const allRefs = cpRes.stdout.split(/\r?\n/).filter(Boolean);
    const numberedRefs: Array<{ ref: string; num: number }> = [];
    let finishRefExists = false;

    for (const r of allRefs) {
      if (r === `refs/maw/checkpoints/${ref}/finish`) {
        finishRefExists = true;
        continue;
      }
      const m = /\/(\d+)$/.exec(r);
      if (m) {
        numberedRefs.push({ ref: r, num: Number.parseInt(m[1]!, 10) });
      }
    }

    if (numberedRefs.length === 0) {
      throw new ApiValidationError('No checkpoint for this job.', 404);
    }
    numberedRefs.sort((a, b) => a.num - b.num);
    beforeRef = numberedRefs[0]!.ref;

    // Check job working dir from metadata
    const allJobs = await readJobs();
    const jobMeta = allJobs.find((j) => String(j.job_id) === ref);
    const jobWorktree = jobMeta && typeof jobMeta.worktree === 'string' && jobMeta.worktree.trim()
      ? jobMeta.worktree.trim()
      : project_path;

    if (finishRefExists) {
      const diffArgs = [
        '-C',
        project_path,
        '-c',
        'core.quotepath=off',
        'diff',
        '--no-color',
        '--no-ext-diff',
        `-U${ctx}`,
      ];
      if (ignore_ws) diffArgs.push('-w');
      diffArgs.push(beforeRef, `refs/maw/checkpoints/${ref}/finish`);
      if (filterPath) {
        diffArgs.push('--', filterPath);
      }
      const diffRes = await runCommand('git', diffArgs);
      rawDiff = diffRes.stdout;
      target_path = null;
    } else {
      // after is working tree
      target_path = jobWorktree;
      const diffArgs = [
        '-C',
        jobWorktree,
        '-c',
        'core.quotepath=off',
        'diff',
        '--no-color',
        '--no-ext-diff',
        `-U${ctx}`,
      ];
      if (ignore_ws) diffArgs.push('-w');
      diffArgs.push(beforeRef);
      if (filterPath) {
        diffArgs.push('--', filterPath);
      }
      const diffRes = await runCommand('git', diffArgs);
      rawDiff = diffRes.stdout;

      // untracked files not in git ls-tree -r --name-only <before>
      const lsTreeRes = await runCommand('git', [
        '-C',
        jobWorktree,
        'ls-tree',
        '-r',
        '--name-only',
        beforeRef,
      ]);
      const trackedInBefore = new Set(lsTreeRes.stdout.split(/\r?\n/).filter(Boolean));

      const untrackedArgs = [
        '-C',
        jobWorktree,
        '-c',
        'core.quotepath=off',
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ];
      if (filterPath) {
        untrackedArgs.push('--', filterPath);
      }
      const untrackedRes = await runCommand('git', untrackedArgs);
      if (untrackedRes.code === 0 && untrackedRes.stdout) {
        const untrackedFiles = untrackedRes.stdout.split('\0').filter(Boolean);
        for (const uFile of untrackedFiles) {
          if (!trackedInBefore.has(uFile)) {
            const uDiffArgs = [
              '-C',
              jobWorktree,
              '-c',
              'core.quotepath=off',
              'diff',
              '--no-color',
              '--no-ext-diff',
              `-U${ctx}`,
            ];
            if (ignore_ws) uDiffArgs.push('-w');
            uDiffArgs.push('--no-index', '--', '/dev/null', uFile);
            const uDiffRes = await runCommand('git', uDiffArgs);
            if (uDiffRes.stdout) {
              rawDiff += (rawDiff ? '\n' : '') + uDiffRes.stdout;
            }
          }
        }
      }
    }
  } else if (source === 'commit') {
    if (!ref || (!isValidSha(ref) && !isValidGitRef(ref))) {
      throw new ApiValidationError('Invalid commit sha or ref.', 400);
    }
    target_path = project_path;
    const diffArgs = [
      '-C',
      project_path,
      '-c',
      'core.quotepath=off',
      'diff-tree',
      '-p',
      '--root',
      '-m',
      '--first-parent',
      '--no-color',
      `-U${ctx}`,
    ];
    if (ignore_ws) diffArgs.push('-w');
    diffArgs.push(ref);
    if (filterPath) {
      diffArgs.push('--', filterPath);
    }
    const diffRes = await runCommand('git', diffArgs);
    rawDiff = diffRes.stdout;
  } else {
    throw new ApiValidationError(`Invalid source '${source}'.`, 400);
  }

  const diffResult = parseUnifiedDiff(rawDiff, {
    full: Boolean(full),
    targetPath: filterPath,
  });

  return {
    diffResult,
    target_path,
    base,
    ref,
    beforeRef,
  };
}

export async function createSafetySnapshot(
  targetPath: string,
  paths: ServerPaths
): Promise<string> {
  const tmpDir = path.win32.join(paths.featureDataDir('review'), 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const tmpIndex = path.win32.join(
    tmpDir,
    `index_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  );
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const tsFormatted = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const hex = crypto.randomBytes(2).toString('hex');
  const snapshotRef = `refs/maw/checkpoints/review-${tsFormatted}-${hex}/1`;

  const envWithIndex = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
  };

  try {
    const hasHeadRes = await runCommand('git', ['-C', targetPath, 'rev-parse', '--verify', 'HEAD']);
    const hasHead = hasHeadRes.code === 0;

    if (hasHead) {
      await runCommand('git', ['-C', targetPath, 'read-tree', 'HEAD'], { env: envWithIndex });
    }

    await runCommand('git', ['-C', targetPath, 'add', '-A'], { env: envWithIndex });

    const writeTreeRes = await runCommand('git', ['-C', targetPath, 'write-tree'], {
      env: envWithIndex,
    });
    if (writeTreeRes.code !== 0 || !writeTreeRes.stdout.trim()) {
      throw new Error(`write-tree failed: ${writeTreeRes.stderr}`);
    }
    const treeSha = writeTreeRes.stdout.trim();

    const commitTreeArgs = ['-C', targetPath, 'commit-tree', treeSha];
    if (hasHead) {
      commitTreeArgs.push('-p', 'HEAD');
    }
    commitTreeArgs.push('-m', `maw review safety ${now.toISOString()}`);

    const commitTreeRes = await runCommand('git', commitTreeArgs, { env: envWithIndex });
    if (commitTreeRes.code !== 0 || !commitTreeRes.stdout.trim()) {
      throw new Error(`commit-tree failed: ${commitTreeRes.stderr}`);
    }
    const commitSha = commitTreeRes.stdout.trim();

    const updateRefRes = await runCommand('git', [
      '-C',
      targetPath,
      'update-ref',
      snapshotRef,
      commitSha,
    ]);
    if (updateRefRes.code !== 0) {
      throw new Error(`update-ref failed: ${updateRefRes.stderr}`);
    }

    return snapshotRef;
  } finally {
    if (fs.existsSync(tmpIndex)) {
      try {
        fs.unlinkSync(tmpIndex);
      } catch {
        // Ignore unlink error
      }
    }
  }
}

export async function executeRejectHunk(options: {
  targetPath: string;
  file: DiffFile;
  hunkId: string | null;
  snapshotRef: string;
  source: string;
  beforeRef?: string;
  paths: ServerPaths;
}): Promise<void> {
  const { targetPath, file, hunkId, source, beforeRef, paths } = options;

  if (file.binary) {
    if (hunkId !== null) {
      throw new ApiValidationError('Binary files can only be rejected as a whole file.', 400);
    }

    const fullFilePath = path.win32.join(targetPath, file.path.replace(/\//g, '\\'));

    // If file is untracked new binary, delete it
    if (file.status === 'A' && file.untracked) {
      if (fs.existsSync(fullFilePath)) {
        fs.unlinkSync(fullFilePath);
      }
      return;
    }

    // Tracked binary file: checkout before version
    const checkoutRef = source === 'worktree' ? 'HEAD' : (beforeRef ?? 'HEAD');
    const checkoutRes = await runCommand('git', [
      '-C',
      targetPath,
      'checkout',
      checkoutRef,
      '--',
      file.path,
    ]);
    if (checkoutRes.code !== 0) {
      throw new ApiValidationError(`Binary revert failed: ${checkoutRes.stderr}`, 409);
    }
    return;
  }

  // Text file reject
  const patchContent = buildHunkPatch(file, hunkId);
  const tmpDir = path.win32.join(paths.featureDataDir('review'), 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const patchFile = path.win32.join(
    tmpDir,
    `patch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.patch`
  );

  fs.writeFileSync(patchFile, patchContent, 'utf8');

  try {
    // Check if patch applies reverse cleanly
    const checkRes = await runCommand('git', [
      '-C',
      targetPath,
      'apply',
      '--check',
      '-R',
      '--whitespace=nowarn',
      patchFile,
    ]);
    if (checkRes.code !== 0) {
      throw new ApiValidationError('Patch does not apply cleanly.', 409);
    }

    const applyRes = await runCommand('git', [
      '-C',
      targetPath,
      'apply',
      '-R',
      '--whitespace=nowarn',
      patchFile,
    ]);
    if (applyRes.code !== 0) {
      throw new ApiValidationError(`Patch application failed: ${applyRes.stderr}`, 409);
    }
  } finally {
    if (fs.existsSync(patchFile)) {
      try {
        fs.unlinkSync(patchFile);
      } catch {
        // Ignore unlink error
      }
    }
  }
}
