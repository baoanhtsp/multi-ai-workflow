import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../lib/paths.ts';
import type { LoadedRegistry } from '../../lib/registry.ts';
import {
  detectAccountLoginFast,
  getEffectiveAccountConfigDir,
  listAllAccounts,
  type AccountView,
} from '../accounts/store.ts';
import { findCodexQuotaWindows } from '../health/probes.ts';
import {
  appendJsonl,
  loadFallbackConfig,
  readAuditRows,
  readJsonSafe,
  writeJsonAtomic,
  type QuotaRoutingConfig,
} from '../policy/lib/s4-core.ts';

export type QuotaWindowId = '5h' | '7d' | 'custom';
export type QuotaSource = 'provider' | 'estimate' | 'error';
export type QuotaLevel = 'ok' | 'warn' | 'high' | 'full';

export interface QuotaWindow {
  id: QuotaWindowId;
  used_percent: number;
  resets_at: string | null;
  source: QuotaSource;
}

export interface QuotaSnapshot {
  agent: string;
  account: string;
  checked_at: string;
  login: 'ok' | 'logged_out' | 'unknown';
  windows: QuotaWindow[];
  level: QuotaLevel;
  cooldown_until: string | null;
  last_error: string | null;
}

export interface QuotaSnapshotsFile {
  version: 1;
  snapshots: QuotaSnapshot[];
}

export interface QuotaRouteDecision {
  requested: { agent: string; account: string };
  chosen: { agent: string; account: string };
  mode: 'auto' | 'suggest' | 'off';
  reason: 'ok' | 'switched' | 'suggested' | 'waiting' | 'all-full';
  quota: Record<string, number>;
  resets_at?: string | null;
  suggestion?: {
    agent: string;
    account: string;
    quota?: Record<string, number>;
  } | null;
}

const LEVEL_RANK: Record<QuotaLevel, number> = {
  ok: 0,
  warn: 1,
  high: 2,
  full: 3,
};

export function getSnapshotsFilePath(paths: ServerPaths): string {
  return path.win32.join(paths.featureDataDir('quota'), 'snapshots.json');
}

export function getQuotaEventsFilePath(paths: ServerPaths): string {
  return path.win32.join(paths.featureDataDir('quota'), 'events.jsonl');
}

export function computeWindowLevel(usedPercent: number, switchAt = 85): QuotaLevel {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return 'ok';
  if (usedPercent >= 100) return 'full';
  if (usedPercent >= switchAt) return 'high';
  if (usedPercent >= 70) return 'warn';
  return 'ok';
}

export function computeQuotaLevel(
  windows: QuotaWindow[],
  cooldownUntil: string | null | undefined,
  switchAt = 85,
  nowMs = Date.now()
): QuotaLevel {
  if (cooldownUntil) {
    const untilMs = Date.parse(cooldownUntil);
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      return 'full';
    }
  }
  let highest: QuotaLevel = 'ok';
  for (const w of windows) {
    const lvl = computeWindowLevel(w.used_percent, switchAt);
    if (LEVEL_RANK[lvl] > LEVEL_RANK[highest]) {
      highest = lvl;
    }
  }
  return highest;
}

export function getMaxUsedPercent(
  windows: QuotaWindow[],
  cooldownUntil?: string | null,
  nowMs = Date.now()
): number {
  if (cooldownUntil) {
    const untilMs = Date.parse(cooldownUntil);
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      return 100;
    }
  }
  let max = 0;
  for (const w of windows) {
    if (Number.isFinite(w.used_percent) && w.used_percent > max) {
      max = w.used_percent;
    }
  }
  return Math.max(0, Math.min(100, Math.round(max * 10) / 10));
}

export function loadQuotaSnapshots(paths: ServerPaths): QuotaSnapshot[] {
  const file = getSnapshotsFilePath(paths);
  if (!fs.existsSync(file)) return [];
  const { data } = readJsonSafe<QuotaSnapshotsFile>(file, { version: 1, snapshots: [] });
  return Array.isArray(data.snapshots) ? data.snapshots : [];
}

