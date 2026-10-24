import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { refreshJobMetaStatus, type JobMeta } from '../../actions/jobs.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { launchSteerJob } from './launch.ts';
import {
  buildResumeCommand,
  buildSummaryPrompt,
  parseSessionRefFromLog,
} from './sessions.ts';

export interface SteerEntry {
  id: string;
  ts: string;
  strategy: 'live' | 'queue' | 'resume' | 'summary';
  message: string;
  status: 'sent' | 'queued' | 'started' | 'failed' | 'cancelled';
  child_job_id?: string;
  error?: string;
}

export interface SteerData {
  job_id: string;
  root_job_id: string;
  entries: SteerEntry[];
}

let queueTimer: NodeJS.Timeout | null = null;
let isQueueProcessing = false;
const inFlightLaunches = new Set<string>();

const jobWriteChains = new Map<string, Promise<unknown>>();

export function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const previous = jobWriteChains.get(jobId) ?? Promise.resolve();

  const run = async (): Promise<T> => {
    try {
      await previous;
    } catch {
      // previous lock error should not block next execution
    }
    return await fn();
  };

  const resultPromise = run();
  const chainPromise = resultPromise
    .catch(() => {})
    .finally(() => {
      if (jobWriteChains.get(jobId) === chainPromise) {
        jobWriteChains.delete(jobId);
      }
    });

  jobWriteChains.set(jobId, chainPromise);
  return resultPromise;
}

export function getSteerFilePath(jobId: string, paths: ServerPaths): string {
  const dataDir = paths.featureDataDir('steer');
  return path.win32.join(dataDir, `${jobId}.json`);
}

export function loadSteerData(jobId: string, paths: ServerPaths): SteerData {
  const filePath = getSteerFilePath(jobId, paths);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SteerData>;
      return {
        job_id: jobId,
        root_job_id: parsed.root_job_id ?? jobId,
        entries: Array.isArray(parsed.entries) ? (parsed.entries as SteerEntry[]) : [],
      };
    } catch {
      // Corrupt file fallback
    }
  }

  return {
    job_id: jobId,
    root_job_id: jobId,
    entries: [],
  };
}

export function saveSteerData(data: SteerData, paths: ServerPaths): void {
  const filePath = getSteerFilePath(data.job_id, paths);
  const dataDir = paths.featureDataDir('steer');
  const tmpFile = path.win32.join(
    dataDir,
    `.tmp_steer_${data.job_id}_${crypto.randomBytes(4).toString('hex')}.json`
  );
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, filePath);
}

export function appendSteerLogLine(
  jobId: string,
  strategy: string,
  targetId: string,
  message: string,
  paths: ServerPaths
): void {
  const logFile = path.win32.join(paths.jobsDir, `${jobId}.log`);
  if (!fs.existsSync(logFile)) {
    return;
  }
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const first200 = message.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const logLine = `\n[STEER ${timeStr}] ${strategy} → ${targetId}: ${first200}\n`;
  try {
    fs.appendFileSync(logFile, logLine, 'utf8');
  } catch {
    // Ignore log append error
  }
}

export function findJobChain(
  jobId: string,
  allJobsMap: Map<string, JobMeta>
): string[] {
  // Step 1: Upwards to root
  const chainUp: string[] = [];
  let cur: string | undefined = jobId;
  const visited = new Set<string>();

  while (cur && !visited.has(cur)) {
    visited.add(cur);
    chainUp.unshift(cur);
    const meta: any = allJobsMap.get(cur);
    cur = meta && typeof meta.parent_job_id === 'string' && meta.parent_job_id.trim()
      ? meta.parent_job_id.trim()
      : undefined;
  }

  // Step 2: Downwards from root
  const rootId = chainUp[0]!;
  const fullChain: string[] = [rootId];
  let currentParent = rootId;

  const childrenMap = new Map<string, string[]>();
  for (const meta of allJobsMap.values()) {
    const pId = (meta as any).parent_job_id;
    if (typeof pId === 'string' && pId) {
      if (!childrenMap.has(pId)) {
        childrenMap.set(pId, []);
      }
      childrenMap.get(pId)!.push(meta.job_id);
    }
  }

  while (childrenMap.has(currentParent)) {
    const children = childrenMap.get(currentParent)!;
    if (children.length === 0) break;
    // Follow the newest or matching child
    const nextChild = children[0]!;
    fullChain.push(nextChild);
    currentParent = nextChild;
  }

  if (!fullChain.includes(jobId)) {
    fullChain.push(jobId);
  }

  return fullChain;
}

