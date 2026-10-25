import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createFeatureContext, type MawFeature, type MawFeatureContext } from '../../lib/feature.ts';
import { logServerError } from '../../lib/logger.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { detectRegistryAgents } from '../../lib/versions.ts';
import {
  appendS4Audit,
  classifyFailure,
  createDefaultFallbackConfig,
  loadBudgetConfig,
  loadFallbackConfig,
  pickFallback,
  readAuditRows,
  readJsonSafe,
  rebuildRunBody,
  replaceAgent,
  validateFallbackConfig,
  writeJsonAtomic,
  type FallbackAgentInfo,
  type FallbackConfig,
} from '../policy/lib/s4-core.ts';
import { syncAttentionToInbox } from '../policy/lib/inbox-bridge.ts';

export interface RecoveryItem {
  id: string;
  root_job_id: string;
  source_job_id: string;
  kind: 'fallback' | 'transient' | 'usage_limit' | 'approval';
  agent: string;
  role: string;
  fallback_agent: string | null;
  attempt: number;
  status: 'waiting' | 'starting' | 'started' | 'done' | 'cancelled' | 'failed' | 'gave_up' | 'suggested';
  next_at: string | null;
  reason: string;
  created_at: string;
  new_job_id: string | null;
  error: string | null;
}

export interface RecoveryData {
  processed_jobs: string[];
  items: RecoveryItem[];
}

let engineInterval: NodeJS.Timeout | null = null;

// Item 7: In-process async mutex
let recoveryLockPromise: Promise<void> = Promise.resolve();
export async function withRecoveryLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = recoveryLockPromise;
  recoveryLockPromise = prev.then(
    () => nextLock,
    () => nextLock
  );
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

function generateRecoveryId(): string {
  const ts = Date.now();
  const hex = crypto.randomBytes(4).toString('hex');
  return `rec_${ts}_${hex}`;
}

export function getAgentDaySpentUsd(auditFile: string, now: Date): Record<string, number> {
  if (!fs.existsSync(auditFile)) return {};
  const { rows } = readAuditRows(auditFile, 0);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const spent: Record<string, number> = {};
  for (const r of rows) {
    if (!r.Timestamp) continue;
    const t = new Date(r.Timestamp).getTime();
    if (t >= startOfDay) {
      const ag = String(r.Agent || r.Tool || '').toLowerCase();
      if (ag) {
        spent[ag] = (spent[ag] || 0) + (Number(r.CostUsd) || 0);
      }
    }
  }
  return spent;
}

let lastClaimsPruneMs = 0;

export function pruneOldClaims(tempDir: string, nowMs: number): void {
  if (nowMs - lastClaimsPruneMs < 3600 * 1000) {
    return;
  }
  lastClaimsPruneMs = nowMs;
  const claimsDir = path.win32.join(tempDir, 'maw_s4_claims');
  try {
    if (!fs.existsSync(claimsDir)) return;
    const files = fs.readdirSync(claimsDir);
    const maxAgeMs = 24 * 3600 * 1000;
    for (const file of files) {
      try {
        const filePath = path.win32.join(claimsDir, file);
        const stat = fs.statSync(filePath);
        if (nowMs - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // ignore per-file errors
      }
    }
  } catch {
    // ignore directory read errors
  }
}

export function tryClaimJob(tempDir: string, jobId: string): boolean {
  const claimsDir = path.win32.join(tempDir, 'maw_s4_claims');
  try {
    if (!fs.existsSync(claimsDir)) {
      fs.mkdirSync(claimsDir, { recursive: true });
    }
  } catch {
    // ignore
  }
  const claimPath = path.win32.join(claimsDir, jobId);
  try {
    const fd = fs.openSync(claimPath, 'wx');
    fs.closeSync(fd);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
      return false;
    }
    return false;
  }
}

