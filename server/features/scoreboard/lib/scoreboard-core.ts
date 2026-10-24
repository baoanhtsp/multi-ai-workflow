import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../../lib/paths.ts';
import type { LoadedRegistry } from '../../../lib/registry.ts';
import {
  isPathInsideProject,
  readAuditRows,
  readHumanVerdicts,
  readJsonSafe,
  writeJsonAtomic,
  type S4AuditEntry,
} from '../../policy/lib/s4-core.ts';

// ============================================================================
// 1. Interfaces
// ============================================================================

export interface LedgerJobRecord {
  job_id: string;
  team_run_id?: string;
  mode: string;
  agent: string;
  role: string;
  team?: Record<string, string>;
  implementer?: string;
  reviewers?: string[];
  project_path?: string;
  status: string;
  exit_code?: number | null;
  started_at?: string;
  finished_at?: string;
  duration_s?: number;
  calls?: number;
  in_tokens?: number;
  out_tokens?: number;
  cost_usd?: number;
  review?: {
    verdict?: string;
    score?: number;
    rounds?: number;
  };
  failure?: {
    kind?: string;
  };
}

export interface ScoreboardRow {
  agent: string;
  label: string;
  color: string;
  role: string;
  tasks: number;
  reviewed: number;
  approval_rate: number | null;
  avg_score: number | null;
  avg_fix_rounds: number | null;
  cost_usd: number;
  cost_per_approved_usd: number | null;
  median_duration_s: number | null;
  failure_rate: number;
  last_at: string | null;
}

export interface ScoreboardTotals {
  jobs: number;
  cost_usd: number;
  approved: number;
}

export interface ScoreboardResult {
  days: number;
  rows: ScoreboardRow[];
  totals: ScoreboardTotals;
  generated_at: string;
}

export interface CandidateMetric {
  agent: string;
  score: number;
  tasks: number;
  approval_rate: number | null;
  avg_score: number | null;
  cost_per_approved_usd: number | null;
}

export interface SuggestTeamRoleDetail {
  agent: string;
  score: number;
  confidence: number;
  reason: string;
  candidates: CandidateMetric[];
}

export interface SuggestTeamResult {
  team: Record<string, string>;
  details: Record<string, SuggestTeamRoleDetail>;
  days: number;
}

// ============================================================================
// 2. Data Extraction & Aggregation
// ============================================================================

export function readLedgerJobs(paths: ServerPaths): LedgerJobRecord[] {
  const ledgerFile = path.win32.join(paths.featureDataDir('budget'), 'ledger.jsonl');
  if (!fs.existsSync(ledgerFile)) return [];
  try {
    const content = fs.readFileSync(ledgerFile, 'utf8');
    return content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerJobRecord);
  } catch {
    return [];
  }
}

interface RawStat {
  agent: string;
  role: string;
  tasks: number;
  reviewed: number;
  approved: number;
  scores: number[];
  fixRounds: number[];
  costUsd: number;
  durations: number[];
  failures: number;
  lastAt: string | null;
}

