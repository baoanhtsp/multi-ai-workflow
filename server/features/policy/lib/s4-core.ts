import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { estimateEntryTelemetry } from '../../../lib/audit.ts';

// ============================================================================
// 1. Data Types & Interfaces
// ============================================================================

export interface BudgetCap {
  usd?: { warn: number; block: number };
  tokens?: { warn: number; block: number };
  period?: 'day' | 'week' | 'month' | 'all';
}

export interface BudgetConfig {
  version: number;
  enabled: boolean;
  caps: {
    job?: { usd?: { warn: number; block: number }; tokens?: { warn: number; block: number } };
    team_run?: { usd?: { warn: number; block: number } };
    day?: { usd?: { warn: number; block: number }; tokens?: { warn: number; block: number } };
    project?: { usd?: { warn: number; block: number }; period?: 'day' | 'week' | 'month' | 'all' };
    agent_day?: { usd?: { warn: number; block: number } };
  };
  projects?: Record<
    string,
    { project?: { usd?: { warn: number; block: number }; period?: 'day' | 'week' | 'month' | 'all' } }
  >;
  estimate_next_call?: boolean;
}

export interface FallbackRoleConfig {
  fallbacks: string[];
  auto_fallback: boolean;
}

export interface FallbackRecoveryConfig {
  enabled: boolean;
  backoff_s: number[];
  max_attempts: number;
  wait_for_reset: boolean;
  reset_grace_s: number;
  max_wait_s: number;
  prefer_fallback_on_limit: boolean;
}

export interface FallbackConfig {
  version: number;
  roles: Record<string, FallbackRoleConfig>;
  recovery: FallbackRecoveryConfig;
}

export interface PolicyGlobalConfig {
  protected_paths: string[];
  deny_commands: string[];
  approve_commands: string[];
  allow_commands: string[];
  redact_secrets: boolean;
  secret_patterns: string[];
  redact_env_files: boolean;
}

export interface PolicyRoleConfig {
  read_only?: boolean;
  protected_paths?: string[];
  deny_commands?: string[];
  approve_commands?: string[];
  allow_commands?: string[];
}

export interface PolicyConfig {
  version: number;
  enabled: boolean;
  global: PolicyGlobalConfig;
  roles: Record<string, PolicyRoleConfig>;
  sandbox: { enabled: boolean };
}

export interface S4AuditEntry {
  Timestamp: string;
  Tool: string;
  Agent?: string;
  Role: string;
  Model: string;
  WorkDir: string;
  PromptChars: number;
  InputTokens: number;
  OutputTokens: number;
  CostUsd: number;
  Score: string;
  Verdict: string;
  in_tokens: number;
  out_tokens: number;
  cost_usd: number;
}

export interface AttentionAction {
  id: string;
  label: string;
  action: string;
  body: Record<string, unknown>;
}

export interface AttentionItem {
  id: string;
  ts: string;
  source: 'budget' | 'fallback' | 'checks' | 'policy';
  kind: string;
  severity: 'info' | 'warn' | 'error';
  title: string;
  detail: string;
  job_id?: string;
  project_path?: string;
  actions?: AttentionAction[];
}

export type ClassifiedFailure =
  | { kind: 'blocked'; by: 's4' | 'other'; reason: string; code?: string; agent?: string; fallback?: string }
  | { kind: 'usage_limit'; reset_at: string | null; raw: string }
  | { kind: 'transient'; code: '429' | '529' | '503' | 'overloaded' | 'rate_limit' | 'network'; raw: string }
  | { kind: 'auth'; raw: string }
  | { kind: 'timeout' }
  | { kind: 'other' };

// ============================================================================
// 2. File & IO Helpers (Atomic writes, Safe JSON reads, JSONL append)
// ============================================================================

export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpFile, content, 'utf8');
  fs.renameSync(tmpFile, filePath);
}

export function appendJsonl(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(data) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

export function appendS4Audit(
  featureDir: string,
  action: string,
  details: Record<string, unknown>
): void {
  const auditFile = path.win32.join(featureDir, 'audit.jsonl');
  appendJsonl(auditFile, {
    ts: new Date().toISOString(),
    action,
    by: 'dashboard',
    details,
  });
}

export function readJsonSafe<T>(filePath: string, fallback: T): { data: T; warning?: string } {
  if (!fs.existsSync(filePath)) {
    return { data: fallback };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) {
      return { data: fallback, warning: `File '${filePath}' is empty.` };
    }
    const parsed = JSON.parse(raw) as T;
    return { data: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: fallback, warning: `Corrupt JSON in '${filePath}': ${msg}` };
  }
}

export function createAttentionId(ts: string, kind: string, jobId?: string, scope?: string): string {
  const seed = `${ts}_${kind}_${jobId || ''}_${scope || ''}`;
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16);
  return `att_${hash}`;
}

// ============================================================================
// 3. Defaults & Validation (Budget, Fallback, Policy)
// ============================================================================

export function createDefaultBudgetConfig(): BudgetConfig {
  return {
    version: 1,
    enabled: true,
    caps: {
      job: { usd: { warn: 1.0, block: 2.0 }, tokens: { warn: 0, block: 0 } },
      team_run: { usd: { warn: 3.0, block: 5.0 } },
      day: { usd: { warn: 10.0, block: 20.0 }, tokens: { warn: 0, block: 4000000 } },
      project: { usd: { warn: 0, block: 0 }, period: 'month' },
      agent_day: { usd: { warn: 0, block: 0 } },
    },
    projects: {},
    estimate_next_call: true,
  };
}

function validateThreshold(
  val: unknown,
  fieldPath: string
): { warn: number; block: number } | { errorField: string; errorMessage: string } {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return { errorField: fieldPath, errorMessage: `${fieldPath} must be an object with warn and block.` };
  }
  const obj = val as Record<string, unknown>;
  const warn = Number(obj.warn ?? 0);
  const block = Number(obj.block ?? 0);

  if (!Number.isFinite(warn) || warn < 0) {
    return { errorField: `${fieldPath}.warn`, errorMessage: `${fieldPath}.warn must be a number >= 0.` };
  }
  if (!Number.isFinite(block) || block < 0) {
    return { errorField: `${fieldPath}.block`, errorMessage: `${fieldPath}.block must be a number >= 0.` };
  }

  const warnDecimals = (warn.toString().split('.')[1] || '').length;
  const blockDecimals = (block.toString().split('.')[1] || '').length;
  if (warnDecimals > 4) {
    return { errorField: `${fieldPath}.warn`, errorMessage: `${fieldPath}.warn can have at most 4 decimals.` };
  }
  if (blockDecimals > 4) {
    return { errorField: `${fieldPath}.block`, errorMessage: `${fieldPath}.block can have at most 4 decimals.` };
  }

  if (warn > 0 && block > 0 && warn > block) {
    return { errorField: `${fieldPath}.warn`, errorMessage: `${fieldPath}.warn cannot be greater than block.` };
  }

  return { warn, block };
}

