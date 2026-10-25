import fs from 'node:fs';
import path from 'node:path';
import { appendActionAudit } from '../../lib/feature.ts';
import { isDirectorySafe, isFileSafe, type ServerPaths } from '../../lib/paths.ts';
import type { AgentEntry, LoadedRegistry } from '../../lib/registry.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { readJsonSafe, writeJsonAtomic } from '../policy/lib/s4-core.ts';

export const ACCOUNT_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,23}$/;

export interface AccountWindowLimit {
  tokens: number;
}

export interface AccountLimits {
  '5h'?: AccountWindowLimit;
  '7d'?: AccountWindowLimit;
}

export interface AccountRecord {
  agent: string;
  id: string;
  label: string;
  dir: string;
  priority: number;
  enabled: boolean;
  limits?: AccountLimits;
}

export interface AccountsFileSchema {
  version: 1;
  accounts: AccountRecord[];
}

export interface AdapterAccountSupport {
  supported: boolean;
  env_var: string | null;
  env_map: Record<string, string> | null;
}

export interface AccountView extends AccountRecord {
  supported: boolean;
  login: 'ok' | 'logged_out' | 'unknown';
  is_default: boolean;
}

export function getAccountsFilePath(paths: ServerPaths): string {
  return path.win32.join(paths.mawHome, 'accounts.json');
}

export function getDefaultAccountDir(paths: ServerPaths, agent: string, id: string): string {
  return path.win32.join(paths.mawHome, 'accounts', agent.toLowerCase(), id.toLowerCase());
}

export function getAdapterAccountSupport(agentEntry: AgentEntry | undefined): AdapterAccountSupport {
  if (!agentEntry) {
    return { supported: false, env_var: null, env_map: null };
  }
  if (agentEntry.adapter === 'claude') {
    return {
      supported: true,
      env_var: 'CLAUDE_CONFIG_DIR',
      env_map: { CLAUDE_CONFIG_DIR: '{account_dir}' },
    };
  }
  if (agentEntry.adapter === 'codex') {
    return {
      supported: true,
      env_var: 'CODEX_HOME',
      env_map: { CODEX_HOME: '{account_dir}' },
    };
  }
  if (agentEntry.adapter === 'cli') {
    const accEnv = agentEntry.cli?.account_env;
    if (accEnv && typeof accEnv === 'object' && Object.keys(accEnv).length > 0) {
      const firstKey = Object.keys(accEnv)[0]!;
      return {
        supported: true,
        env_var: firstKey,
        env_map: { ...accEnv },
      };
    }
  }
  return { supported: false, env_var: null, env_map: null };
}

export function buildAllAdaptersSupportMap(
  registry: LoadedRegistry
): Record<string, { supported: boolean; env_var: string | null }> {
  const out: Record<string, { supported: boolean; env_var: string | null }> = {};
  for (const agent of registry.allAgents) {
    const sup = getAdapterAccountSupport(agent);
    out[agent.id] = {
      supported: sup.supported,
      env_var: sup.env_var,
    };
  }
  return out;
}

