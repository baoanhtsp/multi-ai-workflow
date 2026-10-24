import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../lib/paths.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { generateUnifiedDiff } from './diff.ts';
import {
  isMaskedValue,
  maskEnvValue,
  maskExtraValue,
  parseCodexTomlMcp,
  SECRET_KEY_REGEX,
  updateCodexTomlMcp,
} from './toml.ts';
import type { McpBackupEntry, McpServerConfig, PlatformMcpStatus } from './types.ts';

export interface McpPathOverrides {
  claudeFile?: string;
  codexFile?: string;
  geminiFile?: string;
}

let activeOverrides: McpPathOverrides | null = null;

export function setMcpPathOverrides(overrides: McpPathOverrides | null): void {
  activeOverrides = overrides;
}

export function getMcpFiles(paths: ServerPaths): {
  claude: string;
  codex: string;
  gemini: string;
} {
  return {
    claude: activeOverrides?.claudeFile ?? path.win32.join(paths.userProfile, '.claude.json'),
    codex: activeOverrides?.codexFile ?? path.win32.join(paths.userProfile, '.codex', 'config.toml'),
    gemini: activeOverrides?.geminiFile ?? path.win32.join(paths.userProfile, '.gemini', 'settings.json'),
  };
}

export function maskServerConfig(s: McpServerConfig): McpServerConfig {
  const masked: McpServerConfig = {
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.args ? [...s.args] : undefined,
    url: s.url,
    extra: s.extra ? (maskExtraValue(s.extra) as Record<string, unknown>) : undefined,
  };
  if (s.env) {
    masked.env = {};
    for (const [k, v] of Object.entries(s.env)) {
      masked.env[k] = maskEnvValue(v);
    }
  }
  return masked;
}

export function mergeExtraRetainingExisting(
  newExtra: Record<string, unknown>,
  existingExtra?: Record<string, unknown>,
  maskEnv?: boolean
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, newVal] of Object.entries(newExtra)) {
    const existingVal = existingExtra?.[key];
    result[key] = mergeSingleExtraValue(newVal, existingVal, key, maskEnv);
  }

  return result;
}

function mergeSingleExtraValue(
  newVal: unknown,
  existingVal: unknown,
  keyName: string,
  maskEnv?: boolean
): unknown {
  if (newVal === null || newVal === undefined) return newVal;

  if (typeof newVal === 'string') {
    if (maskEnv) {
      if (SECRET_KEY_REGEX.test(keyName)) {
        return maskEnvValue(newVal);
      }
      return newVal;
    }
    // Write path: if newVal is masked and existingVal is string, retain existingVal
    if (isMaskedValue(newVal) && typeof existingVal === 'string') {
      return existingVal;
    }
    return newVal;
  }

  if (Array.isArray(newVal)) {
    const existingArr = Array.isArray(existingVal) ? existingVal : [];
    return newVal.map((item, idx) =>
      mergeSingleExtraValue(item, existingArr[idx], keyName, maskEnv)
    );
  }

  if (typeof newVal === 'object') {
    const existingObj =
      typeof existingVal === 'object' && existingVal !== null && !Array.isArray(existingVal)
        ? (existingVal as Record<string, unknown>)
        : undefined;
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(newVal as Record<string, unknown>)) {
      res[k] = mergeSingleExtraValue(v, existingObj?.[k], k, maskEnv);
    }
    return res;
  }

  return newVal;
}

export function readPlatformServers(filePath: string, platform: 'claude' | 'codex' | 'gemini'): {
  exists: boolean;
  writable: boolean;
  servers: McpServerConfig[];
  error?: string;
} {
  const exists = isFileSafe(filePath);
  let writable = exists;
  if (!exists) {
    // Check if parent directory is writable
    const parent = path.dirname(filePath);
    writable = isDirectorySafe(parent);
  }

  if (!exists) {
    return { exists: false, writable, servers: [] };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (platform === 'codex') {
      const servers = parseCodexTomlMcp(raw);
      return { exists: true, writable, servers };
    }

    // Claude and Gemini use JSON with mcpServers key
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const mcpServers = parsed?.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
      return { exists: true, writable, servers: [] };
    }

    const servers: McpServerConfig[] = [];
    for (const [name, rawDef] of Object.entries(mcpServers)) {
      if (!rawDef || typeof rawDef !== 'object' || Array.isArray(rawDef)) continue;
      const def = rawDef as Record<string, unknown>;

      const isHttp =
        def.type === 'http' ||
        typeof def.url === 'string' ||
        typeof def.httpUrl === 'string';

      const s: McpServerConfig = {
        name,
        transport: isHttp ? 'http' : 'stdio',
      };

      if (isHttp) {
        s.url = (def.httpUrl as string) || (def.url as string) || '';
      } else {
        s.command = (def.command as string) || 'node';
        if (Array.isArray(def.args)) {
          s.args = def.args.map(String);
        }
        if (def.env && typeof def.env === 'object' && !Array.isArray(def.env)) {
          s.env = {};
          for (const [ek, ev] of Object.entries(def.env)) {
            s.env[ek] = String(ev ?? '');
          }
        }
      }

      // Preserve extra keys
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(def)) {
        if (!['type', 'url', 'httpUrl', 'command', 'args', 'env'].includes(k)) {
          extra[k] = v;
        }
      }
      if (Object.keys(extra).length > 0) {
        s.extra = extra;
      }

      servers.push(s);
    }

    return { exists: true, writable, servers };
  } catch (err) {
    return {
      exists: true,
      writable,
      servers: [],
      error: `Failed to parse ${platform} configuration: ${(err as Error)?.message ?? 'Unknown error'}`,
    };
  }
}

