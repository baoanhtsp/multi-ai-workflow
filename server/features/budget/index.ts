import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature, MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import {
  appendJsonl,
  appendS4Audit,
  calculateAgentDaySpend,
  calculateDaySpend,
  calculateJobSpendFromOffset,
  calculateProjectSpend,
  classifyFailure,
  createDefaultBudgetConfig,
  readAuditRows,
  readJsonSafe,
  validateBudgetConfig,
  writeJsonAtomic,
  type BudgetConfig,
  type S4AuditEntry,
} from '../policy/lib/s4-core.ts';

// Cache for status to keep it fast
let cachedStatus: {
  mtime: number;
  size: number;
  data: Record<string, unknown>;
} | null = null;

let ledgerTimer: NodeJS.Timeout | null = null;

export interface LedgerRow {
  job_id: string;
  team_run_id: string;
  mode: string;
  agent: string;
  role: string;
  team?: Record<string, string>;
  implementer?: string;
  reviewers?: string[];
  project_path: string;
  status: string;
  exit_code: number | null;
  started_at: string;
  finished_at?: string;
  duration_s: number;
  calls: number;
  in_tokens: number;
  out_tokens: number;
  cost_usd: number;
  review: {
    verdict: string | null;
    score: number | null;
    rounds: number | null;
  };
  failure: { kind: string } | null;
  recovery_of: string | null;
}

