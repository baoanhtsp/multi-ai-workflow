import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { handleCancelJob, refreshJobMetaStatus, type JobMeta } from '../../actions/jobs.ts';
import { createFeatureContext, type MawFeatureContext } from '../../lib/feature.ts';
import { logServerError } from '../../lib/logger.ts';
import { isProcessRunning } from '../../lib/proc.ts';
import {
  ApiValidationError,
  appendAudit,
  badRequest,
  conflict,
  fileMutex,
  notFound,
  readJson,
  stripAnsi,
  stripRunnerNoise,
  writeJsonAtomic,
} from './lib.ts';
import { getPreset, getPresets, type TeamPreset } from './presets.ts';
import {
  getCard,
  getCards,
  getConfig,
  getTasksFile,
  isJobIdAttachedToAnyCard,
  patchCard,
  type Card,
  type TaskAttempt,
  type TaskStatus,
} from './store.ts';

export interface SchedulerLock {
  pid: number;
  token: string;
  started_at: string;
  heartbeat_at: string;
}

export interface SchedulerStatus {
  active: boolean;
  pid: number;
  last_tick_at: string | null;
}

export type TickerFunction = (ctx: MawFeatureContext) => Promise<void>;

const tickers = new Map<string, TickerFunction>();

export function registerTicker(name: string, fn: TickerFunction): void {
  tickers.set(name, fn);
}

let schedulerTimer: NodeJS.Timeout | null = null;
let debounceTickTimer: NodeJS.Timeout | null = null;
let lastTickTime: string | null = null;
let isCurrentlyTicking = false;
let myLeaderToken: string | null = null;
let activeCtx: MawFeatureContext | null = null;
const startingCards = new Set<string>();

export function getMyLeaderToken(): string | null {
  return myLeaderToken;
}

function getLockFile(ctx: MawFeatureContext): string {
  return path.win32.join(ctx.paths.featureDataDir('tasks'), 'scheduler.lock');
}