export function validateBudgetConfig(raw: unknown): {
  config: BudgetConfig;
  errorField?: string;
  errorMessage?: string;
} {
  const defaults = createDefaultBudgetConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: defaults, errorField: 'config', errorMessage: 'Config must be an object.' };
  }

  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled !== undefined ? Boolean(obj.enabled) : defaults.enabled;
  const estimate_next_call =
    obj.estimate_next_call !== undefined ? Boolean(obj.estimate_next_call) : defaults.estimate_next_call;

  const capsRaw =
    obj.caps && typeof obj.caps === 'object' && !Array.isArray(obj.caps)
      ? (obj.caps as Record<string, unknown>)
      : {};

  const validatedCaps: BudgetConfig['caps'] = {
    job: { usd: { warn: 0, block: 0 }, tokens: { warn: 0, block: 0 } },
    team_run: { usd: { warn: 0, block: 0 } },
    day: { usd: { warn: 10.0, block: 0 }, tokens: { warn: 0, block: 0 } },
    project: { usd: { warn: 0, block: 0 }, period: 'month' },
    agent_day: { usd: { warn: 0, block: 0 } },
  };

  for (const scope of ['job', 'team_run', 'day', 'project', 'agent_day'] as const) {
    if (capsRaw[scope]) {
      const scopeVal = capsRaw[scope] as Record<string, unknown>;
      if (typeof scopeVal !== 'object' || Array.isArray(scopeVal)) {
        return { config: defaults, errorField: `caps.${scope}`, errorMessage: `caps.${scope} must be an object.` };
      }
      if (scopeVal.usd !== undefined) {
        const res = validateThreshold(scopeVal.usd, `caps.${scope}.usd`);
        if ('errorField' in res) {
          return { config: defaults, ...res };
        }
        if (!validatedCaps[scope]) validatedCaps[scope] = {};
        (validatedCaps[scope] as Record<string, unknown>).usd = res;
      }
      if (scopeVal.tokens !== undefined && (scope === 'job' || scope === 'day')) {
        const res = validateThreshold(scopeVal.tokens, `caps.${scope}.tokens`);
        if ('errorField' in res) {
          return { config: defaults, ...res };
        }
        if (!validatedCaps[scope]) validatedCaps[scope] = {};
        (validatedCaps[scope] as Record<string, unknown>).tokens = res;
      }
      if (scope === 'project' && scopeVal.period !== undefined) {
        const p = String(scopeVal.period);
        if (p !== 'day' && p !== 'week' && p !== 'month' && p !== 'all') {
          return {
            config: defaults,
            errorField: `caps.project.period`,
            errorMessage: `caps.project.period must be day, week, month, or all.`,
          };
        }
        validatedCaps.project!.period = p as 'day' | 'week' | 'month' | 'all';
      }
    }
  }

  const projectsRaw =
    obj.projects && typeof obj.projects === 'object' && !Array.isArray(obj.projects)
      ? (obj.projects as Record<string, unknown>)
      : {};
  const validatedProjects: BudgetConfig['projects'] = {};

  for (const [rawProjKey, rawProjVal] of Object.entries(projectsRaw)) {
    const normKey = rawProjKey.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if (!rawProjVal || typeof rawProjVal !== 'object' || Array.isArray(rawProjVal)) {
      return { config: defaults, errorField: `projects.${rawProjKey}`, errorMessage: `Project override must be an object.` };
    }
    const pVal = rawProjVal as Record<string, unknown>;
    const pProj = pVal.project as Record<string, unknown> | undefined;
    if (pProj) {
      if (typeof pProj !== 'object' || Array.isArray(pProj)) {
        return {
          config: defaults,
          errorField: `projects.${rawProjKey}.project`,
          errorMessage: `Project override 'project' must be an object.`,
        };
      }
      const pEntry: { usd?: { warn: number; block: number }; period?: 'day' | 'week' | 'month' | 'all' } = {};
      if (pProj.usd !== undefined) {
        const res = validateThreshold(pProj.usd, `projects.${rawProjKey}.project.usd`);
        if ('errorField' in res) {
          return { config: defaults, ...res };
        }
        pEntry.usd = res;
      }
      if (pProj.period !== undefined) {
        const p = String(pProj.period);
        if (p !== 'day' && p !== 'week' && p !== 'month' && p !== 'all') {
          return {
            config: defaults,
            errorField: `projects.${rawProjKey}.project.period`,
            errorMessage: `Period must be day, week, month, or all.`,
          };
        }
        pEntry.period = p as 'day' | 'week' | 'month' | 'all';
      }
      validatedProjects[normKey] = { project: pEntry };
    }
  }

  return {
    config: {
      version: 1,
      enabled,
      caps: validatedCaps,
      projects: validatedProjects,
      estimate_next_call,
    },
  };
}

export function loadBudgetConfig(budgetDir: string): { config: BudgetConfig; warnings: string[] } {
  const filePath = path.win32.join(budgetDir, 'budgets.json');
  const defaults = createDefaultBudgetConfig();
  const warnings: string[] = [];
  if (!fs.existsSync(filePath)) {
    return { config: defaults, warnings };
  }
  const readRes = readJsonSafe<unknown>(filePath, defaults);
  if (readRes.warning) warnings.push(readRes.warning);
  const valRes = validateBudgetConfig(readRes.data);
  if (valRes.errorField) {
    warnings.push(`budgets.json validation warning: ${valRes.errorField} - ${valRes.errorMessage}`);
  }
  return { config: valRes.config, warnings };
}

