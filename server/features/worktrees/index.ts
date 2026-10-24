import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature } from '../../lib/feature.ts';
import { isDirectorySafe, isFileSafe, resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  createCheckpoint,
  gitRun,
  JOB_ID_REGEX,
  snapshotTree,
  validateRelativePath,
} from '../checkpoints/snapshot.ts';
import {
  handleBestOfCancel,
  handleBestOfList,
  handleBestOfPick,
  handleBestOfStart,
  handleBestOfStatus,
  loadBestOfRun,
} from './bestof.ts';
import {
  handleGitBranchCreate,
  handleGitBranchSwitch,
  handleGitDiff,
  handleGitLog,
  handleGitPull,
  handleGitPush,
} from './gitActions.ts';
import { createWorktreeRecord, handleWorktreeJob, prepareIsolatedJob } from './isolate.ts';
import {
  handleWorktreeDiscard,
  handleWorktreeFixConflicts,
  handleWorktreeMerge,
} from './merge.ts';
import {
  generateWorktreeName,
  loadWorktreesStore,
  saveWorktreesStore,
  withStoreLock,
  type WorktreeLiveStats,
  type WorktreeRecord,
  type WorktreeWithLive,
} from './store.ts';

export async function computeWorktreeLiveStats(
  record: WorktreeRecord,
  jobStatusSource?: Map<string, string> | string
): Promise<WorktreeLiveStats> {
  const wtPath = record.worktree_path;
  if (record.status === 'creating' || !isDirectorySafe(wtPath)) {
    return {
      exists: false,
      head: null,
      dirty: 0,
      ahead: 0,
      behind: 0,
      additions: 0,
      deletions: 0,
      files: 0,
      job_status: null,
    };
  }

  const headRes = await gitRun(['rev-parse', 'HEAD'], { cwd: wtPath, allowFailure: true });
  const head = headRes.code === 0 ? headRes.stdout.trim() : null;

  const dirtyRes = await gitRun(['status', '--porcelain'], { cwd: wtPath, allowFailure: true });
  const dirty = dirtyRes.code === 0 && dirtyRes.stdout.trim()
    ? dirtyRes.stdout.trim().split(/\r?\n/).filter(Boolean).length
    : 0;

  let ahead = 0;
  let behind = 0;
  const abRes = await gitRun(
    ['rev-list', '--left-right', '--count', `${record.base}...HEAD`],
    { cwd: wtPath, allowFailure: true }
  );
  if (abRes.code === 0 && abRes.stdout.trim()) {
    const parts = abRes.stdout.trim().split(/\s+/);
    behind = Number.parseInt(parts[0]!, 10) || 0;
    ahead = Number.parseInt(parts[1]!, 10) || 0;
  }

  let additions = 0;
  let deletions = 0;
  let filesCount = 0;

  try {
    const mbRes = await gitRun(['merge-base', record.base, 'HEAD'], { cwd: wtPath, allowFailure: true });
    const mergeBase = mbRes.code === 0 && mbRes.stdout.trim() ? mbRes.stdout.trim() : record.base_commit;

    const currentTree = await snapshotTree(wtPath);
    const diffStatRes = await gitRun(
      ['diff', '--numstat', mergeBase, currentTree],
      { cwd: wtPath, allowFailure: true }
    );
    if (diffStatRes.code === 0 && diffStatRes.stdout.trim()) {
      for (const line of diffStatRes.stdout.trim().split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [a, d] = trimmed.split(/\s+/);
        filesCount++;
        if (a && a !== '-') additions += Number.parseInt(a, 10) || 0;
        if (d && d !== '-') deletions += Number.parseInt(d, 10) || 0;
      }
    }
  } catch {
    // Keep zero stats on failure
  }

  let jobStatus: string | null = null;
  if (record.job_id) {
    if (jobStatusSource instanceof Map) {
      jobStatus = jobStatusSource.get(record.job_id) ?? null;
    } else if (typeof jobStatusSource === 'string') {
      const metaFile = path.win32.join(jobStatusSource, `${record.job_id}.json`);
      if (isFileSafe(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { status?: string };
          jobStatus = meta.status || null;
        } catch {
          jobStatus = null;
        }
      }
    }
  }

  return {
    exists: true,
    head,
    dirty,
    ahead,
    behind,
    additions,
    deletions,
    files: filesCount,
    job_status: jobStatus,
  };
}