export function renderPlatformFile(
  filePath: string,
  platform: 'claude' | 'codex' | 'gemini',
  options: {
    set?: McpServerConfig[];
    remove?: string[];
    maskEnv?: boolean;
  }
): string {
  if (platform === 'codex') {
    const current = readPlatformServers(filePath, platform);
    const origToml = isFileSafe(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    return updateCodexTomlMcp(origToml, {
      set: options.set,
      remove: options.remove,
      existingServers: current.servers,
      maskEnv: options.maskEnv,
    });
  }

  // Claude / Gemini JSON: validate JSON first to avoid data-loss (Item 1)
  let rootObj: Record<string, unknown> = {};
  if (isFileSafe(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`${filePath} is not valid JSON; not touching it`);
        }
        rootObj = parsed as Record<string, unknown>;
      } catch {
        throw new Error(`${filePath} is not valid JSON; not touching it`);
      }
    }
  }

  const current = readPlatformServers(filePath, platform);
  const existingMap = new Map<string, McpServerConfig>();
  for (const s of current.servers) {
    existingMap.set(s.name.toLowerCase(), s);
  }

  // Remove
  const removeSet = new Set((options.remove ?? []).map((x) => x.toLowerCase()));
  const activeServers = current.servers.filter((s) => !removeSet.has(s.name.toLowerCase()));

  // Set / merge
  for (const newS of options.set ?? []) {
    const norm = newS.name.toLowerCase();
    const existing = existingMap.get(norm);

    // Resolve unmasked env
    const resolvedEnv: Record<string, string> = {};
    if (newS.env) {
      for (const [k, v] of Object.entries(newS.env)) {
        if (options.maskEnv) {
          resolvedEnv[k] = maskEnvValue(v);
        } else if (isMaskedValue(v) && existing?.env?.[k]) {
          resolvedEnv[k] = existing.env[k]!;
        } else {
          resolvedEnv[k] = v;
        }
      }
    }

    const resolvedExtra = newS.extra
      ? mergeExtraRetainingExisting(newS.extra, existing?.extra, options.maskEnv)
      : undefined;

    const merged: McpServerConfig = {
      ...newS,
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
      extra: resolvedExtra,
    };

    const idx = activeServers.findIndex((s) => s.name.toLowerCase() === norm);
    if (idx !== -1) {
      activeServers[idx] = merged;
    } else {
      activeServers.push(merged);
    }
  }

  const mcpServersMap: Record<string, unknown> = {};
  for (const s of activeServers) {
    const sObj: Record<string, unknown> = {};
    if (s.transport === 'http' || s.url) {
      if (platform === 'gemini') {
        sObj.httpUrl = s.url ?? '';
      } else {
        sObj.type = 'http';
        sObj.url = s.url ?? '';
      }
    } else {
      sObj.command = s.command ?? 'node';
      sObj.args = s.args ?? [];
      if (s.env && Object.keys(s.env).length > 0) {
        const envCopy: Record<string, string> = {};
        for (const [ek, ev] of Object.entries(s.env)) {
          envCopy[ek] = options.maskEnv ? maskEnvValue(ev) : ev;
        }
        sObj.env = envCopy;
      }
    }
    if (s.extra) {
      for (const [ek, ev] of Object.entries(s.extra)) {
        sObj[ek] = ev;
      }
    }
    mcpServersMap[s.name] = sObj;
  }

  rootObj.mcpServers = mcpServersMap;
  return JSON.stringify(rootObj, null, 2) + '\n';
}

export function backupPlatformFile(paths: ServerPaths, filePath: string, platform: string): string | null {
  if (!isFileSafe(filePath)) {
    return null;
  }
  const dataDir = paths.featureDataDir('mcp');
  const backupDir = path.win32.join(dataDir, 'backups');
  if (!isDirectorySafe(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = path.extname(filePath).replace(/^\./, '') || 'bak';
  let backupName = `${platform}-${stamp}.${ext}`;
  let backupPath = path.win32.join(backupDir, backupName);
  let counter = 1;
  while (fs.existsSync(backupPath)) {
    backupName = `${platform}-${stamp}-${counter}.${ext}`;
    backupPath = path.win32.join(backupDir, backupName);
    counter++;
  }

  fs.copyFileSync(filePath, backupPath);

  // Keep newest 20 backups per platform
  try {
    const allBackups = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith(`${platform}-`))
      .sort()
      .reverse();
    if (allBackups.length > 20) {
      for (const oldFile of allBackups.slice(20)) {
        try {
          fs.unlinkSync(path.win32.join(backupDir, oldFile));
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore pruning errors
  }

  return backupName;
}

export function listMcpBackups(paths: ServerPaths): McpBackupEntry[] {
  const dataDir = paths.featureDataDir('mcp');
  const backupDir = path.win32.join(dataDir, 'backups');
  if (!isDirectorySafe(backupDir)) {
    return [];
  }

  const entries: McpBackupEntry[] = [];
  try {
    const files = fs.readdirSync(backupDir).sort().reverse();
    for (const f of files) {
      const full = path.win32.join(backupDir, f);
      try {
        const st = fs.statSync(full);
        const dashIdx = f.indexOf('-');
        const platform = dashIdx !== -1 ? f.slice(0, dashIdx) : 'unknown';
        entries.push({
          platform,
          filename: f,
          created_at: st.mtime.toISOString(),
          size: st.size,
        });
      } catch {
        // Ignore
      }
    }
  } catch {
    return [];
  }
  return entries;
}