export function createDefaultFallbackConfig(): FallbackConfig {
  return {
    version: 1,
    roles: {
      backend: { fallbacks: ['antigravity', 'codex', 'gemini'], auto_fallback: false },
      frontend: { fallbacks: ['claude', 'cursor'], auto_fallback: false },
      reviewer: { fallbacks: ['codex', 'claude', 'gemini'], auto_fallback: true },
      architect: { fallbacks: [], auto_fallback: false },
      leader: { fallbacks: [], auto_fallback: false },
      tester: { fallbacks: [], auto_fallback: false },
    },
    recovery: {
      enabled: true,
      backoff_s: [30, 60, 120, 300, 900, 1800],
      max_attempts: 6,
      wait_for_reset: true,
      reset_grace_s: 60,
      max_wait_s: 21600,
      prefer_fallback_on_limit: false,
    },
  };
}

export function validateFallbackConfig(
  raw: unknown,
  knownAgents?: string[]
): {
  config: FallbackConfig;
  warnings: string[];
  errorField?: string;
  errorMessage?: string;
} {
  const defaults = createDefaultFallbackConfig();
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      config: defaults,
      warnings: ['Invalid fallback config: not an object.'],
      errorField: 'config',
      errorMessage: 'Must be an object',
    };
  }

  const obj = raw as Record<string, unknown>;
  const rolesRaw =
    obj.roles && typeof obj.roles === 'object' && !Array.isArray(obj.roles)
      ? (obj.roles as Record<string, unknown>)
      : defaults.roles;

  const validatedRoles: Record<string, FallbackRoleConfig> = { ...defaults.roles };
  for (const [roleName, roleVal] of Object.entries(rolesRaw)) {
    if (!roleVal || typeof roleVal !== 'object' || Array.isArray(roleVal)) {
      continue;
    }
    const r = roleVal as Record<string, unknown>;
    const rawFallbacks = Array.isArray(r.fallbacks) ? r.fallbacks.map(String) : [];
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const id of rawFallbacks) {
      const trimmed = id.trim().toLowerCase();
      if (!trimmed || seen.has(trimmed)) continue;
      if (knownAgents && knownAgents.length > 0 && !knownAgents.includes(trimmed)) {
        warnings.push(`Unknown agent '${trimmed}' in fallback list for role '${roleName}' dropped.`);
        continue;
      }
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    validatedRoles[roleName] = {
      fallbacks: cleaned,
      auto_fallback: Boolean(r.auto_fallback),
    };
  }

  const recRaw =
    obj.recovery && typeof obj.recovery === 'object' && !Array.isArray(obj.recovery)
      ? (obj.recovery as Record<string, unknown>)
      : defaults.recovery;

  const rawBackoff = Array.isArray(recRaw.backoff_s) ? recRaw.backoff_s.map(Number) : defaults.recovery.backoff_s;
  const backoff_s = rawBackoff.filter((n) => Number.isFinite(n) && n >= 5 && n <= 86400);

  const maxAttempts = Number.isFinite(Number(recRaw.max_attempts))
    ? Math.min(20, Math.max(0, Math.trunc(Number(recRaw.max_attempts))))
    : defaults.recovery.max_attempts;

  const resetGrace = Number.isFinite(Number(recRaw.reset_grace_s))
    ? Math.max(0, Math.trunc(Number(recRaw.reset_grace_s)))
    : defaults.recovery.reset_grace_s;

  const maxWait = Number.isFinite(Number(recRaw.max_wait_s))
    ? Math.max(0, Math.trunc(Number(recRaw.max_wait_s)))
    : defaults.recovery.max_wait_s;

  const validatedRecovery: FallbackRecoveryConfig = {
    enabled: recRaw.enabled !== undefined ? Boolean(recRaw.enabled) : defaults.recovery.enabled,
    backoff_s: backoff_s.length > 0 ? backoff_s : defaults.recovery.backoff_s,
    max_attempts: maxAttempts,
    wait_for_reset:
      recRaw.wait_for_reset !== undefined ? Boolean(recRaw.wait_for_reset) : defaults.recovery.wait_for_reset,
    reset_grace_s: resetGrace,
    max_wait_s: maxWait,
    prefer_fallback_on_limit:
      recRaw.prefer_fallback_on_limit !== undefined
        ? Boolean(recRaw.prefer_fallback_on_limit)
        : defaults.recovery.prefer_fallback_on_limit,
  };

  return {
    config: {
      version: 1,
      roles: validatedRoles,
      recovery: validatedRecovery,
    },
    warnings,
  };
}

export function loadFallbackConfig(
  fallbackDir: string,
  knownAgents?: string[]
): { config: FallbackConfig; warnings: string[] } {
  const filePath = path.win32.join(fallbackDir, 'routing.json');
  const defaults = createDefaultFallbackConfig();
  const warnings: string[] = [];
  if (!fs.existsSync(filePath)) {
    return { config: defaults, warnings };
  }
  const readRes = readJsonSafe<unknown>(filePath, defaults);
  if (readRes.warning) warnings.push(readRes.warning);
  const valRes = validateFallbackConfig(readRes.data, knownAgents);
  warnings.push(...valRes.warnings);
  return { config: valRes.config, warnings };
}

export function createDefaultPolicyConfig(): PolicyConfig {
  return {
    version: 1,
    enabled: true,
    global: {
      protected_paths: ['.env', '.env.*', '**/*.pem', '**/*.key', '.git/**', '**/id_rsa*'],
      deny_commands: ['git push --force', 'git push -f', 'git reset --hard origin', 'rm -rf /', 'format c:'],
      approve_commands: [
        'rm -rf',
        'Remove-Item -Recurse -Force',
        'git push --force',
        'git push -f',
        'DROP TABLE',
        'DROP DATABASE',
        'TRUNCATE TABLE',
      ],
      allow_commands: [],
      redact_secrets: true,
      secret_patterns: [],
      redact_env_files: true,
    },
    roles: {
      reviewer: { read_only: true, deny_commands: ['git commit', 'git push'] },
      tester: { deny_commands: ['git push'] },
      hacker: { deny_commands: ['git push', 'rm -rf'] },
    },
    sandbox: { enabled: false },
  };
}