export function saveQuotaSnapshots(
  paths: ServerPaths,
  snapshots: QuotaSnapshot[],
  prevSnapshots?: QuotaSnapshot[]
): void {
  const file = getSnapshotsFilePath(paths);
  const prevMap = new Map<string, QuotaSnapshot>();
  for (const p of prevSnapshots ?? []) {
    prevMap.set(`${p.agent}:${p.account}`, p);
  }

  const eventsFile = getQuotaEventsFilePath(paths);
  for (const snap of snapshots) {
    const key = `${snap.agent}:${snap.account}`;
    const prev = prevMap.get(key);
    if (prev && prev.level !== snap.level) {
      const topWin = [...snap.windows].sort((a, b) => b.used_percent - a.used_percent)[0];
      appendJsonl(eventsFile, {
        ts: snap.checked_at,
        agent: snap.agent,
        account: snap.account,
        prev_level: prev.level,
        level: snap.level,
        used_percent: getMaxUsedPercent(snap.windows, snap.cooldown_until),
        window: topWin?.id ?? null,
        resets_at: topWin?.resets_at ?? snap.cooldown_until ?? null,
        cooldown_until: snap.cooldown_until,
      });
    }
  }

  writeJsonAtomic(file, {
    version: 1,
    snapshots,
  });
}

export function computeEstimateWindows(
  paths: ServerPaths,
  agent: string,
  account: string,
  limits: { '5h'?: { tokens: number }; '7d'?: { tokens: number } } | undefined,
  nowMs = Date.now(),
  cachedAuditRows?: ReturnType<typeof readAuditRows>['rows']
): QuotaWindow[] {
  if (!limits) return [];
  const cap5h = Number(limits['5h']?.tokens ?? 0);
  const cap7d = Number(limits['7d']?.tokens ?? 0);
  if (!(cap5h > 0) && !(cap7d > 0)) return [];

  const rows =
    cachedAuditRows ??
    (fs.existsSync(paths.auditFile) ? readAuditRows(paths.auditFile, 0).rows : []);

  const win5hMs = 5 * 3600 * 1000;
  const win7dMs = 7 * 24 * 3600 * 1000;
  const start5h = nowMs - win5hMs;
  const start7d = nowMs - win7dMs;

  let tokens5h = 0;
  let earliest5h = 0;
  let tokens7d = 0;
  let earliest7d = 0;

  const normAgent = agent.toLowerCase();
  const normAcc = (account || 'default').toLowerCase();

  for (const r of rows) {
    const rowAgent = String(r.Agent || r.Tool || '').trim().toLowerCase();
    if (rowAgent !== normAgent) continue;
    const rowAcc = String((r as unknown as Record<string, unknown>).Account ?? 'default')
      .trim()
      .toLowerCase() || 'default';
    if (rowAcc !== normAcc) continue;

    const tsMs = Date.parse(r.Timestamp);
    if (!Number.isFinite(tsMs) || tsMs < start7d) continue;

    const totalTok = Math.max(0, (Number(r.InputTokens) || 0) + (Number(r.OutputTokens) || 0));
    if (totalTok <= 0) continue;

    tokens7d += totalTok;
    if (earliest7d === 0 || tsMs < earliest7d) {
      earliest7d = tsMs;
    }

    if (tsMs >= start5h) {
      tokens5h += totalTok;
      if (earliest5h === 0 || tsMs < earliest5h) {
        earliest5h = tsMs;
      }
    }
  }

  const out: QuotaWindow[] = [];
  if (cap5h > 0) {
    const pct = Math.min(100, Math.round((tokens5h / cap5h) * 1000) / 10);
    const resetsIso = new Date((earliest5h > 0 ? earliest5h : nowMs) + win5hMs).toISOString();
    out.push({
      id: '5h',
      used_percent: pct,
      resets_at: resetsIso,
      source: 'estimate',
    });
  }
  if (cap7d > 0) {
    const pct = Math.min(100, Math.round((tokens7d / cap7d) * 1000) / 10);
    const resetsIso = new Date((earliest7d > 0 ? earliest7d : nowMs) + win7dMs).toISOString();
    out.push({
      id: '7d',
      used_percent: pct,
      resets_at: resetsIso,
      source: 'estimate',
    });
  }
  return out;
}

