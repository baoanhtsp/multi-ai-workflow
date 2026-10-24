import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendAuditEntry } from '../../lib/audit.ts';
import { getTempDir, isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { runCommand, type RunCommandOptions } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';

export interface CheckpointStats {
  files: number;
  additions: number;
  deletions: number;
  [key: string]: unknown;
}

export interface CheckpointRecord {
  id: string;
  job_key: string;
  n: number;
  commit: string;
  tree: string;
  parent: string | null;
  event: string;
  label: string;
  agent: string;
  role: string;
  round: number | null;
  workdir: string;
  created_at: string;
  head_moved: boolean;
  stats: CheckpointStats | null;
  [key: string]: unknown;
}

export interface DiffFileEntry {
  path: string;
  status: string;
  old_path: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
  [key: string]: unknown;
}

export interface DiffResult {
  ok: true;
  from: string;
  to: string;
  files: DiffFileEntry[];
  patch: string;
  truncated: boolean;
  [key: string]: unknown;
}

export const REF_REGEX = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
export const COMMIT_ID_REGEX = /^[0-9a-f]{7,40}$/;
export const REMOTE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const JOB_ID_REGEX = /^job_[A-Za-z0-9_]{1,80}$/;
export const JOB_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const CHECKPOINT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/\d{4}$/;
export const WORKTREE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function assertNotOption(val: string, label: string): void {
  if (val.startsWith('-')) {
    throw new ApiValidationError(`Invalid ${label}: cannot start with '-' (option injection prevented).`, 400);
  }
}

export function normalizeWorkdir(dir: string): string {
  try {
    return path.win32.normalize(path.resolve(dir)).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return dir.replace(/[\\/]+$/, '').toLowerCase();
  }
}

export async function gitRun(
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  }
): Promise<{ code: number; stdout: string; stderr: string }> {
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new ApiValidationError('Invalid git argument: must be string.', 400);
    }
  }

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...options.env,
  };

  const res = await runCommand('git', args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 30000,
    env: mergedEnv,
  });

  if (res.code !== 0 && !options.allowFailure) {
    const firstStderrLine = res.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    const trimmed = firstStderrLine.slice(0, 400);
    const subCmd = args[0] ?? 'command';
    throw new ApiValidationError(`git ${subCmd} failed: ${trimmed || `exit code ${res.code}`}`, 500);
  }

  return res;
}

