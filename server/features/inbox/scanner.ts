import fs from 'node:fs';
import path from 'node:path';
import { refreshJobMetaStatus, type JobMeta } from '../../actions/jobs.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { AUTH_PATTERNS, RATE_PATTERNS, classifyLog } from '../health/patterns.ts';
import { redactSecrets } from '../health/probes.ts';
import { reconcilePendingClaims } from './actions.ts';
import {
  addInboxItem,
  readInboxData,
  updateInboxItemStatus,
  withItemsLock,
  writeInboxData,
  type InboxAction,
  type InboxItem,
  type InboxKind,
  type InboxRetryInfo,
  type InboxSeverity,
} from './store.ts';

interface MemoEntry {
  status: string;
  logSize: number;
  lastScannedAt: number;
}

interface RunningJobTracker {
  logSize: number;
  lastGrewAt: number;
}

const memoMap = new Map<string, MemoEntry>();
const runningTrackers = new Map<string, RunningJobTracker>();
const currentJobFlags: Record<string, 'needs_login' | 'rate_limited' | 'needs_input' | 'blocked'> = {};

let bgTimer: NodeJS.Timeout | null = null;

export function getJobFlags(): Record<
  string,
  'needs_login' | 'rate_limited' | 'needs_input' | 'blocked'
> {
  return { ...currentJobFlags };
}

function readPromptFile(jobsDir: string, jobId: string): string {
  const promptFile = path.win32.join(jobsDir, `${jobId}.prompt.txt`);
  if (!isFileSafe(promptFile)) {
    return '';
  }
  try {
    const raw = fs.readFileSync(promptFile, 'utf8').replace(/^\uFEFF/, '');
    return raw.slice(0, 20000);
  } catch {
    return '';
  }
}

export function buildMeaningfulDetail(
  tail: string,
  kind?: InboxKind,
  agentName?: string,
  userProfile?: string
): string {
  if (!tail || !tail.trim()) {
    return '';
  }

  const rawLines = tail.replace(/\r\n/g, '\n').split('\n');

  // Filter out noise lines: header blocks, Mode/Started lines, rulers, job_finished markers
  const meaningfulLines = rawLines
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^=== \[(MISSION CONTROL JOB|JOB_FINISHED)/i.test(l)) return false;
      if (/^(Mode|Started|Agent|Role|Project):\s+/i.test(l)) return false;
      if (/^[-=_]{3,}$/.test(l)) return false;
      return true;
    });

  if (meaningfulLines.length === 0) {
    return '';
  }

  // For needs_login / rate_limited: prefer the line(s) that matched the pattern
  if (kind === 'needs_login' || kind === 'rate_limited') {
    const norm = agentName?.toLowerCase() ?? '';
    const patterns =
      kind === 'needs_login'
        ? (AUTH_PATTERNS[norm] ?? AUTH_PATTERNS['*'] ?? [])
        : RATE_PATTERNS;

    const matchedIndices: number[] = [];
    meaningfulLines.forEach((line, idx) => {
      if (patterns.some((p) => p.test(line))) {
        matchedIndices.push(idx);
      }
    });

    if (matchedIndices.length > 0) {
      const firstMatch = matchedIndices[0]!;
      const start = Math.max(0, firstMatch - 1);
      const end = Math.min(meaningfulLines.length, start + 8);
      const chunk = meaningfulLines.slice(start, end).join('\n');
      return redactSecrets(chunk, userProfile);
    }
  }

  // Default: last <= 8 meaningful lines
  const last8 = meaningfulLines.slice(-8).join('\n');
  return redactSecrets(last8, userProfile);
}

