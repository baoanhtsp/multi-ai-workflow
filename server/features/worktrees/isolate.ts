import fs from 'node:fs';
import path from 'node:path';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { gitRun, validateRefName, validateWorktreeName } from '../checkpoints/snapshot.ts';
import {
  allocateWorktreePortFromStore,
  copyWorktreeIncludeFiles,
  generateWorktreeName,
  loadWorktreesStore,
  resolveMainRepoRoot,
  runWorktreeSetupScript,
  saveWorktreesStore,
  withStoreLock,
  type WorktreeRecord,
} from './store.ts';

export const ALLOWED_ORIGINS = ['manual', 'job', 'fork', 'bestof', 'handoff'] as const;
export type WorktreeOrigin = (typeof ALLOWED_ORIGINS)[number];

export async function createWorktreeRecord(
  ctx: MawFeatureContext,
  params: {
    project_path: string;
    base?: string;
    start_point?: string;
    name?: string;
    owner?: string;
    origin?: WorktreeOrigin;
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

  // Validate owner against enabled registry agents (W1)
  let owner = params.owner ? String(params.owner).trim() : undefined;
  if (owner) {
    const enabledAgents = (ctx.registry?.agents ?? []).map((a) => a.id);
    if (!enabledAgents.includes(owner)) {
      throw new ApiValidationError(`Unknown or disabled agent '${owner}'.`, 400);
    }
  }

  // Validate origin (W1)
  const origin: WorktreeOrigin = params.origin ?? 'manual';
  if (!ALLOWED_ORIGINS.includes(origin)) {
    throw new ApiValidationError(`Invalid origin '${origin}'.`, 400);
  }

  // Validate base (W1, W4)
  let base = String(params.base ?? '').trim();
  if (base) {
    if (/^[0-9a-f]{40}$/i.test(base)) {
      throw new ApiValidationError('base must be a branch, not a commit SHA.', 400);
    }
    await validateRefName(base, repo);
  } else {
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
    throw new ApiValidationError(`Invalid base branch '${base}'.`, 400);
  }
  const baseCommit = baseCommitRes.stdout.trim();

  // Validate optional start_point (W4)
  const startPoint = params.start_point ? String(params.start_point).trim() : undefined;
  if (startPoint) {
    if (startPoint.startsWith('-')) {
      throw new ApiValidationError('Invalid start_point.', 400);
    }
    const spRes = await gitRun(['rev-parse', '--verify', `${startPoint}^{commit}`], {
      cwd: repo,
      allowFailure: true,
    });
    if (spRes.code !== 0 || !spRes.stdout.trim()) {
      throw new ApiValidationError(`Invalid start_point '${startPoint}'.`, 400);
    }
  }

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

  const dataDir = ctx.paths.featureDataDir('worktrees');

  // W3: Check conflicts, allocate port, and reserve record INSIDE withStoreLock
  const { record, port } = await withStoreLock(async () => {
    const store = await loadWorktreesStore(dataDir);

    if (store.worktrees.some((w) => w.status === 'active' && w.id === name)) {
      throw new ApiValidationError(`Worktree '${name}' already exists.`, 409);
    }
    if (
      store.worktrees.some(
        (w) => w.status === 'active' && w.worktree_path.toLowerCase() === wtDir.toLowerCase()
      )
    ) {
      throw new ApiValidationError(`Worktree path '${wtDir}' already exists.`, 409);
    }
    if (store.worktrees.some((w) => w.status === 'active' && w.branch === branchName)) {
      throw new ApiValidationError(`Branch '${branchName}' already exists.`, 409);
    }

    // Check filesystem and git ref conflicts
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

    const allocatedPort = allocateWorktreePortFromStore(store);
    const nowIso = new Date().toISOString();
    const rec: WorktreeRecord = {
      id: name,
      project_path: repo,
      worktree_path: wtDir,
      branch: branchName,
      base,
      base_commit: baseCommit,
      start_point: startPoint,
      port: allocatedPort,
      origin,
      owner,
      status: 'creating',
      created_at: nowIso,
      updated_at: nowIso,
    };

    store.worktrees.push(rec);
    await saveWorktreesStore(dataDir, store);
    return { record: rec, port: allocatedPort };
  });

  // Execute git worktree add
  try {
    const addTarget = startPoint || base;
    await gitRun(['worktree', 'add', '-b', branchName, wtDir, addTarget], { cwd: repo });
  } catch (err) {
    // If git worktree add fails, remove reserved record inside lock (W3)
    await withStoreLock(async () => {
      const store = await loadWorktreesStore(dataDir);
      store.worktrees = store.worktrees.filter((w) => w.id !== name);
      await saveWorktreesStore(dataDir, store);
    });
    throw err;
  }

  // Worktree add succeeded: switch status to active under lock
  await withStoreLock(async () => {
    const store = await loadWorktreesStore(dataDir);
    const item = store.worktrees.find((w) => w.id === name);
    if (item) {
      item.status = 'active';
      item.updated_at = new Date().toISOString();
      await saveWorktreesStore(dataDir, store);
    }
  });
  record.status = 'active';

  // Copy .worktreeinclude files (W12)
  const copied = copyWorktreeIncludeFiles(repo, wtDir);

  // Run optional setup.ps1
  const logsDir = path.win32.join(dataDir, 'logs');
  const setup = await runWorktreeSetupScript(repo, wtDir, name, port, logsDir);

  if (setup.ran) {
    record.setup = setup;
    await withStoreLock(async () => {
      const store = await loadWorktreesStore(dataDir);
      const rec = store.worktrees.find((w) => w.id === name);
      if (rec) {
        rec.setup = setup;
        rec.updated_at = new Date().toISOString();
        await saveWorktreesStore(dataDir, store);
      }
    });
  }

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
  const startPoint = body.start_point ? String(body.start_point).trim() : undefined;
  const name = body.name ? String(body.name).trim() : undefined;

  const result = await createWorktreeRecord(ctx, {
    project_path: projectPath,
    base,
    start_point: startPoint,
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

  let jobRes: Record<string, unknown>;
  try {
    jobRes = await ctx.startJob(jobBody);
  } catch (err) {
    // W2: Clean up worktree folder, branch, and record on startJob failure
    await gitRun(['worktree', 'remove', '--force', wt.worktree_path], {
      cwd: wt.project_path,
      allowFailure: true,
    });
    await gitRun(['branch', '-D', wt.branch], {
      cwd: wt.project_path,
      allowFailure: true,
    });
    const dataDir = ctx.paths.featureDataDir('worktrees');
    await withStoreLock(async () => {
      const store = await loadWorktreesStore(dataDir);
      store.worktrees = store.worktrees.filter((w) => w.id !== wt.id);
      await saveWorktreesStore(dataDir, store);
    });
    throw err;
  }

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