export function computeScoreboard(
  paths: ServerPaths,
  registry: LoadedRegistry,
  options: {
    days?: number;
    role?: string;
    project_path?: string;
  }
): ScoreboardResult {
  const days = Math.max(1, Math.min(365, options.days ?? 30));
  const filterRole = (options.role || '').trim().toLowerCase();
  const filterProject = (options.project_path || '').trim();

  const nowMs = Date.now();
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

  const jobs = readLedgerJobs(paths);
  const ledgerJobIds = new Set(jobs.map((j) => j.job_id).filter(Boolean));
  const { rows: auditRows } = readAuditRows(paths.auditFile, 0);
  const humanVerdicts = readHumanVerdicts(paths.mawHome);

  // Group raw stats by `${agent}:${role}`
  const statsMap = new Map<string, RawStat>();

  const getOrCreateStat = (agent: string, role: string): RawStat => {
    const key = `${agent.toLowerCase()}:${role.toLowerCase()}`;
    let s = statsMap.get(key);
    if (!s) {
      s = {
        agent: agent.toLowerCase(),
        role: role.toLowerCase(),
        tasks: 0,
        reviewed: 0,
        approved: 0,
        scores: [],
        fixRounds: [],
        costUsd: 0,
        durations: [],
        failures: 0,
        lastAt: null,
      };
      statsMap.set(key, s);
    }
    return s;
  };

  const updateLastAt = (s: RawStat, ts?: string) => {
    if (!ts) return;
    if (!s.lastAt || ts > s.lastAt) {
      s.lastAt = ts;
    }
  };

  // 1. Process ledger jobs
  for (const job of jobs) {
    const finishTime = job.finished_at || job.started_at;
    if (finishTime) {
      const ms = new Date(finishTime).getTime();
      if (!Number.isNaN(ms) && ms < cutoffMs) {
        continue;
      }
    }

    if (filterProject && job.project_path) {
      if (!isPathInsideProject(job.project_path, filterProject)) {
        continue;
      }
    }

    const mode = (job.mode || 'task').toLowerCase();

    // Mode attribution:
    if (mode === 'task') {
      const agent = (job.agent || '').trim().toLowerCase();
      const role = (job.role || 'backend').trim().toLowerCase();
      if (agent) {
        const s = getOrCreateStat(agent, role);
        s.tasks++;
        s.costUsd += job.cost_usd ?? 0;
        if (typeof job.duration_s === 'number' && job.duration_s >= 0) {
          s.durations.push(job.duration_s);
        }
        updateLastAt(s, finishTime);

        // Failures
        const isCancelled = (job.status || '').toUpperCase() === 'CANCELLED';
        const isBlocked = job.failure?.kind === 'blocked';
        const isFailed = (job.exit_code !== undefined && job.exit_code !== null && job.exit_code !== 0) || job.status === 'FAILED';
        if (isFailed && !isCancelled && !isBlocked) {
          s.failures++;
        }

        // Reviews
        if (job.review && typeof job.review.score === 'number') {
          s.reviewed++;
          s.scores.push(job.review.score);
          if ((job.review.verdict || '').toUpperCase() === 'APPROVED') {
            s.approved++;
          }
        }
      }
    } else if (mode === 'auto-gate') {
      const impl = (job.implementer || job.agent || '').trim().toLowerCase();
      if (impl) {
        const s = getOrCreateStat(impl, 'backend');
        s.tasks++;
        s.costUsd += job.cost_usd ?? 0;
        if (typeof job.duration_s === 'number' && job.duration_s >= 0) {
          s.durations.push(job.duration_s);
        }
        updateLastAt(s, finishTime);

        const isCancelled = (job.status || '').toUpperCase() === 'CANCELLED';
        const isBlocked = job.failure?.kind === 'blocked';
        const isFailed = (job.exit_code !== undefined && job.exit_code !== null && job.exit_code !== 0) || job.status === 'FAILED';
        if (isFailed && !isCancelled && !isBlocked) {
          s.failures++;
        }

        if (job.review && typeof job.review.score === 'number') {
          s.reviewed++;
          s.scores.push(job.review.score);
          if ((job.review.verdict || '').toUpperCase() === 'APPROVED') {
            s.approved++;
          }
        }
        if (job.review && typeof job.review.rounds === 'number' && job.review.rounds > 1) {
          s.fixRounds.push(job.review.rounds - 1);
        }
      }
    }
  }

  // 1b. Process S5 human review verdicts for jobs not in ledger (Part B)
  for (const hv of humanVerdicts) {
    if (ledgerJobIds.has(hv.job_id)) continue;
    const finishTime = hv.ts;
    if (finishTime) {
      const ms = new Date(finishTime).getTime();
      if (!Number.isNaN(ms) && ms < cutoffMs) {
        continue;
      }
    }
    if (filterProject && hv.project_path) {
      if (!isPathInsideProject(hv.project_path, filterProject)) {
        continue;
      }
    }
    const agent = (hv.agent || '').trim().toLowerCase();
    const role = (hv.role || 'backend').trim().toLowerCase();
    if (agent) {
      const s = getOrCreateStat(agent, role);
      s.reviewed++;
      updateLastAt(s, finishTime);
      const sc = typeof hv.score === 'number' ? hv.score : Number.parseFloat(String(hv.score ?? ''));
      if (Number.isFinite(sc)) {
        s.scores.push(sc);
      }
      if ((hv.verdict || '').toUpperCase() === 'APPROVED') {
        s.approved++;
      }
    }
  }

  // 2. Process audit rows for reviewer calls and team members
  for (const row of auditRows) {
    if (row.Timestamp) {
      const ms = new Date(row.Timestamp).getTime();
      if (!Number.isNaN(ms) && ms < cutoffMs) {
        continue;
      }
    }

    if (filterProject && row.WorkDir) {
      if (!isPathInsideProject(row.WorkDir, filterProject)) {
        continue;
      }
    }

    const agent = (row.Agent || row.Tool || '').trim().toLowerCase();
    const role = (row.Role || '').trim().toLowerCase();

    if (role === 'reviewer' && agent) {
      const s = getOrCreateStat(agent, 'reviewer');
      s.tasks++;
      s.costUsd += row.CostUsd || 0;
      updateLastAt(s, row.Timestamp);

      if (row.Score) {
        const match = /(\d+(?:\.\d+)?)\s*\/\s*10/.exec(row.Score);
        if (match) {
          s.reviewed++;
          s.scores.push(parseFloat(match[1]!));
        }
      }
      if (row.Verdict) {
        if (row.Verdict.toUpperCase() === 'APPROVED') {
          s.approved++;
        }
      }
    } else if (role && role !== 'reviewer' && agent) {
      // For team mode calls: audit row attribute to (agent, role)
      const s = getOrCreateStat(agent, role);
      updateLastAt(s, row.Timestamp);
    }
  }

  // 3. Compile rows
  const rows: ScoreboardRow[] = [];
  let totalJobs = 0;
  let totalCostUsd = 0;
  let totalApproved = 0;

  for (const stat of statsMap.values()) {
    if (filterRole && stat.role !== filterRole) {
      continue;
    }

    const regAgent = registry.agents.find((a) => a.id.toLowerCase() === stat.agent);
    const label = regAgent?.label || stat.agent;
    const color = regAgent?.color || '#888888';

    const approval_rate = stat.reviewed > 0 ? stat.approved / stat.reviewed : null;
    const avg_score =
      stat.scores.length > 0
        ? stat.scores.reduce((a, b) => a + b, 0) / stat.scores.length
        : null;

    const avg_fix_rounds =
      stat.fixRounds.length > 0
        ? stat.fixRounds.reduce((a, b) => a + b, 0) / stat.fixRounds.length
        : null;

    const cost_per_approved_usd =
      stat.approved > 0 ? stat.costUsd / stat.approved : null;

    let median_duration_s: number | null = null;
    if (stat.durations.length > 0) {
      const sorted = [...stat.durations].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      median_duration_s =
        sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    }

    const failure_rate = stat.tasks > 0 ? stat.failures / stat.tasks : 0;

    totalJobs += stat.tasks;
    totalCostUsd += stat.costUsd;
    totalApproved += stat.approved;

    rows.push({
      agent: stat.agent,
      label,
      color,
      role: stat.role,
      tasks: stat.tasks,
      reviewed: stat.reviewed,
      approval_rate,
      avg_score,
      avg_fix_rounds,
      cost_usd: Math.round(stat.costUsd * 10000) / 10000,
      cost_per_approved_usd:
        cost_per_approved_usd !== null
          ? Math.round(cost_per_approved_usd * 10000) / 10000
          : null,
      median_duration_s:
        median_duration_s !== null ? Math.round(median_duration_s * 10) / 10 : null,
      failure_rate: Math.round(failure_rate * 1000) / 1000,
      last_at: stat.lastAt,
    });
  }

  // Sort rows: tasks descending
  rows.sort((a, b) => b.tasks - a.tasks);

  return {
    days,
    rows,
    totals: {
      jobs: totalJobs,
      cost_usd: Math.round(totalCostUsd * 10000) / 10000,
      approved: totalApproved,
    },
    generated_at: new Date().toISOString(),
  };
}

