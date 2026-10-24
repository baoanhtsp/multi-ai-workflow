import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { refreshJobMetaStatus, type JobMeta } from '../../actions/jobs.ts';
import type { MawFeature } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { isValidJobId } from '../review/git.ts';
import { launchSteerJob } from './launch.ts';
import {
  appendSteerLogLine,
  ensureQueueProcessorRunning,
  findJobChain,
  loadSteerData,
  runQueueProcessor,
  saveSteerData,
  type SteerEntry,
} from './queue.ts';
import {
  buildResumeCommand,
  buildSummaryPrompt,
  parseSessionRefFromLog,
} from './sessions.ts';

function readJobLogSafe(logPath: string, maxBytes = 8 * 1024 * 1024): string {
  if (!fs.existsSync(logPath)) {
    return '';
  }
  try {
    const st = fs.statSync(logPath);
    if (st.size <= 0) return '';
    const readLen = Math.min(st.size, maxBytes);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, Math.max(0, st.size - readLen));
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

const VALID_TASK_ROLES = new Set([
  'architect',
  'leader',
  'backend',
  'frontend',
  'reviewer',
  'tester',
]);

function resolveAgentAndRole(meta: JobMeta, registryDefaults?: { implementer?: string }): {
  agent: string;
  role: string;
} {
  let agent = meta.agent;
  let role = meta.role;

  if (meta.mode === 'antigravity' || (!agent && meta.mode === 'antigravity')) {
    agent = 'antigravity';
  } else if (meta.mode === 'claude') {
    agent = 'claude';
  } else if (meta.mode === 'codex') {
    agent = 'codex';
  } else if (
    meta.mode === 'council' ||
    meta.mode === 'auto-gate' ||
    meta.mode === 'spec-guard'
  ) {
    agent = (meta as any).implementer || registryDefaults?.implementer || 'claude';
    role = 'backend';
  }

  if (!agent) {
    agent = 'antigravity';
  }

  const effectiveRole = VALID_TASK_ROLES.has(role) ? role : 'backend';
  return { agent, role: effectiveRole };
}

export const feature: MawFeature = {
  name: 'steer',
  routes: {
    steer_info: {
      method: 'GET',
      handler: async (ctx, req) => {
        const jobId = String(req.query.get('job_id') ?? '').trim();
        if (!isValidJobId(jobId)) {
          throw new ApiValidationError('Invalid job_id.', 400);
        }

        const metaFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.json`);
        if (!fs.existsSync(metaFile)) {
          throw new ApiValidationError(`Job '${jobId}' not found.`, 404);
        }

        let meta: JobMeta;
        try {
          meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
        } catch {
          throw new ApiValidationError(`Corrupted job meta for '${jobId}'.`, 500);
        }

        meta = await refreshJobMetaStatus(meta, ctx.paths.jobsDir, { checkPid: true });

        const validatedProject = resolveProjectPath(meta.project_path, ctx.paths.projectsRoot);
        if (!validatedProject) {
          throw new ApiValidationError('Invalid project_path in job meta.', 400);
        }

        const logFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.log`);
        const logContent = readJobLogSafe(logFile);

        const { agent, role } = resolveAgentAndRole(meta, ctx.registry.defaults);
        const agentEntry = ctx.registry.agents.find((a) => a.id === agent);

        const sessionRef = parseSessionRefFromLog(
          logContent,
          agent,
          validatedProject,
          ctx.paths,
          agentEntry
        );

        const isRunning = meta.status === 'RUNNING';
        const isAntigravity = agent.toLowerCase() === 'antigravity' || meta.mode === 'antigravity';

        const resumeCmd =
          sessionRef && sessionRef.exists
            ? buildResumeCommand({
                platform: agent,
                sessionId: sessionRef.id,
                model: meta.model,
                effort: meta.effort,
                projectPath: validatedProject,
                paths: ctx.paths,
                registryAgent: agentEntry,
              })
            : null;

        const liveAvailable = isRunning && isAntigravity && Boolean(sessionRef?.id);
        const queueAvailable = isRunning && !liveAvailable;
        const resumeAvailable = !isRunning && Boolean(resumeCmd);
        const summaryAvailable = !isRunning;

        const strategies = {
          live: liveAvailable,
          queue: queueAvailable,
          resume: resumeAvailable,
          summary: summaryAvailable,
        };

        let recommended = 'summary';
        if (isRunning) {
          recommended = liveAvailable ? 'live' : 'queue';
        } else {
          recommended = resumeAvailable ? 'resume' : 'summary';
        }

        // Find chain
        const allJobs = await ctx.readJobs();
        const allJobsMap = new Map<string, JobMeta>();
        for (const j of allJobs) {
          if (j.job_id) {
            allJobsMap.set(String(j.job_id), j as unknown as JobMeta);
          }
        }
        allJobsMap.set(jobId, meta);
        const chain = findJobChain(jobId, allJobsMap);

        const steerData = loadSteerData(jobId, ctx.paths);

        // Run queue processor in background
        runQueueProcessor(ctx).catch(() => {});

        return {
          ok: true,
          job: {
            job_id: meta.job_id,
            status: meta.status,
            mode: meta.mode,
            agent,
            role,
            model: meta.model,
            project_path: validatedProject,
            parent_job_id: (meta as any).parent_job_id,
          },
          session_ref: sessionRef,
          strategies,
          recommended,
          history: steerData.entries,
          chain,
        };
      },
    },

    steer_send: {
      method: 'POST',
      handler: async (ctx, req) => {
        const jobId = String(req.body.job_id ?? '').trim();
        if (!isValidJobId(jobId)) {
          throw new ApiValidationError('Invalid job_id.', 400);
        }

        const message = String(req.body.message ?? '').trim();
        if (!message || message.length > 20000) {
          throw new ApiValidationError('message must be between 1 and 20000 characters.', 400);
        }

        const metaFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.json`);
        if (!fs.existsSync(metaFile)) {
          throw new ApiValidationError(`Job '${jobId}' not found.`, 404);
        }

        let meta: JobMeta;
        try {
          meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
        } catch {
          throw new ApiValidationError(`Corrupted job meta for '${jobId}'.`, 500);
        }

        meta = await refreshJobMetaStatus(meta, ctx.paths.jobsDir, { checkPid: true });

        const validatedProject = resolveProjectPath(meta.project_path, ctx.paths.projectsRoot);
        if (!validatedProject) {
          throw new ApiValidationError('Invalid project_path in job meta.', 400);
        }

        const logFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.log`);
        const logContent = readJobLogSafe(logFile);

        const { agent, role } = resolveAgentAndRole(meta, ctx.registry.defaults);
        const agentEntry = ctx.registry.agents.find((a) => a.id === agent);

        const sessionRef = parseSessionRefFromLog(
          logContent,
          agent,
          validatedProject,
          ctx.paths,
          agentEntry
        );

        const isRunning = meta.status === 'RUNNING';
        const isAntigravity = agent.toLowerCase() === 'antigravity' || meta.mode === 'antigravity';

        const resumeCmd =
          sessionRef && sessionRef.exists
            ? buildResumeCommand({
                platform: agent,
                sessionId: sessionRef.id,
                model: typeof req.body.model === 'string' ? req.body.model : meta.model,
                effort: typeof req.body.effort === 'string' ? req.body.effort : meta.effort,
                projectPath: validatedProject,
                paths: ctx.paths,
                registryAgent: agentEntry,
              })
            : null;

        const liveAvailable = isRunning && isAntigravity && Boolean(sessionRef?.id);
        const queueAvailable = isRunning && !liveAvailable;
        const resumeAvailable = !isRunning && Boolean(resumeCmd);
        const summaryAvailable = !isRunning;

        const rawStrategy = String(req.body.strategy ?? 'auto').trim().toLowerCase();
        let strategy: 'live' | 'queue' | 'resume' | 'summary';

        if (rawStrategy === 'auto' || !rawStrategy) {
          if (isRunning) {
            strategy = liveAvailable ? 'live' : 'queue';
          } else {
            strategy = resumeAvailable ? 'resume' : 'summary';
          }
        } else if (
          rawStrategy === 'live' ||
          rawStrategy === 'queue' ||
          rawStrategy === 'resume' ||
          rawStrategy === 'summary'
        ) {
          strategy = rawStrategy;
        } else {
          throw new ApiValidationError(
            "Invalid strategy. Expected 'auto', 'live', 'queue', 'resume', or 'summary'.",
            400
          );
        }

        // Validate strategy availability
        if (strategy === 'live' && !liveAvailable) {
          throw new ApiValidationError(
            'Strategy live is not available (job must be RUNNING, agent antigravity, conversation id known).',
            409
          );
        }
        if (strategy === 'queue' && !queueAvailable) {
          throw new ApiValidationError('Strategy queue is not available (job must be RUNNING).', 409);
        }
        if (strategy === 'resume' && !resumeAvailable) {
          throw new ApiValidationError(
            'Strategy resume is not available (session ref missing, expired, or platform not resumable).',
            409
          );
        }
        if (strategy === 'summary' && !summaryAvailable) {
          throw new ApiValidationError(
            'Strategy summary is only available when the job has finished.',
            409
          );
        }

        const entryId = crypto.randomBytes(4).toString('hex');
        const now = new Date().toISOString();
        const steerData = loadSteerData(jobId, ctx.paths);

        const entry: SteerEntry = {
          id: entryId,
          ts: now,
          strategy,
          message,
          status: 'started',
        };

        if (strategy === 'live') {
          const tmpDir = path.win32.join(ctx.paths.featureDataDir('steer'), 'tmp');
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
          }
          const promptFile = path.win32.join(tmpDir, `steer_prompt_${entryId}.txt`);
          fs.writeFileSync(promptFile, '\uFEFF' + message, 'utf8');

          const scriptPath = path.win32.join(ctx.paths.scriptsDir, 'invoke-antigravity.ps1');
          const runRes = await runCommand(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              scriptPath,
              '-Action',
              'send',
              '-ConversationId',
              sessionRef!.id,
              '-WorkDir',
              validatedProject,
              '-Title',
              'Steer from Mission Control',
              '-PromptFile',
              promptFile,
              '-NoWait',
            ],
            { timeoutMs: 60000 }
          );

          if (fs.existsSync(promptFile)) {
            try {
              fs.unlinkSync(promptFile);
            } catch {}
          }

          if (runRes.code !== 0) {
            entry.status = 'failed';
            entry.error = runRes.stderr || runRes.stdout || `Exit code ${runRes.code}`;
          } else {
            entry.status = 'sent';
            appendSteerLogLine(jobId, 'live', sessionRef!.id, message, ctx.paths);
          }
        } else if (strategy === 'queue') {
          entry.status = 'queued';
          ensureQueueProcessorRunning(ctx);
        } else if (strategy === 'resume') {
          try {
            const steerRes = await launchSteerJob({
              parentJobId: jobId,
              agent,
              role,
              model: typeof req.body.model === 'string' ? req.body.model : meta.model,
              effort: typeof req.body.effort === 'string' ? req.body.effort : meta.effort,
              projectPath: validatedProject,
              prompt: message,
              commandExe: resumeCmd!.exe,
              commandArgs: resumeCmd!.args,
              promptVia: resumeCmd!.promptVia,
              paths: ctx.paths,
              registry: ctx.registry,
              strategy: 'resume',
            });
            entry.status = 'started';
            entry.child_job_id = steerRes.job_id;
            appendSteerLogLine(jobId, 'resume', steerRes.job_id, message, ctx.paths);
          } catch (err: unknown) {
            entry.status = 'failed';
            entry.error = err instanceof Error ? err.message : String(err);
            steerData.entries.push(entry);
            saveSteerData(steerData, ctx.paths);
            throw err;
          }
        } else if (strategy === 'summary') {
          const promptFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.prompt.txt`);
          const originalPrompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';

          const summaryPrompt = buildSummaryPrompt({
            jobId,
            agent,
            role,
            projectPath: validatedProject,
            originalPrompt,
            logTail: logContent,
            message,
          });

          try {
            const jobResult = await ctx.startJob({
              mode: 'task',
              agent,
              role,
              model: typeof req.body.model === 'string' ? req.body.model : meta.model,
              effort: typeof req.body.effort === 'string' ? req.body.effort : meta.effort,
              project_path: validatedProject,
              prompt: summaryPrompt,
            });

            const childJobId = String(jobResult.job_id ?? '');
            entry.status = 'started';
            entry.child_job_id = childJobId;
            appendSteerLogLine(jobId, 'summary', childJobId, message, ctx.paths);
          } catch (err: unknown) {
            entry.status = 'failed';
            entry.error = err instanceof Error ? err.message : String(err);
            steerData.entries.push(entry);
            saveSteerData(steerData, ctx.paths);
            throw err;
          }
        }

        steerData.entries.push(entry);
        saveSteerData(steerData, ctx.paths);

        return {
          ok: true,
          entry,
          child_job_id: entry.child_job_id,
        };
      },
    },

    steer_cancel: {
      method: 'POST',
      handler: async (ctx, req) => {
        const jobId = String(req.body.job_id ?? '').trim();
        const entryId = String(req.body.entry_id ?? '').trim();
        if (!isValidJobId(jobId)) {
          throw new ApiValidationError('Invalid job_id.', 400);
        }

        const steerData = loadSteerData(jobId, ctx.paths);
        const entry = steerData.entries.find((e) => e.id === entryId);
        if (!entry) {
          throw new ApiValidationError(`Entry '${entryId}' not found.`, 404);
        }

        if (entry.status !== 'queued') {
          throw new ApiValidationError('Only queued entries can be cancelled.', 409);
        }

        entry.status = 'cancelled';
        saveSteerData(steerData, ctx.paths);
        ensureQueueProcessorRunning(ctx);

        return {
          ok: true,
        };
      },
    },

    steer_history: {
      method: 'GET',
      handler: async (ctx, req) => {
        const jobId = String(req.query.get('job_id') ?? '').trim();
        if (!isValidJobId(jobId)) {
          throw new ApiValidationError('Invalid job_id.', 400);
        }

        const allJobs = await ctx.readJobs();
        const allJobsMap = new Map<string, JobMeta>();
        for (const j of allJobs) {
          if (j.job_id) {
            allJobsMap.set(String(j.job_id), j as unknown as JobMeta);
          }
        }

        const chain = findJobChain(jobId, allJobsMap);
        const entries: Array<SteerEntry & { job_id: string }> = [];

        for (const cId of chain) {
          const steerData = loadSteerData(cId, ctx.paths);
          for (const e of steerData.entries) {
            entries.push({
              job_id: cId,
              ...e,
            });
          }
        }

        return {
          ok: true,
          chain,
          entries,
        };
      },
    },
  },

  status: async (ctx) => {
    await runQueueProcessor(ctx);

    const steerDir = ctx.paths.featureDataDir('steer');
    const jobs: Record<string, { entries: number; queued: number; last_child_job_id?: string }> = {};
    let totalQueued = 0;

    if (fs.existsSync(steerDir)) {
      const files = fs.readdirSync(steerDir).filter((f) => f.endsWith('.json'));
      const fileStats = files
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.win32.join(steerDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30);

      for (const item of fileStats) {
        const jId = path.basename(item.name, '.json');
        const data = loadSteerData(jId, ctx.paths);
        const queuedCount = data.entries.filter((e) => e.status === 'queued').length;
        totalQueued += queuedCount;

        const startedEntries = data.entries.filter((e) => e.child_job_id);
        const lastChildId =
          startedEntries.length > 0
            ? startedEntries[startedEntries.length - 1]!.child_job_id
            : undefined;

        jobs[jId] = {
          entries: data.entries.length,
          queued: queuedCount,
          last_child_job_id: lastChildId,
        };
      }
    }

    return {
      queued: totalQueued,
      jobs,
    };
  },

  ui: {
    script: 'feat-steer.js',
    style: 'feat-steer.css',
  },
};