function readLogTailSafe(logFile: string, maxBytes = 16384): string {
  if (!isFileSafe(logFile)) {
    return '';
  }
  try {
    const st = fs.statSync(logFile);
    if (st.size <= 0) return '';
    const readLen = Math.min(st.size, maxBytes);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const n = fs.readSync(fd, buf, 0, readLen, Math.max(0, st.size - readLen));
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

const INPUT_PROMPT_REGEX =
  /(\?|\(y\/n\)|\[y\/N\]|\[Y\/n\]|press enter|waiting for (your )?input|continue\?)\s*$/i;

export async function runJobScanner(paths: ServerPaths): Promise<void> {
  // First apply any pending claim that records a job_id (Codex Review #5 Item 2)
  reconcilePendingClaims(paths);

  if (!isDirectorySafe(paths.jobsDir)) {
    return;
  }

  const now = Date.now();
  let files: string[] = [];
  try {
    files = fs.readdirSync(paths.jobsDir).filter((f) => f.startsWith('job_') && f.endsWith('.json'));
  } catch {
    return;
  }

  for (const metaFile of files) {
    const jobId = metaFile.replace(/\.json$/, '');
    const metaPath = path.win32.join(paths.jobsDir, metaFile);
    const logPath = path.win32.join(paths.jobsDir, `${jobId}.log`);

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    let status = String(meta.status ?? '').toUpperCase();

    // Call refreshJobMetaStatus for every RUNNING meta before classifying (Item 10)
    if (status === 'RUNNING') {
      try {
        meta = (await refreshJobMetaStatus(meta as unknown as JobMeta, paths.jobsDir)) as unknown as Record<string, unknown>;
        status = String(meta.status ?? '').toUpperCase();
      } catch {
        // Continue with unrefreshed status on error
      }
    }

    let logSize = 0;
    try {
      if (isFileSafe(logPath)) {
        logSize = fs.statSync(logPath).size;
      }
    } catch {
      // Ignore
    }

    // 1. Tracker for RUNNING jobs: check if log hasn't grown for >= 90s and last non-empty line asks for input
    if (status === 'RUNNING') {
      let tracker = runningTrackers.get(jobId);
      if (!tracker) {
        tracker = { logSize, lastGrewAt: now };
        runningTrackers.set(jobId, tracker);
      } else if (logSize > tracker.logSize) {
        tracker.logSize = logSize;
        tracker.lastGrewAt = now;
      } else if (now - tracker.lastGrewAt >= 90000) {
        // Log has not grown for 90s
        const tail = readLogTailSafe(logPath, 4096);
        const lastLine = tail
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (lastLine && INPUT_PROMPT_REGEX.test(lastLine)) {
          currentJobFlags[jobId] = 'needs_input';
          const prompt = readPromptFile(paths.jobsDir, jobId);
          addInboxItem(
            paths,
            {
              kind: 'needs_input',
              severity: 'warn',
              title: `${meta.agent ?? jobId}: waiting for input`,
              detail: lastLine,
              agent: meta.agent as string,
              role: meta.role as string,
              job_id: jobId,
              project: meta.project_path as string,
              source: 'jobs',
              actions: ['open', 'reply', 'dismiss'],
              dedupe_key: `job:${jobId}:needs_input`,
              retry: {
                mode: meta.mode as string,
                agent: meta.agent as string,
                role: meta.role as string,
                project_path: meta.project_path as string,
                prompt,
                model: (meta.model as string) ?? '',
                effort: (meta.effort as string) ?? '',
                team: meta.team as Record<string, string>,
                reviewers: meta.reviewers as string[],
                implementer: meta.implementer as string,
              },
            },
            { onlyIfAbsent: true }
          );
        }
      }
      continue;
    }

    // Job ended: clean up running tracker and resolve any needs_input
    if (runningTrackers.has(jobId)) {
      try {
        withItemsLock(paths, () => {
          const inboxData = readInboxData(paths);
          let changed = false;
          for (const item of inboxData.items) {
            if (item.job_id === jobId && item.kind === 'needs_input' && item.status === 'open') {
              item.status = 'done';
              item.updated_at = new Date().toISOString();
              changed = true;
            }
          }
          if (changed) {
            writeInboxData(paths, inboxData);
          }
        });
        // Delete tracker only after store write succeeded (Codex Review #5 Item 3)
        runningTrackers.delete(jobId);
      } catch (err: any) {
        if (err?.statusCode !== 503) {
          throw err;
        }
        // Lock busy (503): tracker remains in runningTrackers so next tick retries
      }
    }

    // A job that becomes DONE auto-resolves older inbox items for that job (Item 13: memoized)
    if (status === 'DONE') {
      delete currentJobFlags[jobId];
      const memo = memoMap.get(jobId);
      if (memo && memo.status === 'DONE') {
        continue;
      }
      try {
        withItemsLock(paths, () => {
          const inboxData = readInboxData(paths);
          let changed = false;
          for (const item of inboxData.items) {
            if (item.job_id === jobId && item.status === 'open') {
              item.status = 'done';
              item.updated_at = new Date().toISOString();
              changed = true;
            }
          }
          if (changed) {
            writeInboxData(paths, inboxData);
          }
        });
        memoMap.set(jobId, { status: 'DONE', logSize, lastScannedAt: now });
      } catch (err: any) {
        if (err?.statusCode !== 503) {
          throw err;
        }
        // Lock busy: memo is not set so next tick retries
      }
      continue;
    }

    // Check memoization for finished jobs
    const memo = memoMap.get(jobId);
    if (memo && memo.status === status && memo.logSize === logSize) {
      continue;
    }
    memoMap.set(jobId, { status, logSize, lastScannedAt: now });

    if (status !== 'FAILED') {
      continue;
    }

    // Status is FAILED: analyze log tail
    const tail16k = readLogTailSafe(logPath, 16384);
    const agentName = String(meta.agent ?? meta.mode ?? '').toLowerCase();
    const prompt = readPromptFile(paths.jobsDir, jobId);

    const retryInfo: InboxRetryInfo = {
      mode: meta.mode as string,
      agent: meta.agent as string,
      role: meta.role as string,
      project_path: meta.project_path as string,
      prompt,
      model: (meta.model as string) ?? '',
      effort: (meta.effort as string) ?? '',
      team: meta.team as Record<string, string>,
      reviewers: meta.reviewers as string[],
      implementer: meta.implementer as string,
    };

    // 1. Hook blocked
    if (tail16k.includes('HOOK_BLOCKED (before-agent)')) {
      currentJobFlags[jobId] = 'blocked';
      const m = /HOOK_BLOCKED \(before-agent\):\s*(.+)/.exec(tail16k);
      const reason = m ? m[1]!.trim() : 'Execution blocked by before-agent hook';
      addInboxItem(
        paths,
        {
          kind: 'blocked',
          severity: 'warn',
          title: `${meta.agent ?? jobId}: dispatch blocked`,
          detail: reason,
          agent: meta.agent as string,
          role: meta.role as string,
          job_id: jobId,
          project: meta.project_path as string,
          source: 'jobs',
          actions: ['retry', 'open', 'dismiss'],
          dedupe_key: `job:${jobId}:blocked`,
          retry: retryInfo,
        },
        { onlyIfAbsent: true }
      );
      continue;
    }

    // 2. Classify log for auth vs rate limit
    const classification = classifyLog(agentName, tail16k);
    if (classification === 'needs_login') {
      currentJobFlags[jobId] = 'needs_login';
      addInboxItem(
        paths,
        {
          kind: 'needs_login',
          severity: 'error',
          title: `${meta.agent ?? jobId}: login expired`,
          detail: buildMeaningfulDetail(tail16k, 'needs_login', agentName, paths.userProfile),
          agent: meta.agent as string,
          role: meta.role as string,
          job_id: jobId,
          project: meta.project_path as string,
          source: 'jobs',
          actions: ['login', 'retry', 'open', 'dismiss'],
          dedupe_key: `job:${jobId}:needs_login`,
          retry: retryInfo,
        },
        { onlyIfAbsent: true }
      );
      continue;
    }

    if (classification === 'rate_limited') {
      currentJobFlags[jobId] = 'rate_limited';
      addInboxItem(
        paths,
        {
          kind: 'rate_limited',
          severity: 'warn',
          title: `${meta.agent ?? jobId}: rate limited`,
          detail: buildMeaningfulDetail(tail16k, 'rate_limited', agentName, paths.userProfile),
          agent: meta.agent as string,
          role: meta.role as string,
          job_id: jobId,
          project: meta.project_path as string,
          source: 'jobs',
          actions: ['retry', 'open', 'dismiss'],
          dedupe_key: `job:${jobId}:rate_limited`,
          retry: retryInfo,
        },
        { onlyIfAbsent: true }
      );
      continue;
    }

    // 3. Auto-gate not approved or council with exit 2
    const isAutoGate = meta.mode === 'auto-gate';
    const isCouncilExit2 = meta.mode === 'council' && Number(meta.exit_code) === 2;
    if ((isAutoGate && !tail16k.includes('APPROVED by all reviewers')) || isCouncilExit2) {
      let detail = 'Changes requested by reviewer';
      const lines = tail16k.split('\n').map((l) => l.trim()).filter(Boolean);
      const resLine = lines.reverse().find(
        (l) => l.includes('Round ') || l.includes('COUNCIL_RESULT') || l.includes('VERDICT:')
      );
      if (resLine) {
        detail = resLine;
      }
      currentJobFlags[jobId] = 'blocked';
      addInboxItem(
        paths,
        {
          kind: 'review_changes',
          severity: 'warn',
          title: `${meta.agent ?? jobId}: changes requested`,
          detail,
          agent: meta.agent as string,
          role: meta.role as string,
          job_id: jobId,
          project: meta.project_path as string,
          source: 'jobs',
          actions: ['open', 'retry', 'dismiss'],
          dedupe_key: `job:${jobId}:review_changes`,
          retry: retryInfo,
        },
        { onlyIfAbsent: true }
      );
      continue;
    }

    // 4. Other FAILED (exit ≠ 0, not CANCELLED)
    if (meta.exit_code !== 0) {
      addInboxItem(
        paths,
        {
          kind: 'failed',
          severity: 'error',
          title: `${meta.agent ?? jobId}: job failed`,
          detail: buildMeaningfulDetail(tail16k, 'failed', agentName, paths.userProfile),
          agent: meta.agent as string,
          role: meta.role as string,
          job_id: jobId,
          project: meta.project_path as string,
          source: 'jobs',
          actions: ['retry', 'open', 'dismiss'],
          dedupe_key: `job:${jobId}:failed`,
          retry: retryInfo,
        },
        { onlyIfAbsent: true }
      );
    }
  }
}

export function startBackgroundScanner(paths: ServerPaths): void {
  if (bgTimer) {
    return;
  }
  // Run once immediately
  void runJobScanner(paths);
  bgTimer = setInterval(() => {
    void runJobScanner(paths);
  }, 10000);
  bgTimer.unref();
}

export function stopBackgroundScanner(): void {
  if (bgTimer) {
    clearInterval(bgTimer);
    bgTimer = null;
  }
}