export function countTotalQueued(paths: ServerPaths): number {
  let queuedCount = 0;
  try {
    const steerDir = paths.featureDataDir('steer');
    if (!fs.existsSync(steerDir)) return 0;
    const files = fs.readdirSync(steerDir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.win32.join(steerDir, f), 'utf8');
        const data = JSON.parse(raw) as Partial<SteerData>;
        if (Array.isArray(data.entries)) {
          queuedCount += data.entries.filter((e) => e.status === 'queued').length;
        }
      } catch {
        // Ignore file read error
      }
    }
  } catch {
    return 0;
  }
  return queuedCount;
}

export function ensureQueueProcessorRunning(ctx: MawFeatureContext): void {
  const queued = countTotalQueued(ctx.paths);
  if (queued > 0 && !queueTimer) {
    queueTimer = setInterval(() => {
      runQueueProcessor(ctx).catch(() => {});
    }, 5000);
    queueTimer.unref();
  } else if (queued === 0 && queueTimer) {
    clearInterval(queueTimer);
    queueTimer = null;
  }
}

export async function runQueueProcessor(ctx: MawFeatureContext): Promise<void> {
  if (isQueueProcessing) {
    return;
  }
  isQueueProcessing = true;

  try {
    const steerDir = ctx.paths.featureDataDir('steer');
    if (!fs.existsSync(steerDir)) {
      return;
    }

    const files = fs.readdirSync(steerDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const jobId = path.basename(file, '.json');
      await withJobLock(jobId, async () => {
        const data = loadSteerData(jobId, ctx.paths);

        // Check for orphaned "started" entries after server restart / crash (> 2 minutes old with no child_job_id and not in flight)
        let hasOrphanedFixes = false;
        const nowMs = Date.now();
        for (const entry of data.entries) {
          if (entry.status === 'started' && !entry.child_job_id && !inFlightLaunches.has(entry.id)) {
            const entryAgeMs = nowMs - new Date(entry.ts).getTime();
            if (entryAgeMs > 2 * 60 * 1000) {
              entry.status = 'failed';
              entry.error = 'Server stopped during launch; send again.';
              hasOrphanedFixes = true;
            }
          }
        }
        if (hasOrphanedFixes) {
          saveSteerData(data, ctx.paths);
        }

        const queuedEntries = data.entries.filter((e) => e.status === 'queued');
        if (queuedEntries.length === 0) {
          return;
        }

        // Check parent job status
        const jobMetaFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.json`);
        if (!fs.existsSync(jobMetaFile)) {
          for (const e of queuedEntries) {
            e.status = 'failed';
            e.error = 'Parent job meta not found.';
          }
          saveSteerData(data, ctx.paths);
          return;
        }

        let meta: JobMeta;
        try {
          meta = JSON.parse(fs.readFileSync(jobMetaFile, 'utf8')) as JobMeta;
        } catch {
          for (const e of queuedEntries) {
            e.status = 'failed';
            e.error = 'Parent job meta is corrupt.';
          }
          saveSteerData(data, ctx.paths);
          return;
        }

        const refreshed = await refreshJobMetaStatus(meta, ctx.paths.jobsDir, { checkPid: true });
        if (refreshed.status === 'RUNNING') {
          // Still running, keep queued
          return;
        }

        const validatedProject = resolveProjectPath(meta.project_path, ctx.paths.projectsRoot);
        if (!validatedProject) {
          for (const e of queuedEntries) {
            e.status = 'failed';
            e.error = 'Invalid parent project_path.';
          }
          saveSteerData(data, ctx.paths);
          return;
        }

        // Re-load steer file, re-check that each entry is still "queued"
        const freshData = loadSteerData(jobId, ctx.paths);
        const toLaunch = freshData.entries.filter((e) => e.status === 'queued');
        if (toLaunch.length === 0) {
          return; // Entries were cancelled
        }
        const toLaunchIds = new Set(toLaunch.map((e) => e.id));

        // Mark them "started" and save BEFORE the await on the launch
        for (const entry of toLaunch) {
          entry.status = 'started';
          inFlightLaunches.add(entry.id);
        }
        saveSteerData(freshData, ctx.paths);

        // Parent is no longer RUNNING: process queued entries
        const mergedMessage = toLaunch.map((e) => e.message).join('\n\n---\n\n');
        const logFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.log`);
        const logContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
        const promptFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.prompt.txt`);
        const originalPrompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';

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
          agent = (meta as any).implementer || ctx.registry.defaults?.implementer || 'claude';
          role = 'backend';
        }
        if (!agent) agent = 'antigravity';

        const VALID_TASK_ROLES = new Set([
          'architect',
          'leader',
          'backend',
          'frontend',
          'reviewer',
          'tester',
        ]);
        const effectiveRole = VALID_TASK_ROLES.has(role) ? role : 'backend';
        const agentEntry = ctx.registry.agents.find((a) => a.id === agent);

        const sessionRef = parseSessionRefFromLog(
          logContent,
          agent,
          validatedProject,
          ctx.paths,
          agentEntry
        );
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

        let childJobId: string | null = null;
        let launchError: string | null = null;

        try {
          if (resumeCmd) {
            // Launch steer job
            const steerRes = await launchSteerJob({
              parentJobId: jobId,
              agent,
              role: effectiveRole,
              model: meta.model,
              effort: meta.effort,
              projectPath: validatedProject,
              prompt: mergedMessage,
              commandExe: resumeCmd.exe,
              commandArgs: resumeCmd.args,
              promptVia: resumeCmd.promptVia,
              paths: ctx.paths,
              registry: ctx.registry,
              strategy: 'resume',
            });
            childJobId = steerRes.job_id;
            appendSteerLogLine(jobId, 'resume', steerRes.job_id, mergedMessage, ctx.paths);
          } else {
            // Fall back to summary
            const summaryPrompt = buildSummaryPrompt({
              jobId,
              agent,
              role: effectiveRole,
              projectPath: validatedProject,
              originalPrompt,
              logTail: logContent,
              message: mergedMessage,
            });

            const jobResult = await ctx.startJob({
              mode: 'task',
              agent,
              role: effectiveRole,
              model: meta.model,
              effort: meta.effort,
              project_path: validatedProject,
              prompt: summaryPrompt,
            });
            childJobId = String(jobResult.job_id ?? '');
            appendSteerLogLine(jobId, 'summary', childJobId, mergedMessage, ctx.paths);
          }
        } catch (err: unknown) {
          launchError = err instanceof Error ? err.message : String(err);
        } finally {
          for (const entry of toLaunch) {
            inFlightLaunches.delete(entry.id);
          }
        }

        // Re-load again and patch ONLY toLaunchIds
        const afterLaunchData = loadSteerData(jobId, ctx.paths);
        for (const entry of afterLaunchData.entries) {
          if (toLaunchIds.has(entry.id)) {
            if (launchError) {
              entry.status = 'failed';
              entry.error = launchError;
            } else if (childJobId) {
              entry.status = 'started';
              entry.child_job_id = childJobId;
            }
          }
        }
        saveSteerData(afterLaunchData, ctx.paths);
      });
    }
  } finally {
    isQueueProcessing = false;
    ensureQueueProcessorRunning(ctx);
  }
}