export function refreshAllQuotaSnapshots(
  paths: ServerPaths,
  registry: LoadedRegistry,
  filter?: { agent?: string; account?: string; nowMs?: number }
): QuotaSnapshot[] {
  const nowMs = filter?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const prevSnapshots = loadQuotaSnapshots(paths);
  const prevMap = new Map<string, QuotaSnapshot>();
  const loginMap = new Map<string, 'ok' | 'logged_out' | 'unknown'>();
  for (const s of prevSnapshots) {
    prevMap.set(`${s.agent}:${s.account}`, s);
    if (s.login === 'ok' || s.login === 'logged_out') {
      loginMap.set(`${s.agent}:${s.account}`, s.login);
    }
  }

  const fallbackDir = paths.featureDataDir('fallback');
  const routingCfg = loadFallbackConfig(
    fallbackDir,
    registry.agents.map((a) => a.id)
  ).config;
  const switchAt = routingCfg.quota_routing?.switch_at ?? 85;

  // Read S4 cooldowns.json
  const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
  const s4Cooldowns = readJsonSafe<
    Record<string, { until: string; reason: string; source_job_id?: string }>
  >(cooldownFile, {}).data;

  const { accounts } = listAllAccounts(paths, registry, loginMap);
  const auditRows = fs.existsSync(paths.auditFile) ? readAuditRows(paths.auditFile, 0).rows : [];

  const filterAgent = filter?.agent ? filter.agent.trim().toLowerCase() : '';
  const filterAcc = filter?.account ? filter.account.trim().toLowerCase() : '';

  const updatedMap = new Map<string, QuotaSnapshot>();
  for (const prev of prevSnapshots) {
    updatedMap.set(`${prev.agent}:${prev.account}`, prev);
  }

  for (const acc of accounts) {
    const key = `${acc.agent}:${acc.id}`;
    if (filterAgent && acc.agent !== filterAgent) continue;
    if (filterAcc && acc.id !== filterAcc) continue;

    const prev = prevMap.get(key);
    const agentEntry = registry.allAgents.find((a) => a.id === acc.agent);
    const login = detectAccountLoginFast(paths, agentEntry, acc, prev?.login);

    const windows: QuotaWindow[] = [];

    // Source (a): Provider-reported (Codex rollout primary & secondary)
    if (agentEntry?.adapter === 'codex') {
      const cfgDir = getEffectiveAccountConfigDir(paths, agentEntry, acc);
      if (cfgDir) {
        const codexWins = findCodexQuotaWindows(cfgDir);
        for (const cw of codexWins) {
          windows.push({
            id: cw.id,
            used_percent: cw.used_percent,
            resets_at: cw.resets_at || null,
            source: 'provider',
          });
        }
      }
    }

    // Source (b): Preserve unexpired provider windows from previous snapshot if not overwritten
    if (prev?.windows) {
      for (const pw of prev.windows) {
        if (pw.source === 'provider' && !windows.some((w) => w.id === pw.id)) {
          const resetMs = pw.resets_at ? Date.parse(pw.resets_at) : 0;
          if (!resetMs || resetMs > nowMs) {
            windows.push({ ...pw });
          }
        }
      }
    }

    // Source (d): Rolling 5h / 7d token estimates against account.limits
    const estWins = computeEstimateWindows(
      paths,
      acc.agent,
      acc.id,
      acc.limits,
      nowMs,
      auditRows
    );
    for (const ew of estWins) {
      if (!windows.some((w) => w.id === ew.id)) {
        windows.push(ew);
      }
    }

    // Source (c): Cooldowns / rate_limited errors
    let cooldownUntil: string | null = null;
    let lastError: string | null = prev?.last_error ?? null;

    if (prev?.cooldown_until) {
      const untilMs = Date.parse(prev.cooldown_until);
      if (Number.isFinite(untilMs) && untilMs > nowMs) {
        cooldownUntil = prev.cooldown_until;
      } else {
        lastError = null;
      }
    }

    const s4Entry =
      s4Cooldowns[key] ?? (acc.id === 'default' ? s4Cooldowns[acc.agent] : undefined);
    if (s4Entry?.until) {
      const s4UntilMs = Date.parse(s4Entry.until);
      if (
        Number.isFinite(s4UntilMs) &&
        s4UntilMs > nowMs &&
        (!cooldownUntil || s4UntilMs > Date.parse(cooldownUntil))
      ) {
        cooldownUntil = s4Entry.until;
        lastError = s4Entry.reason || lastError;
      }
    }

    const level = computeQuotaLevel(windows, cooldownUntil, switchAt, nowMs);

    updatedMap.set(key, {
      agent: acc.agent,
      account: acc.id,
      checked_at: nowIso,
      login,
      windows,
      level,
      cooldown_until: cooldownUntil,
      last_error: lastError,
    });
  }

  const nextSnapshots = Array.from(updatedMap.values());
  saveQuotaSnapshots(paths, nextSnapshots, prevSnapshots);
  return nextSnapshots;
}

