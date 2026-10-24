import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { refreshJobMetaStatus, type JobMeta } from '../../actions/jobs.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
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
      const data = loadSteerData(jobId, ctx.paths);
      const queuedEntries = data.entries.filter((e) => e.status === 'queued');
      if (queuedEntries.length === 0) {
        continue;
      }

      // Check parent job status
      const jobMetaFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.json`);
      if (!fs.existsSync(jobMetaFile)) {
        continue;
      }

      let meta: JobMeta;
      try {
        meta = JSON.parse(fs.readFileSync(jobMetaFile, 'utf8')) as JobMeta;
      } catch {
        continue;
      }

      const refreshed = await refreshJobMetaStatus(meta, ctx.paths.jobsDir, { checkPid: true });
      if (refreshed.status === 'RUNNING') {
        // Still running, keep queued
        continue;
      }

      // Parent is no longer RUNNING: process queued entries
      const mergedMessage = queuedEntries.map((e) => e.message).join('\n\n---\n\n');
      const logFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.log`);
      const logContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      const promptFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.prompt.txt`);
      const originalPrompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';

      const agent = meta.agent ?? (meta.mode === 'claude' ? 'claude' : meta.mode === 'codex' ? 'codex' : 'antigravity');
      const role = meta.role ?? 'backend';
      const agentEntry = ctx.registry.agents.find((a) => a.id === agent);

      const sessionRef = parseSessionRefFromLog(logContent, agent, meta.project_path, ctx.paths, agentEntry);
      const resumeCmd = sessionRef && sessionRef.exists
        ? buildResumeCommand({
            platform: agent,
            sessionId: sessionRef.id,
            model: meta.model,
            effort: meta.effort,
            registryAgent: agentEntry,
          })
        : null;

      try {
        if (resumeCmd) {
          // Launch steer job
          const steerRes = await launchSteerJob({
            parentJobId: jobId,
            agent,
            role,
            model: meta.model,
            effort: meta.effort,
            projectPath: meta.project_path,
            prompt: mergedMessage,
            commandExe: resumeCmd.exe,
            commandArgs: resumeCmd.args,
            paths: ctx.paths,
            registry: ctx.registry,
            strategy: 'resume',
          });

          for (const entry of queuedEntries) {
            entry.status = 'started';
            entry.child_job_id = steerRes.job_id;
          }
          appendSteerLogLine(jobId, 'resume', steerRes.job_id, mergedMessage, ctx.paths);
        } else {
          // Fall back to summary
          const summaryPrompt = buildSummaryPrompt({
            jobId,
            agent,
            role,
            projectPath: meta.project_path,
            originalPrompt,
            logTail: logContent,
            message: mergedMessage,
          });

          const jobResult = await ctx.startJob({
            mode: 'task',
            agent,
            role,
            model: meta.model,
            effort: meta.effort,
            project_path: meta.project_path,
            prompt: summaryPrompt,
          });

          const childJobId = String(jobResult.job_id ?? '');
          for (const entry of queuedEntries) {
            entry.status = 'started';
            entry.child_job_id = childJobId;
          }
          appendSteerLogLine(jobId, 'summary', childJobId, mergedMessage, ctx.paths);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        for (const entry of queuedEntries) {
          entry.status = 'failed';
          entry.error = errMsg;
        }
      }

      saveSteerData(data, ctx.paths);
    }
  } finally {
    isQueueProcessing = false;
    ensureQueueProcessorRunning(ctx);
  }
}