export function parseReviewFromLog(logText: string): {
  verdict: string | null;
  score: number | null;
  rounds: number | null;
} {
  let verdict: string | null = null;
  let score: number | null = null;
  let rounds: number | null = null;

  // Rounds
  const roundMatches = [...logText.matchAll(/\[Round\s+(\d+)\s*\//gi)];
  if (roundMatches.length > 0) {
    let maxR = 1;
    for (const m of roundMatches) {
      const num = Number.parseInt(m[1]!, 10);
      if (num > maxR) maxR = num;
    }
    rounds = maxR;
  }

  // 1. Council result: === COUNCIL_RESULT a=APPROVED|9.0 b=APPROVED|8.5 ===
  const councilMatches = [...logText.matchAll(/===\s*COUNCIL_RESULT\s+([\s\S]+?)\s*===/gi)];
  if (councilMatches.length > 0) {
    const lastCouncil = councilMatches[councilMatches.length - 1]![1]!;
    const tokens = lastCouncil.trim().split(/\s+/);
    let allApproved = true;
    let minScore: number | null = null;

    for (const t of tokens) {
      // format: <id>=<VERDICT>|<score>
      const parts = t.split('=');
      if (parts.length === 2) {
        const val = parts[1]!;
        const [v, s] = val.split('|');
        if (v && v.toUpperCase() !== 'APPROVED') {
          allApproved = false;
        }
        if (s) {
          const numS = Number.parseFloat(s);
          if (Number.isFinite(numS)) {
            if (minScore === null || numS < minScore) minScore = numS;
          }
        }
      }
    }

    if (tokens.length > 0) {
      verdict = allApproved && (minScore === null || minScore >= 8.5) ? 'APPROVED' : 'CHANGES_REQUESTED';
      score = minScore;
      return { verdict, score, rounds };
    }
  }

  // 2. Individual VERDICT: X and Score: n/10
  const verdictMatches = [...logText.matchAll(/VERDICT:\s*([A-Za-z_]+)/gi)];
  const scoreMatches = [...logText.matchAll(/Score:\s*([0-9.]+)\s*\/\s*10/gi)];

  if (verdictMatches.length > 0) {
    verdict = verdictMatches[verdictMatches.length - 1]![1]!.toUpperCase();
  }
  if (scoreMatches.length > 0) {
    const s = Number.parseFloat(scoreMatches[scoreMatches.length - 1]![1]!);
    if (Number.isFinite(s)) {
      score = s;
    }
  }

  return { verdict, score, rounds };
}

export async function syncLedger(ctx: MawFeatureContext): Promise<void> {
  const budgetDir = ctx.paths.featureDataDir('budget');
  const ledgerFile = path.win32.join(budgetDir, 'ledger.jsonl');

  const seenJobIds = new Set<string>();
  if (fs.existsSync(ledgerFile)) {
    try {
      const existingLines = fs
        .readFileSync(ledgerFile, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      for (const line of existingLines) {
        try {
          const obj = JSON.parse(line) as { job_id?: string };
          if (obj.job_id) seenJobIds.add(obj.job_id);
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }

  // Read all job metas from jobsDir
  const jobsDir = ctx.paths.jobsDir;
  if (!fs.existsSync(jobsDir)) return;

  let fileNames: string[] = [];
  try {
    fileNames = fs.readdirSync(jobsDir).filter((n) => n.startsWith('job_') && n.endsWith('.json'));
  } catch {
    return;
  }

  // Read audit rows for calculating job cost
  const { rows: auditRows } = readAuditRows(ctx.paths.auditFile, 0);

  // Read recovery items to map recovery_of
  const fallbackDir = ctx.paths.featureDataDir('fallback');
  const recFile = path.win32.join(fallbackDir, 'recovery.json');
  const recoveryItems: Array<{ id: string; new_job_id?: string; source_job_id?: string; root_job_id?: string }> = [];
  if (fs.existsSync(recFile)) {
    const recData = readJsonSafe<{ items?: Array<{ id: string; new_job_id?: string; source_job_id?: string; root_job_id?: string }> }>(
      recFile,
      { items: [] }
    );
    if (recData.data.items) {
      recoveryItems.push(...recData.data.items);
    }
  }

  for (const fName of fileNames) {
    const fullPath = path.win32.join(jobsDir, fName);
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    const jobId = String(meta.job_id ?? '').trim();
    if (!jobId || seenJobIds.has(jobId)) continue;

    const status = String(meta.status ?? 'UNKNOWN');
    if (status === 'RUNNING') continue; // only finished jobs

    // Find recovery info
    const recMatch = recoveryItems.find((it) => it.new_job_id === jobId);
    const recoveryOf = recMatch ? (recMatch.source_job_id || recMatch.root_job_id || null) : null;
    const teamRunId = recMatch?.root_job_id || String(meta.team_run_id || jobId);

    const startedAt = String(meta.started_at ?? '');
    const finishedAt = meta.finished_at ? String(meta.finished_at) : undefined;
    const startedMs = startedAt ? new Date(startedAt).getTime() : 0;
    const finishedMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    const durationS = startedMs > 0 ? Math.max(0, Math.round((finishedMs - startedMs) / 1000)) : 0;

    const projectPath = String(meta.project_path ?? '');

    // Cost aggregation: Timestamp in [started_at - 5s, finished_at + 5s] and inside projectPath
    let jobCalls = 0;
    let inTokens = 0;
    let outTokens = 0;
    let costUsd = 0;

    for (const ar of auditRows) {
      const arTime = new Date(ar.Timestamp).getTime();
      if (arTime >= startedMs - 5000 && arTime <= finishedMs + 5000) {
        const arWorkdir = ar.WorkDir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        const normProj = projectPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        if (arWorkdir === normProj || arWorkdir.startsWith(normProj + '\\')) {
          jobCalls += 1;
          inTokens += ar.in_tokens;
          outTokens += ar.out_tokens;
          costUsd += ar.cost_usd;
        }
      }
    }

    // Review parsing
    let reviewVerdict: string | null = null;
    let reviewScore: number | null = null;
    let reviewRounds: number | null = null;

    if (meta.review && typeof meta.review === 'object' && !Array.isArray(meta.review)) {
      const r = meta.review as Record<string, unknown>;
      if (r.verdict) reviewVerdict = String(r.verdict);
      if (Number.isFinite(Number(r.score))) reviewScore = Number(r.score);
      if (Number.isFinite(Number(r.rounds))) reviewRounds = Number(r.rounds);
    } else {
      // Read log
      const logFile = path.win32.join(jobsDir, `${jobId}.log`);
      if (fs.existsSync(logFile)) {
        try {
          const logText = fs.readFileSync(logFile, 'utf8');
          const parsedRev = parseReviewFromLog(logText);
          reviewVerdict = parsedRev.verdict;
          reviewScore = parsedRev.score;
          reviewRounds = parsedRev.rounds;
        } catch {
          // Ignore
        }
      }
    }

    // Failure parsing
    let failure: { kind: string } | null = null;
    const exitCode = meta.exit_code !== undefined && meta.exit_code !== null ? Number(meta.exit_code) : null;
    if (status === 'FAILED' || (exitCode !== null && exitCode !== 0)) {
      const logFile = path.win32.join(jobsDir, `${jobId}.log`);
      let logTail = '';
      if (fs.existsSync(logFile)) {
        try {
          const rawLog = fs.readFileSync(logFile, 'utf8');
          logTail = rawLog.slice(-65536);
        } catch {
          logTail = '';
        }
      }
      const classified = classifyFailure(logTail, exitCode ?? 1);
      failure = { kind: classified.kind };
    }

    const row: LedgerRow = {
      job_id: jobId,
      team_run_id: teamRunId,
      mode: String(meta.mode ?? 'task'),
      agent: String(meta.agent ?? meta.mode ?? ''),
      role: String(meta.role ?? 'backend'),
      team: meta.team as Record<string, string> | undefined,
      implementer: meta.implementer ? String(meta.implementer) : undefined,
      reviewers: Array.isArray(meta.reviewers) ? meta.reviewers.map(String) : undefined,
      project_path: projectPath,
      status,
      exit_code: exitCode,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_s: durationS,
      calls: jobCalls,
      in_tokens: inTokens,
      out_tokens: outTokens,
      cost_usd: Math.round(costUsd * 10000) / 10000,
      review: {
        verdict: reviewVerdict,
        score: reviewScore,
        rounds: reviewRounds,
      },
      failure,
      recovery_of: recoveryOf,
    };

    appendJsonl(ledgerFile, row);
    seenJobIds.add(jobId);
  }
}

function ensureLedgerTimer(ctx: MawFeatureContext): void {
  if (!ledgerTimer) {
    ledgerTimer = setInterval(() => {
      syncLedger(ctx).catch(() => {});
    }, 60000);
    ledgerTimer.unref();
  }
}

export const feature: MawFeature = {
  name: 'budget',
  ui: {
    script: 'feat-budget.js',
    style: 'feat-budget.css',
  },
  routes: {
    budget_get: {
      method: 'GET',
      handler: async (ctx) => {
        const cfgFile = path.win32.join(ctx.paths.featureDataDir('budget'), 'budgets.json');
        const readRes = readJsonSafe<BudgetConfig>(cfgFile, createDefaultBudgetConfig());
        const warnings: string[] = [];
        if (readRes.warning) warnings.push(readRes.warning);

        return {
          ok: true,
          config: readRes.data,
          defaults: createDefaultBudgetConfig(),
          warnings,
        };
      },
    },
    budget_save: {
      method: 'POST',
      handler: async (ctx, req) => {
        const rawConfig = req.body.config ?? req.body;
        const valRes = validateBudgetConfig(rawConfig);
        if (valRes.errorField) {
          if (req.res) {
            req.res.statusCode = 400;
          }
          return {
            ok: false,
            error: valRes.errorMessage || 'Invalid budget configuration.',
            field: valRes.errorField,
          };
        }

        const budgetDir = ctx.paths.featureDataDir('budget');
        const cfgFile = path.win32.join(budgetDir, 'budgets.json');
        writeJsonAtomic(cfgFile, valRes.config);
        appendS4Audit(budgetDir, 'budget_save', { config: valRes.config });

        // Invalidate status cache
        cachedStatus = null;

        return {
          ok: true,
          config: valRes.config,
        };
      },
    },
    budget_spend: {
      method: 'GET',
      handler: async (ctx, req) => {
        ensureLedgerTimer(ctx);
        await syncLedger(ctx);

        const projectPath = (req.url.searchParams.get('project_path') ?? '').trim();
        const daysParam = Number.parseInt(req.url.searchParams.get('days') ?? '14', 10);
        const days = Math.min(90, Math.max(1, Number.isFinite(daysParam) ? daysParam : 14));

        const cfgFile = path.win32.join(ctx.paths.featureDataDir('budget'), 'budgets.json');
        const budgetCfg = readJsonSafe<BudgetConfig>(cfgFile, createDefaultBudgetConfig()).data;

        const { rows } = readAuditRows(ctx.paths.auditFile, 0);
        const now = new Date();

        // 1. Today
        const daySpend = calculateDaySpend(rows, now);
        const dayCaps = budgetCfg.caps.day ?? {};
        const today = {
          usd: daySpend.usd,
          tokens: daySpend.tokens,
          calls: daySpend.calls,
          cap: dayCaps.usd ?? { warn: 0, block: 0 },
          tokens_cap: dayCaps.tokens ?? { warn: 0, block: 0 },
        };

        // 2. Project
        let project = {
          path: projectPath,
          period: 'month',
          usd: 0,
          tokens: 0,
          cap: { warn: 0, block: 0 },
        };
        if (projectPath) {
          const normProj = projectPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
          const projOverride = budgetCfg.projects?.[normProj]?.project || budgetCfg.caps.project;
          const period = projOverride?.period || 'month';
          const pSpend = calculateProjectSpend(rows, projectPath, period, now);
          project = {
            path: projectPath,
            period,
            usd: pSpend.usd,
            tokens: pSpend.tokens,
            cap: projOverride?.usd ?? { warn: 0, block: 0 },
          };
        }

        // 3. by_day (oldest -> newest, `days` count)
        const byDayMap = new Map<string, { usd: number; tokens: number; calls: number }>();
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date(now.getTime() - i * 86400000);
          const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
            d.getDate()
          ).padStart(2, '0')}`;
          byDayMap.set(dateStr, { usd: 0, tokens: 0, calls: 0 });
        }

        for (const r of rows) {
          const d = new Date(r.Timestamp);
          if (Number.isNaN(d.getTime())) continue;
          const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
            d.getDate()
          ).padStart(2, '0')}`;
          if (byDayMap.has(dateStr)) {
            const entry = byDayMap.get(dateStr)!;
            entry.usd += r.cost_usd;
            entry.tokens += r.in_tokens + r.out_tokens;
            entry.calls += 1;
          }
        }

        const by_day = [...byDayMap.entries()].map(([date, data]) => ({
          date,
          usd: Math.round(data.usd * 10000) / 10000,
          tokens: data.tokens,
          calls: data.calls,
        }));

        // 4. by_agent_today
        const agentMap = new Map<string, { usd: number; calls: number }>();
        for (const r of rows) {
          const d = new Date(r.Timestamp);
          if (
            d.getFullYear() === now.getFullYear() &&
            d.getMonth() === now.getMonth() &&
            d.getDate() === now.getDate()
          ) {
            const ag = (r.Agent || r.Tool).trim().toLowerCase();
            if (ag) {
              const cur = agentMap.get(ag) || { usd: 0, calls: 0 };
              cur.usd += r.cost_usd;
              cur.calls += 1;
              agentMap.set(ag, cur);
            }
          }
        }

        const agentCap = budgetCfg.caps.agent_day?.usd ?? { warn: 0, block: 0 };
        const by_agent_today = [...agentMap.entries()].map(([agent, data]) => ({
          agent,
          usd: Math.round(data.usd * 10000) / 10000,
          calls: data.calls,
          cap: agentCap,
        }));

        // 5. running_jobs
        const running_jobs: Array<{ job_id: string; usd: number; cap: { warn: number; block: number } }> = [];
        try {
          const recent = await ctx.readJobs();
          for (const j of recent) {
            if (j.status === 'RUNNING') {
              const jId = String(j.job_id ?? '');
              const jProj = String(j.project_path ?? projectPath);
              const jSpend = calculateJobSpendFromOffset(ctx.paths.auditFile, 0, jProj);
              running_jobs.push({
                job_id: jId,
                usd: jSpend.usd,
                cap: budgetCfg.caps.job?.usd ?? { warn: 0, block: 0 },
              });
            }
          }
        } catch {
          // Ignore
        }

        // 6. recent_blocks
        const recent_blocks: unknown[] = [];

        return {
          ok: true,
          today,
          project,
          by_day,
          by_agent_today,
          running_jobs,
          recent_blocks,
        };
      },
    },
  },
  status: async (ctx) => {
    ensureLedgerTimer(ctx);

    const auditFile = ctx.paths.auditFile;
    let mtime = 0;
    let size = 0;
    if (fs.existsSync(auditFile)) {
      try {
        const st = fs.statSync(auditFile);
        mtime = st.mtimeMs;
        size = st.size;
      } catch {
        // Ignore
      }
    }

    if (cachedStatus && cachedStatus.mtime === mtime && cachedStatus.size === size) {
      return cachedStatus.data;
    }

    const cfgFile = path.win32.join(ctx.paths.featureDataDir('budget'), 'budgets.json');
    const readRes = readJsonSafe<BudgetConfig>(cfgFile, createDefaultBudgetConfig());
    const budgetCfg = readRes.data;
    const warnings: string[] = [];
    if (readRes.warning) warnings.push(readRes.warning);

    const { rows } = readAuditRows(auditFile, 0);
    const daySpend = calculateDaySpend(rows, new Date());
    const dayUsdCap = budgetCfg.caps.day?.usd;

    const today_usd = daySpend.usd;
    const today_cap_usd = dayUsdCap?.block ?? 0;
    const today_warn_usd = dayUsdCap?.warn ?? 0;

    let level: 'ok' | 'warn' | 'block' = 'ok';
    if (budgetCfg.enabled) {
      if (today_cap_usd > 0 && today_usd >= today_cap_usd) {
        level = 'block';
      } else if (today_warn_usd > 0 && today_usd >= today_warn_usd) {
        level = 'warn';
      }
    }

    const statusData = {
      enabled: budgetCfg.enabled,
      today_usd,
      today_cap_usd,
      today_warn_usd,
      level,
      warnings,
    };

    cachedStatus = {
      mtime,
      size,
      data: statusData,
    };

    return statusData;
  },
};