export function tryAcquireLeaderLock(ctx: MawFeatureContext): boolean {
  activeCtx = ctx;
  const lockFile = getLockFile(ctx);
  const nowIso = new Date().toISOString();

  // If we already hold the lock, verify and refresh heartbeat
  if (myLeaderToken) {
    try {
      if (fs.existsSync(lockFile)) {
        const raw = fs.readFileSync(lockFile, 'utf8').trim();
        const current = raw ? (JSON.parse(raw) as SchedulerLock) : null;
        if (current?.token === myLeaderToken && current.pid === process.pid) {
          current.heartbeat_at = nowIso;
          writeJsonAtomic(lockFile, current);
          return true;
        }
      }
    } catch {
      // Failed to verify/refresh existing lock
    }
    myLeaderToken = null;
  }

  // Check if an existing lock exists
  let existing: SchedulerLock | null = null;
  let lockFileExists = false;
  let lockMtimeMs = 0;
  try {
    if (fs.existsSync(lockFile)) {
      lockFileExists = true;
      const st = fs.statSync(lockFile);
      lockMtimeMs = st.mtimeMs;
      const raw = fs.readFileSync(lockFile, 'utf8').trim();
      if (raw) {
        existing = JSON.parse(raw) as SchedulerLock;
      }
    }
  } catch {
    existing = null;
  }

  if (lockFileExists) {
    if (existing) {
      // If the existing lock has my pid, refresh it
      if (existing.pid === process.pid) {
        if (!myLeaderToken || !existing.token) {
          myLeaderToken = existing.token || crypto.randomBytes(16).toString('hex');
          existing.token = myLeaderToken;
        }
        if (existing.token === myLeaderToken) {
          existing.heartbeat_at = nowIso;
          try {
            writeJsonAtomic(lockFile, existing);
            return true;
          } catch {
            return false;
          }
        }
      }

      const alive = existing.pid ? isProcessRunning(existing.pid) : false;
      const heartbeatAge = Date.now() - (Date.parse(existing.heartbeat_at) || 0);
      if (alive && heartbeatAge <= 60000) {
        return false; // Active leader exists with fresh heartbeat
      }
    } else {
      // Empty or unparsable lock file: if younger than 60s, wait/stay passive
      const mtimeAge = Date.now() - lockMtimeMs;
      if (mtimeAge <= 60000) {
        return false;
      }
    }

    // Stale lock: atomic rename to unique stale file
    const judgedStaleToken = existing?.token ?? null;
    const staleFile = `${lockFile}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(lockFile, staleFile);
    } catch {
      // Rename failed (someone else took it or file disappeared) -> stay passive
      return false;
    }

    // Verify token of the renamed file to guard against race where we moved a fresh lock
    let movedToken: string | null = null;
    try {
      const movedRaw = fs.readFileSync(staleFile, 'utf8').trim();
      if (movedRaw) {
        try {
          const parsedMoved = JSON.parse(movedRaw) as SchedulerLock;
          movedToken = parsedMoved?.token ?? null;
        } catch {
          movedToken = null;
        }
      }
    } catch {
      movedToken = null;
    }

    if (movedToken !== judgedStaleToken) {
      // We moved someone else's fresh lock! Put it back and stay passive
      let restored = false;
      try {
        fs.linkSync(staleFile, lockFile);
        restored = true;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'EEXIST' || fs.existsSync(lockFile)) {
          // If linkSync restore fails because a lock exists, unlink moved copy (someone holds the lock)
          try {
            fs.unlinkSync(staleFile);
          } catch {}
          return false;
        }
        // If it fails for any other reason, try renameSync(moved, lockFile) once and keep moved file if that fails too
        try {
          fs.renameSync(staleFile, lockFile);
          restored = true;
        } catch {
          // Keep moved file if rename fails too
        }
      }

      // Never delete the moved file unless the lock file exists again
      if (restored && fs.existsSync(lockFile)) {
        try {
          if (fs.existsSync(staleFile)) {
            fs.unlinkSync(staleFile);
          }
        } catch {}
      }
      return false;
    }
  }

  // Claim with exclusive create 'wx'
  const token = crypto.randomBytes(16).toString('hex');
  const lockData: SchedulerLock = {
    pid: process.pid,
    token,
    started_at: nowIso,
    heartbeat_at: nowIso,
  };

  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const fd = fs.openSync(lockFile, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(lockData, null, 2), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    myLeaderToken = token;
    pruneStaleSchedulerLocks(path.dirname(lockFile), 3);
    return true;
  } catch {
    myLeaderToken = null;
    return false;
  }
}

export function pruneStaleSchedulerLocks(tasksDir: string, keep = 3): void {
  try {
    if (!fs.existsSync(tasksDir)) return;
    const staleFiles = fs
      .readdirSync(tasksDir)
      .filter((name) => name.startsWith('scheduler.lock.stale-'))
      .map((name) => {
        const fullPath = path.win32.join(tasksDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { name, fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

    for (let i = keep; i < staleFiles.length; i++) {
      try {
        fs.unlinkSync(staleFiles[i]!.fullPath);
      } catch {
        // Best-effort cleanup
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

export function refreshLeaderHeartbeat(ctx: MawFeatureContext): boolean {
  if (!myLeaderToken) return false;
  const lockFile = getLockFile(ctx);
  try {
    if (!fs.existsSync(lockFile)) {
      myLeaderToken = null;
      return false;
    }
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    const current = raw ? (JSON.parse(raw) as SchedulerLock) : null;
    if (current?.token !== myLeaderToken || current.pid !== process.pid) {
      myLeaderToken = null;
      return false;
    }
    current.heartbeat_at = new Date().toISOString();
    writeJsonAtomic(lockFile, current);
    return true;
  } catch {
    myLeaderToken = null;
    return false;
  }
}

export function getSchedulerStatus(ctx: MawFeatureContext): SchedulerStatus {
  const lockFile = getLockFile(ctx);
  let lock: SchedulerLock | null = null;
  try {
    if (fs.existsSync(lockFile)) {
      const raw = fs.readFileSync(lockFile, 'utf8').trim();
      if (raw) lock = JSON.parse(raw) as SchedulerLock;
    }
  } catch {
    lock = null;
  }

  const isHeldByUs = Boolean(
    myLeaderToken && lock?.token === myLeaderToken && lock?.pid === process.pid
  );
  const isAlive = lock?.pid ? isProcessRunning(lock.pid) : false;
  const isFresh = lock?.heartbeat_at
    ? Date.now() - Date.parse(lock.heartbeat_at) <= 60000
    : false;

  return {
    active: Boolean(isHeldByUs && isAlive && isFresh),
    pid: lock?.pid ?? 0,
    last_tick_at: lastTickTime,
  };
}

function parseScoreAndVerdict(text: string): { score: number | null; verdict?: string } {
  const cleanText = stripRunnerNoise(text);
  const scoreMatches = Array.from(cleanText.matchAll(/SCORE:\s*(\d+(?:\.\d+)?)\s*\/\s*10/gi));
  let score: number | null = null;
  if (scoreMatches.length > 0) {
    const lastScoreStr = scoreMatches[scoreMatches.length - 1]![1]!;
    const val = Number.parseFloat(lastScoreStr);
    if (Number.isFinite(val)) score = val;
  }

  const verdictMatches = Array.from(cleanText.matchAll(/VERDICT:\s*([A-Za-z_-]+)/gi));
  let verdict: string | undefined;
  if (verdictMatches.length > 0) {
    verdict = verdictMatches[verdictMatches.length - 1]![1]!.trim().toUpperCase();
  }

  return { score, verdict };
}

function parseFindings(text: string, isReviewerMode: boolean): string {
  const cleanText = stripRunnerNoise(text);
  const maxLen = isReviewerMode ? 6000 : 3000;
  const sliceLen = Math.min(maxLen, cleanText.length);
  return cleanText.slice(cleanText.length - sliceLen).trim();
}

function readJobLogTail(logFile: string, maxBytes = 65536): string {
  try {
    if (!fs.existsSync(logFile)) return '';
    const st = fs.statSync(logFile);
    if (st.size <= 0) return '';
    const readLen = Math.min(st.size, maxBytes);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, st.size - readLen);
      return stripAnsi(buf.subarray(0, bytesRead).toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export async function reconcileStartingCard(
  ctx: MawFeatureContext,
  card: Card,
  allCards: Card[],
  usedJobIds?: Set<string>
): Promise<{ adopted: boolean; card: Card | null }> {
  if (!usedJobIds) {
    usedJobIds = new Set<string>();
    for (const c of allCards) {
      if (c.job_id) usedJobIds.add(c.job_id);
      if (Array.isArray(c.attempts)) {
        for (const a of c.attempts) {
          if (a.job_id) usedJobIds.add(a.job_id);
        }
      }
    }
  }

  const expectedAt = card.starting?.at;
  const expectedPromptSha = card.starting?.prompt_sha;
  const startingAtTs = expectedAt ? Math.floor(Date.parse(expectedAt) / 1000) : 0;

  let bestMatch: { jobId: string; meta: JobMeta; startedTs: number } | null = null;

  try {
    if (fs.existsSync(ctx.paths.jobsDir) && expectedPromptSha) {
      const jobFiles = fs
        .readdirSync(ctx.paths.jobsDir)
        .filter((f) => f.startsWith('job_') && f.endsWith('.json'));

      for (const jf of jobFiles) {
        const metaPath = path.win32.join(ctx.paths.jobsDir, jf);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as JobMeta;
          if (!meta.job_id || usedJobIds.has(meta.job_id)) {
            continue;
          }
          const metaStartedTs =
            meta.started_ts ??
            (meta.started_at ? Math.floor(Date.parse(meta.started_at) / 1000) : 0);
          const projectMatches =
            meta.project_path &&
            path.resolve(meta.project_path).toLowerCase() ===
              path.resolve(card.project_path).toLowerCase();

          if (projectMatches && metaStartedTs >= startingAtTs - 5) {
            let matched = false;
            const metaSha = (meta as unknown as Record<string, unknown>).prompt_sha256;
            if (metaSha && metaSha === expectedPromptSha) {
              matched = true;
            } else {
              const promptFile = path.win32.join(ctx.paths.jobsDir, `${meta.job_id}.prompt.txt`);
              if (fs.existsSync(promptFile)) {
                let promptContent = fs.readFileSync(promptFile, 'utf8');
                if (promptContent.charCodeAt(0) === 0xfeff) promptContent = promptContent.slice(1);
                const sha = crypto.createHash('sha256').update(promptContent).digest('hex');
                if (sha === expectedPromptSha) {
                  matched = true;
                }
              }
            }

            if (matched) {
              // Take the earliest started_ts >= starting.at - 5
              if (!bestMatch || metaStartedTs < bestMatch.startedTs) {
                bestMatch = { jobId: meta.job_id, meta, startedTs: metaStartedTs };
              }
            }
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }

  let outcome: 'adopted' | 'failed' | 'aborted' = 'aborted';
  const patched = await patchCard(ctx, card.id, (freshCard, freshAllTasks) => {
    // Return false (no write) unless fresh card is still queued and starting equals expected
    if (
      freshCard.status !== 'queued' ||
      !freshCard.starting ||
      freshCard.starting.at !== expectedAt ||
      freshCard.starting.prompt_sha !== expectedPromptSha
    ) {
      outcome = 'aborted';
      return false;
    }

    // For adoption also re-check that no card holds that job id
    const canAdopt =
      bestMatch !== null && !isJobIdAttachedToAnyCard(freshAllTasks, bestMatch.jobId);

    if (canAdopt && bestMatch) {
      outcome = 'adopted';
      const kind =
        freshCard.pending_run?.kind || (freshCard.attempts.length === 0 ? 'start' : 'retry');
      const attempt: TaskAttempt = {
        n: freshCard.attempts.length + 1,
        job_id: bestMatch.jobId,
        agent: freshCard.agent,
        role: freshCard.role,
        mode: freshCard.mode,
        kind,
        started_at: bestMatch.meta.started_at ?? new Date().toISOString(),
        status: 'RUNNING',
        exit_code: null,
        prompt_chars: freshCard.prompt.length,
      };

      freshCard.status = 'running';
      freshCard.job_id = bestMatch.jobId;
      freshCard.status_reason = '';
      freshCard.started_at = freshCard.started_at ?? attempt.started_at;
      freshCard.pending_run = null;
      freshCard.starting = null;
      freshCard.attempts.push(attempt);
      if (freshCard.attempts.length > 20) freshCard.attempts.shift();
    } else {
      outcome = 'failed';
      freshCard.status = 'failed';
      freshCard.status_reason =
        'start interrupted (server stopped while starting); retry to run again';
      freshCard.starting = null;
    }
  });

  if (outcome === 'aborted') {
    return { adopted: false, card: null };
  }
  if (outcome === 'adopted') {
    if (bestMatch && usedJobIds) {
      usedJobIds.add(bestMatch.jobId);
    }
    return { adopted: true, card: patched };
  }
  return { adopted: false, card: patched };
}

export async function startCardJob(
  ctx: MawFeatureContext,
  card: Card,
  options?: { ignoreLimits?: boolean; promptOverride?: string; newSession?: boolean }
): Promise<string> {
  if (startingCards.has(card.id)) {
    throw conflict(`Card ${card.id} is already starting.`);
  }
  startingCards.add(card.id);

  try {
    const currentCard = await getCard(ctx, card.id);
    if (!currentCard) {
      throw notFound(`Task card not found: ${card.id}`);
    }
    if (currentCard.status === 'running') {
      throw conflict(`Card ${card.id} is already running.`);
    }

    if (currentCard.starting) {
      const startingAge = Date.now() - (Date.parse(currentCard.starting.at) || 0);
      if (startingAge <= 30000) {
        throw conflict('Card is starting.');
      }
      // Older than 30s: run reconciliation first
      const allCards = await getCards(ctx);
      const reconciled = await reconcileStartingCard(ctx, currentCard, allCards);
      if (reconciled.adopted && reconciled.card) {
        return reconciled.card.job_id || '';
      }
      // Re-fetch card after reconciliation (which marked it failed)
      const afterRecon = await getCard(ctx, card.id);
      if (!afterRecon || (afterRecon.status !== 'queued' && afterRecon.status !== 'backlog')) {
        throw conflict(
          afterRecon?.status_reason || 'Card is not startable after reconciling interrupted start.'
        );
      }
    }

    const allCards = await getCards(ctx);
    const cardMap = new Map(allCards.map((c) => [c.id, c]));

    // Check dependencies
    for (const depId of currentCard.depends_on || []) {
      const depCard = cardMap.get(depId);
      if (!depCard || depCard.status !== 'done') {
        throw conflict(`Cannot start card: dependency ${depId} is not 'done'.`);
      }
    }

    let preset = null;
    if (currentCard.preset_id) {
      preset = await getPreset(ctx, currentCard.preset_id);
    }

    let finalPrompt: string;
    let kind: TaskAttempt['kind'];
    let newSession = options?.newSession;

    if (options?.promptOverride !== undefined) {
      finalPrompt = options.promptOverride;
      kind = currentCard.attempts.length === 0 ? 'start' : 'retry';
    } else if (currentCard.pending_run) {
      finalPrompt = currentCard.pending_run.prompt;
      kind = currentCard.pending_run.kind;
      if (currentCard.pending_run.new_session !== undefined && newSession === undefined) {
        newSession = currentCard.pending_run.new_session;
      }
    } else {
      finalPrompt = currentCard.prompt;
      kind = currentCard.attempts.length === 0 ? 'start' : 'retry';
    }

    const agentEntry = ctx.registry?.agents?.find((a) => a.id === currentCard.agent);
    if (
      newSession === undefined &&
      currentCard.source?.kind === 'playbook' &&
      agentEntry?.capabilities?.new_session
    ) {
      newSession = true;
    }

    const teamHasMembers =
      currentCard.team &&
      typeof currentCard.team === 'object' &&
      Object.keys(currentCard.team).length > 0;
    const finalTeam = teamHasMembers ? currentCard.team : preset?.team;

    const reviewersHaveMembers =
      Array.isArray(currentCard.reviewers) && currentCard.reviewers.length > 0;
    const finalReviewers = reviewersHaveMembers ? currentCard.reviewers : preset?.reviewers;

    const finalIsolate =
      currentCard.isolate === true || preset?.isolate === true;

    const finalImplementer =
      currentCard.mode === 'auto-gate'
        ? currentCard.agent || preset?.implementer
        : undefined;

    const runBody: Record<string, unknown> = {
      mode: currentCard.mode,
      project_path: currentCard.project_path,
      prompt: finalPrompt,
      agent: currentCard.agent || undefined,
      role: currentCard.role || undefined,
      team: finalTeam,
      reviewers: finalReviewers,
      implementer: finalImplementer,
      model: currentCard.model || undefined,
      effort: currentCard.effort || undefined,
      isolate: finalIsolate,
      budget_usd: preset?.budget_usd,
      max_rounds: preset?.max_fix_rounds,
      new_session: newSession,
      source: { feature: 'tasks', task_id: currentCard.id },
    };

    // Restart safety: record starting intent before calling startJob
    const promptSha = crypto.createHash('sha256').update(finalPrompt).digest('hex');
    await patchCard(ctx, card.id, (c) => {
      c.starting = {
        at: new Date().toISOString(),
        prompt_sha: promptSha,
      };
    });

    let jobResp;
    try {
      jobResp = await ctx.startJob(runBody);
    } catch (err: unknown) {
      await patchCard(ctx, card.id, (c) => {
        c.starting = null;
      }).catch(() => {});
      throw err;
    }
    const jobId = String(jobResp.job_id ?? '');

    const attempt: TaskAttempt = {
      n: currentCard.attempts.length + 1,
      job_id: jobId,
      agent: currentCard.agent,
      role: currentCard.role,
      mode: currentCard.mode,
      kind,
      started_at: new Date().toISOString(),
      status: 'RUNNING',
      exit_code: null,
      prompt_chars: finalPrompt.length,
    };

    let cardWasAlreadyRunning = false;
    const patched = await patchCard(ctx, card.id, (c) => {
      if (c.status === 'running') {
        cardWasAlreadyRunning = true;
        return false;
      }
      c.status = 'running';
      c.job_id = jobId;
      c.status_reason = '';
      c.started_at = c.started_at ?? new Date().toISOString();
      c.pending_run = null;
      c.starting = null;
      c.attempts.push(attempt);
      if (c.attempts.length > 20) {
        c.attempts.shift();
      }
    });

    if (cardWasAlreadyRunning) {
      try {
        if (typeof ctx.cancelJob === 'function') {
          await ctx.cancelJob(jobId);
        } else {
          await handleCancelJob({ job_id: jobId }, ctx.paths);
        }
      } catch {}
      throw conflict(`Card ${card.id} is already running.`);
    }

    if (!patched) {
      try {
        if (typeof ctx.cancelJob === 'function') {
          await ctx.cancelJob(jobId);
        } else {
          await handleCancelJob({ job_id: jobId }, ctx.paths);
        }
      } catch {}
      throw notFound(`Task card not found: ${card.id}`);
    }

    card.status = 'running';
    card.job_id = jobId;
    card.status_reason = '';
    card.started_at = patched.started_at;
    card.pending_run = null;
    card.starting = null;
    card.attempts = patched.attempts;

    return jobId;
  } finally {
    startingCards.delete(card.id);
  }
}

export async function tick(ctx: MawFeatureContext): Promise<void> {
  if (isCurrentlyTicking) return;
  isCurrentlyTicking = true;

  try {
    const hasLock = tryAcquireLeaderLock(ctx);
    if (!hasLock) {
      return; // Passive instance
    }

    lastTickTime = new Date().toISOString();

    let freshCtx = ctx;
    try {
      const loaded = createFeatureContext(ctx.paths);
      freshCtx = {
        ...loaded,
        startJob: ctx.startJob,
        readJobs: ctx.readJobs,
        registry: loaded.registry?.agents?.length
          ? loaded.registry
          : (ctx.registry ?? loaded.registry),
      };
    } catch {
      freshCtx = ctx;
    }

    const config = await getConfig(freshCtx);
    const allPresets = await getPresets(freshCtx);
    const presetsMap = new Map(allPresets.map((p) => [p.id, p]));
    const allTasks = await getCards(freshCtx);

    const nowTs = Date.now();

    // 1. Reconcile running and interrupted starting cards
    // 1a. Reconcile queued cards that were left in starting state (> 30s ago)
    const usedJobIds = new Set<string>();
    for (const c of allTasks) {
      if (c.job_id) usedJobIds.add(c.job_id);
      if (Array.isArray(c.attempts)) {
        for (const a of c.attempts) {
          if (a.job_id) usedJobIds.add(a.job_id);
        }
      }
    }

    const startingCardsToReconcile = allTasks.filter(
      (t) => t.status === 'queued' && t.starting && nowTs - Date.parse(t.starting.at) > 30000
    );

    for (const card of startingCardsToReconcile) {
      await reconcileStartingCard(freshCtx, card, allTasks, usedJobIds);
    }

    // 1b. Reconcile running cards
    const runningCards = allTasks.filter((t) => t.status === 'running');
    for (const card of runningCards) {
      if (!card.job_id) {
        await patchCard(freshCtx, card.id, (c) => {
          c.status = 'failed';
          c.status_reason = 'job record missing';
          const lastAtt = c.attempts[c.attempts.length - 1];
          if (lastAtt && lastAtt.status === 'RUNNING') {
            lastAtt.status = 'FAILED';
            lastAtt.finished_at = new Date().toISOString();
          }
        });
        continue;
      }

      const metaFile = path.win32.join(freshCtx.paths.jobsDir, `${card.job_id}.json`);
      let meta: JobMeta | null = null;
      try {
        if (fs.existsSync(metaFile)) {
          meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
          meta = await refreshJobMetaStatus(meta, freshCtx.paths.jobsDir);
        }
      } catch {
        meta = null;
      }

      if (!meta) {
        await patchCard(freshCtx, card.id, (c) => {
          c.status = 'failed';
          c.status_reason = 'job record missing';
          const lastAtt = c.attempts[c.attempts.length - 1];
          if (lastAtt && lastAtt.status === 'RUNNING') {
            lastAtt.status = 'FAILED';
            lastAtt.finished_at = new Date().toISOString();
          }
        });
        continue;
      }

      if (meta.status === 'DONE' || meta.status === 'FAILED' || meta.status === 'CANCELLED') {
        const logFile = path.win32.join(freshCtx.paths.jobsDir, `${card.job_id}.log`);
        const logTail = readJobLogTail(logFile, 65536);
        const { score, verdict } = parseScoreAndVerdict(logTail);
        const isReviewerMode =
          card.mode === 'council' || card.mode === 'auto-gate' || card.role === 'reviewer';
        const findings = parseFindings(logTail, isReviewerMode);

        await patchCard(freshCtx, card.id, (c) => {
          const lastAtt =
            c.attempts.find((a) => a.job_id === c.job_id) ??
            c.attempts[c.attempts.length - 1];

          if (lastAtt) {
            lastAtt.finished_at = meta.finished_at || new Date().toISOString();
            lastAtt.status = meta.status;
            lastAtt.exit_code = meta.exit_code ?? null;
            lastAtt.score = score;
            lastAtt.verdict = verdict;
            lastAtt.findings = findings;
          }

          if (meta.status === 'DONE' && meta.exit_code === 0) {
            if (c.require_review) {
              c.status = 'review';
            } else {
              c.status = 'done';
              c.finished_at = meta.finished_at || new Date().toISOString();
            }
            c.status_reason = '';
          } else if (meta.exit_code === 124) {
            c.status = 'needs_input';
            c.status_reason = 'agent still working / timed out';
          } else if (meta.status === 'CANCELLED') {
            c.status = 'failed';
            c.status_reason = 'cancelled';
          } else if (meta.exit_code === 2) {
            c.status = 'failed';
            c.status_reason = 'rejected (exit 2)';
          } else {
            c.status = 'failed';
            c.status_reason =
              meta.exit_code !== null ? `exit ${meta.exit_code}` : 'job failed';
          }
        });
      }
    }

    // 2. Auto-retry
    const freshAllAfterReconcile = await getCards(freshCtx);
    const failedCards = freshAllAfterReconcile.filter((t) => t.status === 'failed');

    for (const card of failedCards) {
      if (
        card.retry?.auto &&
        card.status_reason !== 'cancelled' &&
        !card.status_reason.startsWith('invalid: ') &&
        !card.status_reason.startsWith('start interrupted') &&
        card.attempts.length < card.retry.max_attempts
      ) {
        if (!card.next_retry_at) {
          const backoffSec = Math.min(
            3600,
            card.retry.backoff_sec * (2 ** Math.max(0, card.attempts.length - 1))
          );
          const nextRetryIso = new Date(nowTs + backoffSec * 1000).toISOString();
          await patchCard(freshCtx, card.id, (c) => {
            c.next_retry_at = nextRetryIso;
          });
        } else if (Date.parse(card.next_retry_at) <= nowTs) {
          const lastAttempt = card.attempts[card.attempts.length - 1];
          let autoPrompt = card.prompt;
          if (lastAttempt?.findings) {
            const scoreText =
              lastAttempt.score !== null && lastAttempt.score !== undefined
                ? `, ${lastAttempt.score}/10`
                : '';
            const findingsHeader = `\n\n---\n## Previous attempt #${lastAttempt.n} (${lastAttempt.agent || card.agent}, ${lastAttempt.status}, exit ${lastAttempt.exit_code ?? 'unknown'}${scoreText})\nFix every finding below.\n`;
            const allowedFindingsLen = 20000 - card.prompt.length - findingsHeader.length;
            if (allowedFindingsLen > 0) {
              const truncatedFindings = lastAttempt.findings.slice(0, allowedFindingsLen);
              autoPrompt = `${card.prompt}${findingsHeader}${truncatedFindings}`;
            }
          }

          await patchCard(freshCtx, card.id, (c) => {
            c.status = 'queued';
            c.next_retry_at = null;
            c.status_reason = '';
            c.pending_run = {
              kind: 'auto-retry',
              prompt: autoPrompt,
            };
          });
        }
      }
    }

    // 3. Start queued cards
    if (!config.paused) {
      const freshCards = await getCards(freshCtx);
      const freshMap = new Map(freshCards.map((c) => [c.id, c]));

      const currentlyRunning = freshCards.filter((c) => c.status === 'running');
      let currentRunningCount = currentlyRunning.length;

      const agentUsage: Record<string, number> = {};
      for (const rc of currentlyRunning) {
        const used = getAgentsUsedByCard(rc, freshCtx, presetsMap);
        for (const a of used) {
          agentUsage[a] = (agentUsage[a] ?? 0) + 1;
        }
      }

      const queued = freshCards
        .filter(
          (c) =>
            c.status === 'queued' &&
            !(c.starting && nowTs - Date.parse(c.starting.at) <= 30000)
        )
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            a.order - b.order ||
            a.created_at.localeCompare(b.created_at)
        );

      for (const card of queued) {
        // Verify leader lock heartbeat before starting candidate card
        if (!refreshLeaderHeartbeat(freshCtx)) {
          break; // Lost leader lock, stop starting cards
        }

        // Check dependencies
        let allDepsDone = true;
        let blockedByFailed: string | null = null;

        for (const depId of card.depends_on || []) {
          const depCard = freshMap.get(depId);
          if (!depCard || depCard.status !== 'done') {
            allDepsDone = false;
            if (depCard?.status === 'failed') {
              blockedByFailed = depId;
            }
          }
        }

        if (blockedByFailed) {
          const newReason = `blocked by ${blockedByFailed} (failed)`;
          if (card.status_reason !== newReason) {
            await patchCard(freshCtx, card.id, (c) => {
              c.status_reason = newReason;
            });
          }
          continue;
        } else if (card.status_reason && card.status_reason.startsWith('blocked by ')) {
          await patchCard(freshCtx, card.id, (c) => {
            c.status_reason = '';
          });
        }

        if (!allDepsDone) {
          continue;
        }

        // Check total concurrency
        if (currentRunningCount >= config.max_parallel) {
          break;
        }

        // Check per-agent limits using effective agents
        const neededAgents = getAgentsUsedByCard(card, freshCtx, presetsMap);
        let agentLimitBlocked = false;

        for (const ag of neededAgents) {
          const limit = config.per_agent[ag];
          if (limit !== undefined) {
            if (limit === 0 || (agentUsage[ag] ?? 0) >= limit) {
              agentLimitBlocked = true;
              break;
            }
          }
        }

        if (agentLimitBlocked) {
          continue;
        }

        // Start the card
        try {
          await startCardJob(freshCtx, card);
          currentRunningCount++;
          for (const ag of neededAgents) {
            agentUsage[ag] = (agentUsage[ag] ?? 0) + 1;
          }
        } catch (err: unknown) {
          if (
            (err instanceof ApiValidationError && err.statusCode === 409) ||
            (err && typeof err === 'object' && (err as { statusCode?: number }).statusCode === 409)
          ) {
            continue;
          }
          await patchCard(freshCtx, card.id, (c) => {
            if (c.status === 'running') {
              return false;
            }
            c.status = 'failed';
            c.status_reason = `invalid: ${err instanceof Error ? err.message : String(err)}`;
            c.starting = null;
          });
        }
      }
    }

    // 4. Run registered tickers
    for (const [name, tickerFn] of tickers.entries()) {
      if (!refreshLeaderHeartbeat(freshCtx)) {
        break; // Lost leader lock, stop running tickers
      }
      try {
        await tickerFn(freshCtx);
      } catch (err: unknown) {
        console.error(`[tasks] ticker ${name} failed:`, err);
      }
    }
  } finally {
    isCurrentlyTicking = false;
  }
}

