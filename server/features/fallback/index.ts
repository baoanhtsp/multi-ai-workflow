import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature, MawFeatureContext } from '../../lib/feature.ts';
import { detectRegistryAgents } from '../../lib/versions.ts';
import {
  appendS4Audit,
  classifyFailure,
  createDefaultFallbackConfig,
  pickFallback,
  readJsonSafe,
  rebuildRunBody,
  replaceAgent,
  validateFallbackConfig,
  writeJsonAtomic,
  type FallbackAgentInfo,
  type FallbackConfig,
} from '../policy/lib/s4-core.ts';

export interface RecoveryItem {
  id: string;
  root_job_id: string;
  source_job_id: string;
  kind: 'fallback' | 'transient' | 'usage_limit' | 'approval';
  agent: string;
  role: string;
  fallback_agent: string | null;
  attempt: number;
  status: 'waiting' | 'started' | 'done' | 'cancelled' | 'failed' | 'gave_up' | 'suggested';
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
let isScanning = false;

function generateRecoveryId(): string {
  const ts = Date.now();
  const hex = crypto.randomBytes(4).toString('hex');
  return `rec_${ts}_${hex}`;
}

export async function scanFinishedJobs(ctx: MawFeatureContext): Promise<void> {
  if (isScanning) return;
  isScanning = true;

  try {
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

    const routingFile = path.win32.join(fallbackDir, 'routing.json');
    const routingCfg = readJsonSafe<FallbackConfig>(routingFile, createDefaultFallbackConfig()).data;

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

    const jobsDir = ctx.paths.jobsDir;
    if (!fs.existsSync(jobsDir)) return;

    let fileNames: string[] = [];
    try {
      fileNames = fs.readdirSync(jobsDir).filter((n) => n.startsWith('job_') && n.endsWith('.json'));
    } catch {
      return;
    }

    const processedSet = new Set(recData.processed_jobs || []);
    const now = new Date();
    const nowMs = now.getTime();
    let changed = false;

    for (const fName of fileNames) {
      const fullPath = path.win32.join(jobsDir, fName);
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }

      const jobId = String(meta.job_id ?? '').trim();
      if (!jobId || processedSet.has(jobId)) continue;

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
      const logFile = path.win32.join(jobsDir, `${jobId}.log`);
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

      const agent = String(meta.agent ?? meta.mode ?? '').trim().toLowerCase();
      const role = String(meta.role ?? 'backend').trim().toLowerCase();
      const roleCfg = routingCfg.roles[role] || { fallbacks: [], auto_fallback: false };

      // Root job id resolution
      let rootJobId = jobId;
      const priorItem = (recData.items || []).find((it) => it.new_job_id === jobId);
      if (priorItem) {
        rootJobId = priorItem.root_job_id;
      }

      // Chain attempt count
      const chainItems = (recData.items || []).filter((it) => it.root_job_id === rootJobId);
      const attempt = chainItems.length + 1;

      // Decisions Table
      if (classified.kind === 'blocked') {
        if (classified.by === 's4' && (classified.code === 'budget' || classified.code === 'policy')) {
          // No auto action, no retry
          continue;
        }
        if (classified.by === 's4' && classified.code === 'approval') {
          // Waits for policy_approve
          continue;
        }
        // Blocked by cooldown / budget agent_day / other hook (unhealthy)
        const fbResult = pickFallback({
          role,
          blockedAgent: agent,
          fallbacks: roleCfg.fallbacks,
          agents: agentInfoMap,
          cooldowns,
          now,
        });
        const fbAgent = fbResult ? fbResult.agent : null;

        if (roleCfg.auto_fallback && fbAgent) {
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'fallback',
            agent,
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
          recData.items.unshift(item);
        } else if (fbAgent) {
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'fallback',
            agent,
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
          recData.items.unshift(item);
        }
      } else if (classified.kind === 'usage_limit') {
        const lastStep = routingCfg.recovery.backoff_s[routingCfg.recovery.backoff_s.length - 1] ?? 1800;
        const untilIso = classified.reset_at || new Date(nowMs + lastStep * 1000).toISOString();
        cooldowns[agent] = {
          until: untilIso,
          reason: 'Usage limit reached',
          source_job_id: jobId,
        };

        const diffS = classified.reset_at ? (new Date(classified.reset_at).getTime() - nowMs) / 1000 : Infinity;
        if (classified.reset_at && diffS <= routingCfg.recovery.max_wait_s) {
          if (routingCfg.recovery.prefer_fallback_on_limit && roleCfg.auto_fallback) {
            const fbResult = pickFallback({
              role,
              blockedAgent: agent,
              fallbacks: roleCfg.fallbacks,
              agents: agentInfoMap,
              cooldowns,
              now,
            });
            if (fbResult) {
              const item: RecoveryItem = {
                id: generateRecoveryId(),
                root_job_id: rootJobId,
                source_job_id: jobId,
                kind: 'fallback',
                agent,
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
              recData.items.unshift(item);
              continue;
            }
          }

          if (routingCfg.recovery.wait_for_reset) {
            const nextAt = new Date(new Date(classified.reset_at).getTime() + routingCfg.recovery.reset_grace_s * 1000).toISOString();
            const item: RecoveryItem = {
              id: generateRecoveryId(),
              root_job_id: rootJobId,
              source_job_id: jobId,
              kind: 'usage_limit',
              agent,
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
            recData.items.unshift(item);
          } else {
            const item: RecoveryItem = {
              id: generateRecoveryId(),
              root_job_id: rootJobId,
              source_job_id: jobId,
              kind: 'usage_limit',
              agent,
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
            recData.items.unshift(item);
          }
        } else {
          // Reset further than max_wait_s -> suggested
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'usage_limit',
            agent,
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
          recData.items.unshift(item);
        }
      } else if (classified.kind === 'transient') {
        const stepIndex = Math.min(attempt - 1, routingCfg.recovery.backoff_s.length - 1);
        const backoffSec = routingCfg.recovery.backoff_s[stepIndex] ?? 30;
        cooldowns[agent] = {
          until: new Date(nowMs + backoffSec * 1000).toISOString(),
          reason: `Rate limit / transient error (${classified.code})`,
          source_job_id: jobId,
        };

        if (routingCfg.recovery.enabled && attempt < routingCfg.recovery.max_attempts) {
          const nextAt = new Date(nowMs + backoffSec * 1000).toISOString();
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'transient',
            agent,
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
          recData.items.unshift(item);
        } else {
          const item: RecoveryItem = {
            id: generateRecoveryId(),
            root_job_id: rootJobId,
            source_job_id: jobId,
            kind: 'transient',
            agent,
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
          recData.items.unshift(item);
        }
      }
    }

    // Save cooldowns
    writeJsonAtomic(cooldownFile, cooldowns);

    // Bound items and processed_jobs
    recData.processed_jobs = [...processedSet].slice(-1000);
    recData.items = (recData.items || []).slice(0, 500);

    if (changed || recData.items.length > 0) {
      writeJsonAtomic(recFile, recData);
    }

    // Process due items
    await processDueItems(ctx, recData, agentInfoMap);
  } finally {
    isScanning = false;
  }
}

async function processDueItems(
  ctx: MawFeatureContext,
  recData: RecoveryData,
  agentInfoMap: Record<string, FallbackAgentInfo>
): Promise<void> {
  const nowIso = new Date().toISOString();
  const dueItems = recData.items.filter(
    (it) => it.status === 'waiting' && it.next_at && it.next_at <= nowIso
  );

  if (dueItems.length === 0) return;

  const fallbackDir = ctx.paths.featureDataDir('fallback');
  const recFile = path.win32.join(fallbackDir, 'recovery.json');
  const jobsDir = ctx.paths.jobsDir;

  let startedCount = 0;
  for (const item of dueItems) {
    if (startedCount >= 3) break; // at most 3 per tick

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

    let runBody = rebuildRunBody(meta, promptFile);
    if (item.fallback_agent) {
      runBody = replaceAgent(runBody, item.agent, item.fallback_agent, agentInfoMap[item.fallback_agent]);
    }

    try {
      const res = await ctx.startJob(runBody);
      const newJobId = String(res.job_id ?? '');
      item.status = 'started';
      item.new_job_id = newJobId;
      startedCount += 1;
    } catch (err) {
      item.status = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
    }

    writeJsonAtomic(recFile, recData);
  }
}

export function ensureEngine(ctx: MawFeatureContext): void {
  if (!engineInterval) {
    engineInterval = setInterval(() => {
      scanFinishedJobs(ctx).catch(() => {});
    }, 5000);
    engineInterval.unref();
  }
}

export const feature: MawFeature = {
  name: 'fallback',
  routes: {
    fallback_get: {
      method: 'GET',
      handler: async (ctx) => {
        ensureEngine(ctx);
        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const cfgFile = path.win32.join(fallbackDir, 'routing.json');
        const readRes = readJsonSafe<FallbackConfig>(cfgFile, createDefaultFallbackConfig());
        const warnings: string[] = [];
        if (readRes.warning) warnings.push(readRes.warning);

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
          config: readRes.data,
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
          if (req.res) req.res.statusCode = 400;
          return {
            ok: false,
            error: valRes.errorMessage || 'Invalid routing configuration.',
            field: valRes.errorField,
          };
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
        const cfgFile = path.win32.join(fallbackDir, 'routing.json');
        const routingCfg = readJsonSafe<FallbackConfig>(cfgFile, createDefaultFallbackConfig()).data;
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

        const suggestion = pickFallback({
          role,
          blockedAgent: agent,
          fallbacks: roleFallbacks,
          agents: agentInfoMap,
          cooldowns,
          now: new Date(),
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
          if (req.res) req.res.statusCode = 400;
          return { ok: false, error: "Missing 'id' parameter." };
        }

        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const recFile = path.win32.join(fallbackDir, 'recovery.json');
        const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;

        const item = recData.items.find((it) => it.id === id);
        if (!item) {
          if (req.res) req.res.statusCode = 404;
          return { ok: false, error: `Recovery item '${id}' not found.` };
        }

        if (item.status !== 'waiting' && item.status !== 'suggested') {
          if (req.res) req.res.statusCode = 400;
          return { ok: false, error: `Item '${id}' cannot be cancelled (status: ${item.status}).` };
        }

        item.status = 'cancelled';
        writeJsonAtomic(recFile, recData);
        appendS4Audit(fallbackDir, 'recovery_cancel', { id });

        return {
          ok: true,
          item,
        };
      },
    },
    recovery_apply: {
      method: 'POST',
      handler: async (ctx, req) => {
        const id = String(req.body.id ?? '').trim();
        const customAgent = req.body.agent ? String(req.body.agent).trim().toLowerCase() : undefined;
        if (!id) {
          if (req.res) req.res.statusCode = 400;
          return { ok: false, error: "Missing 'id' parameter." };
        }

        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const recFile = path.win32.join(fallbackDir, 'recovery.json');
        const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;

        const item = recData.items.find((it) => it.id === id);
        if (!item) {
          if (req.res) req.res.statusCode = 404;
          return { ok: false, error: `Recovery item '${id}' not found.` };
        }

        if (item.status !== 'waiting' && item.status !== 'suggested') {
          if (req.res) req.res.statusCode = 400;
          return { ok: false, error: `Item '${id}' cannot be applied (status: ${item.status}).` };
        }

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

        let runBody = rebuildRunBody(meta, promptFile);
        if (targetAgent && targetAgent !== item.agent) {
          runBody = replaceAgent(runBody, item.agent, targetAgent, agentInfoMap[targetAgent]);
        }

        let newJobId: string;
        try {
          const res = await ctx.startJob(runBody);
          newJobId = String(res.job_id ?? '');
          item.status = 'started';
          item.new_job_id = newJobId;
          if (customAgent) item.fallback_agent = customAgent;
          writeJsonAtomic(recFile, recData);
          appendS4Audit(fallbackDir, 'recovery_apply', { id, new_job_id: newJobId, agent: targetAgent });
        } catch (err) {
          item.status = 'failed';
          item.error = err instanceof Error ? err.message : String(err);
          writeJsonAtomic(recFile, recData);
          if (req.res) req.res.statusCode = 500;
          return { ok: false, error: `Failed to start recovery job: ${item.error}` };
        }

        return {
          ok: true,
          item,
          job_id: newJobId,
        };
      },
    },
    fallback_cooldown_clear: {
      method: 'POST',
      handler: async (ctx, req) => {
        const agent = String(req.body.agent ?? '').trim().toLowerCase();
        if (!agent) {
          if (req.res) req.res.statusCode = 400;
          return { ok: false, error: "Missing 'agent' parameter." };
        }

        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
        const cooldowns = readJsonSafe<Record<string, { until: string; reason: string }>>(cooldownFile, {}).data;

        delete cooldowns[agent];
        writeJsonAtomic(cooldownFile, cooldowns);
        appendS4Audit(fallbackDir, 'fallback_cooldown_clear', { agent });

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

    const routingFile = path.win32.join(fallbackDir, 'routing.json');
    const routingCfg = readJsonSafe<FallbackConfig>(routingFile, createDefaultFallbackConfig()).data;

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