export function validatePolicyConfig(raw: unknown): {
  config: PolicyConfig;
  warnings: string[];
} {
  const defaults = createDefaultPolicyConfig();
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: defaults, warnings: ['Invalid policy config: not an object.'] };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled !== undefined ? Boolean(obj.enabled) : defaults.enabled;

  const gRaw =
    obj.global && typeof obj.global === 'object' && !Array.isArray(obj.global)
      ? (obj.global as Record<string, unknown>)
      : defaults.global;

  const validSecretPatterns: string[] = [];
  if (Array.isArray(gRaw.secret_patterns)) {
    for (const pat of gRaw.secret_patterns) {
      const s = String(pat);
      try {
        new RegExp(s);
        validSecretPatterns.push(s);
      } catch {
        warnings.push(`Invalid secret regex pattern dropped: '${s}'`);
      }
    }
  }

  const globalConfig: PolicyGlobalConfig = {
    protected_paths: Array.isArray(gRaw.protected_paths)
      ? gRaw.protected_paths.map(String)
      : defaults.global.protected_paths,
    deny_commands: Array.isArray(gRaw.deny_commands) ? gRaw.deny_commands.map(String) : defaults.global.deny_commands,
    approve_commands: Array.isArray(gRaw.approve_commands)
      ? gRaw.approve_commands.map(String)
      : defaults.global.approve_commands,
    allow_commands: Array.isArray(gRaw.allow_commands)
      ? gRaw.allow_commands.map(String)
      : defaults.global.allow_commands,
    redact_secrets: gRaw.redact_secrets !== undefined ? Boolean(gRaw.redact_secrets) : defaults.global.redact_secrets,
    secret_patterns: validSecretPatterns,
    redact_env_files:
      gRaw.redact_env_files !== undefined ? Boolean(gRaw.redact_env_files) : defaults.global.redact_env_files,
  };

  const rolesRaw =
    obj.roles && typeof obj.roles === 'object' && !Array.isArray(obj.roles)
      ? (obj.roles as Record<string, unknown>)
      : defaults.roles;
  const rolesConfig: Record<string, PolicyRoleConfig> = {};

  for (const [rName, rVal] of Object.entries(rolesRaw)) {
    if (!rVal || typeof rVal !== 'object' || Array.isArray(rVal)) continue;
    const r = rVal as Record<string, unknown>;
    rolesConfig[rName] = {
      read_only: r.read_only !== undefined ? Boolean(r.read_only) : undefined,
      protected_paths: Array.isArray(r.protected_paths) ? r.protected_paths.map(String) : undefined,
      deny_commands: Array.isArray(r.deny_commands) ? r.deny_commands.map(String) : undefined,
      approve_commands: Array.isArray(r.approve_commands) ? r.approve_commands.map(String) : undefined,
      allow_commands: Array.isArray(r.allow_commands) ? r.allow_commands.map(String) : undefined,
    };
  }

  return {
    config: {
      version: 1,
      enabled,
      global: globalConfig,
      roles: rolesConfig,
      sandbox: { enabled: Boolean((obj.sandbox as Record<string, unknown> | undefined)?.enabled) },
    },
    warnings,
  };
}

export function loadPolicyConfig(policyDir: string): { config: PolicyConfig; warnings: string[] } {
  const filePath = path.win32.join(policyDir, 'policies.json');
  const defaults = createDefaultPolicyConfig();
  const warnings: string[] = [];
  if (!fs.existsSync(filePath)) {
    return { config: defaults, warnings };
  }
  const readRes = readJsonSafe<unknown>(filePath, defaults);
  if (readRes.warning) warnings.push(readRes.warning);
  const valRes = validatePolicyConfig(readRes.data);
  warnings.push(...valRes.warnings);
  return { config: valRes.config, warnings };
}

// ============================================================================
// 4. Path inside project check & Project Overrides Lookup
// ============================================================================

export function isPathInsideProject(childPath: string, parentPath: string): boolean {
  if (!childPath || !parentPath) return false;
  const normChild = childPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const normParent = parentPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return normChild === normParent || normChild.startsWith(normParent + '\\');
}

export function findProjectOverride(
  projects: BudgetConfig['projects'],
  candidatePath: string
): { usd?: { warn: number; block: number }; period?: 'day' | 'week' | 'month' | 'all' } | undefined {
  if (!projects || !candidatePath) return undefined;
  const normCandidate = candidatePath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  for (const [projKey, projVal] of Object.entries(projects)) {
    if (isPathInsideProject(normCandidate, projKey) || isPathInsideProject(projKey, normCandidate)) {
      return projVal.project;
    }
  }
  return undefined;
}

// ============================================================================
// 5. Audit Reader & Spend Helpers
// ============================================================================

export function readAuditRows(
  auditFile: string,
  startByteOffset = 0
): { rows: S4AuditEntry[]; endByteOffset: number } {
  if (!fs.existsSync(auditFile)) {
    return { rows: [], endByteOffset: 0 };
  }

  try {
    const stat = fs.statSync(auditFile);
    if (stat.size <= startByteOffset) {
      return { rows: [], endByteOffset: stat.size };
    }

    const readLen = stat.size - startByteOffset;
    const fd = fs.openSync(auditFile, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(readLen);
      fs.readSync(fd, chunk, 0, readLen, startByteOffset);
    } finally {
      fs.closeSync(fd);
    }

    const text = chunk.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      return { rows: [], endByteOffset: startByteOffset };
    }

    const validText = text.substring(0, lastNewline + 1);
    const consumedBytes = Buffer.byteLength(validText, 'utf8');
    const endByteOffset = startByteOffset + consumedBytes;

    const lines = validText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const rows: S4AuditEntry[] = [];

    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const telemetry = estimateEntryTelemetry(raw);
        const entry: S4AuditEntry = {
          Timestamp: String(raw.Timestamp ?? ''),
          Tool: String(raw.Tool ?? ''),
          Agent: raw.Agent ? String(raw.Agent) : raw.Tool ? String(raw.Tool) : undefined,
          Role: String(raw.Role ?? ''),
          Model: String(raw.Model ?? ''),
          WorkDir: String(raw.WorkDir ?? ''),
          PromptChars: Number(raw.PromptChars ?? 0),
          InputTokens: Number(raw.InputTokens ?? 0),
          OutputTokens: Number(raw.OutputTokens ?? 0),
          CostUsd: Number(raw.CostUsd ?? 0),
          Score: String(raw.Score ?? ''),
          Verdict: String(raw.Verdict ?? ''),
          in_tokens: telemetry.in_tokens,
          out_tokens: telemetry.out_tokens,
          cost_usd: telemetry.cost_usd,
        };
        rows.push(entry);
      } catch {
        // Skip malformed row
      }
    }

    return { rows, endByteOffset };
  } catch {
    return { rows: [], endByteOffset: startByteOffset };
  }
}

