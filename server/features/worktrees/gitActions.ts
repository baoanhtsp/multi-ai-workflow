import path from 'node:path';
import { appendAuditEntry } from '../../lib/audit.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  assertNotOption,
  diffTrees,
  gitRun,
  validateRefName,
  validateRelativePath,
  validateRemoteName,
} from '../checkpoints/snapshot.ts';

export async function handleGitLog(
  ctx: MawFeatureContext,
  query: URLSearchParams
): Promise<Record<string, unknown>> {
  const rawPath = String(query.get('project_path') ?? '').trim();
  const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw new ApiValidationError('Invalid project path.', 400);
  }

  const rawLimit = Number(query.get('limit') ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 50;

  const rawRef = query.get('ref');
  let ref: string | undefined;
  if (rawRef && rawRef.trim()) {
    ref = await validateRefName(rawRef.trim(), projectPath);
  }

  const rawSubPath = query.get('path');
  let subPath: string | undefined;
  if (rawSubPath && rawSubPath.trim()) {
    subPath = validateRelativePath(rawSubPath.trim());
  }

  const args: string[] = [
    'log',
    '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s',
    '-n',
    String(limit),
  ];
  if (ref) {
    args.push(ref);
  }
  if (subPath) {
    args.push('--', subPath);
  }

  const res = await gitRun(args, { cwd: projectPath });
  const commits: Array<{
    sha: string;
    short_sha: string;
    short: string;
    author: string;
    date: string;
    subject: string;
  }> = [];

  for (const line of res.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\x1f');
    if (parts.length >= 5) {
      commits.push({
        sha: parts[0]!,
        short_sha: parts[1]!,
        short: parts[1]!,
        author: parts[2]!,
        date: parts[3]!,
        subject: parts[4]!,
      });
    }
  }

  const tail = `${res.stdout}\n${res.stderr}`.trim().slice(-4000);
  return {
    ok: true,
    commits,
    output: tail,
  };
}

export async function handleGitDiff(
  ctx: MawFeatureContext,
  query: URLSearchParams
): Promise<Record<string, unknown>> {
  const rawPath = String(query.get('project_path') ?? '').trim();
  const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw new ApiValidationError('Invalid project path.', 400);
  }

  const rawRef = query.get('ref');
  let ref: string | undefined;
  if (rawRef && rawRef.trim()) {
    ref = await validateRefName(rawRef.trim(), projectPath);
  }

  const isStaged = query.get('staged') === 'true' || query.get('staged') === '1';

  const rawSubPath = query.get('path');
  let subPath: string | undefined;
  if (rawSubPath && rawSubPath.trim()) {
    subPath = validateRelativePath(rawSubPath.trim());
  }

  const rawArgs = ['diff', '--raw'];
  const numstatArgs = ['diff', '--numstat'];
  const patchArgs = ['diff'];

  if (isStaged) {
    rawArgs.push('--cached');
    numstatArgs.push('--cached');
    patchArgs.push('--cached');
  }
  if (ref) {
    rawArgs.push(ref);
    numstatArgs.push(ref);
    patchArgs.push(ref);
  }
  if (subPath) {
    rawArgs.push('--', subPath);
    numstatArgs.push('--', subPath);
    patchArgs.push('--', subPath);
  }

  const rawRes = await gitRun(rawArgs, { cwd: projectPath });
  const numstatRes = await gitRun(numstatArgs, { cwd: projectPath });
  const patchRes = await gitRun(patchArgs, { cwd: projectPath });

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

  const files: Array<{
    path: string;
    status: string;
    old_path: string | null;
    additions: number;
    deletions: number;
    binary: boolean;
  }> = [];

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

  const tail = `${patchRes.stdout}\n${patchRes.stderr}`.trim().slice(-4000);
  return {
    ok: true,
    files,
    patch,
    truncated,
    output: tail,
  };
}

export async function handleGitPull(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const rawPath = String(body.project_path ?? '').trim();
  const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw new ApiValidationError('Invalid project path.', 400);
  }

  const rawRemote = String(body.remote ?? 'origin').trim() || 'origin';
  const remote = validateRemoteName(rawRemote);

  const args: string[] = ['pull', '--ff-only', remote];

  if (body.branch) {
    const br = await validateRefName(String(body.branch).trim(), projectPath);
    args.push(br);
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');
  const auditEntry = {
    Timestamp: new Date().toISOString(),
    Tool: 'maw-s1',
    Action: 'git_pull',
    Project: projectPath,
    Detail: `git pull --ff-only ${remote} ${body.branch || ''}`.trim(),
  };
  appendAuditEntry(ctx.paths.auditFile, auditEntry);
  appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

  const res = await gitRun(args, {
    cwd: projectPath,
    timeoutMs: 120000,
    allowFailure: true,
  });

  const output = `${res.stdout}\n${res.stderr}`.trim().slice(-4000);
  if (res.code !== 0) {
    const errTail = (res.stderr.trim() || `exit code ${res.code}`).slice(-400);
    throw new ApiValidationError(`git pull failed: ${errTail}`, 500);
  }

  return {
    ok: true,
    output,
  };
}