function normalizeLimits(raw: unknown): AccountLimits | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: AccountLimits = {};
  for (const winKey of ['5h', '7d'] as const) {
    const w = obj[winKey];
    if (w && typeof w === 'object' && !Array.isArray(w)) {
      const tok = Number((w as Record<string, unknown>).tokens ?? 0);
      if (Number.isFinite(tok) && tok > 0) {
        out[winKey] = { tokens: Math.trunc(tok) };
      }
    } else if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      out[winKey] = { tokens: Math.trunc(w) };
    }
  }
  if (!out['5h'] && typeof obj.tokens_5h === 'number' && Number.isFinite(obj.tokens_5h) && obj.tokens_5h > 0) {
    out['5h'] = { tokens: Math.trunc(obj.tokens_5h) };
  }
  if (!out['7d'] && typeof obj.tokens_7d === 'number' && Number.isFinite(obj.tokens_7d) && obj.tokens_7d > 0) {
    out['7d'] = { tokens: Math.trunc(obj.tokens_7d) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function isAllowedAccountDir(dirPath: string, _paths?: ServerPaths): boolean {
  return isSafeAccountDirPath(dirPath);
}

function isSafeAccountDirPath(dirPath: string): boolean {
  if (!dirPath || /[\0\r\n]/.test(dirPath)) return false;
  if (!path.win32.isAbsolute(dirPath)) return false;
  const resolved = path.win32.resolve(dirPath);
  // Reject drive root like C:\
  if (/^[A-Za-z]:\\?$/.test(resolved)) return false;
  const lower = resolved.toLowerCase();
  const winDir = (process.env.WINDIR || 'C:\\Windows').toLowerCase();
  if (lower === winDir || lower.startsWith(winDir + '\\')) return false;
  return true;
}

export function loadAccountsFile(paths: ServerPaths): {
  data: AccountsFileSchema;
  warnings: string[];
} {
  const filePath = getAccountsFilePath(paths);
  const warnings: string[] = [];
  if (!fs.existsSync(filePath)) {
    return { data: { version: 1, accounts: [] }, warnings };
  }
  const readRes = readJsonSafe<unknown>(filePath, { version: 1, accounts: [] });
  if (readRes.warning) {
    warnings.push(readRes.warning);
  }
  const raw = readRes.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('accounts.json root must be an object.');
    return { data: { version: 1, accounts: [] }, warnings };
  }
  const rawList = Array.isArray((raw as Record<string, unknown>).accounts)
    ? ((raw as Record<string, unknown>).accounts as unknown[])
    : [];

  const seen = new Set<string>();
  const accounts: AccountRecord[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const agent = String(obj.agent ?? '')
      .trim()
      .toLowerCase();
    const id = String(obj.id ?? '')
      .trim()
      .toLowerCase();
    if (!agent || !ACCOUNT_ID_REGEX.test(id)) {
      warnings.push(`Skipped invalid account '${agent}/${id}' in accounts.json.`);
      continue;
    }
    const key = `${agent}:${id}`;
    if (seen.has(key)) {
      warnings.push(`Skipped duplicate account '${key}' in accounts.json.`);
      continue;
    }
    const label = String(obj.label ?? '').trim().slice(0, 40);
    const isDefault = id === 'default';
    if (!isDefault && !label) {
      warnings.push(`Skipped account '${key}' with empty label.`);
      continue;
    }
    const rawDir = String(obj.dir ?? '').trim();
    const dir = isDefault ? '' : rawDir || getDefaultAccountDir(paths, agent, id);
    if (!isDefault && !isSafeAccountDirPath(dir)) {
      warnings.push(`Skipped account '${key}' with unsafe dir '${dir}'.`);
      continue;
    }
    const priority = Number.isFinite(Number(obj.priority))
      ? Math.trunc(Number(obj.priority))
      : 0;
    const enabled = obj.enabled !== undefined ? Boolean(obj.enabled) : true;
    const limits = normalizeLimits(obj.limits);

    seen.add(key);
    accounts.push({
      agent,
      id,
      label,
      dir: isDefault ? '' : path.win32.resolve(dir),
      priority,
      enabled,
      ...(limits ? { limits } : {}),
    });
  }

  return { data: { version: 1, accounts }, warnings };
}

export function saveAccountsFile(paths: ServerPaths, data: AccountsFileSchema): void {
  const filePath = getAccountsFilePath(paths);
  writeJsonAtomic(filePath, {
    version: 1,
    accounts: data.accounts,
  });
}

export function getEffectiveAccountConfigDir(
  paths: ServerPaths,
  agentEntry: AgentEntry,
  account: { id: string; dir?: string }
): string {
  if (account.id !== 'default' && account.dir) {
    return account.dir;
  }
  if (agentEntry.adapter === 'claude') {
    return process.env.CLAUDE_CONFIG_DIR?.trim() || path.win32.join(paths.userProfile, '.claude');
  }
  if (agentEntry.adapter === 'codex') {
    return process.env.CODEX_HOME?.trim() || path.win32.join(paths.userProfile, '.codex');
  }
  if (agentEntry.adapter === 'cli' && agentEntry.id === 'gemini') {
    const geminiHome = process.env.GEMINI_CLI_HOME?.trim() || paths.userProfile;
    return path.win32.join(geminiHome, '.gemini');
  }
  return '';
}

export function detectAccountLoginFast(
  paths: ServerPaths,
  agentEntry: AgentEntry | undefined,
  account: { id: string; dir?: string },
  cachedSnapshotLogin?: 'ok' | 'logged_out' | 'unknown'
): 'ok' | 'logged_out' | 'unknown' {
  if (cachedSnapshotLogin === 'ok' || cachedSnapshotLogin === 'logged_out') {
    return cachedSnapshotLogin;
  }
  if (!agentEntry) return 'unknown';

  if (agentEntry.adapter === 'claude') {
    const cfgDir = getEffectiveAccountConfigDir(paths, agentEntry, account);
    if (!cfgDir || !isDirectorySafe(cfgDir)) return 'logged_out';
    const credFile = path.win32.join(cfgDir, '.credentials.json');
    if (isFileSafe(credFile)) {
      try {
        if (fs.statSync(credFile).size > 10) return 'ok';
      } catch {}
    }
    const claudeJson = path.win32.join(cfgDir, '.claude.json');
    if (isFileSafe(claudeJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(claudeJson, 'utf8')) as Record<string, unknown>;
        if (parsed && parsed.oauthAccount && typeof parsed.oauthAccount === 'object') {
          return 'ok';
        }
      } catch {}
    }
    return account.id === 'default' ? 'unknown' : 'logged_out';
  }

  if (agentEntry.adapter === 'codex') {
    const cfgDir = getEffectiveAccountConfigDir(paths, agentEntry, account);
    if (!cfgDir || !isDirectorySafe(cfgDir)) return 'logged_out';
    const authFile = path.win32.join(cfgDir, 'auth.json');
    if (isFileSafe(authFile)) {
      try {
        if (fs.statSync(authFile).size > 10) return 'ok';
      } catch {}
    }
    return account.id === 'default' ? 'unknown' : 'logged_out';
  }

  if (agentEntry.adapter === 'cli' && agentEntry.id === 'gemini') {
    const homeDir = account.id === 'default'
      ? (process.env.GEMINI_CLI_HOME?.trim() || paths.userProfile)
      : (account.dir || '');
    if (!homeDir || !isDirectorySafe(homeDir)) return 'logged_out';
    const geminiDir = path.win32.join(homeDir, '.gemini');
    const oauthFile = path.win32.join(geminiDir, 'oauth_creds.json');
    const accFile = path.win32.join(geminiDir, 'google_accounts.json');
    if (isFileSafe(oauthFile) || isFileSafe(accFile)) {
      return 'ok';
    }
    return account.id === 'default' ? 'unknown' : 'logged_out';
  }

  if (agentEntry.adapter === 'antigravity') {
    return 'ok';
  }

  return 'unknown';
}

