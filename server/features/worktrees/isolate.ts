import fs from 'node:fs';
import path from 'node:path';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { gitRun, validateRefName, validateWorktreeName } from '../checkpoints/snapshot.ts';
import {
  allocateWorktreePort,
  copyWorktreeIncludeFiles,
  generateWorktreeName,
  loadWorktreesStore,
  resolveMainRepoRoot,
  runWorktreeSetupScript,
  saveWorktreesStore,
  withStoreLock,
  type WorktreeRecord,
} from './store.ts';

export async function createWorktreeRecord(
  ctx: MawFeatureContext,
  params: {
    project_path: string;
    base?: string;
    name?: string;
    owner?: string;
    origin?: 'manual' | 'job' | 'fork' | 'bestof' | 'handoff';
  }
): Promise<{
  worktree: WorktreeRecord;
  copied: string[];
  setup: { ran: boolean; exit_code: number | null; log: string };
}> {
  const validatedProject = resolveProjectPath(params.project_path, ctx.paths.projectsRoot);
  if (!validatedProject) {
    throw new ApiValidationError('Invalid project path.', 400);
  }

  const repo = await resolveMainRepoRoot(validatedProject);

  let base = String(params.base ?? '').trim();
  if (!base) {
    const symRes = await gitRun(['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: repo,
      allowFailure: true,
    });
    if (symRes.code === 0 && symRes.stdout.trim()) {
      base = symRes.stdout.trim();
    } else {
      const headRes = await gitRun(['rev-parse', 'HEAD'], { cwd: repo, allowFailure: true });
      if (headRes.code === 0 && headRes.stdout.trim()) {
        base = headRes.stdout.trim();
      } else {
        throw new ApiValidationError('Repository has no HEAD commit.', 400);
      }
    }
  }

  // Validate base resolves
  const baseCommitRes = await gitRun(['rev-parse', '--verify', `${base}^{commit}`], {
    cwd: repo,
    allowFailure: true,
  });
  if (baseCommitRes.code !== 0 || !baseCommitRes.stdout.trim()) {
    throw new ApiValidationError(`Invalid base branch or commit '${base}'.`, 400);
  }
  const baseCommit = baseCommitRes.stdout.trim();

  let name = String(params.name ?? '').trim();
  if (name) {
    validateWorktreeName(name);
  } else {
    name = generateWorktreeName('wt');
  }

  const branchName = `maw/${name}`;
  const parentDir = path.dirname(repo);
  const repoBaseName = path.basename(repo);
  const wtDir = path.win32.join(parentDir, '.maw-wt', repoBaseName, name);

  // Check conflicts
  if (fs.existsSync(wtDir)) {
    throw new ApiValidationError(`Worktree path '${wtDir}' already exists.`, 409);
  }
  const branchExistsRes = await gitRun(['rev-parse', '--verify', `refs/heads/${branchName}`], {
    cwd: repo,
    allowFailure: true,
  });
  if (branchExistsRes.code === 0) {
    throw new ApiValidationError(`Branch '${branchName}' already exists.`, 409);
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');
  const port = await allocateWorktreePort(dataDir);

  // git worktree add -b maw/<name> <wtPath> <base>
  await gitRun(['worktree', 'add', '-b', branchName, wtDir, base], { cwd: repo });

  // Copy .worktreeinclude files
  const copied = copyWorktreeIncludeFiles(repo, wtDir);

  // Run optional setup.ps1
  const logsDir = path.win32.join(dataDir, 'logs');
  const setup = await runWorktreeSetupScript(repo, wtDir, name, port, logsDir);

  const nowIso = new Date().toISOString();
  const record: WorktreeRecord = {
    id: name,
    project_path: repo,
    worktree_path: wtDir,
    branch: branchName,
    base,
    base_commit: baseCommit,
    port,
    origin: params.origin ?? 'manual',
    owner: params.owner || undefined,
    status: 'active',
    created_at: nowIso,
    updated_at: nowIso,
    setup: setup.ran ? setup : undefined,
  };

  await withStoreLock(async () => {
    const store = await loadWorktreesStore(dataDir);
    store.worktrees.push(record);
    await saveWorktreesStore(dataDir, store);
  });

  return {
    worktree: record,
    copied,
    setup,
  };
}

export async function prepareIsolatedJob(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<WorktreeRecord> {
  const projectPath = String(body.project_path ?? ctx.paths.repoRoot).trim();
  const owner = String(body.agent ?? body.implementer ?? '').trim();
  const base = body.base ? String(body.base).trim() : undefined;
  const name = body.name ? String(body.name).trim() : undefined;

  const result = await createWorktreeRecord(ctx, {
    project_path: projectPath,
    base,
    name,
    owner,
    origin: 'job',
  });

  return result.worktree;
}

export async function handleWorktreeJob(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const wt = await prepareIsolatedJob(ctx, body);

  const jobBody: Record<string, unknown> = {
    ...body,
    project_path: wt.worktree_path,
    isolate: undefined,
  };

  const jobRes = await ctx.startJob(jobBody);
  const jobId = String(jobRes.job_id ?? '');

  if (jobId) {
    const dataDir = ctx.paths.featureDataDir('worktrees');
    await withStoreLock(async () => {
      const store = await loadWorktreesStore(dataDir);
      const rec = store.worktrees.find((w) => w.id === wt.id);
      if (rec) {
        rec.job_id = jobId;
        rec.updated_at = new Date().toISOString();
        await saveWorktreesStore(dataDir, store);
      }
    });
  }

  return {
    ...jobRes,
    worktree: {
      id: wt.id,
      path: wt.worktree_path,
      branch: wt.branch,
      port: wt.port,
    },
  };
}