export function isLocalToday(isoString: string, now = new Date()): boolean {
  if (!isoString) return false;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function isWithinPeriod(
  isoString: string,
  period: 'day' | 'week' | 'month' | 'all' = 'month',
  now = new Date()
): boolean {
  if (!isoString) return false;
  if (period === 'all') return true;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;

  const t = d.getTime();

  if (period === 'day') {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
    return t >= startOfDay;
  }

  if (period === 'week') {
    // Current week since Monday 00:00:00 local
    const dayOfWeek = now.getDay();
    const diffDays = (dayOfWeek + 6) % 7;
    const startOfWeek = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diffDays,
      0,
      0,
      0,
      0
    ).getTime();
    return t >= startOfWeek;
  }

  if (period === 'month') {
    // Current LOCAL calendar month (1st 00:00:00 -> now)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
    return t >= startOfMonth;
  }

  return true;
}

export function calculateDaySpend(
  rows: S4AuditEntry[],
  now = new Date()
): { usd: number; tokens: number; calls: number } {
  let usd = 0;
  let tokens = 0;
  let calls = 0;
  for (const r of rows) {
    if (isWithinPeriod(r.Timestamp, 'day', now)) {
      usd += r.cost_usd;
      tokens += r.in_tokens + r.out_tokens;
      calls += 1;
    }
  }
  return {
    usd: Math.round(usd * 10000) / 10000,
    tokens,
    calls,
  };
}

export function calculateProjectSpend(
  rows: S4AuditEntry[],
  projectPath: string,
  period: 'day' | 'week' | 'month' | 'all' = 'month',
  now = new Date()
): { usd: number; tokens: number; calls: number } {
  let usd = 0;
  let tokens = 0;
  let calls = 0;
  for (const r of rows) {
    if (isPathInsideProject(r.WorkDir, projectPath) && isWithinPeriod(r.Timestamp, period, now)) {
      usd += r.cost_usd;
      tokens += r.in_tokens + r.out_tokens;
      calls += 1;
    }
  }
  return {
    usd: Math.round(usd * 10000) / 10000,
    tokens,
    calls,
  };
}

export function calculateAgentDaySpend(
  rows: S4AuditEntry[],
  agent: string,
  now = new Date()
): { usd: number; tokens: number; calls: number } {
  let usd = 0;
  let tokens = 0;
  let calls = 0;
  const normAgent = agent.trim().toLowerCase();
  for (const r of rows) {
    if (isWithinPeriod(r.Timestamp, 'day', now)) {
      const rowAgent = (r.Agent || r.Tool).trim().toLowerCase();
      if (rowAgent === normAgent) {
        usd += r.cost_usd;
        tokens += r.in_tokens + r.out_tokens;
        calls += 1;
      }
    }
  }
  return {
    usd: Math.round(usd * 10000) / 10000,
    tokens,
    calls,
  };
}

export function calculateJobSpendFromOffset(
  auditFile: string,
  startOffset: number,
  projectPath: string
): { usd: number; tokens: number; calls: number } {
  const { rows } = readAuditRows(auditFile, startOffset);
  let usd = 0;
  let tokens = 0;
  let calls = 0;
  for (const r of rows) {
    if (isPathInsideProject(r.WorkDir, projectPath)) {
      usd += r.cost_usd;
      tokens += r.in_tokens + r.out_tokens;
      calls += 1;
    }
  }
  return {
    usd: Math.round(usd * 10000) / 10000,
    tokens,
    calls,
  };
}

export function calculateTeamRunSpend(
  ledgerRows: Array<Record<string, unknown>>,
  teamRunId: string,
  currentJobSpendUsd = 0
): { usd: number; tokens: number } {
  let usd = currentJobSpendUsd;
  let tokens = 0;
  for (const row of ledgerRows) {
    if (String(row.team_run_id ?? '') === teamRunId) {
      usd += Number(row.cost_usd ?? 0);
      tokens += Number(row.in_tokens ?? 0) + Number(row.out_tokens ?? 0);
    }
  }
  return {
    usd: Math.round(usd * 10000) / 10000,
    tokens,
  };
}

export function estimateNextCallCost(rows: S4AuditEntry[], agent: string): number {
  const norm = agent.trim().toLowerCase();
  const agentRows = rows.filter((r) => (r.Agent || r.Tool).trim().toLowerCase() === norm);
  if (agentRows.length === 0) {
    return 0.02;
  }
  const last20 = agentRows.slice(-20);
  const sum = last20.reduce((acc, r) => acc + r.cost_usd, 0);
  return Math.round((sum / last20.length) * 10000) / 10000;
}

// ============================================================================
// 6. Log Failure Classifier with Reset-time Parsing
// ============================================================================

export function parseResetTime(text: string, now = new Date()): string | null {
  // 1. ISO timestamp
  const isoMatch = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/i.exec(text);
  if (isoMatch) {
    const d = new Date(isoMatch[0]);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }

  // 2. resets? (at)? 14:05 / 3pm / 3:00 PM
  const timeMatch = /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})/i.exec(text);
  if (timeMatch && timeMatch[1]) {
    const rawTime = timeMatch[1].trim().toLowerCase();
    let hours = 0;
    let mins = 0;
    const isAmPm = rawTime.includes('am') || rawTime.includes('pm');
    if (isAmPm) {
      const isPm = rawTime.includes('pm');
      const clean = rawTime.replace(/am|pm/, '').trim();
      if (clean.includes(':')) {
        const parts = clean.split(':');
        hours = Number.parseInt(parts[0]!, 10);
        mins = Number.parseInt(parts[1]!, 10);
      } else {
        hours = Number.parseInt(clean, 10);
        mins = 0;
      }
      if (isPm && hours < 12) hours += 12;
      if (!isPm && hours === 12) hours = 0;
    } else {
      const parts = rawTime.split(':');
      hours = Number.parseInt(parts[0]!, 10);
      mins = Number.parseInt(parts[1]!, 10);
    }

    if (hours >= 0 && hours < 24 && mins >= 0 && mins < 60) {
      const target = new Date(now.getTime());
      target.setHours(hours, mins, 0, 0);
      if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
      }
      return target.toISOString();
    }
  }

  // 3. (try again|retry|resets?) in 2h 13m / in 45 minutes / in 30s
  const durationMatch =
    /(?:try again|retry|resets?)\s+in\s+((?:(?:\d+\s*(?:h|hours?|m|minutes?|s|seconds?))\s*)+)/i.exec(text);
  if (durationMatch && durationMatch[1]) {
    const durStr = durationMatch[1];
    let totalSec = 0;
    const hMatch = /(\d+)\s*(?:h|hours?)/i.exec(durStr);
    const mMatch = /(\d+)\s*(?:m|minutes?)/i.exec(durStr);
    const sMatch = /(\d+)\s*(?:s|seconds?)/i.exec(durStr);
    if (hMatch && hMatch[1]) totalSec += Number.parseInt(hMatch[1], 10) * 3600;
    if (mMatch && mMatch[1]) totalSec += Number.parseInt(mMatch[1], 10) * 60;
    if (sMatch && sMatch[1]) totalSec += Number.parseInt(sMatch[1], 10);

    if (totalSec > 0) {
      return new Date(now.getTime() + totalSec * 1000).toISOString();
    }
  }

  // 4. retry-after: 120
  const retryAfterMatch = /retry-after:\s*(\d+)/i.exec(text);
  if (retryAfterMatch && retryAfterMatch[1]) {
    const sec = Number.parseInt(retryAfterMatch[1], 10);
    if (sec > 0) {
      return new Date(now.getTime() + sec * 1000).toISOString();
    }
  }

  // 5. epoch seconds after reset (e.g. "reset 1761362700")
  const epochMatch = /reset\s+(\d{10})\b/i.exec(text);
  if (epochMatch && epochMatch[1]) {
    const epochSec = Number.parseInt(epochMatch[1], 10);
    const d = new Date(epochSec * 1000);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }

  return null;
}

