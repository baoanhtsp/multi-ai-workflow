import fs from 'node:fs';
import path from 'node:path';
import { getBridgeStatus } from '../../actions/status.ts';
import { isDirectorySafe, isFileSafe, type ServerPaths } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import type { AgentEntry, LoadedRegistry } from '../../lib/registry.ts';
import { classifyLog } from './patterns.ts';

export interface HealthAgentResult {
  id: string;
  label: string;
  platform: string;
  installed: boolean;
  version: string | null;
  login: 'ok' | 'logged_out' | 'unknown' | 'n/a';
  auth_method: string | null;
  quota: {
    used_percent: number;
    resets_at: string;
    window: string;
  } | null;
  model: string | null;
  model_source: 'override' | 'cli-config' | 'unknown';
  status: 'ok' | 'warn' | 'error';
  reason: string;
  fix: {
    kind: 'login' | 'install' | 'start-ide' | null;
    command: string | null;
  } | null;
  checked_at: string;
  ms: number;
}

export interface HealthCacheData {
  agents: Record<string, HealthAgentResult>;
}

// In-memory 60s cache
const memoryCache = new Map<string, { result: HealthAgentResult; expiresAt: number }>();

export function invalidateHealthCache(platformOrId?: string): void {
  if (!platformOrId) {
    memoryCache.clear();
    return;
  }
  const norm = platformOrId.toLowerCase();
  for (const [key, item] of memoryCache.entries()) {
    if (
      key.toLowerCase() === norm ||
      item.result.platform.toLowerCase() === norm ||
      item.result.id.toLowerCase() === norm
    ) {
      memoryCache.delete(key);
    }
  }
}

export function redactSecrets(raw: string, userProfile?: string): string {
  let s = String(raw ?? '');
  if (userProfile && userProfile.trim() !== '') {
    const escaped = userProfile.replace(/\\/g, '\\\\');
    s = s.replace(new RegExp(escaped, 'gi'), '~');
  }
  // Redact email addresses
  s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted-email]');
  // Redact Telegram bot tokens (digits:token)
  s = s.replace(/bot\d+:[a-zA-Z0-9_-]{20,}/gi, 'bot[redacted-token]');
  s = s.replace(/\b\d{8,11}:[a-zA-Z0-9_-]{25,}\b/g, '[redacted-token]');
  // Redact API keys / tokens
  s = s.replace(/\b(sk-[a-zA-Z0-9_-]{15,}|ghp_[a-zA-Z0-9]{20,}|key-[a-zA-Z0-9]{15,})\b/gi, '[redacted-key]');
  // Redact Bearer tokens
  s = s.replace(/Bearer\s+[a-zA-Z0-9._~+/-]{15,}/gi, 'Bearer [redacted]');
  // Truncate to max 200 chars
  if (s.length > 200) {
    s = s.slice(0, 197) + '...';
  }
  return s.trim();
}

function extractSemver(raw: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[a-zA-Z0-9._]+)?)/.exec(raw);
  return m ? m[1]! : null;
}

export function findClaudeExe(userProfile: string): string | null {
  const roamingDirs = [path.win32.join(userProfile, 'AppData', 'Roaming')];
  const envAppData = (process.env.APPDATA ?? '').trim();
  if (envAppData && !roamingDirs.some((d) => d.toLowerCase() === envAppData.toLowerCase())) {
    roamingDirs.push(envAppData);
  }
  for (const roam of roamingDirs) {
    const claudeBase = path.win32.join(roam, 'Claude', 'claude-code');
    if (!isDirectorySafe(claudeBase)) {
      continue;
    }
    const found: Array<{ file: string; mtime: number }> = [];
    try {
      for (const d1 of fs.readdirSync(claudeBase, { withFileTypes: true })) {
        if (!d1.isDirectory()) continue;
        const p1 = path.win32.join(claudeBase, d1.name);
        const exe1 = path.win32.join(p1, 'claude.exe');
        if (isFileSafe(exe1)) {
          found.push({ file: exe1, mtime: fs.statSync(exe1).mtimeMs });
        }
        for (const d2 of fs.readdirSync(p1, { withFileTypes: true })) {
          if (!d2.isDirectory()) continue;
          const exe2 = path.win32.join(p1, d2.name, 'claude.exe');
          if (isFileSafe(exe2)) {
            found.push({ file: exe2, mtime: fs.statSync(exe2).mtimeMs });
          }
        }
      }
    } catch {
      // Ignore scan errors
    }
    if (found.length > 0) {
      found.sort((a, b) => b.mtime - a.mtime);
      return found[0]!.file;
    }
  }
  return null;
}