export function listAllAccounts(
  paths: ServerPaths,
  registry: LoadedRegistry,
  snapshotLogins?: Map<string, 'ok' | 'logged_out' | 'unknown'>
): {
  accounts: AccountView[];
  adapters: Record<string, { supported: boolean; env_var: string | null }>;
} {
  const { data } = loadAccountsFile(paths);
  const adapters = buildAllAdaptersSupportMap(registry);
  const out: AccountView[] = [];

  const agentIds = new Set<string>();
  for (const ag of registry.agents) {
    agentIds.add(ag.id);
  }
  for (const acc of data.accounts) {
    if (registry.allAgents.some((a) => a.id === acc.agent)) {
      agentIds.add(acc.agent);
    }
  }

  for (const agentId of agentIds) {
    const agentEntry = registry.allAgents.find((a) => a.id === agentId);
    const sup = getAdapterAccountSupport(agentEntry);
    const savedForAgent = data.accounts.filter((a) => a.agent === agentId);

    const savedDefault = savedForAgent.find((a) => a.id === 'default');
    const defKey = `${agentId}:default`;
    const defLogin = detectAccountLoginFast(
      paths,
      agentEntry,
      { id: 'default', dir: '' },
      snapshotLogins?.get(defKey)
    );
    out.push({
      agent: agentId,
      id: 'default',
      label: savedDefault?.label ?? '',
      dir: '',
      priority: savedDefault?.priority ?? 0,
      enabled: savedDefault?.enabled ?? true,
      ...(savedDefault?.limits ? { limits: savedDefault.limits } : {}),
      supported: sup.supported,
      login: defLogin,
      is_default: true,
    });

    const nonDefaults = savedForAgent
      .filter((a) => a.id !== 'default')
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    for (const acc of nonDefaults) {
      const k = `${agentId}:${acc.id}`;
      const login = detectAccountLoginFast(
        paths,
        agentEntry,
        acc,
        snapshotLogins?.get(k)
      );
      out.push({
        ...acc,
        supported: sup.supported,
        login,
        is_default: false,
      });
    }
  }

  return { accounts: out, adapters };
}