export function classifyFailure(
  logTail: string,
  exitCode: number,
  now = new Date()
): ClassifiedFailure {
  // S4 Design 0.6 & Item 9:
  // Extract last 60 non-empty lines for usage_limit, auth, transient, blocked
  const nonEmpties = logTail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last60 = nonEmpties.slice(-60).join('\n');

  // 1. Blocked check
  const isBlocked =
    exitCode === 5 ||
    logTail.includes('HOOK_BLOCKED') ||
    logTail.includes('[Auto-Gate HOOK BLOCKED') ||
    logTail.includes('[HOOK BLOCKED: job-start]') ||
    /\[S4:(?:gate|policy|budget|cooldown|approval)/i.test(logTail);

  if (isBlocked) {
    // Generalized S4 tag: [S4:<code>( agent=<id>)?( fallback=<fb>)?]
    const tagMatch = /\[S4:([a-z_]+)(?:\s+agent=([^\s\]]+))?(?:\s+fallback=([^\s\]]+))?\]/i.exec(logTail);
    const reasonMatch = /(?:HOOK_BLOCKED(?:\s*\([^)]*\))?|\[Auto-Gate HOOK BLOCKED(?::\s*[^\]]+)?\]):\s*(.+)$/m.exec(
      logTail
    );
    const reason = reasonMatch ? reasonMatch[1]!.trim() : 'Blocked by hook';

    if (tagMatch) {
      const code = tagMatch[1]!;
      const agent = tagMatch[2];
      const fb = tagMatch[3];
      return {
        kind: 'blocked',
        by: 's4',
        reason,
        code,
        agent,
        fallback: fb === 'none' ? undefined : fb,
      };
    }
    return {
      kind: 'blocked',
      by: 'other',
      reason,
    };
  }

  // 2. Usage limit (applied only to last 60 non-empty lines)
  const usagePattern =
    /\b(?:usage limit|limit reached|quota exceeded|exceeded your current quota|you've hit your limit|out of credits|insufficient_quota|RESOURCE_EXHAUSTED)\b/i;
  if (usagePattern.test(last60)) {
    const reset_at = parseResetTime(last60, now);
    const match = usagePattern.exec(last60);
    return {
      kind: 'usage_limit',
      reset_at,
      raw: match ? match[0] : 'usage_limit',
    };
  }

  // 3. Auth (applied only to last 60 non-empty lines)
  const authPattern = /OAuth session expired|Please set an Auth method|\b401\b|not logged in/i;
  if (authPattern.test(last60)) {
    const match = authPattern.exec(last60);
    return {
      kind: 'auth',
      raw: match ? match[0] : 'auth',
    };
  }

  // 4. Transient (applied only to last 60 non-empty lines)
  if (/\b429\b/.test(last60)) return { kind: 'transient', code: '429', raw: '429' };
  if (/\b529\b/.test(last60)) return { kind: 'transient', code: '529', raw: '529' };
  if (/\b503\b/.test(last60)) return { kind: 'transient', code: '503', raw: '503' };
  if (/overloaded/i.test(last60)) return { kind: 'transient', code: 'overloaded', raw: 'overloaded' };
  if (/Too Many Requests/i.test(last60) || /rate.?limit/i.test(last60)) {
    return { kind: 'transient', code: 'rate_limit', raw: 'rate_limit' };
  }
  if (/ECONNRESET|ETIMEDOUT|socket hang up|temporarily unavailable/i.test(last60)) {
    return { kind: 'transient', code: 'network', raw: 'network' };
  }

  // 5. Timeout
  if (exitCode === 124) {
    return { kind: 'timeout' };
  }

  // 6. Other
  return { kind: 'other' };
}

// ============================================================================
// 7. Secret Redaction
// ============================================================================

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isValidEnvSecret(key: string, value: string): boolean {
  if (typeof value !== 'string') return false;
  const val = value.trim();
  if (val.length < 8) return false;
  if (val.toLowerCase() === 'true' || val.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(val) && val.length < 10) return false;

  if (/(KEY|SECRET|TOKEN|PASS|PWD|AUTH|CREDENTIAL|PRIVATE)/i.test(key)) {
    return true;
  }

  if (val.length >= 16) {
    const hasLower = /[a-z]/.test(val);
    const hasUpper = /[A-Z]/.test(val);
    const hasDigit = /\d/.test(val);
    const hasSymbol = /[^a-zA-Z0-9]/.test(val);
    const typesCount = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
    if (typesCount >= 3) return true;
  }

  return false;
}

export function extractProjectEnvSecrets(projectPath: string): string[] {
  if (!projectPath || !fs.existsSync(projectPath)) return [];
  const secrets = new Set<string>();
  const MAX_FILE_SIZE = 256 * 1024; // 256 KB

  try {
    const entries = fs.readdirSync(projectPath, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      if (name === '.env' || name.startsWith('.env.')) {
        const fullPath = path.join(projectPath, name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const stripped = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
            const eqIdx = stripped.indexOf('=');
            if (eqIdx <= 0) continue;
            const key = stripped.slice(0, eqIdx).trim();
            let val = stripped.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (isValidEnvSecret(key, val)) {
              secrets.add(val);
            }
          }
        } catch {
          // Ignore unreadable env file
        }
      }
    }
  } catch {
    // Ignore unreadable directory
  }

  return Array.from(secrets);
}