export async function handleGitPush(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const rawPath = String(body.project_path ?? '').trim();
  const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw new ApiValidationError('Invalid project path.', 400);
  }

  const rawRemote = String(body.remote ?? 'origin').trim() || 'origin';
  const remote = validateRemoteName(rawRemote);

  let branch = String(body.branch ?? '').trim();
  if (!branch) {
    const curBrRes = await gitRun(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: projectPath });
    branch = curBrRes.stdout.trim();
  }
  const validBranch = await validateRefName(branch, projectPath);

  // NEVER allow --force
  const args: string[] = ['push'];
  if (body.set_upstream === true) {
    args.push('-u');
  }
  args.push(remote, validBranch);

  const dataDir = ctx.paths.featureDataDir('worktrees');
  const auditEntry = {
    Timestamp: new Date().toISOString(),
    Tool: 'maw-s1',
    Action: 'git_push',
    Project: projectPath,
    Detail: `git push ${body.set_upstream ? '-u ' : ''}${remote} ${validBranch}`,
  };
  appendAuditEntry(ctx.paths.auditFile, auditEntry);
  appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

  const res = await gitRun(args, {
    cwd: projectPath,
    timeoutMs: 120000,
    allowFailure: true,
  });

  const output = `${res.stdout}\n${res.stderr}`.trim().slice(-4000);
  if (res.code !== 0) {
    const errTail = (res.stderr.trim() || `exit code ${res.code}`).slice(-400);
    throw new ApiValidationError(`git push failed: ${errTail}`, 500);
  }

  return {
    ok: true,
    output,
  };
}

export async function handleGitBranchSwitch(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const rawPath = String(body.project_path ?? '').trim();
  const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw new ApiValidationError('Invalid project path.', 400);
  }

  const rawBranch = String(body.branch ?? '').trim();
  if (!rawBranch) {
    throw new ApiValidationError('Branch name is required.', 400);
  }
  const branch = await validateRefName(rawBranch, projectPath);

  const dataDir = ctx.paths.featureDataDir('worktrees');
  const auditEntry = {
    Timestamp: new Date().toISOString(),
    Tool: 'maw-s1',
    Action: 'git_branch_switch',
    Project: projectPath,
    Detail: `git switch ${branch}`,
  };
  appendAuditEntry(ctx.paths.auditFile, auditEntry);
  appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

  const res = await gitRun(['switch', branch], {
    cwd: projectPath,
    allowFailure: true,
  });

  const output = `${res.stdout}\n${res.stderr}`.trim().slice(-4000);
  if (res.code !== 0) {
    const errTail = (res.stderr.trim() || `exit code ${res.code}`).slice(-400);
    throw new ApiValidationError(`git switch failed: ${errTail}`, 500);
  }

  return {
    ok: true,
    output,
  };
}

export async function handleGitBranchCreate(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const rawPath = String(body.project_path ?? '').trim();
  const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw new ApiValidationError('Invalid project path.', 400);
  }

  const rawName = String(body.name ?? '').trim();
  if (!rawName) {
    throw new ApiValidationError('Branch name is required.', 400);
  }
  const name = await validateRefName(rawName, projectPath);

  let base: string | undefined;
  if (body.base && String(body.base).trim()) {
    base = await validateRefName(String(body.base).trim(), projectPath);
  }

  const shouldSwitch = body.switch !== false;
  const args = shouldSwitch ? ['switch', '-c', name] : ['branch', name];
  if (base) {
    args.push(base);
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');
  const auditEntry = {
    Timestamp: new Date().toISOString(),
    Tool: 'maw-s1',
    Action: 'git_branch_create',
    Project: projectPath,
    Detail: `git branch create ${name} (base: ${base || 'HEAD'}, switch: ${shouldSwitch})`,
  };
  appendAuditEntry(ctx.paths.auditFile, auditEntry);
  appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

  const res = await gitRun(args, {
    cwd: projectPath,
    allowFailure: true,
  });

  const output = `${res.stdout}\n${res.stderr}`.trim().slice(-4000);
  if (res.code !== 0) {
    const errTail = (res.stderr.trim() || `exit code ${res.code}`).slice(-400);
    throw new ApiValidationError(
      `git branch creation failed: ${errTail}`,
      500
    );
  }

  return {
    ok: true,
    name,
    base: base || 'HEAD',
    switched: shouldSwitch,
    output,
  };
}
