import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logServerError } from './logger.ts';
import {
  getRealSystemPaths,
  getTempDir,
  isDirectorySafe,
  isFileSafe,
  isTestContext,
  sameWinPath,
} from './paths.ts';

export interface AuditLogRow {
  Timestamp: string;
  Tool: string;
  Role: string;
  Model: string;
  WorkDir: string;
  PromptChars: number;
  InputTokens: number;
  CachedInputTokens?: number;
  OutputTokens: number;
  CostUsd: number;
  Score: string;
  Verdict: string;
}

export interface AuditStats {
  total_calls: number;
  total_prompt_chars: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  avg_cost_per_call_usd: number;
  by_tool: Record<string, number>;
  cost_by_tool: Record<string, number>;
  cost_by_model: Record<string, number>;
  by_role: Record<string, number>;
  verdicts: Record<string, number>;
  recent_logs: AuditLogRow[];
}

function roundTo(val: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

export function estimateEntryTelemetry(entry: Record<string, unknown>): {
  in_tokens: number;
  out_tokens: number;
  cost_usd: number;
} {
  const promptChars = Math.max(0, Number(entry.PromptChars ?? 0) || 0);
  const outputChars = Math.max(0, Number(entry.OutputChars ?? 0) || 0);
  const model = String(entry.Model ?? 'sonnet').trim().toLowerCase();
  const tool = String(entry.Tool ?? 'claude').trim().toLowerCase();

  const rawIn = Number(entry.InputTokens ?? 0);
  const inTokens =
    Number.isFinite(rawIn) && rawIn > 0
      ? Math.trunc(rawIn)
      : Math.max(1, Math.ceil((promptChars > 0 ? promptChars : 600) / 3.8));

  const rawOut = Number(entry.OutputTokens ?? 0);
  const outTokens =
    Number.isFinite(rawOut) && rawOut > 0
      ? Math.trunc(rawOut)
      : Math.max(1, Math.ceil((outputChars > 0 ? outputChars : 1600) / 3.8));

  const hasExplicitCost =
    entry.CostUsd !== undefined && entry.CostUsd !== null && String(entry.CostUsd).trim() !== '';
  const rawCost = Number(entry.CostUsd ?? 0);
  const rawCached = Math.max(0, Math.trunc(Number(entry.CachedInputTokens ?? 0) || 0));
  let costUsd: number;
  if (hasExplicitCost && Number.isFinite(rawCost) && (rawCost > 0 || (rawIn === 0 && rawOut === 0 && promptChars === 0 && outputChars === 0))) {
    costUsd = rawCost;
  } else {
    let inRate = 3.0;
    let cachedInRate = 0.3;
    let outRate = 15.0;
    if (model.includes('opus')) {
      inRate = 15.0;
      cachedInRate = 1.5;
      outRate = 75.0;
    } else if (model.includes('haiku')) {
      inRate = 0.8;
      cachedInRate = 0.08;
      outRate = 4.0;
    } else if (model.includes('fable')) {
      inRate = 6.0;
      cachedInRate = 0.6;
      outRate = 30.0;
    } else if (tool === 'codex' || model.includes('gpt')) {
      inRate = 2.5;
      cachedInRate = 0.25;
      outRate = 10.0;
    } else if (tool === 'antigravity' || model.includes('gemini')) {
      inRate = 1.25;
      cachedInRate = 0.125;
      outRate = 5.0;
    }
    const cachedIn = Math.min(inTokens, rawCached);
    const uncachedIn = Math.max(0, inTokens - cachedIn);
    costUsd = roundTo(
      (uncachedIn * inRate + cachedIn * cachedInRate + outTokens * outRate) / 1_000_000,
      5
    );
  }

  return {
    in_tokens: inTokens,
    out_tokens: outTokens,
    cost_usd: costUsd,
  };
}

export function createDefaultAuditStats(): AuditStats {
  return {
    total_calls: 0,
    total_prompt_chars: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0.0,
    avg_cost_per_call_usd: 0.0,
    by_tool: { claude: 0, codex: 0, antigravity: 0 },
    cost_by_tool: { claude: 0.0, codex: 0.0, antigravity: 0.0 },
    cost_by_model: {},
    by_role: {
      architect: 0,
      leader: 0,
      backend: 0,
      frontend: 0,
      reviewer: 0,
      tester: 0,
      'ui-tweak': 0,
      'review-diff': 0,
      critic: 0,
      coder: 0,
      'send-latest': 0,
    },
    verdicts: { APPROVED: 0, CHANGES_REQUESTED: 0, COMPLETED: 0 },
    recent_logs: [],
  };
}

export function getAuditStats(auditFile: string): AuditStats {
  const defaultStats = createDefaultAuditStats();
  if (!isFileSafe(auditFile)) {
    return defaultStats;
  }

  let mtime = 0;
  let size = 0;
  try {
    const st = fs.statSync(auditFile);
    mtime = Math.trunc(st.mtimeMs / 1000);
    size = st.size;
  } catch {
    return defaultStats;
  }

  const sig = `${mtime}|${size}`;
  const cacheFile = `${auditFile}.cache.json`;
  if (isFileSafe(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
        _sig?: string;
        data?: AuditStats;
      };
      if (cached && cached._sig === sig && cached.data) {
        return cached.data;
      }
    } catch {
      // Recompute on corrupt cache
    }
  }

  let rawText = '';
  try {
    rawText = fs.readFileSync(auditFile, 'utf8');
  } catch {
    return defaultStats;
  }

  const stats = createDefaultAuditStats();
  const recentRing: AuditLogRow[] = [];

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    stats.total_calls++;
    const chars = Math.max(0, Math.trunc(Number(entry.PromptChars ?? 0) || 0));
    stats.total_prompt_chars += chars;

    let tool = String(entry.Tool ?? 'unknown').trim().toLowerCase();
    if (!tool) tool = 'unknown';
    stats.by_tool[tool] = (stats.by_tool[tool] ?? 0) + 1;

    let role = String(entry.Role ?? 'unknown').trim().toLowerCase();
    if (!role) role = 'unknown';
    stats.by_role[role] = (stats.by_role[role] ?? 0) + 1;

    let verdict = String(entry.Verdict ?? 'COMPLETED').trim().toUpperCase();
    if (!verdict) verdict = 'COMPLETED';
    stats.verdicts[verdict] = (stats.verdicts[verdict] ?? 0) + 1;

    const modelName = String(entry.Model ?? 'default');
    const tel = estimateEntryTelemetry(entry);
    stats.total_input_tokens += tel.in_tokens;
    stats.total_output_tokens += tel.out_tokens;
    stats.total_cost_usd = roundTo(stats.total_cost_usd + tel.cost_usd, 4);
    stats.cost_by_tool[tool] = roundTo((stats.cost_by_tool[tool] ?? 0) + tel.cost_usd, 4);
    stats.cost_by_model[modelName] = roundTo(
      (stats.cost_by_model[modelName] ?? 0) + tel.cost_usd,
      4
    );

    const rowItem: AuditLogRow = {
      Timestamp: String(entry.Timestamp ?? ''),
      Tool: tool,
      Role: role,
      Model: modelName,
      WorkDir: String(entry.WorkDir ?? ''),
      PromptChars: chars,
      InputTokens: tel.in_tokens,
      OutputTokens: tel.out_tokens,
      CostUsd: tel.cost_usd,
      Score: String(entry.Score ?? ''),
      Verdict: verdict,
    };
    if (entry.CachedInputTokens !== undefined && entry.CachedInputTokens !== null) {
      rowItem.CachedInputTokens = Math.max(0, Math.trunc(Number(entry.CachedInputTokens) || 0));
    }
    recentRing.push(rowItem);
    if (recentRing.length > 20) {
      recentRing.shift();
    }
  }

  stats.avg_cost_per_call_usd =
    stats.total_calls > 0 ? roundTo(stats.total_cost_usd / stats.total_calls, 5) : 0.0;
  stats.recent_logs = recentRing.reverse();

  const tmpCache = `${cacheFile}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpCache, JSON.stringify({ _sig: sig, data: stats }), 'utf8');
    fs.renameSync(tmpCache, cacheFile);
  } catch {
    try {
      fs.unlinkSync(tmpCache);
    } catch {
      // Ignore cleanup errors
    }
  }

  return stats;
}

export function appendAuditEntry(auditFile: string, entry: Record<string, unknown>): void {
  const realAuditFile = path.win32.join(
    getRealSystemPaths().userProfile,
    '.gemini',
    'antigravity',
    'multi-ai-audit.jsonl'
  );
  if (isTestContext() && sameWinPath(auditFile, realAuditFile)) {
    logServerError(
      'audit:appendAuditEntry',
      new Error(`Refused to write to real AI audit log in test context: ${auditFile}`)
    );
    return;
  }
  const dir = path.dirname(auditFile);
  if (!isDirectorySafe(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n', 'utf8');
}