export function recordAccountRateLimited(
  paths: ServerPaths,
  registry: LoadedRegistry,
  agent: string,
  account: string,
  resetAtIso: string | null,
  reason = 'rate_limited',
  sourceJobId?: string,
  nowMs = Date.now()
): QuotaSnapshot {
  const normAgent = agent.trim().toLowerCase();
  const normAcc = (account || 'default').trim().toLowerCase() || 'default';
  const cooldownUntil =
    resetAtIso && Number.isFinite(Date.parse(resetAtIso)) && Date.parse(resetAtIso) > nowMs
      ? resetAtIso
      : new Date(nowMs + 3600 * 1000).toISOString();

  // Sync to S4 cooldowns.json per-account (and per-agent when default)
  const fallbackDir = paths.featureDataDir('fallback');
  const cooldownFile = path.win32.join(fallbackDir, 'cooldowns.json');
  const cooldowns = readJsonSafe<
    Record<string, { until: string; reason: string; source_job_id?: string }>
  >(cooldownFile, {}).data;
  const cdEntry = {
    until: cooldownUntil,
    reason: reason || 'rate_limited',
    ...(sourceJobId ? { source_job_id: sourceJobId } : {}),
  };
  cooldowns[`${normAgent}:${normAcc}`] = cdEntry;
  if (normAcc === 'default') {
    cooldowns[normAgent] = cdEntry;
  }
  writeJsonAtomic(cooldownFile, cooldowns);

  const prevSnapshots = loadQuotaSnapshots(paths);
  const key = `${normAgent}:${normAcc}`;
  const existing = prevSnapshots.find((s) => `${s.agent}:${s.account}` === key);
  const nowIso = new Date(nowMs).toISOString();

  const updated: QuotaSnapshot = {
    agent: normAgent,
    account: normAcc,
    checked_at: nowIso,
    login: existing?.login ?? 'ok',
    windows: existing?.windows ?? [],
    level: 'full',
    cooldown_until: cooldownUntil,
    last_error: reason || 'rate_limited',
  };

  const nextList = prevSnapshots.filter((s) => `${s.agent}:${s.account}` !== key);
  nextList.push(updated);
  saveQuotaSnapshots(paths, nextList, prevSnapshots);
  return updated;
}

function buildQuotaMap(snap: QuotaSnapshot | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!snap) return out;
  for (const w of snap.windows) {
    out[w.id] = w.used_percent;
  }
  return out;
}