export function getAgentsUsedByCard(
  card: Card,
  ctx: MawFeatureContext,
  presetsMap?: Map<string, TeamPreset>
): string[] {
  const result: string[] = [];
  let preset: TeamPreset | null = null;
  if (card.preset_id) {
    if (presetsMap) {
      preset = presetsMap.get(card.preset_id) ?? null;
    } else {
      try {
        const file = path.win32.join(ctx.paths.featureDataDir('tasks'), 'presets.json');
        if (fs.existsSync(file)) {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
          preset = (raw.presets ?? []).find((p: TeamPreset) => p.id === card.preset_id) ?? null;
        }
      } catch {
        preset = null;
      }
    }
  }

  if (card.mode === 'task' || card.mode === 'chat') {
    if (card.agent) result.push(card.agent);
  } else if (card.mode === 'team') {
    if (card.agent) result.push(card.agent);
    const teamHasMembers =
      card.team && typeof card.team === 'object' && Object.keys(card.team).length > 0;
    const effectiveTeam = teamHasMembers ? card.team : preset?.team;
    if (effectiveTeam) {
      for (const val of Object.values(effectiveTeam)) {
        if (val) result.push(val);
      }
    }
  } else if (card.mode === 'council') {
    const revs =
      (Array.isArray(card.reviewers) && card.reviewers.length > 0
        ? card.reviewers
        : (preset?.reviewers ?? ctx.registry?.defaults?.council ?? []));
    for (const r of revs) {
      if (r) result.push(r);
    }
  } else if (card.mode === 'auto-gate') {
    const effectiveImpl = card.agent || preset?.implementer;
    if (effectiveImpl) result.push(effectiveImpl);
    const revs =
      (Array.isArray(card.reviewers) && card.reviewers.length > 0
        ? card.reviewers
        : (preset?.reviewers ?? ctx.registry?.defaults?.council ?? []));
    for (const r of revs) {
      if (r) result.push(r);
    }
  }
  return Array.from(new Set(result.filter(Boolean)));
}

