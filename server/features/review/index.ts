import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  createSafetySnapshot,
  executeRejectHunk,
  getDefaultBase,
  getReviewSources,
  readJobMetaDirect,
  runReviewDiff,
  validateSafeRelativePath,
} from './git.ts';
import {
  appendReviewAudit,
  appendReviewVerdict,
  buildFixPrompt,
  computeReviewKey,
  loadReviewSession,
  readReviewVerdicts,
  saveReviewSession,
  withReviewLock,
  type ReviewComment,
  type ReviewSession,
} from './session.ts';

export const feature: MawFeature = {
  name: 'review',
  routes: {
    review_sources: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawProjectPath = String(req.query.get('project_path') ?? '').trim();
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        return await getReviewSources(projectPath, ctx.paths);
      },
    },

    review_diff: {
      method: 'GET',
      handler: async (ctx, req) => {
        const source = (String(req.query.get('source') ?? 'worktree').trim() ||
          'worktree') as 'worktree' | 'branch' | 'job' | 'commit';
        const ref = String(req.query.get('ref') ?? '').trim();
        let base = String(req.query.get('base') ?? '').trim();
        const rawProjectPath = String(req.query.get('project_path') ?? '').trim();

        let projectPath: string | null = null;
        if (rawProjectPath) {
          projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
          if (!projectPath && source !== 'job') {
            throw new ApiValidationError('Invalid project_path.', 400);
          }
        }

        const ctxParam = req.query.has('context')
          ? Number.parseInt(req.query.get('context')!, 10)
          : 3;
        const ignoreWs = req.query.get('ignore_ws') === '1';
        const filterPath = req.query.get('path') ?? undefined;
        const full = req.query.get('full') === '1';

        const diffRun = await runReviewDiff(
          {
            project_path: projectPath ?? undefined,
            source,
            ref,
            base,
            context: ctxParam,
            ignore_ws: ignoreWs,
            path: filterPath,
            full,
          },
          ctx.paths
        );

        const effectiveProjectPath = diffRun.project_path;
        const effectiveRef = diffRun.ref;
        const effectiveBase = diffRun.base;
        const reviewKey = computeReviewKey(effectiveProjectPath, source, effectiveRef, effectiveBase);
        const session = loadReviewSession(
          reviewKey,
          effectiveProjectPath,
          source,
          effectiveRef,
          effectiveBase,
          ctx.paths
        );

        // Strip internal rawLines and headerLines to reduce payload size
        const sanitizedFiles = diffRun.diffResult.files.map((file) => ({
          id: file.id,
          path: file.path,
          old_path: file.old_path,
          status: file.status,
          binary: file.binary,
          untracked: file.untracked,
          too_large: file.too_large,
          omitted: file.omitted,
          additions: file.additions,
          deletions: file.deletions,
          hunks: file.hunks.map((hunk) => ({
            id: hunk.id,
            header: hunk.header,
            old_start: hunk.old_start,
            old_lines: hunk.old_lines,
            new_start: hunk.new_start,
            new_lines: hunk.new_lines,
            lines: hunk.lines,
          })),
        }));

        return {
          ok: true,
          source,
          ref: effectiveRef,
          base: effectiveBase,
          project_path: effectiveProjectPath,
          target_path: diffRun.target_path,
          writable: diffRun.target_path !== null,
          review_key: reviewKey,
          truncated: diffRun.diffResult.truncated,
          stats: diffRun.diffResult.stats,
          files: sanitizedFiles,
          session: {
            states: session.states,
            comments: session.comments,
            verdict: session.verdict,
            fix_jobs: session.fix_jobs,
          },
        };
      },
    },

    review_hunk: {
      method: 'POST',
      handler: async (ctx, req) => {
        const source = String(req.body.source ?? 'worktree').trim() as
          | 'worktree'
          | 'branch'
          | 'job'
          | 'commit';
        const ref = String(req.body.ref ?? '').trim();
        const base = String(req.body.base ?? '').trim();
        const rawProjectPath = String(req.body.project_path ?? '').trim();

        let projectPath: string | null = null;
        if (rawProjectPath) {
          projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        }
        if (!projectPath && source === 'job') {
          const jobMeta = readJobMetaDirect(ref, ctx.paths);
          if (jobMeta?.project_path) {
            projectPath = resolveProjectPath(jobMeta.project_path, ctx.paths.projectsRoot);
          }
        }
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const relPath = String(req.body.path ?? '').trim();
        const hunkId =
          req.body.hunk_id !== undefined && req.body.hunk_id !== null && req.body.hunk_id !== ''
            ? String(req.body.hunk_id).trim()
            : null;
        const fileId =
          req.body.file_id !== undefined && req.body.file_id !== null && req.body.file_id !== ''
            ? String(req.body.file_id).trim()
            : null;
        const action = String(req.body.action ?? '').trim().toLowerCase();
        const confirm = Boolean(req.body.confirm);
        const context =
          req.body.context !== undefined && req.body.context !== null && req.body.context !== ''
            ? Number(req.body.context)
            : undefined;
        const ignore_ws = Boolean(req.body.ignore_ws);

        if (action !== 'accept' && action !== 'reject' && action !== 'reset') {
          throw new ApiValidationError(
            "Invalid action. Expected 'accept', 'reject', or 'reset'.",
            400
          );
        }

        const validPath = validateSafeRelativePath(projectPath, relPath);

        const diffRun = await runReviewDiff(
          {
            project_path: projectPath,
            source,
            ref,
            base,
            path: validPath,
            full: true,
            context,
            ignore_ws,
          },
          ctx.paths
        );

        const file = diffRun.diffResult.files.find(
          (f) => f.path.toLowerCase() === validPath.toLowerCase()
        );
        if (!file) {
          throw new ApiValidationError('The diff changed; reload it.', 409);
        }

        let targetHunk: (typeof file.hunks)[number] | null = null;
        if (hunkId === null) {
          if (action === 'reject' && !fileId) {
            throw new ApiValidationError('file_id is required for whole-file reject.', 400);
          }
          if (fileId && file.id !== fileId) {
            throw new ApiValidationError('The diff changed; reload it.', 409);
          }
        } else {
          if (fileId && file.id !== fileId) {
            throw new ApiValidationError('The diff changed; reload it.', 409);
          }
          const found = file.hunks.find((h) => h.id === hunkId);
          if (!found) {
            throw new ApiValidationError('The diff changed; reload it.', 409);
          }
          targetHunk = found;
        }

        if (action === 'reject' && (file.too_large || file.omitted)) {
          throw new ApiValidationError('Load the full file before rejecting it.', 409);
        }

        const reviewKey = computeReviewKey(projectPath, source, diffRun.ref, diffRun.base);

        return await withReviewLock(reviewKey, async () => {
          const session = loadReviewSession(
            reviewKey,
            projectPath,
            source,
            diffRun.ref,
            diffRun.base,
            ctx.paths
          );

          if (!session.states[validPath]) {
            session.states[validPath] = { file: null, hunks: {}, headers: {} };
          }
          session.states[validPath].headers = session.states[validPath].headers || {};

          let snapshotRef: string | undefined;

          if (action === 'reject') {
            if (!confirm) {
              throw new ApiValidationError('Confirmation required.', 400);
            }
            if (diffRun.target_path === null) {
              throw new ApiValidationError('Target is not writable.', 409);
            }

            let rejectFile = file;
            if (ignore_ws) {
              const nonWsDiffRun = await runReviewDiff(
                {
                  project_path: projectPath,
                  source,
                  ref,
                  base,
                  path: validPath,
                  full: true,
                  context,
                  ignore_ws: false,
                },
                ctx.paths
              );

              const nonWsFile = nonWsDiffRun.diffResult.files.find(
                (f) => f.path.toLowerCase() === validPath.toLowerCase()
              );
              if (!nonWsFile) {
                throw new ApiValidationError("Turn off 'ignore whitespace' to reject this hunk.", 409);
              }

              if (hunkId !== null) {
                const nonWsHunk = nonWsFile.hunks.find((h) => h.id === hunkId);
                if (!nonWsHunk) {
                  throw new ApiValidationError("Turn off 'ignore whitespace' to reject this hunk.", 409);
                }
              }
              rejectFile = nonWsFile;
            }

            try {
              snapshotRef = await createSafetySnapshot(diffRun.target_path, ctx.paths);
              await executeRejectHunk({
                targetPath: diffRun.target_path,
                file: rejectFile,
                hunkId,
                snapshotRef,
                source,
                beforeRef: diffRun.beforeRef,
                ref: diffRun.ref,
                base: diffRun.base,
                paths: ctx.paths,
              });

              appendReviewAudit(
                {
                  ts: new Date().toISOString(),
                  action: 'reject',
                  project_path: projectPath,
                  source,
                  ref: diffRun.ref,
                  path: validPath,
                  hunk_id: hunkId,
                  snapshot_ref: snapshotRef,
                  ok: true,
                },
                ctx.paths
              );

              if (hunkId === null) {
                session.states[validPath].file = 'rejected';
              } else {
                session.states[validPath].hunks[hunkId] = 'rejected';
                if (targetHunk) {
                  session.states[validPath].headers![hunkId] = targetHunk.header;
                }
              }
            } catch (err: unknown) {
              appendReviewAudit(
                {
                  ts: new Date().toISOString(),
                  action: 'reject',
                  project_path: projectPath,
                  source,
                  ref: diffRun.ref,
                  path: validPath,
                  hunk_id: hunkId,
                  snapshot_ref: snapshotRef ?? null,
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                },
                ctx.paths
              );
              throw err;
            }
          } else if (action === 'accept') {
            if (hunkId === null) {
              session.states[validPath].file = 'accepted';
            } else {
              session.states[validPath].hunks[hunkId] = 'accepted';
              if (targetHunk) {
                session.states[validPath].headers![hunkId] = targetHunk.header;
              }
            }
          } else {
            // reset
            if (hunkId === null) {
              session.states[validPath].file = null;
            } else {
              delete session.states[validPath].hunks[hunkId];
              if (session.states[validPath].headers) {
                delete session.states[validPath].headers![hunkId];
              }
            }
          }

          saveReviewSession(session, ctx.paths);

          const storedState =
            hunkId === null
              ? session.states[validPath].file
              : (session.states[validPath].hunks[hunkId] ?? null);

          return {
            ok: true,
            action,
            path: validPath,
            hunk_id: hunkId,
            state: storedState,
            ...(snapshotRef ? { snapshot_ref: snapshotRef } : {}),
          };
        });
      },
    },

    review_comment: {
      method: 'POST',
      handler: async (ctx, req) => {
        const source = String(req.body.source ?? 'worktree').trim();
        const ref = String(req.body.ref ?? '').trim();
        let base = String(req.body.base ?? '').trim();
        const rawProjectPath = String(req.body.project_path ?? '').trim();

        let projectPath: string | null = null;
        if (rawProjectPath) {
          projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        }
        if (!projectPath && source === 'job') {
          const jobMeta = readJobMetaDirect(ref, ctx.paths);
          if (jobMeta?.project_path) {
            projectPath = resolveProjectPath(jobMeta.project_path, ctx.paths.projectsRoot);
          }
        }
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        if (source === 'branch' && !base) {
          base = await getDefaultBase(projectPath);
        }

        const op = String(req.body.op ?? '').trim().toLowerCase();
        const reviewKey = computeReviewKey(projectPath, source, ref, base);

        return await withReviewLock(reviewKey, async () => {
          const session = loadReviewSession(reviewKey, projectPath, source, ref, base, ctx.paths);

          if (op === 'add') {
            if (session.comments.length >= 500) {
              throw new ApiValidationError('Maximum 500 comments per session.', 400);
            }
            const relPath = String(req.body.path ?? '').trim();
            const validPath = validateSafeRelativePath(projectPath, relPath);
            const line = Number.parseInt(String(req.body.line ?? '1'), 10);
            if (Number.isNaN(line) || line < 1) {
              throw new ApiValidationError('Invalid line number (must be >= 1).', 400);
            }
            const rawSide = String(req.body.side ?? 'new').trim().toLowerCase();
            const side: 'new' | 'old' = rawSide === 'old' ? 'old' : 'new';
            const quote = String(req.body.quote ?? '').slice(0, 500);
            const body = String(req.body.body ?? '').trim();
            if (body.length < 1 || body.length > 4000) {
              throw new ApiValidationError('Comment body must be 1 to 4000 characters.', 400);
            }

            const now = new Date().toISOString();
            const comment: ReviewComment = {
              id: crypto.randomBytes(4).toString('hex'),
              path: validPath,
              line,
              side,
              quote,
              body,
              created_at: now,
              updated_at: now,
              resolved: false,
              sent_at: null,
            };
            session.comments.push(comment);
          } else if (op === 'edit') {
            const id = String(req.body.id ?? '').trim();
            const comment = session.comments.find((c) => c.id === id);
            if (!comment) {
              throw new ApiValidationError(`Comment '${id}' not found.`, 404);
            }
            const body = String(req.body.body ?? '').trim();
            if (body.length < 1 || body.length > 4000) {
              throw new ApiValidationError('Comment body must be 1 to 4000 characters.', 400);
            }
            comment.body = body;
            comment.sent_at = null;
            comment.updated_at = new Date().toISOString();
          } else if (op === 'delete') {
            const id = String(req.body.id ?? '').trim();
            session.comments = session.comments.filter((c) => c.id !== id);
          } else if (op === 'resolve') {
            const id = String(req.body.id ?? '').trim();
            const comment = session.comments.find((c) => c.id === id);
            if (!comment) {
              throw new ApiValidationError(`Comment '${id}' not found.`, 404);
            }
            // Honour resolved boolean so the UI can reopen comments
            const resolved = typeof req.body.resolved === 'boolean' ? req.body.resolved : true;
            comment.resolved = resolved;
            comment.updated_at = new Date().toISOString();
          } else {
            throw new ApiValidationError(
              "Invalid op. Expected 'add', 'edit', 'delete', or 'resolve'.",
              400
            );
          }

          saveReviewSession(session, ctx.paths);
          return {
            ok: true,
            comments: session.comments,
          };
        });
      },
    },

    review_send_fix: {
      method: 'POST',
      handler: async (ctx, req) => {
        const source = (String(req.body.source ?? 'worktree').trim() ||
          'worktree') as 'worktree' | 'branch' | 'job' | 'commit';
        const ref = String(req.body.ref ?? '').trim();
        let base = String(req.body.base ?? '').trim();
        const rawProjectPath = String(req.body.project_path ?? '').trim();

        let projectPath: string | null = null;
        if (rawProjectPath) {
          projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        }
        if (!projectPath && source === 'job') {
          const jobMeta = readJobMetaDirect(ref, ctx.paths);
          if (jobMeta?.project_path) {
            projectPath = resolveProjectPath(jobMeta.project_path, ctx.paths.projectsRoot);
          }
        }
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        if (source === 'branch' && !base) {
          base = await getDefaultBase(projectPath);
        }

        const dryRun = Boolean(req.body.dry_run);

        const reviewKey = computeReviewKey(projectPath, source, ref, base);
        const session = loadReviewSession(reviewKey, projectPath, source, ref, base, ctx.paths);

        const unsentComments = session.comments.filter((c) => !c.resolved && !c.sent_at);
        const rejectedHunks: Array<{ path: string; header: string }> = [];

        for (const [filePath, fileState] of Object.entries(session.states)) {
          if (fileState.file === 'rejected') {
            rejectedHunks.push({ path: filePath, header: '(entire file)' });
          }
          for (const [hunkId, state] of Object.entries(fileState.hunks)) {
            if (state === 'rejected') {
              const headerText = fileState.headers?.[hunkId] ?? hunkId;
              rejectedHunks.push({ path: filePath, header: headerText });
            }
          }
        }

        const note = typeof req.body.note === 'string' ? req.body.note : undefined;
        const projectName = path.basename(projectPath);

        const fixPromptResult = buildFixPrompt({
          projectName,
          source,
          ref,
          comments: unsentComments,
          rejectedHunks,
          note,
        });

        const prompt = fixPromptResult.prompt;
        const included = fixPromptResult.included;
        const remaining = fixPromptResult.remaining;

        if (dryRun) {
          return {
            ok: true,
            prompt,
            included: included.length,
            remaining: remaining.length,
          };
        }

        let targetAgent = typeof req.body.agent === 'string' ? req.body.agent.trim() : '';
        let targetRole = typeof req.body.role === 'string' ? req.body.role.trim() : '';
        let targetModel = typeof req.body.model === 'string' ? req.body.model.trim() : undefined;
        let targetEffort = typeof req.body.effort === 'string' ? req.body.effort.trim() : undefined;

        if (source === 'job' && ref) {
          const parentJob = readJobMetaDirect(ref, ctx.paths);
          if (parentJob) {
            if (!targetAgent && typeof parentJob.agent === 'string') {
              targetAgent = parentJob.agent;
            }
            if (!targetRole && typeof parentJob.role === 'string') {
              targetRole = parentJob.role;
            }
            if (!targetModel && typeof parentJob.model === 'string') {
              targetModel = parentJob.model;
            }
            if (!targetEffort && typeof parentJob.effort === 'string') {
              targetEffort = parentJob.effort;
            }
          }
        }

        const validRoles = new Set([
          'architect',
          'leader',
          'backend',
          'frontend',
          'reviewer',
          'tester',
        ]);
        if (!validRoles.has(targetRole)) {
          targetRole = 'backend';
        }

        if (!targetAgent) {
          throw new ApiValidationError('agent is required.', 400);
        }

        const diffRun = await runReviewDiff(
          {
            project_path: projectPath,
            source,
            ref,
            base,
          },
          ctx.paths
        );

        const executionPath = diffRun.target_path ?? projectPath;
        const jobResult = await ctx.startJob({
          mode: 'task',
          agent: targetAgent,
          role: targetRole,
          model: targetModel,
          effort: targetEffort,
          project_path: executionPath,
          prompt,
        });

        const childJobId = String(jobResult.job_id ?? '');
        const sentNow = new Date().toISOString();

        await withReviewLock(reviewKey, async () => {
          const freshSession = loadReviewSession(reviewKey, projectPath, source, ref, base, ctx.paths);
          const includedIds = new Set(included.map((c) => c.id));
          for (const c of freshSession.comments) {
            if (includedIds.has(c.id)) {
              c.sent_at = sentNow;
            }
          }
          if (childJobId) {
            freshSession.fix_jobs.push(childJobId);
          }
          saveReviewSession(freshSession, ctx.paths);
        });

        return {
          ok: true,
          prompt,
          job_id: childJobId,
          included: included.length,
          remaining: remaining.length,
        };
      },
    },

    review_verdict: {
      method: 'POST',
      handler: async (ctx, req) => {
        const source = String(req.body.source ?? 'worktree').trim();
        const ref = String(req.body.ref ?? '').trim();
        let base = String(req.body.base ?? '').trim();
        const rawProjectPath = String(req.body.project_path ?? '').trim();

        let projectPath: string | null = null;
        if (rawProjectPath) {
          projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        }
        if (!projectPath && source === 'job') {
          const jobMeta = readJobMetaDirect(ref, ctx.paths);
          if (jobMeta?.project_path) {
            projectPath = resolveProjectPath(jobMeta.project_path, ctx.paths.projectsRoot);
          }
        }
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        if (source === 'branch' && !base) {
          base = await getDefaultBase(projectPath);
        }

        const verdict = String(req.body.verdict ?? '').trim().toUpperCase();
        if (verdict !== 'APPROVED' && verdict !== 'CHANGES_REQUESTED') {
          throw new ApiValidationError(
            "verdict must be 'APPROVED' or 'CHANGES_REQUESTED'.",
            400
          );
        }

        const rawScore = Number(req.body.score);
        if (Number.isNaN(rawScore) || rawScore < 0 || rawScore > 10) {
          throw new ApiValidationError('score must be a number between 0 and 10.', 400);
        }
        const score = Math.round(rawScore * 10) / 10;
        const note = String(req.body.note ?? '').slice(0, 2000);

        const reviewKey = computeReviewKey(projectPath, source, ref, base);

        return await withReviewLock(reviewKey, async () => {
          const session = loadReviewSession(reviewKey, projectPath, source, ref, base, ctx.paths);

          const now = new Date().toISOString();
          session.verdict = {
            verdict: verdict as 'APPROVED' | 'CHANGES_REQUESTED',
            score,
            note,
            ts: now,
          };

          if (source === 'job' && ref) {
            const jobMeta = readJobMetaDirect(ref, ctx.paths);
            appendReviewVerdict(
              {
                ts: now,
                job_id: ref,
                agent: typeof jobMeta?.agent === 'string' ? jobMeta.agent : undefined,
                role: typeof jobMeta?.role === 'string' ? jobMeta.role : undefined,
                model: typeof jobMeta?.model === 'string' ? jobMeta.model : undefined,
                project_path: projectPath,
                verdict: verdict as 'APPROVED' | 'CHANGES_REQUESTED',
                score,
                note,
                reviewer: 'human',
              },
              ctx.paths
            );
          }

          saveReviewSession(session, ctx.paths);
          return {
            ok: true,
            verdict: session.verdict,
          };
        });
      },
    },

    review_verdicts: {
      method: 'GET',
      handler: async (ctx, req) => {
        const jobId = req.query.get('job_id') ?? undefined;
        const limitParam = req.query.has('limit')
          ? Number.parseInt(req.query.get('limit')!, 10)
          : 100;
        const limit = Number.isNaN(limitParam) ? 100 : limitParam;
        const verdicts = readReviewVerdicts(ctx.paths, jobId, limit);
        return {
          ok: true,
          verdicts,
        };
      },
    },
  },

  status: async (ctx) => {
    const verdicts = readReviewVerdicts(ctx.paths, undefined, 50);
    const verdicts_by_job: Record<string, { verdict: string; score: number }> = {};
    for (const v of verdicts) {
      if (v.job_id && !verdicts_by_job[v.job_id]) {
        verdicts_by_job[v.job_id] = {
          verdict: v.verdict,
          score: v.score,
        };
      }
    }

    let open_comments = 0;
    try {
      const sessionsDir = path.win32.join(ctx.paths.featureDataDir('review'), 'sessions');
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
        for (const f of files) {
          try {
            const raw = fs.readFileSync(path.win32.join(sessionsDir, f), 'utf8');
            const data = JSON.parse(raw) as Partial<ReviewSession>;
            if (Array.isArray(data.comments)) {
              for (const c of data.comments) {
                if (!c.resolved && !c.sent_at) {
                  open_comments++;
                }
              }
            }
          } catch {
            // Ignore corrupted session file in status
          }
        }
      }
    } catch {
      // Ignore scan error
    }

    return {
      verdicts_by_job,
      open_comments,
    };
  },

  ui: {
    script: 'feat-review.js',
    style: 'feat-review.css',
  },
};