// ============================================================================
// 3. Team Suggestion (`suggest_team`)
// ============================================================================

export function suggestTeam(
  paths: ServerPaths,
  registry: LoadedRegistry,
  options: {
    days?: number;
    roles?: string[];
    project_path?: string;
  }
): SuggestTeamResult {
  const days = Math.max(1, Math.min(365, options.days ?? 30));
  const requestedRoles = options.roles && options.roles.length > 0
    ? options.roles.map((r) => r.trim().toLowerCase())
    : ['backend', 'frontend', 'reviewer'];

  const sb = computeScoreboard(paths, registry, { days, project_path: options.project_path });
  const rowMap = new Map<string, ScoreboardRow>();
  for (const r of sb.rows) {
    rowMap.set(`${r.agent}:${r.role}`, r);
  }

  const cooldownFile = path.win32.join(paths.featureDataDir('fallback'), 'cooldowns.json');
  const cooldowns = readJsonSafe<Record<string, { until: string }>>(cooldownFile, {}).data;
  const now = Date.now();

  const isCoolingDown = (agentId: string) => {
    const cd = cooldowns[agentId];
    if (!cd || !cd.until) return false;
    const untilMs = new Date(cd.until).getTime();
    return !Number.isNaN(untilMs) && untilMs > now;
  };

  const team: Record<string, string> = {};
  const details: Record<string, SuggestTeamRoleDetail> = {};

  for (const role of requestedRoles) {
    // 1. Identify candidates from registry
    const candidates = registry.agents.filter((a) => {
      if (a.enabled === false) return false;
      if ((a as unknown as { installed?: boolean }).installed === false) return false;
      if (isCoolingDown(a.id)) return false;

      const caps = a.capabilities || {};
      if (role === 'reviewer') {
        return caps.review === true;
      }
      if (role === 'backend' || role === 'frontend' || role === 'tester') {
        return caps.write === true;
      }
      return true; // architect / leader / any other
    });

    const regDefaultsTeam = registry.defaults.team as Record<string, string>;

    if (candidates.length === 0) {
      const defAgent = regDefaultsTeam[role] || registry.defaults.implementer || 'antigravity';
      team[role] = defAgent;
      details[role] = {
        agent: defAgent,
        score: 0.5,
        confidence: 0,
        reason: 'no eligible candidates, registry fallback',
        candidates: [],
      };
      continue;
    }

    // 2. Score candidates
    const candidateMetrics: Array<{
      agent: string;
      tasks: number;
      approval_rate: number | null;
      avg_score: number | null;
      failure_rate: number;
      median_duration_s: number | null;
      cost_per_approved_usd: number | null;
      cost_usd: number;
    }> = [];

    for (const c of candidates) {
      const r = rowMap.get(`${c.id.toLowerCase()}:${role}`);
      if (r) {
        candidateMetrics.push({
          agent: c.id,
          tasks: r.tasks,
          approval_rate: r.approval_rate,
          avg_score: r.avg_score,
          failure_rate: r.failure_rate,
          median_duration_s: r.median_duration_s,
          cost_per_approved_usd: r.cost_per_approved_usd,
          cost_usd: r.cost_usd,
        });
      } else {
        candidateMetrics.push({
          agent: c.id,
          tasks: 0,
          approval_rate: null,
          avg_score: null,
          failure_rate: 0,
          median_duration_s: null,
          cost_per_approved_usd: null,
          cost_usd: 0,
        });
      }
    }

    // Calculate max median duration for speed calculation
    const durations = candidateMetrics
      .map((m) => m.median_duration_s)
      .filter((d): d is number => d !== null && d > 0);
    const maxMedian = durations.length > 0 ? Math.max(...durations) : 0;

    const scoredCandidates: Array<{
      agent: string;
      rawScore: number;
      finalScore: number;
      confidence: number;
      tasks: number;
      approval_rate: number | null;
      avg_score: number | null;
      cost_per_approved_usd: number | null;
      cost_usd: number;
    }> = [];

    for (const m of candidateMetrics) {
      const approval = m.approval_rate !== null ? m.approval_rate : 0.5;
      const avgScoreNorm = m.avg_score !== null ? m.avg_score / 10 : 0.75;
      const failRate = m.failure_rate;
      const speed =
        maxMedian > 0 && m.median_duration_s !== null
          ? Math.max(0, 1 - m.median_duration_s / maxMedian)
          : 0.5;

      // Score = 0.45*approval_rate + 0.25*(avg_score/10) + 0.15*(1-failure_rate) + 0.15*speed
      const rawScore =
        0.45 * approval +
        0.25 * avgScoreNorm +
        0.15 * (1 - failRate) +
        0.15 * speed;

      const confidence = Math.min(1, m.tasks / 5);
      const finalScore = confidence * rawScore + (1 - confidence) * 0.5;

      scoredCandidates.push({
        agent: m.agent,
        rawScore,
        finalScore: Math.round(finalScore * 1000) / 1000,
        confidence: Math.round(confidence * 100) / 100,
        tasks: m.tasks,
        approval_rate: m.approval_rate !== null ? Math.round(m.approval_rate * 100) / 100 : null,
        avg_score: m.avg_score !== null ? Math.round(m.avg_score * 10) / 10 : null,
        cost_per_approved_usd:
          m.cost_per_approved_usd !== null
            ? Math.round(m.cost_per_approved_usd * 100) / 100
            : null,
        cost_usd: m.cost_usd,
      });
    }

    // Check if there is NO data at all for any candidate
    const hasAnyData = scoredCandidates.some((c) => c.tasks > 0);
    if (!hasAnyData) {
      const defAgent =
        regDefaultsTeam[role] ||
        (role === 'backend' ? registry.defaults.implementer : '') ||
        candidates[0]!.id;

      team[role] = defAgent;
      details[role] = {
        agent: defAgent,
        score: 0.5,
        confidence: 0,
        reason: 'no history, registry default',
        candidates: scoredCandidates.map((c) => ({
          agent: c.agent,
          score: c.finalScore,
          tasks: c.tasks,
          approval_rate: c.approval_rate,
          avg_score: c.avg_score,
          cost_per_approved_usd: c.cost_per_approved_usd,
        })),
      };
      continue;
    }

    // Sort scored candidates strictly by descending finalScore.
    scoredCandidates.sort((a, b) => {
      const diff = b.finalScore - a.finalScore;
      if (Math.abs(diff) > 0.0001) return diff;
      if (b.tasks !== a.tasks) return b.tasks - a.tasks;
      return a.agent.localeCompare(b.agent);
    });

    const regDefault = regDefaultsTeam[role] || registry.defaults.implementer || '';
    const top = scoredCandidates[0]!;
    const tied = scoredCandidates.filter((c) => top.finalScore - c.finalScore < 0.02);

    let chosen = top;
    let tieBreakReason: string | null = null;

    if (tied.length > 1) {
      // Tie-break 1: lower cost_per_approved_usd (if null, mean cost per task)
      let minCostCand = tied[0]!;
      let minCostVal =
        minCostCand.cost_per_approved_usd !== null
          ? minCostCand.cost_per_approved_usd
          : minCostCand.tasks > 0
          ? minCostCand.cost_usd / minCostCand.tasks
          : 999;

      for (let i = 1; i < tied.length; i++) {
        const c = tied[i]!;
        const costVal =
          c.cost_per_approved_usd !== null
            ? c.cost_per_approved_usd
            : c.tasks > 0
            ? c.cost_usd / c.tasks
            : 999;
        if (costVal < minCostVal) {
          minCostVal = costVal;
          minCostCand = c;
        }
      }

      const topCostVal =
        top.cost_per_approved_usd !== null
          ? top.cost_per_approved_usd
          : top.tasks > 0
          ? top.cost_usd / top.tasks
          : 999;

      if (topCostVal - minCostVal > 0.01) {
        chosen = minCostCand;
        tieBreakReason = 'tie-break: lower cost';
      } else if (regDefault) {
        // Tie-break 2: registry default
        const defCand = tied.find(
          (c) => c.agent.toLowerCase() === regDefault.toLowerCase()
        );
        if (defCand && defCand.agent.toLowerCase() !== top.agent.toLowerCase()) {
          chosen = defCand;
          tieBreakReason = 'tie-break: registry default';
        }
      }
    }

    team[role] = chosen.agent;

    let reasonParts: string[] = [];
    if (chosen.approval_rate !== null) {
      reasonParts.push(`approval ${Math.round(chosen.approval_rate * 100)}%`);
    }
    if (chosen.avg_score !== null) {
      reasonParts.push(`avg ${chosen.avg_score}`);
    }
    if (chosen.cost_per_approved_usd !== null) {
      reasonParts.push(`$${chosen.cost_per_approved_usd.toFixed(2)}/approved`);
    }
    if (tieBreakReason) {
      reasonParts.push(tieBreakReason);
    }
    if (reasonParts.length === 0) {
      reasonParts = ['registry default'];
    }

    details[role] = {
      agent: chosen.agent,
      score: chosen.finalScore,
      confidence: chosen.confidence,
      reason: reasonParts.join(' · '),
      candidates: scoredCandidates.map((c) => ({
        agent: c.agent,
        score: c.finalScore,
        tasks: c.tasks,
        approval_rate: c.approval_rate,
        avg_score: c.avg_score,
        cost_per_approved_usd: c.cost_per_approved_usd,
      })),
    };
  }

  return {
    team,
    details,
    days,
  };
}