export function resolveCliExecutable(cmd: string, userProfile: string): string | null {
  if (!cmd || cmd.trim() === '') {
    return null;
  }
  if (isFileSafe(cmd)) {
    return cmd;
  }
  const npmCmd = path.win32.join(userProfile, 'AppData', 'Roaming', 'npm', `${cmd}.cmd`);
  if (isFileSafe(npmCmd)) {
    return npmCmd;
  }
  const npmPs1 = path.win32.join(userProfile, 'AppData', 'Roaming', 'npm', `${cmd}.ps1`);
  if (isFileSafe(npmPs1)) {
    return npmPs1;
  }
  return null;
}

export async function runCliWithShimFallback(
  cmd: string,
  args: string[],
  userProfile: string,
  timeoutMs = 5000,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string; resolvedPath: string | null }> {
  let resolved = resolveCliExecutable(cmd, userProfile);
  if (!resolved) {
    const whereRes = await runCommand('where.exe', [cmd], { timeoutMs: 2500, env });
    if (whereRes.code === 0 && whereRes.stdout.trim() !== '') {
      const firstLine = whereRes.stdout
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l !== '');
      if (firstLine) {
        resolved = firstLine;
      }
    }
  }

  if (!resolved) {
    const directRes = await runCommand(cmd, args, { timeoutMs, env });
    return {
      code: directRes.code,
      stdout: directRes.stdout,
      stderr: directRes.stderr,
      resolvedPath: directRes.code === 0 ? cmd : null,
    };
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const res = await runCommand('cmd.exe', ['/d', '/s', '/c', resolved, ...args], { timeoutMs, env });
    return { code: res.code, stdout: res.stdout, stderr: res.stderr, resolvedPath: resolved };
  }
  if (ext === '.ps1') {
    const res = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args],
      { timeoutMs, env }
    );
    return { code: res.code, stdout: res.stdout, stderr: res.stderr, resolvedPath: resolved };
  }

  const res = await runCommand(resolved, args, { timeoutMs, env });
  return { code: res.code, stdout: res.stdout, stderr: res.stderr, resolvedPath: resolved };
}

function scanRecentJobErrors(
  jobsDir: string,
  agentId: string
): { hasError: boolean; isRateLimited: boolean; lastMinutesAgo: number | null } {
  if (!isDirectorySafe(jobsDir)) {
    return { hasError: false, isRateLimited: false, lastMinutesAgo: null };
  }
  const now = Date.now();
  const thirtyMinMs = 30 * 60 * 1000;
  let newestErrTime = 0;
  let isRateLimited = false;
  let hasAuthOrRateErr = false;

  try {
    const files = fs.readdirSync(jobsDir);
    for (const file of files) {
      if (!file.endsWith('.json') || !file.startsWith('job_')) continue;
      const metaPath = path.win32.join(jobsDir, file);
      try {
        const st = fs.statSync(metaPath);
        if (now - st.mtimeMs > thirtyMinMs) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
        const jobAgent = String(meta.agent ?? meta.mode ?? '').toLowerCase();
        if (jobAgent !== agentId.toLowerCase() && meta.mode !== 'team' && meta.mode !== 'council') {
          continue;
        }
        const logFile = path.win32.join(jobsDir, file.replace(/\.json$/, '.log'));
        if (!isFileSafe(logFile)) continue;
        const logSt = fs.statSync(logFile);
        const readLen = Math.min(logSt.size, 16384);
        const fd = fs.openSync(logFile, 'r');
        let tailText = '';
        try {
          const buf = Buffer.alloc(readLen);
          const n = fs.readSync(fd, buf, 0, readLen, Math.max(0, logSt.size - readLen));
          tailText = buf.subarray(0, n).toString('utf8');
        } finally {
          fs.closeSync(fd);
        }

        const classification = classifyLog(agentId, tailText);
        if (classification === 'rate_limited') {
          isRateLimited = true;
          hasAuthOrRateErr = true;
          if (st.mtimeMs > newestErrTime) newestErrTime = st.mtimeMs;
        } else if (classification === 'needs_login') {
          hasAuthOrRateErr = true;
          if (st.mtimeMs > newestErrTime) newestErrTime = st.mtimeMs;
        }
      } catch {
        // Ignore file read error
      }
    }
  } catch {
    // Ignore scan error
  }

  const minsAgo = newestErrTime > 0 ? Math.max(1, Math.round((now - newestErrTime) / 60000)) : null;
  return { hasError: hasAuthOrRateErr, isRateLimited, lastMinutesAgo: minsAgo };
}