export function redactSecrets(text: string, extraValues?: string[]): string {
  if (!text) return '';

  // 1. Stash S4 Policy blocks so policy markers are never touched
  const policyBlocks: string[] = [];
  const policyMarkerRegex = /<!-- MAW-S4-POLICY:BEGIN -->[\s\S]*?<!-- MAW-S4-POLICY:END -->/g;
  let out = text.replace(policyMarkerRegex, (match) => {
    policyBlocks.push(match);
    return `__MAW_S4_POLICY_BLOCK_${policyBlocks.length - 1}__`;
  });

  // 2. Built-in patterns (Item 12: require non-alphanumeric boundary before tokens)
  out = out.replace(/(?<=^|[^a-zA-Z0-9_\-])sk-ant-[A-Za-z0-9_\-]{20,}/g, '[REDACTED:anthropic]');
  out = out.replace(/(?<=^|[^a-zA-Z0-9_\-])sk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g, '[REDACTED:openai]');
  out = out.replace(/(?<=^|[^a-zA-Z0-9_\-])github_pat_[A-Za-z0-9_]{50,}/g, '[REDACTED:github]');
  out = out.replace(/(?<=^|[^a-zA-Z0-9_\-])gh[pousr]_[A-Za-z0-9]{36,}/g, '[REDACTED:github]');
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws]');
  out = out.replace(/(?<=^|[^a-zA-Z0-9_\-])AIza[0-9A-Za-z_\-]{35}/g, '[REDACTED:google]');
  out = out.replace(/(?<=^|[^a-zA-Z0-9_\-])xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack]');
  out = out.replace(/\b\d{8,10}:[A-Za-z0-9_\-]{35}\b/g, '[REDACTED:telegram]');
  out = out.replace(/(?<=^|[^a-zA-Z0-9_\-])eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '[REDACTED:jwt]');
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED:private_key]'
  );

  // Assignment: keeps key name, redacts value (supports quotes before colon as in JSON/YAML)
  out = out.replace(
    /(["']?(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)(?!\[REDACTED:)([^\s"']{8,})(["']?)/gi,
    '$1[REDACTED:assignment]$3'
  );

  // 3. Extra values (.env values, secret_patterns)
  if (extraValues && extraValues.length > 0) {
    for (const val of extraValues) {
      if (typeof val === 'string' && val.trim().length >= 8) {
        const trimmed = val.trim();
        if (trimmed.startsWith('[REDACTED:')) continue;
        const re = new RegExp(escapeRegExp(trimmed), 'g');
        out = out.replace(re, '[REDACTED:custom]');
      }
    }
  }

  // 4. Restore policy blocks
  for (let i = 0; i < policyBlocks.length; i++) {
    out = out.replace(`__MAW_S4_POLICY_BLOCK_${i}__`, policyBlocks[i]!);
  }

  return out;
}

// ============================================================================
// 8. Command Matching
// ============================================================================

export function matchCommand(text: string, pattern: string, allowPatterns?: string[]): boolean {
  if (!text || !pattern) return false;
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Check allow patterns first
    if (allowPatterns && allowPatterns.length > 0) {
      let isAllowed = false;
      for (const allow of allowPatterns) {
        if (matchSinglePattern(trimmedLine, allow)) {
          isAllowed = true;
          break;
        }
      }
      if (isAllowed) {
        continue;
      }
    }

    if (matchSinglePattern(trimmedLine, pattern)) {
      return true;
    }
  }

  return false;
}

function matchSinglePattern(line: string, pattern: string): boolean {
  const pat = pattern.trim();
  if (pat.startsWith('re:')) {
    try {
      const regex = new RegExp(pat.substring(3).trim(), 'i');
      return regex.test(line);
    } catch {
      return false;
    }
  }

  // Item 10: Ordered tokens bounded by start/end/whitespace or shell separator
  const tokens = pat.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const sepStart = '(?:^|[\\s;|`"\'&()\\\\/<>=])';
  const sepEnd = '(?=$|[\\s;|`"\'&()\\\\/<>=])';

  const regexStr = tokens
    .map((t, idx) => {
      const esc = escapeRegExp(t);
      if (idx === 0) {
        return `${sepStart}${esc}${sepEnd}`;
      }
      return `.*${sepStart}${esc}${sepEnd}`;
    })
    .join('');

  try {
    const regex = new RegExp(regexStr, 'i');
    return regex.test(line);
  } catch {
    return false;
  }
}

// ============================================================================
// 9. Glob Matcher for Protected Paths
// ============================================================================

export function matchGlob(relativePath: string, pattern: string): boolean {
  if (!relativePath || !pattern) return false;
  const normPath = relativePath.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
  const normPat = pattern.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

  // If pattern does not contain '/', match against basename at any depth
  if (!normPat.includes('/')) {
    const baseName = path.posix.basename(normPath);
    return matchGlobExact(baseName, normPat);
  }

  return matchGlobExact(normPath, normPat);
}

function matchGlobExact(str: string, pat: string): boolean {
  let reStr = '';
  let i = 0;
  while (i < pat.length) {
    if (pat.substring(i, i + 3) === '**/') {
      reStr += '(?:.*/)?';
      i += 3;
    } else if (pat.substring(i, i + 2) === '**') {
      reStr += '.*';
      i += 2;
    } else if (pat[i] === '*') {
      reStr += '[^/]*';
      i += 1;
    } else if (pat[i] === '?') {
      reStr += '[^/]';
      i += 1;
    } else {
      reStr += escapeRegExp(pat[i]!);
      i += 1;
    }
  }
  const regex = new RegExp(`^${reStr}$`, 'i');
  return regex.test(str);
}

