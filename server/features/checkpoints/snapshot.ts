import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendAuditEntry } from '../../lib/audit.ts';
import { getTempDir, isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { runCommand, type RunCommandOptions, type RunCommandResult } from '../../lib/proc.ts';
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
  created_at_unix: number;
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
export const FULL_HEX_SHA_REGEX = /^[0-9a-f]{40}$/;
export const REMOTE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const JOB_ID_REGEX = /^job_[A-Za-z0-9_]{1,80}$/;
export const JOB_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const CHECKPOINT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/\d{4}$/;
export const WORKTREE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,47}$/;

// C9: Module-level stats cache (prevSha..curSha => CheckpointStats), capped at 5000 entries
const statsCache = new Map<string, CheckpointStats>();

function getCachedStats(prevCommit: string, curCommit: string): CheckpointStats | undefined {
  return statsCache.get(`${prevCommit}..${curCommit}`);
}

function setCachedStats(prevCommit: string, curCommit: string, stats: CheckpointStats): void {
  if (statsCache.size >= 5000) {
    const keys = Array.from(statsCache.keys()).slice(0, 1000);
    for (const k of keys) {
      statsCache.delete(k);
    }
  }
  statsCache.set(`${prevCommit}..${curCommit}`, stats);
}

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

export function gitRunWithStdin(
  args: readonly string[],
  stdinData: Buffer | string,
  options: {
    cwd: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const safeResolve = (res: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(res);
    };

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      ...options.env,
    };

    let child: ChildProcess;
    try {
      child = spawn('git', [...args], {
        cwd: options.cwd,
        env: mergedEnv,
        shell: false,
        windowsHide: true,
      });
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      safeResolve({
        code: 127,
        stdout: '',
        stderr: `Failed to spawn git: ${msg}`,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.on('error', (err) => {
      safeResolve({
        code: 127,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: (Buffer.concat(stderrChunks).toString('utf8') + `\n${err.message}`).trim(),
      });
    });

    if (child.stdin) {
      child.stdin.on('error', (err) => {
        // EPIPE or write failure: guard against unhandled error crash
        stderrChunks.push(Buffer.from(`\nstdin error: ${err.message}`));
      });
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      safeResolve({
        code: 124,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: (Buffer.concat(stderrChunks).toString('utf8') + '\nTimed out').trim(),
      });
    }, options.timeoutMs ?? 30000);

    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

    child.on('close', (code) => {
      safeResolve({
        code: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(stdinData);
        child.stdin.end();
      }
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      stderrChunks.push(Buffer.from(`\nstdin write error: ${msg}`));
    }
  });
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
 * C6: Always operates at repository top-level.
 */
export async function snapshotTree(cwd: string): Promise<string> {
  const top = await resolveGitTopLevel(cwd);
  const tempDir = getTempDir();
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpIndex = path.win32.join(tempDir, `maw-cp-${rand}.idx`);

  try {
    const gitPathRes = await gitRun(['rev-parse', '--git-path', 'index'], {
      cwd: top,
      allowFailure: true,
    });
    if (gitPathRes.code === 0 && gitPathRes.stdout.trim()) {
      let realIdx = gitPathRes.stdout.trim();
      if (!path.win32.isAbsolute(realIdx)) {
        realIdx = path.win32.join(top, realIdx);
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
      cwd: top,
      env: { GIT_INDEX_FILE: tmpIndex },
    });

    const writeRes = await gitRun(['write-tree'], {
      cwd: top,
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
  // C7: Sanitize label, agent, role to prevent trailer forgery
  const cleanLabel = meta.label.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const cleanAgent = /^[a-z0-9-]{0,32}$/.test(meta.agent) ? meta.agent : '';
  const cleanRole = /^[a-z0-9-]{0,32}$/.test(meta.role) ? meta.role : '';
  const roundStr = meta.round !== null && meta.round !== undefined ? String(meta.round) : '';

  return [
    `maw checkpoint: ${cleanLabel}`,
    '',
    `MAW-Event: ${meta.event}`,
    `MAW-Job: ${meta.jobKey}`,
    `MAW-Agent: ${cleanAgent}`,
    `MAW-Role: ${cleanRole}`,
    `MAW-Round: ${roundStr}`,
    `MAW-Workdir: ${meta.workdir}`,
  ].join('\n');
}

/**
 * C1 & W10: Single unified diff parser for snapshots, worktrees, and git actions.
 * Dropping -M eliminates "old => new" rename ambiguities.
 */
export async function diffRevisions(
  cwd: string,
  fromRev: string,
  toRev: string,
  options?: {
    cached?: boolean;
    subPath?: string;
  }
): Promise<DiffResult> {
  assertNotOption(fromRev, 'from');
  assertNotOption(toRev, 'to');

  const rawArgs = ['diff', '--raw'];
  const numstatArgs = ['diff', '--numstat'];
  const patchArgs = ['diff'];

  if (options?.cached) {
    rawArgs.push('--cached');
    numstatArgs.push('--cached');
    patchArgs.push('--cached');
  }

  if (fromRev) {
    rawArgs.push(fromRev);
    numstatArgs.push(fromRev);
    patchArgs.push(fromRev);
  }

  if (toRev && toRev !== 'WORKTREE') {
    rawArgs.push(toRev);
    numstatArgs.push(toRev);
    patchArgs.push(toRev);
  }

  if (options?.subPath) {
    const validSubPath = validateRelativePath(options.subPath);
    rawArgs.push('--', validSubPath);
    numstatArgs.push('--', validSubPath);
    patchArgs.push('--', validSubPath);
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
      if (files.length >= 2000) break;
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
    from: fromRev,
    to: toRev,
    files,
    patch,
    truncated,
  };
}

/**
 * C1 Security: Validates from and to revisions in diffTrees.
 * Rejects options like --output=... with 400.
 */
export async function diffTrees(
  cwd: string,
  from: string,
  to: string,
  subPath?: string
): Promise<DiffResult> {
  const top = await resolveGitTopLevel(cwd);

  const fromRaw = String(from ?? '').trim();
  assertNotOption(fromRaw, 'from');

  let fromTarget: string;
  if (CHECKPOINT_ID_REGEX.test(fromRaw)) {
    fromTarget = `refs/maw/checkpoints/${fromRaw}`;
  } else if (FULL_HEX_SHA_REGEX.test(fromRaw)) {
    fromTarget = fromRaw;
  } else {
    throw new ApiValidationError(
      `Invalid 'from' revision '${fromRaw}'. Must be a checkpoint id or 40-hex sha.`,
      400
    );
  }

  const toRaw = String(to ?? 'WORKTREE').trim() || 'WORKTREE';
  assertNotOption(toRaw, 'to');

  let toTarget: string;
  let toIsWorktree = false;

  if (toRaw === 'WORKTREE') {
    toIsWorktree = true;
    toTarget = await snapshotTree(top);
  } else if (CHECKPOINT_ID_REGEX.test(toRaw)) {
    toTarget = `refs/maw/checkpoints/${toRaw}`;
  } else if (FULL_HEX_SHA_REGEX.test(toRaw)) {
    toTarget = toRaw;
  } else {
    throw new ApiValidationError(
      `Invalid 'to' revision '${toRaw}'. Must be 'WORKTREE', a checkpoint id, or 40-hex sha.`,
      400
    );
  }

  const res = await diffRevisions(top, fromTarget, toTarget, { subPath });
  return {
    ...res,
    from,
    to: toIsWorktree ? 'WORKTREE' : to,
  };
}

/**
 * C3: Concurrency-safe createCheckpoint using expected old sha of 40 zeros.
 */
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
  // C6: Work at repo top level
  const top = await resolveGitTopLevel(cwd);

  const jobKey = validateJobKey(options.jobKey);
  const event = options.event ?? 'manual';
  const label = options.label ?? `checkpoint for ${jobKey}`;
  const agent = options.agent ?? '';
  const role = options.role ?? '';
  const round = options.round ?? null;
  const normTop = normalizeWorkdir(top);

  const currentHeadRes = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], {
    cwd: top,
    allowFailure: true,
  });
  const currentHead = currentHeadRes.code === 0 ? currentHeadRes.stdout.trim() : null;

  const tree = await snapshotTree(top);

  const refPrefix = `refs/maw/checkpoints/${jobKey}/`;

  // Dedup: check if the latest checkpoint of this jobKey already has the same tree
  const listRefsRes = await gitRun(
    ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(creatordate:unix)', refPrefix],
    { cwd: top, allowFailure: true }
  );

  let maxN = 0;
  let newestRef: string | null = null;
  if (listRefsRes.code === 0 && listRefsRes.stdout.trim()) {
    const lines = listRefsRes.stdout.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const parts = line.split('\0');
      const r = parts[0]!.trim();
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

  if (newestRef) {
    const treeRes = await gitRun(['rev-parse', `${newestRef}^{tree}`], {
      cwd: top,
      allowFailure: true,
    });
    if (treeRes.code === 0 && treeRes.stdout.trim() === tree) {
      const commitRes = await gitRun(['rev-parse', newestRef], { cwd: top, allowFailure: true });
      const commitSha = commitRes.code === 0 ? commitRes.stdout.trim() : '';
      const existingId = `${jobKey}/${String(maxN).padStart(4, '0')}`;
      const msgRes = await gitRun(['log', '-1', '--format=%B', newestRef], { cwd: top, allowFailure: true });
      const meta = parseCheckpointCommitMessage(msgRes.stdout);

      const parentRes = await gitRun(['rev-parse', '--verify', '-q', `${commitSha}^@`], {
        cwd: top,
        allowFailure: true,
      });
      const parent = parentRes.code === 0 && parentRes.stdout.trim() ? parentRes.stdout.trim().split(/\s+/)[0]! : null;

      const dateRes = await gitRun(['log', '-1', '--format=%ct', newestRef], { cwd: top, allowFailure: true });
      const unixSec = dateRes.code === 0 && dateRes.stdout.trim() ? Number.parseInt(dateRes.stdout.trim(), 10) : Math.floor(Date.now() / 1000);
      const createdAt = new Date(unixSec * 1000).toISOString();

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
        workdir: meta.workdir || normTop,
        created_at: createdAt,
        created_at_unix: unixSec,
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

  const metaContent = formatCheckpointCommitMessage({
    label,
    event,
    jobKey,
    agent,
    role,
    round,
    workdir: normTop,
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
      cwd: top,
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
    } catch {}
  }

  // C3: Race guard on update-ref: expected old value of 40 zeros ensures ref must not exist yet!
  const ZERO_SHA = '0000000000000000000000000000000000000000';
  let createdN = 0;
  let createdRef = '';
  let updatedSuccessfully = false;

  for (let attempt = 0; attempt < 5; attempt++) {
    // Re-check highest N in case of parallel writers
    const checkRefsRes = await gitRun(
      ['for-each-ref', '--format=%(refname)', refPrefix],
      { cwd: top, allowFailure: true }
    );
    let curMax = 0;
    if (checkRefsRes.code === 0 && checkRefsRes.stdout.trim()) {
      for (const line of checkRefsRes.stdout.split(/\r?\n/)) {
        const match = line.trim().match(/\/(\d{4})$/);
        if (match) {
          const num = Number.parseInt(match[1]!, 10);
          if (num > curMax) curMax = num;
        }
      }
    }

    createdN = curMax + 1;
    const nStr = String(createdN).padStart(4, '0');
    createdRef = `${refPrefix}${nStr}`;

    const upRes = await gitRun(
      ['update-ref', createdRef, commitSha, ZERO_SHA],
      { cwd: top, allowFailure: true }
    );
    if (upRes.code === 0) {
      updatedSuccessfully = true;
      break;
    }
  }

  if (!updatedSuccessfully) {
    throw new ApiValidationError(
      `Failed to create checkpoint after 5 attempts due to concurrent updates on ${jobKey}.`,
      500
    );
  }

  const retention = Math.min(
    500,
    Math.max(5, options.retention ?? options.configRetention ?? 50)
  );
  await pruneCheckpoints(top, normTop, retention, createdRef);

  const unixNow = Math.floor(Date.now() / 1000);
  const checkpointRecord: CheckpointRecord = {
    id: `${jobKey}/${String(createdN).padStart(4, '0')}`,
    job_key: jobKey,
    n: createdN,
    commit: commitSha,
    tree,
    parent: currentHead,
    event,
    label,
    agent,
    role,
    round,
    workdir: normTop,
    created_at: new Date().toISOString(),
    created_at_unix: unixNow,
    head_moved: false,
    stats: null,
  };

  return {
    ok: true,
    checkpoint: checkpointRecord,
    created: true,
  };
}

/**
 * C2, Y2: Prunes checkpoints using creatordate:unix integer comparison.
 * Never deletes excludeRef (the newly created ref).
 */
export async function pruneCheckpoints(
  cwd: string,
  normalizedWorkdir: string,
  retention: number,
  excludeRef?: string
): Promise<number> {
  const top = await resolveGitTopLevel(cwd);
  const listRes = await gitRun(
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(contents)%00@@MAW_END@@%0a',
      'refs/maw/checkpoints/',
    ],
    { cwd: top, allowFailure: true }
  );

  if (listRes.code !== 0 || !listRes.stdout.trim()) {
    return 0;
  }

  const entries: Array<{ ref: string; commit: string; unix: number; n: number; workdir: string; order: number }> = [];
  const rawEntries = listRes.stdout.split('\0@@MAW_END@@\n').map((s) => s.replace(/^\n+/, ''));

  let orderIndex = 0;
  for (const raw of rawEntries) {
    if (!raw.trim()) continue;
    const parts = raw.split('\0');
    if (parts.length < 4) continue;
    const ref = parts[0]!.trim();
    if (excludeRef && ref === excludeRef) {
      continue;
    }
    const commit = parts[1]!.trim();
    const unix = Number.parseInt(parts[2]!.trim(), 10) || 0;
    const contents = parts.slice(3).join('\0');
    const meta = parseCheckpointCommitMessage(contents);
    const itemWorkdir = normalizeWorkdir(meta.workdir);

    const match = ref.match(/\/(\d{4})$/);
    const n = match ? Number.parseInt(match[1]!, 10) : 0;

    if (itemWorkdir === normalizedWorkdir) {
      entries.push({ ref, commit, unix, n, workdir: itemWorkdir, order: orderIndex++ });
    }
  }

  // Y2: Sort by (unix time desc, then ref creation order desc)
  entries.sort((a, b) => (b.unix !== a.unix ? b.unix - a.unix : b.order - a.order));

  let deletedCount = 0;
  const maxOthers = Math.max(0, retention - 1);
  if (entries.length > maxOthers) {
    const toDelete = entries.slice(maxOthers);
    for (const item of toDelete) {
      await gitRun(['update-ref', '-d', item.ref], { cwd: top, allowFailure: true });
      deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * C2, C6, C8, C9: Lists checkpoints using unix timestamps, C6 top-level cwd, and C9 stats caching.
 */
export async function listCheckpoints(
  cwd: string,
  options?: {
    jobId?: string;
    limit?: number;
    retention?: number;
  }
): Promise<{ head: string | null; checkpoints: CheckpointRecord[] }> {
  const top = await resolveGitTopLevel(cwd);
  const normTop = normalizeWorkdir(top);

  const headRes = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], {
    cwd: top,
    allowFailure: true,
  });
  const currentHead = headRes.code === 0 ? headRes.stdout.trim() : null;

  let refPattern = 'refs/maw/checkpoints/';
  if (options?.jobId) {
    const validJobKey = validateJobKey(options.jobId);
    refPattern = `refs/maw/checkpoints/${validJobKey}/`;
  }

  const listRes = await gitRun(
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(tree)%00%(parent)%00%(creatordate:unix)%00%(contents)%00@@MAW_END@@%0a',
      refPattern,
    ],
    { cwd: top, allowFailure: true }
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
    created_at_unix: number;
    head_moved: boolean;
  }> = [];

  for (const raw of rawEntries) {
    if (!raw.trim()) continue;
    const parts = raw.split('\0');
    if (parts.length < 6) continue;
    const ref = parts[0]!.trim();
    const commit = parts[1]!.trim();
    const tree = parts[2]!.trim();
    const rawParent = parts[3]!.trim();
    const parent = rawParent ? rawParent.split(/\s+/)[0]! : null;
    const unixSec = Number.parseInt(parts[4]!.trim(), 10) || 0;
    const contents = parts.slice(5).join('\0');

    const match = ref.match(/^refs\/maw\/checkpoints\/([^\/]+)\/(\d{4})$/);
    if (!match) continue;
    const itemJobKey = match[1]!;
    const itemN = Number.parseInt(match[2]!, 10);
    const id = `${itemJobKey}/${match[2]!}`;

    const meta = parseCheckpointCommitMessage(contents);
    const itemWorkdir = normalizeWorkdir(meta.workdir);
    if (itemWorkdir !== normTop) {
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
      created_at: new Date(unixSec * 1000).toISOString(),
      created_at_unix: unixSec,
      head_moved: parent !== currentHead,
    });
  }

  // C2: Sort chronological ascending by unix timestamp, tie-break by n
  matchedRecords.sort((a, b) =>
    a.created_at_unix !== b.created_at_unix ? a.created_at_unix - b.created_at_unix : a.n - b.n
  );

  // C9: Map older checkpoint for each item (in chronological order)
  const prevCommitMap = new Map<string, string | null>();
  for (let i = 0; i < matchedRecords.length; i++) {
    prevCommitMap.set(matchedRecords[i]!.commit, i > 0 ? matchedRecords[i - 1]!.commit : null);
  }

  // Sort newest first
  matchedRecords.reverse();

  const maxLimit = Math.min(500, Math.max(1, options?.limit ?? 200));
  const page = matchedRecords.slice(0, maxLimit);

  // C9: Compute stats ONLY for the returned page, using cache
  const resultWithStats: CheckpointRecord[] = [];
  for (const cur of page) {
    let stats: CheckpointStats | null = null;
    const prevCommit = prevCommitMap.get(cur.commit);

    if (prevCommit) {
      const cached = getCachedStats(prevCommit, cur.commit);
      if (cached) {
        stats = cached;
      } else {
        const diffStatRes = await gitRun(
          ['diff', '--numstat', prevCommit, cur.commit],
          { cwd: top, allowFailure: true }
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
          setCachedStats(prevCommit, cur.commit, stats);
        }
      }
    }

    resultWithStats.push({
      ...cur,
      stats,
    });
  }

  return {
    head: currentHead,
    checkpoints: resultWithStats,
  };
}

/**
 * C5: Real delta restore using git checkout-index -f -z --stdin.
 * Writes only modified/added files, preserving mtime of unchanged files.
 */
export async function restoreTree(
  cwd: string,
  checkpointId: string,
  options: {
    confirm?: boolean;
    auditFile?: string;
    checkpointsAuditFile?: string;
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

  const top = await resolveGitTopLevel(cwd);
  const validatedId = validateCheckpointId(checkpointId);
  const targetRef = `refs/maw/checkpoints/${validatedId}`;

  const targetRes = await gitRun(['rev-parse', '--verify', targetRef], { cwd: top, allowFailure: true });
  if (targetRes.code !== 0) {
    throw new ApiValidationError(`Checkpoint '${validatedId}' not found.`, 404);
  }
  const targetCommit = targetRes.stdout.trim();

  // Safety checkpoint first so restore can be undone
  const safetyRes = await createCheckpoint(top, {
    jobKey: 'safety',
    event: 'safety',
    label: `before restore to ${validatedId}`,
  });
  const safetyCheckpointId = safetyRes.checkpoint.id;

  const currentTree = await snapshotTree(top);
  const targetTreeRes = await gitRun(['rev-parse', `${targetCommit}^{tree}`], { cwd: top });
  const targetTree = targetTreeRes.stdout.trim();

  // Audit entry for destructive action
  const auditEntry = {
    Timestamp: new Date().toISOString(),
    Tool: 'maw-s1',
    Action: 'checkpoint_restore',
    Project: top,
    Detail: `Restored checkpoint ${validatedId} (safety: ${safetyCheckpointId})`,
  };
  if (options.auditFile) appendAuditEntry(options.auditFile, auditEntry);
  if (options.checkpointsAuditFile) appendAuditEntry(options.checkpointsAuditFile, auditEntry);

  // C5: Files to write = AMT from currentTree to targetTree
  const writeRes = await gitRun(
    ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--diff-filter=AMT', currentTree, targetTree],
    { cwd: top, allowFailure: true }
  );
  const filesToWrite = writeRes.stdout
    .split('\0')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // C5: Files to delete = D from currentTree to targetTree
  const deleteRes = await gitRun(
    ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--diff-filter=D', currentTree, targetTree],
    { cwd: top, allowFailure: true }
  );
  const filesToDelete = deleteRes.stdout
    .split('\0')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const tempDir = getTempDir();
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpIndex = path.win32.join(tempDir, `maw-restore-${rand}.idx`);

  let filesWritten = 0;
  let filesDeleted = 0;

  try {
    if (filesToWrite.length > 0) {
      const readTreeRes = await gitRun(['read-tree', targetTree], {
        cwd: top,
        env: { GIT_INDEX_FILE: tmpIndex },
        allowFailure: true,
      });
      if (readTreeRes.code !== 0) {
        throw new ApiValidationError(
          `Failed to read tree for restore (safety checkpoint ${safetyCheckpointId}): ${readTreeRes.stderr || 'git read-tree failed'}`,
          500
        );
      }

      // Write only the changed files via -z --stdin
      const stdinData = filesToWrite.join('\0') + '\0';
      const checkoutRes = await gitRunWithStdin(['checkout-index', '-f', '-z', '--stdin'], stdinData, {
        cwd: top,
        env: { GIT_INDEX_FILE: tmpIndex },
      });
      if (checkoutRes.code !== 0) {
        throw new ApiValidationError(
          `Failed to checkout files for restore (safety checkpoint ${safetyCheckpointId}): ${checkoutRes.stderr || 'git checkout-index failed'}`,
          500
        );
      }

      filesWritten = filesToWrite.length;
    }

    for (const rel of filesToDelete) {
      const full = path.win32.join(top, rel);
      if (isFileSafe(full)) {
        try {
          fs.unlinkSync(full);
          filesDeleted++;
        } catch {}

        // Remove empty directories up to top
        let dir = path.dirname(full);
        while (dir.toLowerCase() !== top.toLowerCase() && isDirectorySafe(dir)) {
          try {
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
          } catch {
            break;
          }
        }
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmpIndex)) {
        fs.unlinkSync(tmpIndex);
      }
    } catch {}
  }

  const targetParentRes = await gitRun(['rev-parse', '--verify', '-q', `${targetCommit}^@`], {
    cwd: top,
    allowFailure: true,
  });
  const targetParent = targetParentRes.code === 0 && targetParentRes.stdout.trim() ? targetParentRes.stdout.trim().split(/\s+/)[0]! : null;

  const currentHeadRes = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: top, allowFailure: true });
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