export interface CodexQuotaWindow {
  id: '5h' | '7d' | 'custom';
  used_percent: number;
  resets_at: string;
  window_minutes: number;
  source: 'provider';
}

export function mapCodexWindowMinutes(windowMinutes?: number | null): '5h' | '7d' | 'custom' {
  if (windowMinutes === 300) return '5h';
  if (windowMinutes === 10080) return '7d';
  return 'custom';
}

export function parseCodexRateLimitsFromRolloutLine(line: string): CodexQuotaWindow[] {
  if (!line.includes('"rate_limits"')) return [];
  try {
    const parsed = JSON.parse(line) as {
      payload?: {
        type?: string;
        rate_limits?: {
          primary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
          secondary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
        };
      };
      rate_limits?: {
        primary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
        secondary?: { used_percent?: number; resets_at?: number; window_minutes?: number } | null;
      };
    };
    const rl = parsed.payload?.rate_limits ?? parsed.rate_limits;
    if (!rl) return [];

    const out: CodexQuotaWindow[] = [];
    for (const rawWin of [rl.primary, rl.secondary]) {
      if (!rawWin || typeof rawWin.used_percent !== 'number' || !Number.isFinite(rawWin.used_percent)) {
        continue;
      }
      let resetsIso = '';
      if (rawWin.resets_at && Number.isFinite(rawWin.resets_at)) {
        const ms = rawWin.resets_at > 1e11 ? rawWin.resets_at : rawWin.resets_at * 1000;
        resetsIso = new Date(ms).toISOString();
      }
      const winMinutes = typeof rawWin.window_minutes === 'number' ? rawWin.window_minutes : 0;
      const winId = mapCodexWindowMinutes(winMinutes);
      const existingIdx = out.findIndex((w) => w.id === winId);
      const entry: CodexQuotaWindow = {
        id: winId,
        used_percent: Math.max(0, Math.min(100, rawWin.used_percent)),
        resets_at: resetsIso,
        window_minutes: winMinutes,
        source: 'provider',
      };
      if (existingIdx >= 0) {
        if (entry.used_percent >= out[existingIdx]!.used_percent) {
          out[existingIdx] = entry;
        }
      } else {
        out.push(entry);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function findCodexQuotaWindows(
  codexHomeDir: string,
  options?: { maxAgeMs?: number }
): CodexQuotaWindow[] {
  const sessionsDir = path.win32.join(codexHomeDir, 'sessions');
  if (!isDirectorySafe(sessionsDir)) return [];

  try {
    const now = Date.now();
    const maxAgeMs = options?.maxAgeMs ?? 7 * 24 * 3600 * 1000;
    const candidates: Array<{ file: string; mtime: number }> = [];

    function walk(dir: string, depth = 0): void {
      if (depth > 6) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.win32.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          try {
            const st = fs.statSync(full);
            if (now - st.mtimeMs <= maxAgeMs) {
              candidates.push({ file: full, mtime: st.mtimeMs });
            }
          } catch {
            // Ignore
          }
        }
      }
    }

    walk(sessionsDir);
    if (candidates.length === 0) return [];
    candidates.sort((a, b) => b.mtime - a.mtime);

    for (const cand of candidates.slice(0, 5)) {
      const st = fs.statSync(cand.file);
      const readLen = Math.min(st.size, 65536);
      const fd = fs.openSync(cand.file, 'r');
      let chunk = '';
      try {
        const buf = Buffer.alloc(readLen);
        const n = fs.readSync(fd, buf, 0, readLen, Math.max(0, st.size - readLen));
        chunk = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }

      const lines = chunk
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse();
      for (const line of lines) {
        const wins = parseCodexRateLimitsFromRolloutLine(line);
        if (wins.length > 0) {
          return wins;
        }
      }
    }
  } catch {
    // Ignore quota read error
  }
  return [];
}

function findCodexQuota(userProfile: string): {
  used_percent: number;
  resets_at: string;
  window: string;
  windows?: CodexQuotaWindow[];
} | null {
  const codexHome = path.win32.join(userProfile, '.codex');
  const wins = findCodexQuotaWindows(codexHome, { maxAgeMs: 24 * 3600 * 1000 });
  if (wins.length === 0) return null;

  const sorted = [...wins].sort((a, b) => b.used_percent - a.used_percent);
  const top = sorted[0]!;
  const winMinutes = top.window_minutes;
  const windowStr =
    top.id === '5h' || top.id === '7d'
      ? top.id
      : winMinutes >= 60
        ? `${Math.round(winMinutes / 60)}h`
        : `${winMinutes}m`;

  return {
    used_percent: top.used_percent,
    resets_at: top.resets_at,
    window: windowStr,
    windows: wins,
  };
}

interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
}

export async function probeAgent(
  agent: AgentEntry,
  paths: ServerPaths
): Promise<HealthAgentResult> {
  const startMs = Date.now();
  const id = agent.id;
  const label = agent.label;
  const platform = agent.adapter === 'cli' ? (agent.cli?.command || agent.id) : agent.adapter;

  let installed = false;
  let version: string | null = null;
  let login: 'ok' | 'logged_out' | 'unknown' | 'n/a' = 'unknown';
  let authMethod: string | null = null;
  let quota: HealthAgentResult['quota'] = null;
  let model: string | null = null;
  let modelSource: 'override' | 'cli-config' | 'unknown' = 'unknown';
  let status: 'ok' | 'warn' | 'error' = 'ok';
  let reason = '';
  let fix: HealthAgentResult['fix'] = null;

  try {
    if (id === 'claude') {
      const claudeExe = findClaudeExe(paths.userProfile);
      let probeExe = claudeExe;
      if (!probeExe) {
        const verTry = await runCommand('claude.exe', ['--version'], { timeoutMs: 3000 });
        if (verTry.code === 0) {
          probeExe = 'claude.exe';
          version = extractSemver(verTry.stdout || verTry.stderr);
        }
      }
      if (claudeExe && !version) {
        const verTry = await runCommand(claudeExe, ['--version'], { timeoutMs: 3000 });
        version = extractSemver(verTry.stdout || verTry.stderr);
      }

      installed = Boolean(probeExe) || isDirectorySafe(path.win32.join(paths.userProfile, '.claude'));

      // Check model from ~/.claude/settings.json
      const claudeSettings = path.win32.join(paths.userProfile, '.claude', 'settings.json');
      if (isFileSafe(claudeSettings)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(claudeSettings, 'utf8')) as { model?: unknown };
          if (typeof cfg.model === 'string' && cfg.model.trim()) {
            model = cfg.model.trim();
            modelSource = 'cli-config';
          }
        } catch {
          // Ignore
        }
      }
      if (!model) {
        model = 'default';
        modelSource = 'cli-config';
      }

      if (!probeExe) {
        installed = false;
        login = 'n/a';
        status = 'error';
        reason = 'Claude Code CLI is not installed';
        fix = { kind: 'install', command: 'irm https://claude.ai/install.ps1 | iex' };
      } else {
        installed = true;
        const probeRes = await runCommand(probeExe, ['auth', 'status'], { timeoutMs: 5000 });
        const rawJson = probeRes.stdout.trim() || probeRes.stderr.trim();
        let parsedAuth: ClaudeAuthStatus | null = null;
        try {
          parsedAuth = JSON.parse(rawJson) as ClaudeAuthStatus;
        } catch {
          // If stdout had extra text, attempt regex extraction
          const match = /\{[\s\S]*"loggedIn"[\s\S]*\}/.exec(rawJson);
          if (match) {
            try {
              parsedAuth = JSON.parse(match[0]) as ClaudeAuthStatus;
            } catch {
              // Ignore
            }
          }
        }

        if (parsedAuth && typeof parsedAuth.loggedIn === 'boolean') {
          if (parsedAuth.loggedIn) {
            login = 'ok';
            authMethod = parsedAuth.authMethod ?? 'claude.ai';
            const sub = parsedAuth.subscriptionType ? ` (${parsedAuth.subscriptionType})` : '';
            reason = `Logged in via ${authMethod}${sub}`;
          } else {
            login = 'logged_out';
            status = 'error';
            reason = 'Not logged in to Claude Code';
            fix = { kind: 'login', command: 'claude /login' };
          }
        } else if (probeRes.code === 0 && /logged in/i.test(rawJson) && !/not logged in/i.test(rawJson)) {
          login = 'ok';
          reason = 'Logged in to Claude Code';
        } else {
          login = 'logged_out';
          status = 'error';
          reason = 'Not logged in to Claude Code';
          fix = { kind: 'login', command: 'claude /login' };
        }
      }
    } else if (id === 'codex') {
      const codexTry = await runCliWithShimFallback('codex', ['--version'], paths.userProfile, 4000);
      version = extractSemver(codexTry.stdout || codexTry.stderr);
      installed = codexTry.resolvedPath !== null || Boolean(version);

      // Model from ~/.codex/config.toml
      const codexToml = path.win32.join(paths.userProfile, '.codex', 'config.toml');
      if (isFileSafe(codexToml)) {
        try {
          const tomlText = fs.readFileSync(codexToml, 'utf8');
          const m = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(tomlText);
          if (m && m[1]) {
            model = m[1].trim();
            modelSource = 'cli-config';
          }
        } catch {
          // Ignore
        }
      }

      if (!installed) {
        login = 'n/a';
        status = 'error';
        reason = 'Codex CLI is not installed';
        fix = { kind: 'install', command: 'npm i -g @openai/codex' };
      } else {
        const probeRes = await runCliWithShimFallback('codex', ['login', 'status'], paths.userProfile, 5000);
        const combined = `${probeRes.stdout}\n${probeRes.stderr}`.trim();
        if (/logged in/i.test(combined) && !/not logged in/i.test(combined)) {
          login = 'ok';
          if (/using chatgpt/i.test(combined)) {
            authMethod = 'chatgpt';
            reason = 'Logged in using ChatGPT';
          } else if (/using an api key/i.test(combined)) {
            authMethod = 'api_key';
            reason = 'Logged in using an API key';
          } else {
            reason = redactSecrets(combined.slice(0, 100), paths.userProfile);
          }
        } else {
          login = 'logged_out';
          status = 'error';
          reason = 'Not logged in to Codex';
          fix = { kind: 'login', command: 'codex login' };
        }

        // Check Quota
        quota = findCodexQuota(paths.userProfile);
        if (quota) {
          if (quota.used_percent >= 100) {
            const resetsMs = Date.parse(quota.resets_at);
            if (!Number.isNaN(resetsMs) && Date.now() < resetsMs) {
              status = 'error';
              reason = `Quota exhausted (100% used, resets at ${quota.resets_at})`;
            }
          } else if (quota.used_percent >= 90 && status !== 'error') {
            status = 'warn';
            reason = `Quota usage high (${quota.used_percent}% used)`;
          }
        }
      }
    } else if (id === 'gemini') {
      const geminiTry = await runCliWithShimFallback('gemini', ['--version'], paths.userProfile, 4000);
      version = extractSemver(geminiTry.stdout || geminiTry.stderr);
      installed = geminiTry.resolvedPath !== null || Boolean(version);

      // Model from ~/.gemini/settings.json
      const geminiSettings = path.win32.join(paths.userProfile, '.gemini', 'settings.json');
      if (isFileSafe(geminiSettings)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(geminiSettings, 'utf8')) as {
            model?: { name?: string };
            'model.name'?: string;
          };
          const name = cfg.model?.name ?? cfg['model.name'];
          if (typeof name === 'string' && name.trim()) {
            model = name.trim();
            modelSource = 'cli-config';
          }
        } catch {
          // Ignore
        }
      }
      if (!model) {
        model = 'auto';
        modelSource = 'cli-config';
      }

      if (!installed) {
        login = 'n/a';
        status = 'error';
        reason = 'Gemini CLI is not installed';
        fix = { kind: 'install', command: 'npm i -g @google/gemini-cli' };
      } else {
        // Config check: GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_USE_VERTEXAI
        const hasEnvKey = Boolean(
          process.env.GEMINI_API_KEY ||
            process.env.GOOGLE_API_KEY ||
            process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true'
        );

        let hasSettingsAuth = false;
        if (isFileSafe(geminiSettings)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(geminiSettings, 'utf8')) as {
              security?: { auth?: { selectedType?: string } };
              selectedAuthType?: string;
            };
            const selType = cfg.security?.auth?.selectedType ?? cfg.selectedAuthType;
            if (selType) {
              if (selType === 'oauth-personal') {
                const credsFile = path.win32.join(paths.userProfile, '.gemini', 'oauth_creds.json');
                hasSettingsAuth = isFileSafe(credsFile);
              } else {
                hasSettingsAuth = true;
              }
            }
          } catch {
            // Ignore
          }
        }

        if (hasEnvKey || hasSettingsAuth) {
          login = 'ok';
          authMethod = hasEnvKey ? 'api_key' : 'oauth';
          reason = 'Gemini authentication configured';
        } else {
          login = 'logged_out';
          status = 'error';
          reason = 'No Gemini auth configured (run gemini once, or set GEMINI_API_KEY)';
          fix = { kind: 'login', command: 'gemini' };
        }
      }
    } else if (id === 'antigravity') {
      const batFile = path.win32.join(paths.antigravityDir, 'bin', 'agentapi.bat');
      installed = isFileSafe(batFile);
      const bridge = await getBridgeStatus(paths.bridgeFile);
      const isOnline = Boolean(bridge.online);

      if (isOnline) {
        login = 'ok';
        status = 'ok';
        reason = 'Antigravity IDE bridge online';
        const candidateModel = typeof bridge.model === 'string' ? bridge.model.trim() : null;
        if (candidateModel && !candidateModel.startsWith('hub-')) {
          model = candidateModel;
          modelSource = 'cli-config';
        } else {
          model = null;
          modelSource = 'unknown';
        }
      } else if (!installed) {
        login = 'n/a';
        status = 'error';
        reason = 'Antigravity IDE is not installed';
        fix = { kind: 'install', command: 'Install the Antigravity IDE' };
      } else {
        login = 'logged_out';
        status = 'error';
        reason = 'Antigravity IDE is not running';
        fix = { kind: 'start-ide', command: 'Start the Antigravity IDE' };
      }
    } else if (id === 'cursor') {
      const cursorTry = await runCliWithShimFallback(
        agent.detect?.command || 'cursor-agent',
        ['--version'],
        paths.userProfile,
        4000
      );
      version = extractSemver(cursorTry.stdout || cursorTry.stderr);
      installed = cursorTry.resolvedPath !== null || Boolean(version);

      if (!installed) {
        login = 'n/a';
        status = 'error';
        reason = 'Cursor Agent CLI is not installed';
        fix = { kind: 'install', command: "irm 'https://cursor.com/install?win32=true' | iex" };
      } else {
        const statusCmd = agent.status_cmd ?? ['cursor-agent', 'status'];
        const [bin, ...sArgs] = statusCmd;
        const probeRes = await runCliWithShimFallback(bin ?? 'cursor-agent', sArgs, paths.userProfile, 5000);
        const combined = `${probeRes.stdout}\n${probeRes.stderr}`.trim();
        if (probeRes.code === 0 && !/not (logged|signed) in/i.test(combined)) {
          login = 'ok';
          reason = 'Logged in to Cursor';
        } else {
          login = 'logged_out';
          status = 'error';
          reason = 'Not logged in to Cursor';
          fix = { kind: 'login', command: 'cursor-agent login' };
        }
      }
    } else if (id === 'aider') {
      const aiderTry = await runCliWithShimFallback('aider', ['--version'], paths.userProfile, 4000);
      version = extractSemver(aiderTry.stdout || aiderTry.stderr);
      installed = aiderTry.resolvedPath !== null || Boolean(version);

      if (!installed) {
        login = 'n/a';
        status = 'error';
        reason = 'Aider CLI is not installed';
        fix = { kind: 'install', command: 'python -m pip install aider-install; aider-install' };
      } else {
        const envKeys = [
          'ANTHROPIC_API_KEY',
          'OPENAI_API_KEY',
          'GEMINI_API_KEY',
          'DEEPSEEK_API_KEY',
          'OPENROUTER_API_KEY',
        ];
        const presentKey = envKeys.find((k) => Boolean(process.env[k]));
        if (presentKey) {
          login = 'ok';
          authMethod = presentKey;
          reason = `Aider key present (${presentKey})`;
        } else {
          login = 'unknown';
          status = 'warn';
          reason = 'No API key env vars detected (aider may use a config file)';
        }
      }
    } else {
      // Generic CLI agent
      const detectCmd = agent.detect?.command || agent.cli?.command || agent.id;
      const verArgs = agent.detect?.version_args ?? ['--version'];
      const tryRes = await runCliWithShimFallback(detectCmd, verArgs, paths.userProfile, 4000);
      version = extractSemver(tryRes.stdout || tryRes.stderr);
      installed = tryRes.resolvedPath !== null || Boolean(version);

      if (!installed) {
        login = 'n/a';
        status = 'error';
        reason = `${label} is not installed`;
        fix = { kind: 'install', command: `Install ${label}` };
      } else if (agent.status_cmd && agent.status_cmd.length > 0) {
        const [bin, ...sArgs] = agent.status_cmd;
        const probeRes = await runCliWithShimFallback(bin!, sArgs, paths.userProfile, 5000);
        const combined = `${probeRes.stdout}\n${probeRes.stderr}`.trim();
        if (probeRes.code === 0) {
          login = 'ok';
          reason = `${label} status ok`;
        } else if (/not (logged|signed) in|login required|unauthenticated|401/i.test(combined)) {
          login = 'logged_out';
          status = 'error';
          reason = `${label} authentication required`;
          if (agent.login_cmd && agent.login_cmd.length > 0) {
            fix = { kind: 'login', command: agent.login_cmd.join(' ') };
          }
        } else {
          login = 'unknown';
          status = 'warn';
          reason = redactSecrets(combined.slice(0, 100), paths.userProfile) || `${label} status unknown`;
        }
      } else {
        login = 'ok';
        reason = `${label} installed`;
      }
    }

    // Recent errors check from job logs (last 30 min)
    if (status !== 'error') {
      const recent = scanRecentJobErrors(paths.jobsDir, id);
      if (recent.hasError) {
        status = 'warn';
        const agoStr = recent.lastMinutesAgo ? ` ${recent.lastMinutesAgo} min ago` : '';
        if (recent.isRateLimited) {
          reason = `Rate-limited${agoStr}`;
        } else {
          reason = `Auth error seen in jobs${agoStr}`;
        }
      }
    }
  } catch (err) {
    status = 'error';
    reason = redactSecrets(String((err as Error)?.message ?? 'Probe failed'), paths.userProfile);
  }

  const durationMs = Date.now() - startMs;
  const result: HealthAgentResult = {
    id,
    label,
    platform,
    installed,
    version,
    login,
    auth_method: authMethod,
    quota,
    model,
    model_source: modelSource,
    status,
    reason: redactSecrets(reason, paths.userProfile),
    fix,
    checked_at: new Date().toISOString(),
    ms: durationMs,
  };

  return result;
}