export async function resolveGitTopLevel(projectPath: string): Promise<string> {
  const res = await gitRun(['rev-parse', '--show-toplevel'], {
    cwd: projectPath,
    allowFailure: true,
  });
  if (res.code !== 0 || !res.stdout.trim()) {
    throw new ApiValidationError('Not a git repository.', 400);
  }
  let top = res.stdout.trim().replace(/\//g, '\\');
  try {
    top = fs.realpathSync(top);
  } catch {
    // Keep resolved top
  }
  return top;
}

export async function validateRefName(ref: string, cwd: string): Promise<string> {
  const trimmed = String(ref ?? '').trim();
  assertNotOption(trimmed, 'ref');
  if (
    !REF_REGEX.test(trimmed) ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('.lock')
  ) {
    throw new ApiValidationError(`Invalid ref or branch name '${trimmed}'.`, 400);
  }

  const res = await gitRun(['check-ref-format', '--branch', trimmed], {
    cwd,
    allowFailure: true,
  });
  if (res.code !== 0) {
    throw new ApiValidationError(`Invalid ref format for branch '${trimmed}'.`, 400);
  }

  return trimmed;
}

export function validateCommitId(sha: string): string {
  const trimmed = String(sha ?? '').trim();
  assertNotOption(trimmed, 'commit id');
  if (!COMMIT_ID_REGEX.test(trimmed)) {
    throw new ApiValidationError(`Invalid commit id '${trimmed}'.`, 400);
  }
  return trimmed;
}

export function validateRemoteName(remote: string): string {
  const trimmed = String(remote ?? '').trim();
  assertNotOption(trimmed, 'remote name');
  if (!REMOTE_NAME_REGEX.test(trimmed)) {
    throw new ApiValidationError(`Invalid remote name '${trimmed}'.`, 400);
  }
  return trimmed;
}

export function validateJobKey(key: string): string {
  const trimmed = String(key ?? '').trim();
  assertNotOption(trimmed, 'job key');
  if (!JOB_KEY_REGEX.test(trimmed)) {
    throw new ApiValidationError(`Invalid job key '${trimmed}'.`, 400);
  }
  return trimmed;
}

export function validateCheckpointId(id: string): string {
  const trimmed = String(id ?? '').trim();
  assertNotOption(trimmed, 'checkpoint id');
  if (!CHECKPOINT_ID_REGEX.test(trimmed)) {
    throw new ApiValidationError(`Invalid checkpoint id '${trimmed}'.`, 400);
  }
  return trimmed;
}

export function validateWorktreeName(name: string): string {
  const trimmed = String(name ?? '').trim();
  assertNotOption(trimmed, 'worktree name');
  if (!WORKTREE_NAME_REGEX.test(trimmed)) {
    throw new ApiValidationError(`Invalid worktree name '${trimmed}'.`, 400);
  }
  return trimmed;
}

export function validateRelativePath(relPath: string): string {
  const trimmed = String(relPath ?? '').trim();
  assertNotOption(trimmed, 'path');
  if (
    trimmed.includes('..') ||
    path.win32.isAbsolute(trimmed) ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\')
  ) {
    throw new ApiValidationError(`Invalid relative path '${trimmed}'.`, 400);
  }
  return trimmed.replace(/\\/g, '/');
}

/**
 * Creates a standalone git tree capturing the whole working tree without touching HEAD or real index.
 */
export async function snapshotTree(cwd: string): Promise<string> {
  const tempDir = getTempDir();
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpIndex = path.win32.join(tempDir, `maw-cp-${rand}.idx`);

  try {
    const gitPathRes = await gitRun(['rev-parse', '--git-path', 'index'], {
      cwd,
      allowFailure: true,
    });
    if (gitPathRes.code === 0 && gitPathRes.stdout.trim()) {
      let realIdx = gitPathRes.stdout.trim();
      if (!path.win32.isAbsolute(realIdx)) {
        realIdx = path.win32.join(cwd, realIdx);
      }
      if (isFileSafe(realIdx)) {
        try {
          fs.copyFileSync(realIdx, tmpIndex);
        } catch {
          // Continue if copy fails
        }
      }
    }

    await gitRun(['add', '-A', '--', '.'], {
      cwd,
      env: { GIT_INDEX_FILE: tmpIndex },
    });

    const writeRes = await gitRun(['write-tree'], {
      cwd,
      env: { GIT_INDEX_FILE: tmpIndex },
    });

    return writeRes.stdout.trim();
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) {
        fs.unlinkSync(tmpIndex);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

export interface CheckpointCommitMetadata {
  label: string;
  event: string;
  jobKey: string;
  agent: string;
  role: string;
  round: number | null;
  workdir: string;
}

export function parseCheckpointCommitMessage(rawMessage: string): CheckpointCommitMetadata {
  const lines = rawMessage.split(/\r?\n/);
  let label = '';
  let event = 'manual';
  let jobKey = '';
  let agent = '';
  let role = '';
  let round: number | null = null;
  let workdir = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('maw checkpoint:')) {
      label = trimmed.slice('maw checkpoint:'.length).trim();
    } else if (trimmed.startsWith('MAW-Event:')) {
      event = trimmed.slice('MAW-Event:'.length).trim();
    } else if (trimmed.startsWith('MAW-Job:')) {
      jobKey = trimmed.slice('MAW-Job:'.length).trim();
    } else if (trimmed.startsWith('MAW-Agent:')) {
      agent = trimmed.slice('MAW-Agent:'.length).trim();
    } else if (trimmed.startsWith('MAW-Role:')) {
      role = trimmed.slice('MAW-Role:'.length).trim();
    } else if (trimmed.startsWith('MAW-Round:')) {
      const r = trimmed.slice('MAW-Round:'.length).trim();
      if (r && /^\d+$/.test(r)) {
        round = Number.parseInt(r, 10);
      }
    } else if (trimmed.startsWith('MAW-Workdir:')) {
      workdir = trimmed.slice('MAW-Workdir:'.length).trim();
    }
  }

  return {
    label,
    event,
    jobKey,
    agent,
    role,
    round,
    workdir,
  };
}

export function formatCheckpointCommitMessage(meta: CheckpointCommitMetadata): string {
  const roundStr = meta.round !== null && meta.round !== undefined ? String(meta.round) : '';
  return [
    `maw checkpoint: ${meta.label}`,
    '',
    `MAW-Event: ${meta.event}`,
    `MAW-Job: ${meta.jobKey}`,
    `MAW-Agent: ${meta.agent}`,
    `MAW-Role: ${meta.role}`,
    `MAW-Round: ${roundStr}`,
    `MAW-Workdir: ${meta.workdir}`,
  ].join('\n');
}

export async function createCheckpoint(
  cwd: string,
  options: {
    jobKey: string;
    event?: string;
    label?: string;
    agent?: string;
    role?: string;
    round?: number | null;
    retention?: number;
    configRetention?: number;
  }
): Promise<{ ok: true; checkpoint: CheckpointRecord; created: boolean }> {
  await resolveGitTopLevel(cwd);

  const jobKey = validateJobKey(options.jobKey);
  const event = options.event ?? 'manual';
  const label = options.label ?? `checkpoint for ${jobKey}`;
  const agent = options.agent ?? '';
  const role = options.role ?? '';
  const round = options.round ?? null;
  const normCwd = normalizeWorkdir(cwd);

  const currentHeadRes = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], {
    cwd,
    allowFailure: true,
  });
  const currentHead = currentHeadRes.code === 0 ? currentHeadRes.stdout.trim() : null;

  const tree = await snapshotTree(cwd);

  const refPrefix = `refs/maw/checkpoints/${jobKey}/`;
  const listRefsRes = await gitRun(
    ['for-each-ref', '--format=%(refname)', refPrefix],
    { cwd, allowFailure: true }
  );

  let maxN = 0;
  let newestRef: string | null = null;
  if (listRefsRes.code === 0 && listRefsRes.stdout.trim()) {
    const lines = listRefsRes.stdout.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const r of lines) {
      const match = r.match(/\/(\d{4})$/);
      if (match) {
        const num = Number.parseInt(match[1]!, 10);
        if (num > maxN) {
          maxN = num;
          newestRef = r;
        }
      }
    }
  }

  // Dedup: if newest checkpoint of the same job key has the same tree, return it without creating
  if (newestRef) {
    const treeRes = await gitRun(['rev-parse', `${newestRef}^{tree}`], {
      cwd,
      allowFailure: true,
    });
    if (treeRes.code === 0 && treeRes.stdout.trim() === tree) {
      const commitRes = await gitRun(['rev-parse', newestRef], { cwd, allowFailure: true });
      const commitSha = commitRes.code === 0 ? commitRes.stdout.trim() : '';
      const existingId = `${jobKey}/${String(maxN).padStart(4, '0')}`;
      const msgRes = await gitRun(['log', '-1', '--format=%B', newestRef], { cwd, allowFailure: true });
      const meta = parseCheckpointCommitMessage(msgRes.stdout);

      const parentRes = await gitRun(['rev-parse', '--verify', '-q', `${commitSha}^@`], {
        cwd,
        allowFailure: true,
      });
      const parent = parentRes.code === 0 && parentRes.stdout.trim() ? parentRes.stdout.trim().split(/\s+/)[0]! : null;

      const dateRes = await gitRun(['log', '-1', '--format=%aI', newestRef], { cwd, allowFailure: true });
      const createdAt = dateRes.code === 0 && dateRes.stdout.trim() ? dateRes.stdout.trim() : new Date().toISOString();

      const existingRecord: CheckpointRecord = {
        id: existingId,
        job_key: jobKey,
        n: maxN,
        commit: commitSha,
        tree,
        parent,
        event: meta.event || event,
        label: meta.label || label,
        agent: meta.agent || agent,
        role: meta.role || role,
        round: meta.round ?? round,
        workdir: meta.workdir || normCwd,
        created_at: createdAt,
        head_moved: parent !== currentHead,
        stats: null,
      };

      return {
        ok: true,
        checkpoint: existingRecord,
        created: false,
      };
    }
  }

  const nextN = maxN + 1;
  const nStr = String(nextN).padStart(4, '0');
  const newRef = `${refPrefix}${nStr}`;
  const newId = `${jobKey}/${nStr}`;

  const metaContent = formatCheckpointCommitMessage({
    label,
    event,
    jobKey,
    agent,
    role,
    round,
    workdir: normCwd,
  });

  const tempDir = getTempDir();
  const msgFile = path.win32.join(tempDir, `maw-msg-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(msgFile, metaContent, 'utf8');

  let commitSha = '';
  try {
    const nowIso = new Date().toISOString();
    const commitArgs: string[] = ['commit-tree', tree];
    if (currentHead) {
      commitArgs.push('-p', currentHead);
    }
    commitArgs.push('-F', msgFile);

    const commitRes = await gitRun(commitArgs, {
      cwd,
      env: {
        GIT_AUTHOR_NAME: 'MAW Checkpoint',
        GIT_AUTHOR_EMAIL: 'maw@localhost',
        GIT_COMMITTER_NAME: 'MAW Checkpoint',
        GIT_COMMITTER_EMAIL: 'maw@localhost',
        GIT_AUTHOR_DATE: nowIso,
        GIT_COMMITTER_DATE: nowIso,
      },
    });

    commitSha = commitRes.stdout.trim();
  } finally {
    try {
      if (fs.existsSync(msgFile)) {
        fs.unlinkSync(msgFile);
      }
    } catch {
      // Ignore msgFile cleanup error
    }
  }

  await gitRun(['update-ref', newRef, commitSha], { cwd });

  // Retention pruning for this workdir
  const retention = Math.min(
    500,
    Math.max(5, options.retention ?? options.configRetention ?? 50)
  );

  await pruneCheckpoints(cwd, normCwd, retention);

  const createdAt = new Date().toISOString();
  const checkpointRecord: CheckpointRecord = {
    id: newId,
    job_key: jobKey,
    n: nextN,
    commit: commitSha,
    tree,
    parent: currentHead,
    event,
    label,
    agent,
    role,
    round,
    workdir: normCwd,
    created_at: createdAt,
    head_moved: false,
    stats: null,
  };

  return {
    ok: true,
    checkpoint: checkpointRecord,
    created: true,
  };
}

export async function pruneCheckpoints(
  cwd: string,
  normalizedWorkdir: string,
  retention: number
): Promise<number> {
  const listRes = await gitRun(
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(authordate:iso-strict)%00%(contents)%00@@MAW_END@@%0a',
      'refs/maw/checkpoints/',
    ],
    { cwd, allowFailure: true }
  );

  if (listRes.code !== 0 || !listRes.stdout.trim()) {
    return 0;
  }

  const entries: Array<{ ref: string; commit: string; date: string; workdir: string }> = [];
  const rawEntries = listRes.stdout.split('\0@@MAW_END@@\n').map((s) => s.replace(/^\n+/, ''));
  for (const raw of rawEntries) {
    if (!raw.trim()) continue;
    const parts = raw.split('\0');
    if (parts.length < 4) continue;
    const ref = parts[0]!.trim();
    const commit = parts[1]!.trim();
    const date = parts[2]!.trim();
    const contents = parts.slice(3).join('\0');
    const meta = parseCheckpointCommitMessage(contents);
    const itemWorkdir = normalizeWorkdir(meta.workdir);
    if (itemWorkdir === normalizedWorkdir) {
      entries.push({ ref, commit, date, workdir: itemWorkdir });
    }
  }

  // Sort newest first by date/ref
  entries.sort((a, b) => b.date.localeCompare(a.date));

  let deletedCount = 0;
  if (entries.length > retention) {
    const toDelete = entries.slice(retention);
    for (const item of toDelete) {
      await gitRun(['update-ref', '-d', item.ref], { cwd, allowFailure: true });
      deletedCount++;
    }
  }

  return deletedCount;
}

export async function listCheckpoints(
  cwd: string,
  options?: {
    jobId?: string;
    limit?: number;
    retention?: number;
  }
): Promise<{ head: string | null; checkpoints: CheckpointRecord[] }> {
  await resolveGitTopLevel(cwd);

  const normCwd = normalizeWorkdir(cwd);
  const headRes = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], {
    cwd,
    allowFailure: true,
  });
  const currentHead = headRes.code === 0 ? headRes.stdout.trim() : null;

  const jobFilter = options?.jobId ? options.jobId.trim() : '';
  const refPattern = jobFilter
    ? `refs/maw/checkpoints/${jobFilter}/`
    : 'refs/maw/checkpoints/';

  const listRes = await gitRun(
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(tree)%00%(parent)%00%(authordate:iso-strict)%00%(contents)%00@@MAW_END@@%0a',
      refPattern,
    ],
    { cwd, allowFailure: true }
  );

  if (listRes.code !== 0 || !listRes.stdout.trim()) {
    return { head: currentHead, checkpoints: [] };
  }

  const rawEntries = listRes.stdout.split('\0@@MAW_END@@\n').map((s) => s.replace(/^\n+/, ''));
  const matchedRecords: Array<{
    id: string;
    job_key: string;
    n: number;
    commit: string;
    tree: string;
    parent: string | null;
    event: string;
    label: string;
    agent: string;
    role: string;
    round: number | null;
    workdir: string;
    created_at: string;
    head_moved: boolean;
  }> = [];

  for (const raw of rawEntries) {
    if (!raw.trim()) continue;
    const parts = raw.split('\0');
    if (parts.length < 6) {
      continue;
    }
    const ref = parts[0]!.trim();
    const commit = parts[1]!.trim();
    const tree = parts[2]!.trim();
    const rawParent = parts[3]!.trim();
    const parent = rawParent ? rawParent.split(/\s+/)[0]! : null;
    const date = parts[4]!.trim();
    const contents = parts.slice(5).join('\0');

    const match = ref.match(/^refs\/maw\/checkpoints\/([^\/]+)\/(\d{4})$/);
    if (!match) {
      continue;
    }
    const itemJobKey = match[1]!;
    const itemN = Number.parseInt(match[2]!, 10);
    const id = `${itemJobKey}/${match[2]!}`;

    const meta = parseCheckpointCommitMessage(contents);
    const itemWorkdir = normalizeWorkdir(meta.workdir);
    if (itemWorkdir !== normCwd) {
      continue;
    }

    matchedRecords.push({
      id,
      job_key: itemJobKey,
      n: itemN,
      commit,
      tree,
      parent,
      event: meta.event,
      label: meta.label,
      agent: meta.agent,
      role: meta.role,
      round: meta.round,
      workdir: itemWorkdir,
      created_at: date,
      head_moved: parent !== currentHead,
    });
  }

  // Sort chronological ascending first to compute diff stats vs older checkpoint of same workdir
  matchedRecords.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const resultWithStats: CheckpointRecord[] = [];
  for (let i = 0; i < matchedRecords.length; i++) {
    const cur = matchedRecords[i]!;
    let stats: CheckpointStats | null = null;

    if (i > 0) {
      const prev = matchedRecords[i - 1]!;
      const diffStatRes = await gitRun(
        ['diff', '--numstat', prev.commit, cur.commit],
        { cwd, allowFailure: true }
      );
      if (diffStatRes.code === 0) {
        let files = 0;
        let adds = 0;
        let dels = 0;
        for (const line of diffStatRes.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [a, d] = trimmed.split(/\s+/);
          files++;
          if (a && a !== '-') adds += Number.parseInt(a, 10) || 0;
          if (d && d !== '-') dels += Number.parseInt(d, 10) || 0;
        }
        stats = { files, additions: adds, deletions: dels };
      }
    }

    resultWithStats.push({
      ...cur,
      stats,
    });
  }

  // Return newest first
  resultWithStats.reverse();

  const maxLimit = Math.min(500, Math.max(1, options?.limit ?? 200));
  return {
    head: currentHead,
    checkpoints: resultWithStats.slice(0, maxLimit),
  };
}

export async function diffTrees(
  cwd: string,
  from: string,
  to: string,
  subPath?: string
): Promise<DiffResult> {
  await resolveGitTopLevel(cwd);

  let fromTarget = from.trim();
  let toTarget = to.trim();

  if (CHECKPOINT_ID_REGEX.test(fromTarget)) {
    fromTarget = `refs/maw/checkpoints/${fromTarget}`;
  }

  let toIsWorktree = false;
  let worktreeTree: string | null = null;
  if (toTarget === 'WORKTREE' || toTarget === '') {
    toIsWorktree = true;
    worktreeTree = await snapshotTree(cwd);
    toTarget = worktreeTree;
  } else if (CHECKPOINT_ID_REGEX.test(toTarget)) {
    toTarget = `refs/maw/checkpoints/${toTarget}`;
  }

  const rawArgs = ['diff', '--raw', '-M', fromTarget, toTarget];
  const numstatArgs = ['diff', '--numstat', '-M', fromTarget, toTarget];
  const patchArgs = ['diff', fromTarget, toTarget];

  if (subPath) {
    const validPath = validateRelativePath(subPath);
    rawArgs.push('--', validPath);
    numstatArgs.push('--', validPath);
    patchArgs.push('--', validPath);
  }

  const rawRes = await gitRun(rawArgs, { cwd });
  const numstatRes = await gitRun(numstatArgs, { cwd });
  const patchRes = await gitRun(patchArgs, { cwd });

  const numstatMap = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of numstatRes.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length >= 3) {
      const a = parts[0]!;
      const d = parts[1]!;
      const filePath = parts[2]!;
      const isBin = a === '-' || d === '-';
      numstatMap.set(filePath, {
        additions: isBin ? 0 : Number.parseInt(a, 10) || 0,
        deletions: isBin ? 0 : Number.parseInt(d, 10) || 0,
        binary: isBin,
      });
    }
  }

  const files: DiffFileEntry[] = [];
  for (const line of rawRes.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(':')) continue;
    const parts = trimmed.split('\t');
    if (parts.length >= 2) {
      const metaPart = parts[0]!.slice(1).split(/\s+/);
      const statusRaw = metaPart[4] ?? 'M';
      const statusCode = statusRaw[0] ?? 'M';
      const targetPath = parts[1]!;
      const oldPath = parts.length >= 3 ? targetPath : null;
      const actualPath = parts.length >= 3 ? parts[2]! : targetPath;

      const num = numstatMap.get(actualPath) ?? { additions: 0, deletions: 0, binary: false };
      files.push({
        path: actualPath,
        status: statusCode,
        old_path: oldPath,
        additions: num.additions,
        deletions: num.deletions,
        binary: num.binary,
      });
      if (files.length >= 2000) {
        break;
      }
    }
  }

  const MAX_PATCH_BYTES = 512 * 1024;
  let patch = patchRes.stdout;
  let truncated = false;
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    const buf = Buffer.from(patch, 'utf8').subarray(0, MAX_PATCH_BYTES);
    patch = buf.toString('utf8');
    truncated = true;
  }

  return {
    ok: true,
    from,
    to: toIsWorktree ? 'WORKTREE' : to,
    files,
    patch,
    truncated,
  };
}

export async function restoreTree(
  cwd: string,
  checkpointId: string,
  options: {
    confirm: boolean;
    auditFile: string;
    checkpointsAuditFile: string;
  }
): Promise<{
  ok: true;
  restored: string;
  safety_checkpoint: string;
  files_written: number;
  files_deleted: number;
  head_moved: boolean;
}> {
  if (options.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  await resolveGitTopLevel(cwd);
  const validatedId = validateCheckpointId(checkpointId);
  const targetRef = `refs/maw/checkpoints/${validatedId}`;

  const targetRes = await gitRun(['rev-parse', '--verify', targetRef], { cwd, allowFailure: true });
  if (targetRes.code !== 0) {
    throw new ApiValidationError(`Checkpoint '${validatedId}' not found.`, 404);
  }
  const targetCommit = targetRes.stdout.trim();

  // Safety checkpoint first so restore can be undone
  const safetyRes = await createCheckpoint(cwd, {
    jobKey: 'safety',
    event: 'safety',
    label: `before restore to ${validatedId}`,
  });
  const safetyCheckpointId = safetyRes.checkpoint.id;

  const currentTree = await snapshotTree(cwd);
  const targetTreeRes = await gitRun(['rev-parse', `${targetCommit}^{tree}`], { cwd });
  const targetTree = targetTreeRes.stdout.trim();

  // Audit entry for destructive action
  const auditEntry = {
    Timestamp: new Date().toISOString(),
    Tool: 'maw-s1',
    Action: 'checkpoint_restore',
    Project: cwd,
    Detail: `Restored checkpoint ${validatedId} (safety: ${safetyCheckpointId})`,
  };
  appendAuditEntry(options.auditFile, auditEntry);
  appendAuditEntry(options.checkpointsAuditFile, auditEntry);

  const tempDir = getTempDir();
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpIndex = path.win32.join(tempDir, `maw-restore-${rand}.idx`);

  let filesWritten = 0;
  let filesDeleted = 0;

  try {
    await gitRun(['read-tree', targetTree], {
      cwd,
      env: { GIT_INDEX_FILE: tmpIndex },
    });

    await gitRun(['checkout-index', '-a', '-f'], {
      cwd,
      env: { GIT_INDEX_FILE: tmpIndex },
    });

    // Count files in target tree
    const lsTargetRes = await gitRun(['ls-tree', '-r', '--name-only', targetTree], {
      cwd,
      allowFailure: true,
    });
    if (lsTargetRes.code === 0 && lsTargetRes.stdout.trim()) {
      filesWritten = lsTargetRes.stdout.trim().split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    }

    // Delete files that exist in current but not in target
    // diff-tree -r --name-only --diff-filter=A <target> <current> gives files present in current but absent in target
    const addedFilesRes = await gitRun(
      ['diff-tree', '-r', '--name-only', '--diff-filter=A', targetTree, currentTree],
      { cwd, allowFailure: true }
    );

    if (addedFilesRes.code === 0 && addedFilesRes.stdout.trim()) {
      const addedList = addedFilesRes.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      for (const rel of addedList) {
        const full = path.win32.join(cwd, rel);
        if (isFileSafe(full)) {
          try {
            fs.unlinkSync(full);
            filesDeleted++;
          } catch {
            // Ignore file unlink failure
          }
          // Remove empty parent directories up to cwd
          let dir = path.dirname(full);
          while (dir.toLowerCase() !== cwd.toLowerCase() && isDirectorySafe(dir)) {
            try {
              fs.rmdirSync(dir);
              dir = path.dirname(dir);
            } catch {
              break;
            }
          }
        }
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) {
        fs.unlinkSync(tmpIndex);
      }
    } catch {
      // Ignore tmpIndex cleanup error
    }
  }

  const checkpointMetaRes = await gitRun(['log', '-1', '--format=%B', targetRef], { cwd, allowFailure: true });
  const targetParentRes = await gitRun(['rev-parse', '--verify', '-q', `${targetCommit}^@`], {
    cwd,
    allowFailure: true,
  });
  const targetParent = targetParentRes.code === 0 && targetParentRes.stdout.trim() ? targetParentRes.stdout.trim().split(/\s+/)[0]! : null;

  const currentHeadRes = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, allowFailure: true });
  const currentHead = currentHeadRes.code === 0 ? currentHeadRes.stdout.trim() : null;

  return {
    ok: true,
    restored: validatedId,
    safety_checkpoint: safetyCheckpointId,
    files_written: filesWritten,
    files_deleted: filesDeleted,
    head_moved: targetParent !== currentHead,
  };
}