export function ensureScheduler(ctx: MawFeatureContext): void {
  if (schedulerTimer) {
    return;
  }
  schedulerTimer = setInterval(() => {
    try {
      tick(ctx).catch((err) => {
        logServerError('tasks:schedulerTick', err, ctx.paths.mawHome);
      });
    } catch (err) {
      logServerError('tasks:schedulerInterval', err, ctx.paths.mawHome);
    }
  }, 3000);
  schedulerTimer.unref();
}

export function triggerImmediateTick(ctx: MawFeatureContext): void {
  if (debounceTickTimer) {
    clearTimeout(debounceTickTimer);
  }
  debounceTickTimer = setTimeout(() => {
    debounceTickTimer = null;
    try {
      tick(ctx).catch((err) => {
        logServerError('tasks:immediateTick', err, ctx.paths.mawHome);
      });
    } catch (err) {
      logServerError('tasks:immediateTickTimeout', err, ctx.paths.mawHome);
    }
  }, 200);
  debounceTickTimer.unref();
}

export function stopScheduler(ctx?: MawFeatureContext): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  if (debounceTickTimer) {
    clearTimeout(debounceTickTimer);
    debounceTickTimer = null;
  }
  const targetCtx = ctx || activeCtx;
  if (targetCtx && myLeaderToken) {
    try {
      const lockFile = getLockFile(targetCtx);
      if (fs.existsSync(lockFile)) {
        const raw = fs.readFileSync(lockFile, 'utf8').trim();
        const current = raw ? (JSON.parse(raw) as SchedulerLock) : null;
        if (current?.token === myLeaderToken && current.pid === process.pid) {
          fs.unlinkSync(lockFile);
        }
      }
    } catch {
      // ignore
    }
  }
  myLeaderToken = null;
  activeCtx = null;
}