export async function probeAllAgents(
  agents: AgentEntry[],
  paths: ServerPaths,
  options?: { bypassCache?: boolean }
): Promise<{
  agents: HealthAgentResult[];
  summary: { ok: number; warn: number; error: number };
  cached: boolean;
  ms: number;
}> {
  const startMs = Date.now();
  const now = Date.now();
  let allCached = !options?.bypassCache;
  const results: HealthAgentResult[] = [];

  const agentsToProbe: AgentEntry[] = [];
  for (const agent of agents) {
    if (!options?.bypassCache) {
      const cached = memoryCache.get(agent.id);
      if (cached && now < cached.expiresAt) {
        results.push(cached.result);
        continue;
      }
    }
    allCached = false;
    agentsToProbe.push(agent);
  }

  if (agentsToProbe.length > 0) {
    const probed = await Promise.all(agentsToProbe.map((a) => probeAgent(a, paths)));
    for (const res of probed) {
      memoryCache.set(res.id, {
        result: res,
        expiresAt: now + 60_000, // 60s cache
      });
      results.push(res);
    }
  }

  // Sort results by original agent order
  results.sort((a, b) => {
    const idxA = agents.findIndex((x) => x.id === a.id);
    const idxB = agents.findIndex((x) => x.id === b.id);
    return idxA - idxB;
  });

  // Persist cache to data/health/cache.json
  try {
    const dataDir = paths.featureDataDir('health');
    const cacheFile = path.win32.join(dataDir, 'cache.json');
    const cachePayload: HealthCacheData = {
      agents: {},
    };
    for (const [key, item] of memoryCache.entries()) {
      cachePayload.agents[key] = item.result;
    }
    const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(cachePayload, null, 2), 'utf8');
    fs.renameSync(tempFile, cacheFile);
  } catch {
    // Ignore cache persistence error
  }

  const summary = { ok: 0, warn: 0, error: 0 };
  for (const r of results) {
    summary[r.status]++;
  }

  return {
    agents: results,
    summary,
    cached: allCached,
    ms: Date.now() - startMs,
  };
}