export function unquoteGitPath(raw: string): string {
  const p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    try {
      return JSON.parse(p);
    } catch {
      return p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return p;
}

export function parsePorcelainPaths(line: string): string[] {
  if (!line || line.length < 3) return [];
  const rawPath = line.substring(3).trim();
  if (!rawPath) return [];

  if (rawPath.includes(' -> ')) {
    const parts = rawPath.split(' -> ');
    if (parts.length === 2) {
      const oldPath = unquoteGitPath(parts[0]!);
      const newPath = unquoteGitPath(parts[1]!);
      return [oldPath, newPath].filter(Boolean);
    }
  }

  const single = unquoteGitPath(rawPath);
  return single ? [single] : [];
}

// ============================================================================
// 10. Fallback Picking & Agent Replacement
// ============================================================================

export interface FallbackCandidateSkip {
  agent: string;
  why: string;
}

export interface PickFallbackResult {
  agent: string;
  skipped: FallbackCandidateSkip[];
}

export interface FallbackAgentCapabilities {
  write?: boolean;
  review?: boolean;
  new_session?: boolean;
}

export interface FallbackAgentInfo {
  id: string;
  label?: string;
  enabled?: boolean;
  installed?: boolean;
  capabilities?: FallbackAgentCapabilities;
}

export function pickFallback(options: {
  role: string;
  blockedAgent: string;
  fallbacks: string[];
  agents: Record<string, FallbackAgentInfo>;
  cooldowns: Record<string, { until: string }>;
  now?: Date;
  agentDaySpentUsd?: Record<string, number>;
  agentDayCapBlockUsd?: number;
}): PickFallbackResult | null {
  const {
    role,
    blockedAgent,
    fallbacks,
    agents,
    cooldowns,
    now = new Date(),
    agentDaySpentUsd = {},
    agentDayCapBlockUsd = 0,
  } = options;

  const normBlocked = blockedAgent.trim().toLowerCase();
  const normRole = role.trim().toLowerCase();
  const skipped: FallbackCandidateSkip[] = [];

  for (const candidate of fallbacks) {
    const id = candidate.trim().toLowerCase();
    if (!id) continue;

    // 1. Skip blocked agent itself
    if (id === normBlocked) {
      skipped.push({ agent: id, why: 'is blocked agent' });
      continue;
    }

    const agentInfo = agents[id];
    // 2. Skip disabled or not installed
    if (!agentInfo || agentInfo.enabled === false) {
      skipped.push({ agent: id, why: 'disabled or unknown' });
      continue;
    }
    if (agentInfo.installed === false) {
      skipped.push({ agent: id, why: 'not installed' });
      continue;
    }

    // 3. Skip cooldowns in future
    const cd = cooldowns[id];
    if (cd && cd.until) {
      const untilDate = new Date(cd.until);
      if (!Number.isNaN(untilDate.getTime()) && untilDate.getTime() > now.getTime()) {
        skipped.push({ agent: id, why: `in cooldown until ${cd.until}` });
        continue;
      }
    }

    // 4. Skip agent_day cap at block
    if (agentDayCapBlockUsd > 0) {
      const spent = agentDaySpentUsd[id] ?? 0;
      if (spent >= agentDayCapBlockUsd) {
        skipped.push({
          agent: id,
          why: `agent_day budget exceeded ($${spent.toFixed(2)} >= $${agentDayCapBlockUsd.toFixed(2)})`,
        });
        continue;
      }
    }

    // 5. Capability check
    const caps = agentInfo.capabilities ?? {};
    if (normRole === 'reviewer') {
      if (!caps.review) {
        skipped.push({ agent: id, why: 'missing capability: review' });
        continue;
      }
    } else if (normRole === 'backend' || normRole === 'frontend' || normRole === 'tester') {
      if (!caps.write) {
        skipped.push({ agent: id, why: 'missing capability: write' });
        continue;
      }
    }

    return {
      agent: id,
      skipped,
    };
  }

  return null;
}

export function replaceAgent(
  body: Record<string, unknown>,
  from: string,
  to: string,
  toAgentInfo?: FallbackAgentInfo
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...body };
  const normFrom = from.trim().toLowerCase();
  const normTo = to.trim().toLowerCase();

  let agentChanged = false;

  // Direct / task mode
  if (typeof result.agent === 'string' && result.agent.trim().toLowerCase() === normFrom) {
    result.agent = normTo;
    agentChanged = true;
  }

  // Team mode
  if (result.team && typeof result.team === 'object' && !Array.isArray(result.team)) {
    const newTeam: Record<string, string> = {};
    for (const [r, a] of Object.entries(result.team as Record<string, unknown>)) {
      if (typeof a === 'string' && a.trim().toLowerCase() === normFrom) {
        newTeam[r] = normTo;
        agentChanged = true;
      } else {
        newTeam[r] = String(a);
      }
    }
    result.team = newTeam;
  }

  // Auto-gate mode
  if (typeof result.implementer === 'string' && result.implementer.trim().toLowerCase() === normFrom) {
    result.implementer = normTo;
    agentChanged = true;
  }
  if (Array.isArray(result.reviewers)) {
    const newRev: string[] = [];
    const seen = new Set<string>();
    for (const r of result.reviewers) {
      const normR = String(r).trim().toLowerCase();
      const mapped = normR === normFrom ? normTo : normR;
      if (normR === normFrom) agentChanged = true;
      if (!seen.has(mapped)) {
        seen.add(mapped);
        newRev.push(mapped);
      }
    }
    result.reviewers = newRev;
  }

  if (agentChanged) {
    delete result.model;
    delete result.effort;
    if (result.new_session) {
      if (!toAgentInfo?.capabilities?.new_session) {
        delete result.new_session;
      }
    }
  }

  return result;
}

export function cleanPromptText(raw: string): string {
  let clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  clean = clean.replace(/<!-- MAW-S4-POLICY:BEGIN -->[\s\S]*?<!-- MAW-S4-POLICY:END -->\s*/g, '');
  return clean.trim();
}

export function rebuildRunBody(
  meta: Record<string, unknown>,
  promptFile?: string
): Record<string, unknown> {
  let prompt = '';
  if (promptFile && fs.existsSync(promptFile)) {
    try {
      const raw = fs.readFileSync(promptFile, 'utf8');
      prompt = cleanPromptText(raw);
    } catch {
      prompt = '';
    }
  }

  const body: Record<string, unknown> = {
    mode: meta.mode ?? 'task',
    role: meta.role ?? 'backend',
    project_path: meta.project_path ?? '',
    prompt,
  };

  if (meta.agent) body.agent = meta.agent;
  if (meta.team && typeof meta.team === 'object' && !Array.isArray(meta.team)) {
    body.team = meta.team;
  }
  if (Array.isArray(meta.reviewers)) {
    body.reviewers = [...meta.reviewers];
  }
  if (meta.implementer) body.implementer = meta.implementer;
  if (meta.model) body.model = meta.model;
  if (meta.effort) body.effort = meta.effort;
  if (meta.new_session !== undefined) body.new_session = meta.new_session;

  return body;
}