export async function handleTaskRetry(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Card> {
  const id = String(body.id ?? '').trim();
  if (!id) {
    throw badRequest('Card id is required for retry.');
  }

  const existingCard = await getCard(ctx, id);
  if (!existingCard) {
    throw notFound(`Task card not found: ${id}`);
  }

  if (existingCard.status === 'running') {
    throw conflict('Cannot retry a running card.');
  }

  // Allowed for failed, review, needs_input, done
  const retryMode = String(body.mode ?? 'retry').trim().toLowerCase();
  if (retryMode === 'resume') {
    const executingAgent = String(body.agent ?? existingCard.agent).trim();
    const agEntry = ctx.registry?.agents?.find((a) => a.id === executingAgent);
    if (!agEntry?.capabilities?.sessions) {
      throw badRequest('resume needs an agent with sessions; use retry');
    }
  }

  // Reassign if agent/role given
  let targetAgent = existingCard.agent;
  if (body.agent !== undefined && String(body.agent).trim()) {
    const ag = String(body.agent).trim();
    const enabledAgents = new Set(
      (ctx.registry?.agents ?? []).filter((a) => a.enabled).map((a) => a.id)
    );
    if (enabledAgents.size > 0 && !enabledAgents.has(ag)) {
      throw badRequest(`Agent '${ag}' is not installed or enabled.`);
    }
    targetAgent = ag;
  }

  let targetRole = existingCard.role;
  if (body.role !== undefined && String(body.role).trim()) {
    targetRole = String(body.role).trim() as Card['role'];
  }

  const includeFindings = body.include_findings !== false;
  const note = String(body.note ?? '').trim();

  let renderedPrompt = existingCard.prompt;
  const lastAttempt = existingCard.attempts[existingCard.attempts.length - 1];

  if (retryMode === 'resume') {
    renderedPrompt = note || 'Continue the task and report when done.';
  } else {
    if (includeFindings && lastAttempt?.findings) {
      const scorePart =
        lastAttempt.score !== null && lastAttempt.score !== undefined
          ? `, score: ${lastAttempt.score}/10`
          : '';
      const findingsBlock = `\n\n---\n## Previous attempt #${lastAttempt.n} (${lastAttempt.agent || targetAgent}, ${lastAttempt.status}, exit ${lastAttempt.exit_code ?? 'unknown'}${scorePart})\nFix every finding below.\n${lastAttempt.findings}`;
      const noteBlock = note ? `\n\n## Note from the user\n${note}` : '';

      const totalNeeded = existingCard.prompt.length + findingsBlock.length + noteBlock.length;
      if (totalNeeded > 20000) {
        const allowedFindings = Math.max(
          0,
          20000 - existingCard.prompt.length - noteBlock.length - 150
        );
        const truncated = lastAttempt.findings.slice(0, allowedFindings);
        renderedPrompt = `${existingCard.prompt}\n\n---\n## Previous attempt #${lastAttempt.n} (${lastAttempt.agent || targetAgent}, ${lastAttempt.status}, exit ${lastAttempt.exit_code ?? 'unknown'})\nFix every finding below.\n${truncated}${noteBlock}`;
      } else {
        renderedPrompt = `${existingCard.prompt}${findingsBlock}${noteBlock}`;
      }
    } else if (note) {
      renderedPrompt = `${existingCard.prompt}\n\n## Note from the user\n${note}`.slice(0, 20000);
    }
  }

  const updated = await patchCard(ctx, id, (card) => {
    if (card.status === 'running') {
      throw conflict('Cannot retry a running card.');
    }
    card.agent = targetAgent;
    card.role = targetRole;
    card.status = 'queued';
    card.next_retry_at = null;
    card.status_reason = '';
    card.pending_run = {
      kind: retryMode === 'resume' ? 'resume' : 'retry',
      prompt: renderedPrompt,
      new_session: retryMode === 'resume' ? false : undefined,
    };
  });

  if (!updated) {
    throw notFound(`Task card not found: ${id}`);
  }

  triggerImmediateTick(ctx);
  return updated;
}