export const feature: MawFeature = {
  name: 'worktrees',
  ui: {
    script: 'feat-worktrees.js',
    style: 'feat-worktrees.css',
  },
  status: async (ctx) => {
    const dataDir = ctx.paths.featureDataDir('worktrees');
    const store = await loadWorktreesStore(dataDir);
    let active = 0;
    const jobs: Record<string, { id: string; branch: string; path: string }> = {};

    for (const wt of store.worktrees) {
      if (wt.status === 'active') {
        active++;
        if (wt.job_id) {
          jobs[wt.job_id] = {
            id: wt.id,
            branch: wt.branch,
            path: wt.worktree_path,
          };
        }
      }
    }

    // Read bestof_active count (runs in 'running' | 'judging')
    let bestofActive = 0;
    const bestofDir = path.win32.join(dataDir, 'bestof');
    if (isDirectorySafe(bestofDir)) {
      try {
        const files = fs.readdirSync(bestofDir).filter((f) => f.endsWith('.json'));
        for (const f of files) {
          try {
            const raw = JSON.parse(fs.readFileSync(path.win32.join(bestofDir, f), 'utf8')) as {
              state?: string;
            };
            if (raw && (raw.state === 'running' || raw.state === 'judging')) {
              bestofActive++;
            }
          } catch {
            // Ignore parse errors
          }
        }
      } catch {
        // Ignore read dir errors
      }
    }

    return {
      active,
      jobs,
      bestof_active: bestofActive,
    };
  },
  routes: {
    worktree_create: {
      method: 'POST',
      handler: async (ctx, req) => {
        const projectPath = String(req.body.project_path ?? ctx.paths.repoRoot).trim();
        const base = req.body.base ? String(req.body.base).trim() : undefined;
        const name = req.body.name ? String(req.body.name).trim() : undefined;
        const owner = req.body.owner ? String(req.body.owner).trim() : undefined;
        const origin = req.body.origin as any;

        const result = await createWorktreeRecord(ctx, {
          project_path: projectPath,
          base,
          name,
          owner,
          origin,
        });

        return {
          ok: true,
          worktree: result.worktree,
          copied: result.copied,
          setup: result.setup,
        };
      },
    },

    worktree_list: {
      method: 'GET',
      handler: async (ctx, req) => {
        const dataDir = ctx.paths.featureDataDir('worktrees');
        const rawProject = req.url.searchParams.get('project_path');
        let projectPath: string | null = null;
        if (rawProject !== null && rawProject !== '') {
          projectPath = resolveProjectPath(rawProject, ctx.paths.projectsRoot);
          if (!projectPath) {
            throw new ApiValidationError('Invalid project path.', 400);
          }
        }
        const includeAll = req.url.searchParams.get('include') === 'all';

        const store = await withStoreLock(async () => {
          const loaded = await loadWorktreesStore(dataDir);
          let changed = false;
          for (const wt of loaded.worktrees) {
            if (wt.status === 'active' && !isDirectorySafe(wt.worktree_path)) {
              wt.status = 'missing';
              wt.updated_at = new Date().toISOString();
              changed = true;
            }
          }
          if (changed) {
            await saveWorktreesStore(dataDir, loaded);
          }
          return loaded;
        });

        // W9: Single ctx.readJobs() call to build job status map
        const jobStatusMap = new Map<string, string>();
        try {
          const allJobs = await ctx.readJobs();
          for (const j of allJobs) {
            const jId = String(j.id ?? j.job_id ?? '').trim();
            const jStatus = String(j.status ?? '').trim();
            if (jId) {
              jobStatusMap.set(jId, jStatus);
            }
          }
        } catch {
          // Keep empty map on failure
        }

        const filtered = store.worktrees.filter((wt) => {
          if (projectPath && wt.project_path.toLowerCase() !== projectPath.toLowerCase()) {
            return false;
          }
          if (!includeAll && (wt.status !== 'active' && wt.status !== 'creating')) {
            return false;
          }
          return true;
        });

        // W11: Cap live stats concurrency at 4
        const list: WorktreeWithLive[] = [];
        const CONCURRENCY_LIMIT = 4;
        for (let i = 0; i < filtered.length; i += CONCURRENCY_LIMIT) {
          const chunk = filtered.slice(i, i + CONCURRENCY_LIMIT);
          const chunkResults = await Promise.all(
            chunk.map(async (wt) => {
              const live = await computeWorktreeLiveStats(wt, jobStatusMap);
              return {
                ...wt,
                live,
              };
            })
          );
          list.push(...chunkResults);
        }

        return {
          ok: true,
          worktrees: list,
        };
      },
    },

    worktree_diff: {
      method: 'GET',
      handler: async (ctx, req) => {
        const id = String(req.url.searchParams.get('id') ?? '').trim();
        if (!id) {
          throw new ApiValidationError('Worktree id is required.', 400);
        }

        const dataDir = ctx.paths.featureDataDir('worktrees');
        const store = await loadWorktreesStore(dataDir);
        const record = store.worktrees.find((w) => w.id === id);
        if (!record) {
          throw new ApiValidationError(`Worktree '${id}' not found.`, 404);
        }

        const wtPath = record.worktree_path;
        if (!isDirectorySafe(wtPath)) {
          throw new ApiValidationError(`Worktree directory not found on disk.`, 404);
        }

        const mbRes = await gitRun(['merge-base', record.base, 'HEAD'], {
          cwd: wtPath,
          allowFailure: true,
        });
        const mergeBase = mbRes.code === 0 && mbRes.stdout.trim() ? mbRes.stdout.trim() : record.base_commit;

        const rawSubPath = req.url.searchParams.get('path');
        let subPath: string | undefined = undefined;
        if (rawSubPath && rawSubPath.trim()) {
          subPath = validateRelativePath(rawSubPath.trim());
        }

        // Diff from mergeBase to WORKTREE snapshot (C12: without -M)
        const fromTree = mergeBase;
        const toTree = await snapshotTree(wtPath);

        const rawArgs = ['diff', '--raw', fromTree, toTree];
        const numstatArgs = ['diff', '--numstat', fromTree, toTree];
        const patchArgs = ['diff', fromTree, toTree];

        if (subPath) {
          rawArgs.push('--', subPath);
          numstatArgs.push('--', subPath);
          patchArgs.push('--', subPath);
        }

        const rawRes = await gitRun(rawArgs, { cwd: wtPath });
        const numstatRes = await gitRun(numstatArgs, { cwd: wtPath });
        const patchRes = await gitRun(patchArgs, { cwd: wtPath });

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

        // Commits: git log <merge-base>..HEAD max 100
        const logRes = await gitRun(
          ['log', '--format=%H%x1f%s%x1f%an%x1f%aI', '-n', '100', `${mergeBase}..HEAD`],
          { cwd: wtPath, allowFailure: true }
        );
        const commits: Array<{ sha: string; subject: string; author: string; date: string }> = [];
        if (logRes.code === 0 && logRes.stdout.trim()) {
          for (const l of logRes.stdout.split(/\r?\n/)) {
            const trimmed = l.trim();
            if (!trimmed) continue;
            const parts = trimmed.split('\x1f');
            if (parts.length >= 4) {
              commits.push({
                sha: parts[0]!,
                subject: parts[1]!,
                author: parts[2]!,
                date: parts[3]!,
              });
            }
          }
        }

        return {
          ok: true,
          from: record.base,
          to: 'WORKTREE',
          files,
          patch,
          truncated,
          commits,
        };
      },
    },

    worktree_merge: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleWorktreeMerge(ctx, req.body);
      },
    },

    worktree_fix_conflicts: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleWorktreeFixConflicts(ctx, req.body);
      },
    },

    worktree_discard: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleWorktreeDiscard(ctx, req.body);
      },
    },

    worktree_job: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleWorktreeJob(ctx, req.body);
      },
    },

    job_fork: {
      method: 'POST',
      handler: async (ctx, req) => {
        const jobId = String(req.body.job_id ?? '').trim();
        // F1: Validate job_id with JOB_ID_REGEX
        if (!jobId || !JOB_ID_REGEX.test(jobId)) {
          throw new ApiValidationError('Invalid job_id.', 400);
        }

        const metaFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.json`);
        const promptFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.prompt.txt`);
        const logFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.log`);

        if (!isFileSafe(metaFile) || !isFileSafe(promptFile)) {
          throw new ApiValidationError(`Job not found or missing prompt: ${jobId}`, 404);
        }

        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
        } catch {
          throw new ApiValidationError(`Job meta unreadable: ${jobId}`, 404);
        }

        // F2: Strip UTF-8 BOM if present
        let originalPrompt = fs.readFileSync(promptFile, 'utf8');
        if (originalPrompt.charCodeAt(0) === 0xfeff) {
          originalPrompt = originalPrompt.slice(1);
        }

        // F2: Pre-validate agent and role before creating worktree
        const forkAgent = String(req.body.agent ?? meta.agent ?? 'antigravity').trim();
        const forkRole = String(req.body.role ?? meta.role ?? 'backend').trim();
        const enabledAgents = (ctx.registry?.agents ?? []).map((a) => a.id);
        if (!enabledAgents.includes(forkAgent)) {
          throw new ApiValidationError(`Unknown or disabled agent '${forkAgent}'.`, 400);
        }
        if (!forkRole || forkRole.startsWith('-')) {
          throw new ApiValidationError(`Invalid role '${forkRole}'.`, 400);
        }

        let rawLog = '';
        if (isFileSafe(logFile)) {
          try {
            rawLog = fs.readFileSync(logFile, 'utf8');
          } catch {
            rawLog = '';
          }
        }

        // Clean ANSI escape sequences
        const cleanLog = rawLog.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        let summary = cleanLog.slice(-6000).trim();

        const baseOption = String(req.body.base ?? 'project').trim().toLowerCase();
        const dataDir = ctx.paths.featureDataDir('worktrees');
        const store = await loadWorktreesStore(dataDir);
        const sourceWt = store.worktrees.find((w) => w.job_id === jobId);

        let forkBase: string | undefined = undefined;
        let forkStartPoint: string | undefined = undefined;
        let projectPath = String(meta.project_path ?? ctx.paths.repoRoot).trim();

        // W4: Result fork passes sourceWt.base as base and snapshot commit as start_point
        if (baseOption === 'result' && sourceWt && isDirectorySafe(sourceWt.worktree_path)) {
          projectPath = sourceWt.project_path;
          forkBase = sourceWt.base;
          try {
            const snapRes = await createCheckpoint(sourceWt.worktree_path, {
              jobKey: 'fork-source',
              event: 'safety',
              label: `snapshot before fork of job ${jobId}`,
            });
            forkStartPoint = snapRes.checkpoint.commit;
          } catch {
            forkStartPoint = undefined;
          }
        }

        const note = String(req.body.note ?? '').trim();
        const instructions =
          note || 'Solve the task again, independently; avoid the problems visible above.';

        let composedPrompt = [
          originalPrompt,
          '',
          '---',
          `## Previous attempt (job ${jobId}, agent ${String(meta.agent || '')}, status ${String(meta.status || '')})`,
          summary,
          '',
          '## Instructions for this attempt',
          instructions,
        ].join('\n');

        // Prompt limit: 20000 chars. If exceeded, truncate summary first, keeping original prompt whole.
        if (composedPrompt.length > 20000) {
          const overhead = composedPrompt.length - summary.length;
          const allowedSummary = Math.max(0, 20000 - overhead - 20);
          summary = summary.slice(0, allowedSummary);
          composedPrompt = [
            originalPrompt,
            '',
            '---',
            `## Previous attempt (job ${jobId}, agent ${String(meta.agent || '')}, status ${String(meta.status || '')})`,
            summary,
            '',
            '## Instructions for this attempt',
            instructions,
          ].join('\n');
        }

        const forkModel = req.body.model ? String(req.body.model).trim() : undefined;
        const forkEffort = req.body.effort ? String(req.body.effort).trim() : undefined;

        const wtRes = await createWorktreeRecord(ctx, {
          project_path: projectPath,
          base: forkBase,
          start_point: forkStartPoint,
          name: generateWorktreeName('fork'),
          owner: forkAgent,
          origin: 'fork',
        });

        // Record source_job_id
        await withStoreLock(async () => {
          const s = await loadWorktreesStore(dataDir);
          const r = s.worktrees.find((w) => w.id === wtRes.worktree.id);
          if (r) {
            r.source_job_id = jobId;
            await saveWorktreesStore(dataDir, s);
          }
        });

        const jobRes = await ctx.startJob({
          mode: 'task',
          agent: forkAgent,
          role: forkRole,
          model: forkModel,
          effort: forkEffort,
          project_path: wtRes.worktree.worktree_path,
          prompt: composedPrompt,
        });

        const newJobId = String(jobRes.job_id ?? '');
        if (newJobId) {
          await withStoreLock(async () => {
            const s = await loadWorktreesStore(dataDir);
            const r = s.worktrees.find((w) => w.id === wtRes.worktree.id);
            if (r) {
              r.job_id = newJobId;
              await saveWorktreesStore(dataDir, s);
            }
          });
        }

        return {
          ok: true,
          job_id: newJobId,
          source_job_id: jobId,
          worktree: {
            id: wtRes.worktree.id,
            path: wtRes.worktree.worktree_path,
            branch: wtRes.worktree.branch,
            port: wtRes.worktree.port,
          },
        };
      },
    },

    bestof_start: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleBestOfStart(ctx, req.body);
      },
    },

    bestof_status: {
      method: 'GET',
      handler: async (ctx, req) => {
        return await handleBestOfStatus(ctx, req.url.searchParams);
      },
    },

    bestof_list: {
      method: 'GET',
      handler: async (ctx, req) => {
        return await handleBestOfList(ctx, req.url.searchParams);
      },
    },

    bestof_pick: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleBestOfPick(ctx, req.body);
      },
    },

    bestof_cancel: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleBestOfCancel(ctx, req.body);
      },
    },

    git_log: {
      method: 'GET',
      handler: async (ctx, req) => {
        return await handleGitLog(ctx, req.url.searchParams);
      },
    },

    git_diff: {
      method: 'GET',
      handler: async (ctx, req) => {
        return await handleGitDiff(ctx, req.url.searchParams);
      },
    },

    git_pull: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleGitPull(ctx, req.body);
      },
    },

    git_push: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleGitPush(ctx, req.body);
      },
    },

    git_branch_switch: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleGitBranchSwitch(ctx, req.body);
      },
    },

    git_branch_create: {
      method: 'POST',
      handler: async (ctx, req) => {
        return await handleGitBranchCreate(ctx, req.body);
      },
    },
  },
};