export function readHealthCacheOnly(paths: ServerPaths): {
  summary: { ok: number; warn: number; error: number };
  checked_at: string | null;
  agents: Record<string, { status: string; login: string; reason: string }>;
} {
  const agentMap: Record<string, { status: string; login: string; reason: string }> = {};
  const summary = { ok: 0, warn: 0, error: 0 };
  let newestCheckedAt: string | null = null;

  // Use memory cache first, or read data/health/cache.json
  let sourceRecords: Record<string, HealthAgentResult> = {};
  for (const [key, item] of memoryCache.entries()) {
    sourceRecords[key] = item.result;
  }

  if (Object.keys(sourceRecords).length === 0) {
    try {
      const dataDir = paths.featureDataDir('health');
      const cacheFile = path.win32.join(dataDir, 'cache.json');
      if (isFileSafe(cacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as HealthCacheData;
        if (parsed?.agents) {
          sourceRecords = parsed.agents;
        }
      }
    } catch {
      // Ignore
    }
  }

  for (const [id, r] of Object.entries(sourceRecords)) {
    agentMap[id] = {
      status: r.status,
      login: r.login,
      reason: r.reason,
    };
    if (r.status in summary) {
      summary[r.status as 'ok' | 'warn' | 'error']++;
    }
    if (!newestCheckedAt || (r.checked_at && r.checked_at > newestCheckedAt)) {
      newestCheckedAt = r.checked_at;
    }
  }

  return {
    summary,
    checked_at: newestCheckedAt,
    agents: agentMap,
  };
}