export async function scanFinishedJobs(ctx: MawFeatureContext): Promise<void> {
  await withRecoveryLock(async () => {
    const fallbackDir = ctx.paths.featureDataDir('fallback');
    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = readJsonSafe<RecoveryData>(recFile, {
      processed_jobs: [],
      items: [],
    }).data;

    const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
    const cooldowns = readJsonSafe<Record<string, { until: string; reason: string; source_job_id?: string }>>(
      cooldownFile,
      {}
    ).data;

    const { config: routingCfg } = loadFallbackConfig(fallbackDir);
    const budgetCfg = loadBudgetConfig(ctx.paths.featureDataDir('budget')).config;
    const agentDayCapBlockUsd = budgetCfg.caps.agent_day?.usd?.block ?? 0;

    const validAgentIds = new Set(ctx.registry.agents.map((a) => a.id.toLowerCase()));

    // Item 6: Use ctx.readJobs() as the source of job metas
    let jobs: Array<Record<string, unknown>> = [];
    try {
      jobs = await ctx.readJobs();
    } catch {
      jobs = [];
    }

    const processedSet = new Set(recData.processed_jobs || []);
    const now = new Date();
    const nowMs = now.getTime();
    const agentDaySpentUsd = getAgentDaySpentUsd(ctx.paths.auditFile, now);
    let changed = false;

    pruneOldClaims(ctx.paths.tempDir, nowMs);

    for (const meta of jobs) {
      const jobId = String(meta.job_id ?? '').trim();
      if (!jobId || processedSet.has(jobId)) continue;

      // Only consider jobs whose project_path resolves inside ctx.paths.projectsRoot; others marked processed silently.
      const rawProj = String(meta.project_path ?? meta.project ?? meta.workdir ?? '').trim();
      const resolvedProj = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
      if (!resolvedProj) {
        processedSet.add(jobId);
        changed = true;
        continue;
      }

      const pushRecoveryItem = (item: RecoveryItem): boolean => {
        if (!tryClaimJob(ctx.paths.tempDir, jobId)) {
          return false;
        }
        recData.items.unshift(item);
        return true;
      };

      const status = String(meta.status ?? '');
      const exitCode = meta.exit_code !== undefined && meta.exit_code !== null ? Number(meta.exit_code) : null;

      // Only jobs with status FAILED and exit_code != 0 (never CANCELLED)
      if (status !== 'FAILED' || exitCode === 0) continue;

      // Must be finished less than 30 min ago
      const finishedAt = meta.finished_at ? String(meta.finished_at) : '';
      if (finishedAt) {
        const finishedMs = new Date(finishedAt).getTime();
        if (nowMs - finishedMs > 30 * 60 * 1000) {
          processedSet.add(jobId);
          changed = true;
          continue;
        }
      }

      // Read last 64 KB of log
      const logFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.log`);
      let logTail = '';
      if (fs.existsSync(logFile)) {
        try {
          const raw = fs.readFileSync(logFile, 'utf8');
          logTail = raw.slice(-65536);
        } catch {
          logTail = '';
        }
      }

      const classified = classifyFailure(logTail, exitCode ?? 1, now);
      processedSet.add(jobId);
      changed = true;

      // Rule: the failed agent = the [S4:... agent=] tag if present;
      // else for mode task/direct = meta.agent;
      // for team/council/auto-gate WITHOUT a tag = unknown -> retry the same body for transient/usage_limit, no cooldown, no fallback;
      // never call replaceAgent with an unknown/non-registry id.
      const mode = String(meta.mode ?? 'task').trim().toLowerCase();
      const isMultiAgentMode = ['team', 'auto-gate', 'council'].includes(mode);

      let failedAgent = 'unknown';
      if ('agent' in classified && classified.agent) {
        failedAgent = classified.agent.trim().toLowerCase();
      } else if (!isMultiAgentMode) {
        failedAgent = String(meta.agent ?? '').trim().toLowerCase();
      }
      const isKnownAgent = failedAgent !== 'unknown' && validAgentIds.has(failedAgent);

      const role = String(meta.role ?? 'backend').trim().toLowerCase();
      const roleCfg = routingCfg.roles[role] || { fallbacks: [], auto_fallback: false };

      // Root job id resolution
      let rootJobId = jobId;
      const priorItem = (recData.items || []).find((it) => it.new_job_id === jobId);
      if (priorItem) {
        rootJobId = priorItem.root_job_id;
      }

      const chainItems = (recData.items || []).filter((it) => it.root_job_id === rootJobId);
      const attempt = chainItems.length + 1;

      // Lazy detectRegistryAgents only if needed for fallback picking
      let agentInfoMap: Record<string, FallbackAgentInfo> | null = null;
      const getAgentInfoMap = async () => {
        if (!agentInfoMap) {
          const detected = await detectRegistryAgents(ctx.paths, ctx.registry.agents);
          agentInfoMap = {};
          for (const a of ctx.registry.agents) {
            const det = detected.get(a.id);
            agentInfoMap[a.id] = {
              id: a.id,
              label: a.label,
              enabled: a.enabled,
              installed: det ? det.installed : true,
              capabilities: a.capabilities,
            };
          }
        }
        return agentInfoMap;
      };

      // Decisions Table
      if (classified.kind === 'blocked') {
        if (classified.by === 's4') {
          if (classified.code === 'budget') {
            // Per design 2.4: a [S4:budget agent=X fallback=Y] block whose fallback is not 'none'
            // (= the agent_day scope) must go down the fallback path.
            if (!classified.fallback || classified.fallback === 'none') {
              continue;
            }
          } else if (classified.code === 'policy' || classified.code === 'approval') {
            continue;
          }
        }

        // If failedAgent is unknown or not in registry, cannot determine fallback
        if (!isKnownAgent) {
          continue;
        }

        const infoMap = await getAgentInfoMap();
        const fbResult = pickFallback({
          role,
          blockedAgent: failedAgent,
          fallbacks: roleCfg.fallbacks,
          agents: infoMap,
          cooldowns,
          now,
          agentDaySpentUsd,
          agentDayCapBlockUsd,
        });
        const fbAgent =
          classified.fallback && classified.fallback !== 'none' && validAgentIds.has(classified.fallback)
            ? classified.fallback
            : fbResult ? fbResult.agent : null;

        if (roleCfg.auto_fallback && fbAgent) {
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'fallback',
            agent: failedAgent,
            role,
            fallback_agent: fbAgent,
            attempt,
            status: 'waiting',
            next_at: now.toISOString(),
            reason: classified.reason || 'Fallback triggered',
            created_at: now.toISOString(),
            new_job_id: null,
            error: null,
          };
          pushRecoveryItem(item);
        } else if (fbAgent) {
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'fallback',
            agent: failedAgent,
            role,
            fallback_agent: fbAgent,
            attempt,
            status: 'suggested',
            next_at: null,
            reason: classified.reason || 'Fallback suggested',
            created_at: now.toISOString(),
            new_job_id: null,
            error: null,
          };
          pushRecoveryItem(item);
        }
      } else if (classified.kind === 'usage_limit') {
        // Item 13: usage_limit without a reset time = transient with the LONGEST backoff step (design 0.6), not 'suggested'
        if (!classified.reset_at) {
          const longestBackoffSec = routingCfg.recovery.backoff_s[routingCfg.recovery.backoff_s.length - 1] ?? 1800;
          if (isKnownAgent) {
            cooldowns[failedAgent] = {
              until: new Date(nowMs + longestBackoffSec * 1000).toISOString(),
              reason: 'Usage limit reached (no reset time given)',
              source_job_id: jobId,
            };
          }

          if (routingCfg.recovery.enabled && attempt < routingCfg.recovery.max_attempts) {
            const nextAt = new Date(nowMs + longestBackoffSec * 1000).toISOString();
            const item: RecoveryItem = {
              id: generateRecoveryId(),
              root_job_id: rootJobId,
              source_job_id: jobId,
              kind: 'usage_limit',
              agent: failedAgent,
              role,
              fallback_agent: null,
              attempt,
              status: 'waiting',
              next_at: nextAt,
              reason: `Usage limit without reset time; retrying in ${longestBackoffSec}s`,
              created_at: now.toISOString(),
              new_job_id: null,
              error: null,
            };
            pushRecoveryItem(item);
          } else {
            const item: RecoveryItem = {
              id: generateRecoveryId(),
              root_job_id: rootJobId,
              source_job_id: jobId,
              kind: 'usage_limit',
              agent: failedAgent,
              role,
              fallback_agent: null,
              attempt,
              status: 'gave_up',
              next_at: null,
              reason: `Usage limit without reset time; max attempts reached`,
              created_at: now.toISOString(),
              new_job_id: null,
              error: null,
            };
            pushRecoveryItem(item);
          }
          continue;
        }

        const lastStep = routingCfg.recovery.backoff_s[routingCfg.recovery.backoff_s.length - 1] ?? 1800;
        const untilIso = classified.reset_at || new Date(nowMs + lastStep * 1000).toISOString();

        // Never set cooldown for non-registry id
        if (isKnownAgent) {
          cooldowns[failedAgent] = {
            until: untilIso,
            reason: 'Usage limit reached',
            source_job_id: jobId,
          };
        }

        const diffS = (new Date(classified.reset_at).getTime() - nowMs) / 1000;
        if (diffS <= routingCfg.recovery.max_wait_s) {
          if (routingCfg.recovery.prefer_fallback_on_limit && roleCfg.auto_fallback && isKnownAgent) {
            const infoMap = await getAgentInfoMap();
            const fbResult = pickFallback({
              role,
              blockedAgent: failedAgent,
              fallbacks: roleCfg.fallbacks,
              agents: infoMap,
              cooldowns,
              now,
              agentDaySpentUsd,
              agentDayCapBlockUsd,
            });
            if (fbResult) {
              const item: RecoveryItem = {
                id: generateRecoveryId(),
                root_job_id: rootJobId,
                source_job_id: jobId,
                kind: 'fallback',
                agent: failedAgent,
                role,
                fallback_agent: fbResult.agent,
                attempt,
                status: 'waiting',
                next_at: now.toISOString(),
                reason: 'Usage limit reached; switched to fallback',
                created_at: now.toISOString(),
                new_job_id: null,
                error: null,
              };
              pushRecoveryItem(item);
              continue;
            }
          }

          if (routingCfg.recovery.wait_for_reset || isMultiAgentMode) {
            const nextAt = new Date(
              new Date(classified.reset_at).getTime() + routingCfg.recovery.reset_grace_s * 1000
            ).toISOString();
            const item: RecoveryItem = {
              id: generateRecoveryId(),
              root_job_id: rootJobId,
              source_job_id: jobId,
              kind: 'usage_limit',
              agent: failedAgent,
              role,
              fallback_agent: null,
              attempt,
              status: 'waiting',
              next_at: nextAt,
              reason: 'Waiting for quota reset',
              created_at: now.toISOString(),
              new_job_id: null,
              error: null,
            };
            pushRecoveryItem(item);
          } else {
            const item: RecoveryItem = {
              id: generateRecoveryId(),
              root_job_id: rootJobId,
              source_job_id: jobId,
              kind: 'usage_limit',
              agent: failedAgent,
              role,
              fallback_agent: null,
              attempt,
              status: 'suggested',
              next_at: null,
              reason: 'Quota limit reached (wait recommended)',
              created_at: now.toISOString(),
              new_job_id: null,
              error: null,
            };
            pushRecoveryItem(item);
          }
        } else {
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'usage_limit',
            agent: failedAgent,
            role,
            fallback_agent: null,
            attempt,
            status: 'suggested',
            next_at: null,
            reason: 'Quota reset is beyond max wait',
            created_at: now.toISOString(),
            new_job_id: null,
            error: null,
          };
          pushRecoveryItem(item);
        }
      } else if (classified.kind === 'transient') {
        const stepIndex = Math.min(attempt - 1, routingCfg.recovery.backoff_s.length - 1);
        const backoffSec = routingCfg.recovery.backoff_s[stepIndex] ?? 30;

        // Item 8: Never set cooldown for non-registry id
        if (isKnownAgent) {
          cooldowns[failedAgent] = {
            until: new Date(nowMs + backoffSec * 1000).toISOString(),
            reason: `Rate limit / transient error (${classified.code})`,
            source_job_id: jobId,
          };
        }

        if (routingCfg.recovery.enabled && attempt < routingCfg.recovery.max_attempts) {
          const nextAt = new Date(nowMs + backoffSec * 1000).toISOString();
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'transient',
            agent: failedAgent,
            role,
            fallback_agent: null,
            attempt,
            status: 'waiting',
            next_at: nextAt,
            reason: `Transient error ${classified.code}; retrying in ${backoffSec}s`,
            created_at: now.toISOString(),
            new_job_id: null,
            error: null,
          };
          pushRecoveryItem(item);
        } else {
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'transient',
            agent: failedAgent,
            role,
            fallback_agent: null,
            attempt,
            status: 'gave_up',
            next_at: null,
            reason: `Transient error ${classified.code}; max attempts reached`,
            created_at: now.toISOString(),
            new_job_id: null,
            error: null,
          };
          pushRecoveryItem(item);
        }
      }
    }

    writeJsonAtomic(cooldownFile, cooldowns);
    recData.processed_jobs = [...processedSet].slice(-1000);
    recData.items = (recData.items || []).slice(0, 500);

    if (changed || recData.items.length > 0) {
      writeJsonAtomic(recFile, recData);
    }
  });

  // Process due items
  await processDueItems(ctx);
}

async function processDueItems(ctx: MawFeatureContext): Promise<void> {
  const fallbackDir = ctx.paths.featureDataDir('fallback');
  const recFile = path.win32.join(fallbackDir, 'recovery.json');
  const jobsDir = ctx.paths.jobsDir;

  let dueItemToStart: RecoveryItem | null = null;
  let runBody: Record<string, unknown> | null = null;

  // Item 7: Lock to select and mark item as 'starting'
  await withRecoveryLock(async () => {
    const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;
    const nowIso = new Date().toISOString();
    const item = recData.items.find((it) => it.status === 'waiting' && it.next_at && it.next_at <= nowIso);

    if (!item) return;

    item.status = 'starting';
    writeJsonAtomic(recFile, recData);

    const sourceMetaFile = path.win32.join(jobsDir, `${item.source_job_id}.json`);
    const promptFile = path.win32.join(jobsDir, `${item.source_job_id}.prompt.txt`);

    let meta: Record<string, unknown> = {};
    if (fs.existsSync(sourceMetaFile)) {
      try {
        meta = JSON.parse(fs.readFileSync(sourceMetaFile, 'utf8')) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }

    const validAgentIds = new Set(ctx.registry.agents.map((a) => a.id.toLowerCase()));
    runBody = rebuildRunBody(meta, promptFile);
    if (
      item.fallback_agent &&
      item.agent !== 'unknown' &&
      validAgentIds.has(item.agent) &&
      validAgentIds.has(item.fallback_agent)
    ) {
      runBody = replaceAgent(runBody, item.agent, item.fallback_agent);
    }
    dueItemToStart = item;
  });

  if (!dueItemToStart || !runBody) return;

  // Start the job outside the lock so we don't hold the lock during long spawns
  let newJobId: string | null = null;
  let startError: string | null = null;
  try {
    const res = await ctx.startJob(runBody);
    newJobId = String(res.job_id ?? '');
  } catch (err) {
    startError = err instanceof Error ? err.message : String(err);
  }

  // Update item inside the lock
  await withRecoveryLock(async () => {
    const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;
    const item = recData.items.find((it) => it.id === dueItemToStart!.id);
    if (item) {
      if (item.status === 'cancelled') {
        // Cancelled while starting
        return;
      }
      if (newJobId) {
        item.status = 'started';
        item.new_job_id = newJobId;
      } else {
        item.status = 'failed';
        item.error = startError || 'Failed to start recovery job';
      }
      writeJsonAtomic(recFile, recData);
    }
  });
}

// Item 17: rebuild context each tick with createFeatureContext(ctx.paths)
export function ensureEngine(ctx: MawFeatureContext): void {
  if (!engineInterval) {
    engineInterval = setInterval(() => {
      try {
        const freshCtx = createFeatureContext(ctx.paths);
        scanFinishedJobs(freshCtx)
          .then(() =>
            syncAttentionToInbox(freshCtx).catch((err) => {
              logServerError('fallback:syncAttentionToInbox', err, ctx.paths.mawHome);
            })
          )
          .catch((err) => {
            logServerError('fallback:scanFinishedJobs', err, ctx.paths.mawHome);
          });
      } catch (err) {
        logServerError('fallback:ensureEngine', err, ctx.paths.mawHome);
      }
    }, 5000);
    engineInterval.unref();
  }
}

export async function applyRecoveryItem(
  ctx: MawFeatureContext,
  id: string,
  customAgent?: string
): Promise<{ ok: boolean; item: RecoveryItem; job_id: string }> {
  let itemToApply: RecoveryItem | null = null;
  let runBody: Record<string, unknown> | null = null;

  await withRecoveryLock(async () => {
    const fallbackDir = ctx.paths.featureDataDir('fallback');
    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;

    const item = recData.items.find((it) => it.id === id);
    if (!item) {
      throw new ApiValidationError(`Recovery item '${id}' not found.`, 404);
    }

    if (
      item.status !== 'waiting' &&
      item.status !== 'suggested' &&
      item.status !== 'failed' &&
      item.status !== 'gave_up'
    ) {
      throw new ApiValidationError(`Item '${id}' cannot be applied (status: ${item.status}).`, 409);
    }

    item.status = 'starting';
    writeJsonAtomic(recFile, recData);

    const targetAgent = customAgent || item.fallback_agent || item.agent;
    const jobsDir = ctx.paths.jobsDir;
    const sourceMetaFile = path.win32.join(jobsDir, `${item.source_job_id}.json`);
    const promptFile = path.win32.join(jobsDir, `${item.source_job_id}.prompt.txt`);

    let meta: Record<string, unknown> = {};
    if (fs.existsSync(sourceMetaFile)) {
      try {
        meta = JSON.parse(fs.readFileSync(sourceMetaFile, 'utf8')) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }

    const validAgentIds = new Set(ctx.registry.agents.map((a) => a.id.toLowerCase()));
    runBody = rebuildRunBody(meta, promptFile);
    if (
      targetAgent &&
      targetAgent !== item.agent &&
      item.agent !== 'unknown' &&
      validAgentIds.has(item.agent) &&
      validAgentIds.has(targetAgent)
    ) {
      runBody = replaceAgent(runBody, item.agent, targetAgent);
    }
    itemToApply = item;
  });

  if (!itemToApply || !runBody) {
    throw new ApiValidationError('Could not prepare recovery request.', 500);
  }

  let newJobId: string;
  try {
    const res = await ctx.startJob(runBody);
    newJobId = String(res.job_id ?? '');
  } catch (err) {
    await withRecoveryLock(async () => {
      const fallbackDir = ctx.paths.featureDataDir('fallback');
      const recFile = path.win32.join(fallbackDir, 'recovery.json');
      const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;
      const item = recData.items.find((it) => it.id === id);
      if (item) {
        item.status = 'failed';
        item.error = err instanceof Error ? err.message : String(err);
        writeJsonAtomic(recFile, recData);
      }
    });
    throw new ApiValidationError(`Failed to start recovery job: ${err instanceof Error ? err.message : String(err)}`, 500);
  }

  await withRecoveryLock(async () => {
    const fallbackDir = ctx.paths.featureDataDir('fallback');
    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;
    const item = recData.items.find((it) => it.id === id);
    if (item) {
      item.status = 'started';
      item.new_job_id = newJobId;
      if (customAgent) item.fallback_agent = customAgent;
      writeJsonAtomic(recFile, recData);
      appendS4Audit(fallbackDir, 'recovery_apply', { id, new_job_id: newJobId, agent: customAgent || item.fallback_agent });
    }
  });

  return {
    ok: true,
    item: itemToApply,
    job_id: newJobId,
  };
}

export const feature: MawFeature = {
  name: 'fallback',
  routes: {
    fallback_get: {
      method: 'GET',
      handler: async (ctx) => {
        ensureEngine(ctx);
        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const { config, warnings } = loadFallbackConfig(fallbackDir);

        const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
        const cooldowns = readJsonSafe<Record<string, { until: string }>>(cooldownFile, {}).data;

        const detected = await detectRegistryAgents(ctx.paths, ctx.registry.agents);
        const agents = ctx.registry.agents.map((a) => {
          const det = detected.get(a.id);
          const cd = cooldowns[a.id];
          return {
            id: a.id,
            label: a.label,
            installed: det ? det.installed : true,
            cooldown_until: cd ? cd.until : null,
          };
        });

        return {
          ok: true,
          config,
          roles: ['architect', 'leader', 'backend', 'frontend', 'reviewer', 'tester'],
          agents,
          warnings,
        };
      },
    },
    fallback_save: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureEngine(ctx);
        const rawConfig = req.body.config ?? req.body;
        const knownAgents = ctx.registry.agents.map((a) => a.id);
        const valRes = validateFallbackConfig(rawConfig, knownAgents);

        if (valRes.errorField) {
          throw new ApiValidationError(
            `${valRes.errorField}: ${valRes.errorMessage || 'Invalid routing configuration.'}`,
            400
          );
        }

        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const cfgFile = path.win32.join(fallbackDir, 'routing.json');
        writeJsonAtomic(cfgFile, valRes.config);
        appendS4Audit(fallbackDir, 'fallback_save', { config: valRes.config });

        return {
          ok: true,
          config: valRes.config,
        };
      },
    },
    fallback_suggest: {
      method: 'GET',
      handler: async (ctx, req) => {
        ensureEngine(ctx);
        const role = (req.url.searchParams.get('role') ?? '').trim().toLowerCase();
        const agent = (req.url.searchParams.get('agent') ?? '').trim().toLowerCase();

        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const { config: routingCfg } = loadFallbackConfig(fallbackDir);
        const roleFallbacks = routingCfg.roles[role]?.fallbacks || [];

        const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
        const cooldowns = readJsonSafe<Record<string, { until: string }>>(cooldownFile, {}).data;

        const detected = await detectRegistryAgents(ctx.paths, ctx.registry.agents);
        const agentInfoMap: Record<string, FallbackAgentInfo> = {};
        for (const a of ctx.registry.agents) {
          const det = detected.get(a.id);
          agentInfoMap[a.id] = {
            id: a.id,
            label: a.label,
            enabled: a.enabled,
            installed: det ? det.installed : true,
            capabilities: a.capabilities,
          };
        }

        const now = new Date();
        const budgetCfg = loadBudgetConfig(ctx.paths.featureDataDir('budget')).config;
        const agentDayCapBlockUsd = budgetCfg.caps.agent_day?.usd?.block ?? 0;
        const agentDaySpentUsd = getAgentDaySpentUsd(ctx.paths.auditFile, now);

        const suggestion = pickFallback({
          role,
          blockedAgent: agent,
          fallbacks: roleFallbacks,
          agents: agentInfoMap,
          cooldowns,
          now,
          agentDaySpentUsd,
          agentDayCapBlockUsd,
        });

        return {
          ok: true,
          suggestion,
        };
      },
    },
    recovery_list: {
      method: 'GET',
      handler: async (ctx, req) => {
        ensureEngine(ctx);
        await scanFinishedJobs(ctx);

        const filterJobId = (req.url.searchParams.get('job_id') ?? '').trim();

        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const recFile = path.win32.join(fallbackDir, 'recovery.json');
        const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;

        const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
        const cooldowns = readJsonSafe<Record<string, { until: string; reason: string }>>(cooldownFile, {}).data;

        let items = recData.items || [];
        if (filterJobId) {
          items = items.filter(
            (it) =>
              it.source_job_id === filterJobId ||
              it.root_job_id === filterJobId ||
              it.new_job_id === filterJobId
          );
        }

        return {
          ok: true,
          items: items.slice(0, 100),
          cooldowns,
        };
      },
    },
    recovery_cancel: {
      method: 'POST',
      handler: async (ctx, req) => {
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw new ApiValidationError("Missing 'id' parameter.", 400);
        }

        return await withRecoveryLock(async () => {
          const fallbackDir = ctx.paths.featureDataDir('fallback');
          const recFile = path.win32.join(fallbackDir, 'recovery.json');
          const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;

          const item = recData.items.find((it) => it.id === id);
          if (!item) {
            throw new ApiValidationError(`Recovery item '${id}' not found.`, 404);
          }

          if (item.status !== 'waiting' && item.status !== 'suggested') {
            throw new ApiValidationError(`Item '${id}' cannot be cancelled (status: ${item.status}).`, 409);
          }

          item.status = 'cancelled';
          writeJsonAtomic(recFile, recData);
          appendS4Audit(fallbackDir, 'recovery_cancel', { id });

          return {
            ok: true,
            item,
          };
        });
      },
    },
    recovery_apply: {
      method: 'POST',
      handler: async (ctx, req) => {
        const id = String(req.body.id ?? '').trim();
        const customAgent = req.body.agent ? String(req.body.agent).trim().toLowerCase() : undefined;
        if (!id) {
          throw new ApiValidationError("Missing 'id' parameter.", 400);
        }
        return await applyRecoveryItem(ctx, id, customAgent);
      },
    },
    fallback_cooldown_clear: {
      method: 'POST',
      handler: async (ctx, req) => {
        const agent = String(req.body.agent ?? '').trim().toLowerCase();
        if (!agent) {
          throw new ApiValidationError("Missing 'agent' parameter.", 400);
        }

        await withRecoveryLock(async () => {
          const fallbackDir = ctx.paths.featureDataDir('fallback');
          const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
          const cooldowns = readJsonSafe<Record<string, { until: string; reason: string }>>(cooldownFile, {}).data;

          delete cooldowns[agent];
          writeJsonAtomic(cooldownFile, cooldowns);
          appendS4Audit(fallbackDir, 'fallback_cooldown_clear', { agent });
        });

        return { ok: true };
      },
    },
  },
  status: async (ctx) => {
    ensureEngine(ctx);
    await scanFinishedJobs(ctx);

    const fallbackDir = ctx.paths.featureDataDir('fallback');
    const recFile = path.win32.join(fallbackDir, 'recovery.json');
    const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;

    const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
    const cooldowns = readJsonSafe<Record<string, { until: string }>>(cooldownFile, {}).data;

    const { config: routingCfg } = loadFallbackConfig(fallbackDir);

    const waiting = (recData.items || [])
      .filter((it) => it.status === 'waiting')
      .map((it) => ({
        id: it.id,
        source_job_id: it.source_job_id,
        next_at: it.next_at,
        kind: it.kind,
        agent: it.fallback_agent || it.agent,
      }));

    const cooldownMap: Record<string, string> = {};
    for (const [ag, cd] of Object.entries(cooldowns)) {
      if (cd && cd.until) {
        cooldownMap[ag] = cd.until;
      }
    }

    const autoRoles: string[] = [];
    for (const [r, cfg] of Object.entries(routingCfg.roles)) {
      if (cfg && cfg.auto_fallback) {
        autoRoles.push(r);
      }
    }

    return {
      waiting,
      cooldowns: cooldownMap,
      auto_roles: autoRoles,
    };
  },
};