export function decideQuotaRoute(
  paths: ServerPaths,
  registry: LoadedRegistry,
  options: {
    agent: string;
    role: string;
    account?: string;
    refreshIfStale?: boolean;
    forceSwitch?: boolean;
    nowMs?: number;
  }
): {
  decision: QuotaRouteDecision;
  routingConfig: QuotaRoutingConfig;
  snapshots: QuotaSnapshot[];
} {
  const nowMs = options.nowMs ?? Date.now();
  const reqAgent = String(options.agent ?? '')
    .trim()
    .toLowerCase();
  const role = String(options.role ?? 'backend')
    .trim()
    .toLowerCase();
  const explicitAcc = options.account ? String(options.account).trim().toLowerCase() : '';

  const fallbackDir = paths.featureDataDir('fallback');
  const fallbackCfg = loadFallbackConfig(
    fallbackDir,
    registry.agents.map((a) => a.id)
  ).config;
  const qr = fallbackCfg.quota_routing;

  let snapshots = loadQuotaSnapshots(paths);
  if (options.refreshIfStale !== false) {
    const isStale =
      snapshots.length === 0 ||
      snapshots.some((s) => {
        const t = Date.parse(s.checked_at);
        return !Number.isFinite(t) || nowMs - t > 60_000;
      });
    if (isStale) {
      snapshots = refreshAllQuotaSnapshots(paths, registry, { nowMs });
    }
  }

  const snapMap = new Map<string, QuotaSnapshot>();
  const loginMap = new Map<string, 'ok' | 'logged_out' | 'unknown'>();
  for (const s of snapshots) {
    snapMap.set(`${s.agent}:${s.account}`, s);
    if (s.login === 'ok' || s.login === 'logged_out') {
      loginMap.set(`${s.agent}:${s.account}`, s.login);
    }
  }

  const { accounts: allAccountViews } = listAllAccounts(paths, registry, loginMap);

  interface EvaluatedCandidate {
    view: AccountView;
    snap: QuotaSnapshot | undefined;
    level: QuotaLevel;
    usedPercent: number;
    cooling: boolean;
    signedIn: boolean;
    underThreshold: boolean;
    resetsAt: string | null;
  }

  const evaluate = (view: AccountView): EvaluatedCandidate => {
    const snap = snapMap.get(`${view.agent}:${view.id}`);
    const cooling = Boolean(
      snap?.cooldown_until &&
        Number.isFinite(Date.parse(snap.cooldown_until)) &&
        Date.parse(snap.cooldown_until) > nowMs
    );
    const level = computeQuotaLevel(
      snap?.windows ?? [],
      snap?.cooldown_until ?? null,
      qr.switch_at,
      nowMs
    );
    const usedPercent = getMaxUsedPercent(snap?.windows ?? [], snap?.cooldown_until ?? null, nowMs);
    const effLogin = snap?.login && snap.login !== 'unknown' ? snap.login : view.login;
    const signedIn =
      effLogin !== 'logged_out' &&
      (view.is_default || Boolean(view.dir && fs.existsSync(view.dir)));
    const underThreshold =
      view.enabled &&
      signedIn &&
      !cooling &&
      level !== 'full' &&
      usedPercent < qr.switch_at;

    let resetsAt: string | null = snap?.cooldown_until ?? null;
    if (!resetsAt && snap?.windows) {
      for (const w of snap.windows) {
        if (w.resets_at) {
          if (!resetsAt || Date.parse(w.resets_at) < Date.parse(resetsAt)) {
            resetsAt = w.resets_at;
          }
        }
      }
    }

    return {
      view,
      snap,
      level,
      usedPercent,
      cooling,
      signedIn,
      underThreshold,
      resetsAt,
    };
  };

  const agentAccounts = allAccountViews
    .filter((a) => a.agent === reqAgent)
    .map(evaluate);

  // Determine primary account for reqAgent:
  // If explicit account was given, use it; otherwise pick reqAgent's highest-priority enabled account (lower priority value first).
  let primaryCand: EvaluatedCandidate | undefined;
  if (explicitAcc) {
    primaryCand = agentAccounts.find((c) => c.view.id === explicitAcc);
  } else {
    const enabledForAgent = agentAccounts
      .filter((c) => c.view.enabled && c.signedIn)
      .sort(
        (a, b) =>
          a.view.priority - b.view.priority ||
          (a.view.is_default ? -1 : b.view.is_default ? 1 : a.view.id.localeCompare(b.view.id))
      );
    primaryCand = enabledForAgent[0] ?? agentAccounts.find((c) => c.view.is_default) ?? agentAccounts[0];
  }

  const reqAccountId = primaryCand?.view.id ?? (explicitAcc || 'default');
  const reqSnap = primaryCand?.snap ?? snapMap.get(`${reqAgent}:${reqAccountId}`);

  // Mode 'off' or disabled
  if (!qr.enabled || qr.mode === 'off') {
    return {
      decision: {
        requested: { agent: reqAgent, account: reqAccountId },
        chosen: { agent: reqAgent, account: reqAccountId },
        mode: 'off',
        reason: 'ok',
        quota: buildQuotaMap(reqSnap),
      },
      routingConfig: qr,
      snapshots,
    };
  }

  // Step 1: If primary account of A is enabled, signed in, and < switch_at, use it.
  if (primaryCand && primaryCand.underThreshold && !options.forceSwitch) {
    return {
      decision: {
        requested: { agent: reqAgent, account: reqAccountId },
        chosen: { agent: reqAgent, account: primaryCand.view.id },
        mode: qr.mode,
        reason: 'ok',
        quota: buildQuotaMap(primaryCand.snap),
      },
      routingConfig: qr,
      snapshots,
    };
  }

  // Gather alternatives < switch_at
  const sortCandidates = (list: EvaluatedCandidate[]): EvaluatedCandidate[] =>
    [...list].sort(
      (a, b) =>
        LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
        a.usedPercent - b.usedPercent ||
        a.view.priority - b.view.priority ||
        (a.view.is_default ? -1 : b.view.is_default ? 1 : a.view.id.localeCompare(b.view.id))
    );

  const sameAgentAlts = sortCandidates(
    agentAccounts.filter((c) => c.view.id !== reqAccountId && c.underThreshold)
  );

  const roleFallbacks = fallbackCfg.roles[role]?.fallbacks ?? [];
  const enabledAgentIds = new Set(registry.agents.map((a) => a.id));
  const fallbackAgentAlts: EvaluatedCandidate[] = [];

  for (const fbAgent of roleFallbacks) {
    if (fbAgent === reqAgent || !enabledAgentIds.has(fbAgent)) continue;
    const fbCands = sortCandidates(
      allAccountViews
        .filter((a) => a.agent === fbAgent)
        .map(evaluate)
        .filter((c) => c.underThreshold)
    );
    fallbackAgentAlts.push(...fbCands);
  }

  let bestAlt: EvaluatedCandidate | undefined;
  if (qr.prefer === 'any') {
    const combined = sortCandidates([...sameAgentAlts, ...fallbackAgentAlts]);
    bestAlt = combined[0];
  } else {
    bestAlt = sameAgentAlts[0] ?? fallbackAgentAlts[0];
  }

  if (bestAlt) {
    if (qr.mode === 'suggest') {
      return {
        decision: {
          requested: { agent: reqAgent, account: reqAccountId },
          chosen: { agent: reqAgent, account: reqAccountId },
          mode: 'suggest',
          reason: 'suggested',
          quota: buildQuotaMap(reqSnap),
          suggestion: {
            agent: bestAlt.view.agent,
            account: bestAlt.view.id,
            quota: buildQuotaMap(bestAlt.snap),
          },
        },
        routingConfig: qr,
        snapshots,
      };
    }

    return {
      decision: {
        requested: { agent: reqAgent, account: reqAccountId },
        chosen: { agent: bestAlt.view.agent, account: bestAlt.view.id },
        mode: 'auto',
        reason: 'switched',
        quota: buildQuotaMap(bestAlt.snap),
      },
      routingConfig: qr,
      snapshots,
    };
  }

  // Step 4: Every candidate is >= switch_at (or full)
  const allPossibleCands: EvaluatedCandidate[] = [
    ...agentAccounts.filter((c) => c.view.enabled && c.signedIn),
  ];
  for (const fbAgent of roleFallbacks) {
    if (fbAgent === reqAgent || !enabledAgentIds.has(fbAgent)) continue;
    allPossibleCands.push(
      ...allAccountViews
        .filter((a) => a.agent === fbAgent)
        .map(evaluate)
        .filter((c) => c.view.enabled && c.signedIn)
    );
  }

  let earliestResetIso: string | null = null;
  for (const c of allPossibleCands) {
    if (c.resetsAt && Number.isFinite(Date.parse(c.resetsAt))) {
      if (!earliestResetIso || Date.parse(c.resetsAt) < Date.parse(earliestResetIso)) {
        earliestResetIso = c.resetsAt;
      }
    }
  }

  const leastUsed = [...allPossibleCands].sort(
    (a, b) =>
      (a.cooling ? 1 : 0) - (b.cooling ? 1 : 0) ||
      (a.level === 'full' ? 1 : 0) - (b.level === 'full' ? 1 : 0) ||
      a.usedPercent - b.usedPercent ||
      a.view.priority - b.view.priority
  )[0];

  if (qr.mode === 'suggest') {
    return {
      decision: {
        requested: { agent: reqAgent, account: reqAccountId },
        chosen: { agent: reqAgent, account: reqAccountId },
        mode: 'suggest',
        reason: 'suggested',
        quota: buildQuotaMap(reqSnap),
        resets_at: earliestResetIso,
        suggestion: leastUsed
          ? {
              agent: leastUsed.view.agent,
              account: leastUsed.view.id,
              quota: buildQuotaMap(leastUsed.snap),
            }
          : null,
      },
      routingConfig: qr,
      snapshots,
    };
  }

  if (qr.when_all_full === 'wait') {
    return {
      decision: {
        requested: { agent: reqAgent, account: reqAccountId },
        chosen: { agent: reqAgent, account: reqAccountId },
        mode: qr.mode,
        reason: 'waiting',
        quota: buildQuotaMap(reqSnap),
        resets_at: earliestResetIso,
      },
      routingConfig: qr,
      snapshots,
    };
  }

  const runTarget = leastUsed ?? primaryCand;
  return {
    decision: {
      requested: { agent: reqAgent, account: reqAccountId },
      chosen: {
        agent: runTarget?.view.agent ?? reqAgent,
        account: runTarget?.view.id ?? reqAccountId,
      },
      mode: qr.mode,
      reason: 'all-full',
      quota: buildQuotaMap(runTarget?.snap ?? reqSnap),
      resets_at: earliestResetIso,
    },
    routingConfig: qr,
    snapshots,
  };
}