export function saveAccountRecord(
  paths: ServerPaths,
  registry: LoadedRegistry,
  rawAccount: unknown
): AccountView {
  if (!rawAccount || typeof rawAccount !== 'object' || Array.isArray(rawAccount)) {
    throw new ApiValidationError("Missing or invalid 'account' object.", 400);
  }
  const obj = rawAccount as Record<string, unknown>;
  const agent = String(obj.agent ?? '')
    .trim()
    .toLowerCase();
  const agentEntry = registry.allAgents.find((a) => a.id === agent);
  if (!agentEntry) {
    throw new ApiValidationError(`Unknown agent '${agent}'.`, 400);
  }

  const id = String(obj.id ?? '')
    .trim()
    .toLowerCase();
  if (!id || !ACCOUNT_ID_REGEX.test(id)) {
    throw new ApiValidationError(
      `Invalid account id '${id}'. Must match ^[a-z0-9][a-z0-9-]{0,23}$.`,
      400
    );
  }

  const sup = getAdapterAccountSupport(agentEntry);
  const isDefault = id === 'default';
  if (!isDefault && !sup.supported) {
    throw new ApiValidationError(
      `Agent '${agent}' does not support multiple accounts (only 'default' is available).`,
      400
    );
  }

  const rawLabel = String(obj.label ?? '').trim();
  if (!isDefault && (rawLabel.length < 1 || rawLabel.length > 40)) {
    throw new ApiValidationError('Account label is required and must be 1-40 characters.', 400);
  }
  if (isDefault && rawLabel.length > 40) {
    throw new ApiValidationError('Account label must not exceed 40 characters.', 400);
  }

  const priorityRaw = Number(obj.priority ?? 0);
  if (!Number.isFinite(priorityRaw) || !Number.isInteger(priorityRaw)) {
    throw new ApiValidationError('Account priority must be an integer.', 400);
  }
  const priority = Math.trunc(priorityRaw);
  const enabled = obj.enabled !== undefined ? Boolean(obj.enabled) : true;
  const limits = normalizeLimits(obj.limits);

  let resolvedDir = '';
  if (!isDefault) {
    const rawDir = String(obj.dir ?? '').trim();
    const candidateDir = rawDir ? rawDir : getDefaultAccountDir(paths, agent, id);
    if (!isSafeAccountDirPath(candidateDir)) {
      throw new ApiValidationError(
        `Invalid account directory '${candidateDir}'. Must be a safe absolute directory path.`,
        400
      );
    }
    resolvedDir = path.win32.resolve(candidateDir);
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    } else if (!fs.statSync(resolvedDir).isDirectory()) {
      throw new ApiValidationError(`Path '${resolvedDir}' exists and is not a directory.`, 400);
    }
  }

  const { data } = loadAccountsFile(paths);
  const record: AccountRecord = {
    agent,
    id,
    label: rawLabel,
    dir: resolvedDir,
    priority,
    enabled,
    ...(limits ? { limits } : {}),
  };

  const idx = data.accounts.findIndex((a) => a.agent === agent && a.id === id);
  if (idx >= 0) {
    data.accounts[idx] = record;
  } else {
    data.accounts.push(record);
  }

  saveAccountsFile(paths, data);
  appendActionAudit(paths, {
    feature: 'accounts',
    action: 'account_save',
    agent,
    account: id,
    dir: resolvedDir,
    enabled,
    priority,
  });

  return {
    ...record,
    supported: sup.supported,
    login: detectAccountLoginFast(paths, agentEntry, record),
    is_default: isDefault,
  };
}

export function deleteAccountRecord(
  paths: ServerPaths,
  agentRaw: unknown,
  idRaw: unknown
): void {
  const agent = String(agentRaw ?? '')
    .trim()
    .toLowerCase();
  const id = String(idRaw ?? '')
    .trim()
    .toLowerCase();
  if (!agent || !id) {
    throw new ApiValidationError("Both 'agent' and 'id' are required.", 400);
  }
  if (id === 'default') {
    throw new ApiValidationError("The 'default' account cannot be deleted.", 400);
  }

  const { data } = loadAccountsFile(paths);
  const idx = data.accounts.findIndex((a) => a.agent === agent && a.id === id);
  if (idx < 0) {
    throw new ApiValidationError(`Account '${id}' for agent '${agent}' not found.`, 404);
  }

  const removed = data.accounts[idx]!;
  data.accounts.splice(idx, 1);
  saveAccountsFile(paths, data);

  appendActionAudit(paths, {
    feature: 'accounts',
    action: 'account_delete',
    agent,
    account: id,
    dir_kept: removed.dir,
  });
}

export const saveAccount = saveAccountRecord;
export const deleteAccount = deleteAccountRecord;

export function resolveAccountExecutionEnv(
  paths: ServerPaths,
  registry: LoadedRegistry,
  agentId: string,
  accountId?: string | null
): {
  accountId: string;
  env: Record<string, string>;
  dir: string;
  isDefault: boolean;
  account: AccountRecord;
} {
  const normAgent = String(agentId ?? '')
    .trim()
    .toLowerCase();
  const normAcc = String(accountId ?? '')
    .trim()
    .toLowerCase();

  const { data } = loadAccountsFile(paths);
  if (!normAcc || normAcc === 'default') {
    const savedDef = data.accounts.find((a) => a.agent === normAgent && a.id === 'default');
    if (savedDef && savedDef.enabled === false) {
      throw new ApiValidationError(`Account 'default' for agent '${normAgent}' is disabled.`, 400);
    }
    return {
      accountId: 'default',
      env: {},
      dir: '',
      isDefault: true,
      account: savedDef ?? {
        agent: normAgent,
        id: 'default',
        label: '',
        dir: '',
        priority: 0,
        enabled: true,
      },
    };
  }

  if (!ACCOUNT_ID_REGEX.test(normAcc)) {
    throw new ApiValidationError(`Invalid account id '${normAcc}'.`, 400);
  }

  const agentEntry = registry.allAgents.find((a) => a.id === normAgent);
  const sup = getAdapterAccountSupport(agentEntry);
  if (!sup.supported || !sup.env_map) {
    throw new ApiValidationError(
      `Agent '${normAgent}' does not support non-default account '${normAcc}'.`,
      400
    );
  }

  const found = data.accounts.find((a) => a.agent === normAgent && a.id === normAcc);
  if (!found) {
    throw new ApiValidationError(
      `Unknown account '${normAcc}' for agent '${normAgent}'.`,
      400
    );
  }
  if (!found.enabled) {
    throw new ApiValidationError(
      `Account '${normAcc}' for agent '${normAgent}' is disabled.`,
      400
    );
  }
  if (!found.dir || !isDirectorySafe(found.dir)) {
    throw new ApiValidationError(
      `Config directory for account '${normAcc}' (${normAgent}) does not exist: ${found.dir}`,
      400
    );
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(sup.env_map)) {
    env[k] = v.replace(/\{account_dir\}/g, found.dir);
  }

  return {
    accountId: found.id,
    env,
    dir: found.dir,
    isDefault: false,
    account: found,
  };
}