export function buildQuotaStatusSummary(
  paths: ServerPaths,
  registry: LoadedRegistry
): {
  accounts: number;
  worst: {
    agent: string;
    account: string;
    level: QuotaLevel;
    used_percent: number;
    window: string | null;
    resets_at: string | null;
  } | null;
  by_agent: Record<string, { level: QuotaLevel; used_percent: number }>;
} {
  const snapshots = loadQuotaSnapshots(paths);
  const nowMs = Date.now();
  const byAgent: Record<string, { level: QuotaLevel; used_percent: number }> = {};

  let worst: {
    agent: string;
    account: string;
    level: QuotaLevel;
    used_percent: number;
    window: string | null;
    resets_at: string | null;
  } | null = null;

  for (const snap of snapshots) {
    const pct = getMaxUsedPercent(snap.windows, snap.cooldown_until, nowMs);
    const lvl = snap.level || 'ok';
    const topWin = [...snap.windows].sort((a, b) => b.used_percent - a.used_percent)[0];
    const resetsAt = topWin?.resets_at ?? snap.cooldown_until ?? null;

    const curAgent = byAgent[snap.agent];
    if (
      !curAgent ||
      LEVEL_RANK[lvl] > LEVEL_RANK[curAgent.level] ||
      (LEVEL_RANK[lvl] === LEVEL_RANK[curAgent.level] && pct > curAgent.used_percent)
    ) {
      byAgent[snap.agent] = { level: lvl, used_percent: pct };
    }

    if (
      !worst ||
      LEVEL_RANK[lvl] > LEVEL_RANK[worst.level] ||
      (LEVEL_RANK[lvl] === LEVEL_RANK[worst.level] && pct > worst.used_percent)
    ) {
      worst = {
        agent: snap.agent,
        account: snap.account,
        level: lvl,
        used_percent: pct,
        window: topWin?.id ?? null,
        resets_at: resetsAt,
      };
    }
  }

  return {
    accounts: snapshots.length,
    worst,
    by_agent: byAgent,
  };
}
