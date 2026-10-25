import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRun } from '../features/checkpoints/snapshot.ts';
import {
  extractProjectEnvSecrets,
  loadPolicyConfig,
  redactSecrets,
} from '../features/policy/lib/s4-core.ts';
import { prepareIsolatedJob } from '../features/worktrees/isolate.ts';
import {
  loadWorktreesStore,
  saveWorktreesStore,
  withStoreLock,
  type WorktreeRecord,
} from '../features/worktrees/store.ts';
import { buildCommandSpec, psq } from '../lib/commands.ts';
import type { MawFeatureContext } from '../lib/feature.ts';
import {
  isDirectorySafe,
  isFileSafe,
  isTestContext,
  trimIncompleteUtf8Tail,
  type ServerPaths,
} from '../lib/paths.ts';
import { isProcessRunning, runCommand } from '../lib/proc.ts';
import { loadAgentRegistry } from '../lib/registry.ts';
import { ApiValidationError, buildValidatedCommand } from '../lib/validate.ts';
import { detectRegistryAgents } from '../lib/versions.ts';

export interface JobWorktreeInfo {
  id: string;
  path: string;
  branch: string;
  port: number;
}

export interface JobSourceInfo {
  feature: string;
  task_id?: string;
  [k: string]: unknown;
}

export interface JobSessionRef {
  platform: string;
  id: string;
}

export interface JobMeta {
  job_id: string;
  pid: number;
  server_id?: string;
  projects_root?: string;
  mode: string;
  agent?: string;
  role: string;
  model?: string;
  effort?: string;
  new_session?: boolean;
  team?: Record<string, string>;
  reviewers?: string[];
  implementer?: string;
  project_path: string;
  isolated_from?: string;
  worktree?: JobWorktreeInfo | string;
  branch?: string;
  budget_usd?: number;
  max_rounds?: number;
  source?: JobSourceInfo;
  agent_profile_id?: string;
  conversation_id?: string;
  resume_token?: string;
  session_ref?: JobSessionRef | string;
  parent_job_id?: string;
  steer_strategy?: string;
  command: string;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED' | string;
  exit_code: number | null;
  started_at: string;
  started_ts: number;
  finished_at?: string;
}

export function extractSessionIdFromLogText(logContent: string): string | null {
  if (!logContent) return null;
  const agyMatches = Array.from(
    logContent.matchAll(/(?:CONVERSATION_ID|conversation):\s*([0-9a-f-]{36})/gi)
  );
  if (agyMatches.length > 0) {
    return agyMatches[agyMatches.length - 1]![1]!;
  }
  const sessMatch = /"session_id"\s*:\s*"([^"]+)"/i.exec(logContent);
  if (sessMatch) {
    return sessMatch[1]!;
  }
  const threadJsonMatch = /"thread_id"\s*:\s*"([^"]+)"/i.exec(logContent);
  if (threadJsonMatch) {
    return threadJsonMatch[1]!;
  }
  const codexSessMatch = /session id:\s*([0-9a-f-]{36})/i.exec(logContent);
  if (codexSessMatch) {
    return codexSessMatch[1]!;
  }
  const threadLineMatch = /(?:OpenAI Codex Thread:|Thread:)\s*([a-zA-Z0-9._-]+)/i.exec(logContent);
  if (threadLineMatch) {
    return threadLineMatch[1]!;
  }
  return null;
}

function populateSessionRefFromLog(meta: JobMeta, logFile: string): boolean {
  if (meta.session_ref) {
    return false;
  }
  const platform = String(meta.agent ?? meta.mode ?? '').toLowerCase();
  if (!platform) return false;

  let foundId: string | null = null;
  if (isFileSafe(logFile)) {
    try {
      const st = fs.statSync(logFile);
      const readLen = Math.min(st.size, 65536);
      if (readLen > 0) {
        const fd = fs.openSync(logFile, 'r');
        try {
          const buf = Buffer.alloc(readLen);
          const n = fs.readSync(fd, buf, 0, readLen, 0);
          foundId = extractSessionIdFromLogText(buf.subarray(0, n).toString('utf8'));
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      // Ignore read errors
    }
  }
  if (!foundId && meta.resume_token) {
    foundId = meta.resume_token;
  }
  if (foundId) {
    meta.session_ref = { platform, id: foundId };
    return true;
  }
  return false;
}

export function redactJobLogChunk(
  chunk: string,
  paths?: ServerPaths,
  projectPath?: string
): string {
  if (!chunk) return '';
  try {
    if (paths) {
      const policyDir = path.win32.join(paths.mawHome, 'data', 'policy');
      const policyCfg = loadPolicyConfig(policyDir).config;
      if (policyCfg.enabled && policyCfg.global.redact_secrets === false) {
        return chunk;
      }
      const extraSecrets =
        policyCfg.global.redact_env_files !== false && projectPath
          ? extractProjectEnvSecrets(projectPath)
          : [];
      return redactSecrets(chunk, extraSecrets, policyCfg.global.secret_patterns);
    }
  } catch {
    // Fall back to default built-in patterns
  }
  return redactSecrets(chunk);
}

function readLogTail(logFile: string, maxBytes = 1024): string {
  if (!isFileSafe(logFile)) {
    return '';
  }
  try {
    const st = fs.statSync(logFile);
    if (st.size <= 0) {
      return '';
    }
    const readLen = Math.min(st.size, maxBytes);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const n = fs.readSync(fd, buf, 0, readLen, st.size - readLen);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function parseTerminalMarker(
  tail: string
): { status: 'DONE' | 'FAILED' | 'CANCELLED'; exitCode: number | null } | null {
  if (tail.includes('=== [JOB_CANCELLED_BY_USER] ===')) {
    return {
      status: 'CANCELLED',
      exitCode: null,
    };
  }
  const finMatch = /===\s*\[JOB_FINISHED\s+exit_code=(-?\d+)\]\s*===/.exec(tail);
  if (finMatch) {
    const code = Number.parseInt(finMatch[1]!, 10);
    return {
      status: code === 0 ? 'DONE' : 'FAILED',
      exitCode: code,
    };
  }
  return null;
}

export async function refreshJobMetaStatus(
  meta: JobMeta,
  jobsDir: string,
  options?: { checkPid?: boolean }
): Promise<JobMeta> {
  const jobId = String(meta.job_id ?? '');
  const logFile = path.win32.join(jobsDir, `${jobId}.log`);
  const metaFile = path.win32.join(jobsDir, `${jobId}.json`);

  if (meta.status !== 'RUNNING') {
    if (meta.exit_code === undefined) {
      meta.exit_code = null;
    }
    if (populateSessionRefFromLog(meta, logFile)) {
      try {
        fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
      } catch {}
    }
    return meta;
  }

  const pid = Math.trunc(Number(meta.pid ?? 0) || 0);

  const tail = readLogTail(logFile, 1024);
  const marker = parseTerminalMarker(tail);
  if (marker) {
    meta.status = marker.status;
    meta.exit_code = marker.status === 'CANCELLED' ? (meta.exit_code ?? null) : marker.exitCode;
    meta.finished_at = new Date().toISOString();
    populateSessionRefFromLog(meta, logFile);
    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    } catch {
      // Ignore write error
    }
    return meta;
  }

  if (populateSessionRefFromLog(meta, logFile)) {
    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    } catch {}
  }

  if (options?.checkPid === false) {
    meta.exit_code = meta.exit_code ?? null;
    return meta;
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // R5: If PID capture failed (pid <= 0), keep RUNNING while the log was modified in the last 60s
  if (pid <= 0) {
    let lastMod = 0;
    if (isFileSafe(logFile)) {
      try {
        lastMod = Math.floor(fs.statSync(logFile).mtimeMs / 1000);
      } catch {
        lastMod = 0;
      }
    }
    if (lastMod <= 0) {
      lastMod = Math.trunc(Number(meta.started_ts ?? 0) || 0);
    }
    if (lastMod > 0 && nowSec - lastMod < 60) {
      meta.exit_code = meta.exit_code ?? null;
      return meta;
    }
    meta.status = 'FAILED';
    meta.exit_code = null;
    meta.finished_at = new Date().toISOString();
    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    } catch {
      // Ignore write error
    }
    return meta;
  }

  // Check if PID is still running via process.kill(pid, 0) (M3: zero child processes)
  const alive = isProcessRunning(pid);
  if (!alive) {
    // Re-read tail once in case the process wrote JOB_FINISHED right as it exited
    const tailAfterExit = readLogTail(logFile, 1024);
    const markerAfterExit = parseTerminalMarker(tailAfterExit);
    if (markerAfterExit) {
      meta.status = markerAfterExit.status;
      meta.exit_code =
        markerAfterExit.status === 'CANCELLED'
          ? (meta.exit_code ?? null)
          : markerAfterExit.exitCode;
    } else {
      meta.status = 'FAILED';
      meta.exit_code = null;
    }
    meta.finished_at = new Date().toISOString();
    populateSessionRefFromLog(meta, logFile);
    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    } catch {
      // Ignore write error
    }
    return meta;
  }

  meta.exit_code = meta.exit_code ?? null;
  return meta;
}

/**
 * SPEC §3.6: On server startup, reconcile any metas still marked RUNNING whose PID no longer exists.
 */
export async function reconcileJobsOnStartup(jobsDir: string): Promise<void> {
  if (!isDirectorySafe(jobsDir)) {
    return;
  }
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(jobsDir)
      .filter((n) => n.startsWith('job_') && n.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of names) {
    const metaPath = path.win32.join(jobsDir, name);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as JobMeta;
      if (meta && meta.status === 'RUNNING') {
        await refreshJobMetaStatus(meta, jobsDir);
      }
    } catch {
      // Ignore unreadable job meta
    }
  }
}

export async function getRecentJobs(
  jobsDir: string,
  limit = 8
): Promise<Array<Record<string, unknown>>> {
  if (!isDirectorySafe(jobsDir)) {
    return [];
  }
  const entries: Array<{ file: string; mtime: number }> = [];
  try {
    for (const name of fs.readdirSync(jobsDir)) {
      if (!name.startsWith('job_') || !name.endsWith('.json')) continue;
      const full = path.win32.join(jobsDir, name);
      try {
        entries.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      } catch {
        // Ignore stat error
      }
    }
  } catch {
    return [];
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  const cappedLimit = Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 8)));
  const jobs: Array<Record<string, unknown>> = [];

  for (const item of entries.slice(0, cappedLimit)) {
    let meta: JobMeta;
    try {
      meta = JSON.parse(fs.readFileSync(item.file, 'utf8')) as JobMeta;
      if (!meta || typeof meta !== 'object') continue;
    } catch {
      continue;
    }
    meta = await refreshJobMetaStatus(meta, jobsDir);
    const row: Record<string, unknown> = {
      job_id: meta.job_id ?? '',
      mode: meta.mode ?? '',
      agent: meta.agent ?? meta.mode ?? '',
      role: meta.role ?? '',
      project_path: meta.project_path ?? '',
      project_name: path.basename(String(meta.project_path ?? '')),
      status: meta.status ?? 'UNKNOWN',
      exit_code: meta.exit_code ?? null,
      started_at: meta.started_at ?? '',
      pid: meta.pid ?? null,
    };
    if (meta.team && typeof meta.team === 'object' && !Array.isArray(meta.team)) {
      row.team = meta.team;
    }
    if (Array.isArray(meta.reviewers) && meta.reviewers.length > 0) {
      row.reviewers = meta.reviewers;
    }
    if (typeof meta.implementer === 'string' && meta.implementer !== '') {
      row.implementer = meta.implementer;
    }
    if (meta.worktree !== undefined) {
      row.worktree = meta.worktree;
    }
    if (meta.isolated_from !== undefined) {
      row.isolated_from = meta.isolated_from;
    }
    if (meta.session_ref !== undefined) {
      row.session_ref = meta.session_ref;
    }
    if (meta.source !== undefined) {
      row.source = meta.source;
    }
    jobs.push(row);
  }

  return jobs;
}

function formatJobTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function formatHumanDateTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export interface LaunchJobOptions {
  meta: Partial<JobMeta> & { project_path: string; mode?: string; role?: string };
  commandLine:
    | string
    | ((ctx: { jobId: string; promptFile: string; logFile: string; runnerFile: string }) => string);
  prompt: string;
  paths?: ServerPaths;
  jobsDir?: string;
  scriptsDir?: string;
  notifyCfgFile?: string;
  headerExtraLines?: string[];
  env?: Record<string, string>;
  cliArgs?: string[];
  worktreePort?: number;
  customLauncher?: (runnerFile: string) => Promise<number>;
}

export async function launchJob(options: LaunchJobOptions): Promise<{
  job_id: string;
  pid: number;
  command: string;
  meta: JobMeta;
}> {
  const paths = options.paths;
  const jobsDir = options.jobsDir ?? paths?.jobsDir;
  if (!jobsDir) {
    throw new Error('launchJob requires paths or jobsDir.');
  }
  if (!isDirectorySafe(jobsDir)) {
    fs.mkdirSync(jobsDir, { recursive: true });
  }

  const scriptsDir = options.scriptsDir ?? paths?.scriptsDir ?? '';
  const notifyCfgFile = options.notifyCfgFile ?? paths?.notifyCfgFile ?? '';
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const jobId =
    options.meta.job_id ||
    `job_${formatJobTimestamp(now)}_${crypto.randomBytes(3).toString('hex')}`;

  const promptFile = path.win32.join(jobsDir, `${jobId}.prompt.txt`);
  const logFile = path.win32.join(jobsDir, `${jobId}.log`);
  const runnerFile = path.win32.join(jobsDir, `${jobId}.runner.ps1`);
  const metaFile = path.win32.join(jobsDir, `${jobId}.json`);

  const mode = String(options.meta.mode ?? 'task');
  const agent = String(options.meta.agent ?? mode);
  const role = String(options.meta.role ?? 'backend');
  const projectPath = String(options.meta.project_path);

  const redactedPromptForLog = options.prompt ?? '';
  fs.writeFileSync(promptFile, '\uFEFF' + redactedPromptForLog, 'utf8');

  const extraLines =
    options.headerExtraLines && options.headerExtraLines.length > 0
      ? options.headerExtraLines.join('\n') + '\n'
      : '';
  const headerLine =
    `=== [MISSION CONTROL JOB ${jobId}] ===\n` +
    `Mode: ${mode.toUpperCase()} | Agent: ${agent} | Role: ${role} | Project: ${projectPath}\n` +
    extraLines +
    `Started: ${formatHumanDateTime(now)}\n` +
    `------------------------------------------------------------\n`;
  fs.writeFileSync(logFile, '\uFEFF' + headerLine, 'utf8');

  const resolvedCommandLine =
    typeof options.commandLine === 'function'
      ? options.commandLine({ jobId, promptFile, logFile, runnerFile })
      : options.commandLine;

  const notifyScript = scriptsDir ? path.win32.join(scriptsDir, 'send-notification.ps1') : '';
  const hooksLib = scriptsDir ? path.win32.join(scriptsDir, 'lib', 'maw-hooks.ps1') : '';
  const projShort = path.basename(projectPath);
  const portValue = String(options.worktreePort ?? process.env.MAW_PORT ?? '4317');

  const envExportLines: string[] = [
    `$env:MAW_JOB_ID = ${psq(jobId)}`,
    `$env:MAW_PROJECT = ${psq(projectPath)}`,
    `$env:MAW_PORT = ${psq(portValue)}`,
    `$env:MAW_JOBS_DIR = ${psq(jobsDir)}`,
  ];
  if (paths) {
    envExportLines.push(
      `$env:USERPROFILE = ${psq(paths.userProfile)}`,
      `$env:MAW_HOME = ${psq(paths.mawHome)}`,
      `$env:TEMP = ${psq(paths.tempDir)}`,
      `$env:TMP = ${psq(paths.tempDir)}`,
      `$env:MAW_SCRIPTS_DIR = ${psq(paths.scriptsDir)}`
    );
  }
  if (isTestContext()) {
    envExportLines.push(`$env:MAW_TEST = '1'`);
  }
  if (mode === 'task' || mode === 'chat' || mode === 'team' || mode === 'steer') {
    envExportLines.push(`$env:MAW_PERSIST_SESSION = '1'`);
  }
  if (options.meta.budget_usd !== undefined) {
    envExportLines.push(`$env:MAW_BUDGET_USD = ${psq(String(options.meta.budget_usd))}`);
  }
  if (options.meta.max_rounds !== undefined) {
    envExportLines.push(`$env:MAW_MAX_ROUNDS = ${psq(String(options.meta.max_rounds))}`);
  }
  if (options.cliArgs && options.cliArgs.length > 0) {
    envExportLines.push(`$env:MAW_EXTRA_CLI_ARGS = ${psq(JSON.stringify(options.cliArgs))}`);
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) {
        envExportLines.push(`$env:${k} = ${psq(String(v ?? ''))}`);
      }
    }
  }

  const runnerCode =
    `$ErrorActionPreference = 'Continue'\n` +
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n` +
    `$OutputEncoding = New-Object System.Text.UTF8Encoding $false\n` +
    envExportLines.join('\n') +
    `\n` +
    `function Redact-MawLine([string]$s) {\n` +
    `    if (-not $s) { return '' }\n` +
    `    $o = $s -replace '(?<=^|[^a-zA-Z0-9_\\-])sk-ant-[A-Za-z0-9_\\-]{20,}', '[REDACTED:anthropic]'\n` +
    `    $o = $o -replace '(?<=^|[^a-zA-Z0-9_\\-])sk-(?:proj-)?[A-Za-z0-9_\\-]{20,}', '[REDACTED:openai]'\n` +
    `    $o = $o -replace '(?<=^|[^a-zA-Z0-9_\\-])github_pat_[A-Za-z0-9_]{50,}', '[REDACTED:github]'\n` +
    `    $o = $o -replace '(?<=^|[^a-zA-Z0-9_\\-])gh[pousr]_[A-Za-z0-9]{36,}', '[REDACTED:github]'\n` +
    `    $o = $o -replace '\\bAKIA[0-9A-Z]{16}\\b', '[REDACTED:aws]'\n` +
    `    $o = $o -replace '(?<=^|[^a-zA-Z0-9_\\-])AIza[0-9A-Za-z_\\-]{35}', '[REDACTED:google]'\n` +
    `    $o = $o -replace '(?<=^|[^a-zA-Z0-9_\\-])xox[baprs]-[A-Za-z0-9-]{10,}', '[REDACTED:slack]'\n` +
    `    $o = $o -replace '\\b\\d{8,10}:[A-Za-z0-9_\\-]{35}\\b', '[REDACTED:telegram]'\n` +
    `    $o = $o -replace '(?<=^|[^a-zA-Z0-9_\\-])eyJ[A-Za-z0-9_\\-]+\\.eyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+', '[REDACTED:jwt]'\n` +
    `    $o = [regex]::Replace($o, '(["'']?(?:api[_-]?key|secret|token|password|passwd)["'']?\\s*[:=]\\s*["'']?)(?!\\[REDACTED:)([^\\s"'']{8,})(["'']?)', '$1[REDACTED:assignment]$3', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)\n` +
    `    return $o\n` +
    `}\n` +
    `$logPath = ${psq(logFile)}\n` +
    (hooksLib
      ? `if (Test-Path -LiteralPath ${psq(hooksLib)}) {\n    try { . ${psq(hooksLib)} } catch {}\n}\n`
      : '') +
    `$code = 0\n` +
    `$hookBlocked = $false\n` +
    `if (Get-Command Invoke-MawHooks -ErrorAction SilentlyContinue) {\n` +
    `    try {\n` +
    `        $startRes = @(Invoke-MawHooks -Event 'job-start' -Context @{ job_id = ${psq(jobId)}; mode = ${psq(mode)}; agent = ${psq(agent)}; role = ${psq(role)}; project = ${psq(projectPath)}; exit_code = $null })\n` +
    `        foreach ($item in $startRes) {\n` +
    `            if ($item -is [string] -and $item.Trim()) {\n` +
    `                [System.IO.File]::AppendAllText($logPath, (Redact-MawLine $item) + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `            } elseif ($null -ne $item -and $item.Block) {\n` +
    `                $hookBlocked = $true\n` +
    `                [System.IO.File]::AppendAllText($logPath, "[HOOK BLOCKED: job-start] " + (Redact-MawLine ([string]$item.Reason)) + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `                $code = 4\n` +
    `            }\n` +
    `        }\n` +
    `    } catch {}\n` +
    `}\n` +
    `if (-not $hookBlocked) {\n` +
    `    try {\n` +
    `        ${resolvedCommandLine} *>&1 | ForEach-Object {\n` +
    `            $line = Redact-MawLine ($_.ToString())\n` +
    `            [System.IO.File]::AppendAllText($logPath, $line + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `        }\n` +
    `        $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }\n` +
    `    } catch {\n` +
    `        [System.IO.File]::AppendAllText($logPath, "[ERROR] " + (Redact-MawLine $_.Exception.Message) + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `        $code = 1\n` +
    `    }\n` +
    `}\n` +
    `if (Get-Command Invoke-MawHooks -ErrorAction SilentlyContinue) {\n` +
    `    try {\n` +
    `        $finRes = @(Invoke-MawHooks -Event 'job-finish' -Context @{ job_id = ${psq(jobId)}; mode = ${psq(mode)}; agent = ${psq(agent)}; role = ${psq(role)}; project = ${psq(projectPath)}; exit_code = $code })\n` +
    `        foreach ($item in $finRes) {\n` +
    `            if ($item -is [string] -and $item.Trim()) {\n` +
    `                [System.IO.File]::AppendAllText($logPath, (Redact-MawLine $item) + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `            }\n` +
    `        }\n` +
    `    } catch {}\n` +
    `}\n` +
    `[System.IO.File]::AppendAllText($logPath, "\`r\`n=== [JOB_FINISHED exit_code=$code] ===\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    (notifyScript
      ? `if (Test-Path -LiteralPath ${psq(notifyScript)}) {\n` +
        `    $finalStatus = if ($code -eq 0) { 'DONE' } else { 'FAILED' }\n` +
        `    try {\n` +
        `        & ${psq(notifyScript)} -JobId ${psq(jobId)} -Status $finalStatus -Mode ${psq(mode)} -Role ${psq(role)} -Project ${psq(projShort)} -ExitCode $code -ConfigFile ${psq(notifyCfgFile)} *>$null\n` +
        `    } catch {}\n` +
        `}\n`
      : '') +
    `exit $code\n`;

  fs.writeFileSync(runnerFile, '\uFEFF' + runnerCode, 'utf8');

  let pid = 0;
  if (options.customLauncher) {
    pid = await options.customLauncher(runnerFile);
  } else {
    const launchScript =
      `$r = ${psq(runnerFile)}; ` +
      `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $r)) -WindowStyle Hidden -PassThru; ` +
      `if ($p) { [Console]::Out.WriteLine($p.Id) }`;
    const encodedLaunch = Buffer.from(launchScript, 'utf16le').toString('base64');

    const launchRes = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedLaunch],
      { timeoutMs: 10000 }
    );
    const pidMatch = /(\d+)/.exec(launchRes.stdout.trim());
    if (pidMatch) {
      pid = Number.parseInt(pidMatch[1]!, 10) || 0;
    }
  }

  const serverId = `${process.pid}@${process.env.MAW_PORT || '4317'}`;
  const fullMeta: JobMeta = {
    ...options.meta,
    job_id: jobId,
    pid,
    server_id: options.meta.server_id ?? serverId,
    projects_root: options.meta.projects_root ?? paths?.projectsRoot,
    mode,
    agent,
    role,
    project_path: projectPath,
    command: resolvedCommandLine,
    status: 'RUNNING',
    exit_code: null,
    started_at: now.toISOString(),
    started_ts: nowSec,
  };

  fs.writeFileSync(metaFile, JSON.stringify(fullMeta), 'utf8');

  return {
    job_id: jobId,
    pid,
    command: resolvedCommandLine,
    meta: fullMeta,
  };
}

export async function handleRunJob(
  body: Record<string, unknown>,
  paths: ServerPaths
): Promise<Record<string, unknown>> {
  const info = buildValidatedCommand(body, paths);
  const {
    mode,
    agent,
    role,
    model: modelOverride,
    effort: effortOverride,
    new_session: newSession,
    team: teamArray,
    project_path: validatedProjectPath,
    prompt,
  } = info;

  const registry = loadAgentRegistry(paths);
  const effectiveReviewers =
    mode === 'council' || mode === 'auto-gate'
      ? info.reviewers && info.reviewers.length > 0
        ? info.reviewers
        : registry.defaults.council
      : undefined;
  const effectiveImplementer =
    mode === 'auto-gate'
      ? info.implementer && info.implementer !== ''
        ? info.implementer
        : registry.defaults.implementer
      : undefined;

  const requiredAgentIds: string[] = [];
  if (mode === 'task' || mode === 'chat') {
    requiredAgentIds.push(agent);
  } else if (mode === 'team') {
    requiredAgentIds.push(agent);
    if (teamArray) {
      for (const v of Object.values(teamArray)) {
        if (!requiredAgentIds.includes(v)) {
          requiredAgentIds.push(v);
        }
      }
    }
  } else if (mode === 'claude' || mode === 'codex' || mode === 'antigravity') {
    requiredAgentIds.push(mode);
  } else if (mode === 'council' && effectiveReviewers) {
    for (const r of effectiveReviewers) {
      if (!requiredAgentIds.includes(r)) {
        requiredAgentIds.push(r);
      }
    }
  } else if (mode === 'auto-gate') {
    if (role !== 'review-only' && effectiveImplementer) {
      requiredAgentIds.push(effectiveImplementer);
    }
    if (effectiveReviewers) {
      for (const r of effectiveReviewers) {
        if (!requiredAgentIds.includes(r)) {
          requiredAgentIds.push(r);
        }
      }
    }
  }

  if (requiredAgentIds.length > 0) {
    const requiredEntries = requiredAgentIds
      .map((id) => registry.agents.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined);
    const detectedMap = await detectRegistryAgents(paths, requiredEntries);
    for (const entry of requiredEntries) {
      const det = detectedMap.get(entry.id);
      if (!det || !det.installed) {
        throw new ApiValidationError(`${entry.label} is not installed.`, 400);
      }
    }
  }

  const jobsDir = paths.jobsDir;
  if (!isDirectorySafe(jobsDir)) {
    fs.mkdirSync(jobsDir, { recursive: true });
  }

  // Cleanup old completed job files (> 7200s old)
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const allFiles = fs.readdirSync(jobsDir);
    const metaNames = allFiles.filter((n) => n.startsWith('job_') && n.endsWith('.json'));
    for (const metaName of metaNames) {
      const jid = metaName.slice(0, -5);
      const metaPath = path.win32.join(jobsDir, metaName);
      try {
        const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as JobMeta;
        if (metaData && metaData.status === 'RUNNING') {
          const mPid = Math.trunc(Number(metaData.pid ?? 0) || 0);
          if (mPid > 0 && isProcessRunning(mPid)) {
            continue;
          }
          if (mPid <= 0 && nowSec - Math.trunc(Number(metaData.started_ts ?? 0) || 0) < 60) {
            continue;
          }
        }
      } catch {
        // Proceed with age check
      }

      const related = allFiles.filter((n) => n.startsWith(`${jid}.`));
      let newestMtimeSec = 0;
      for (const rf of related) {
        try {
          const mt = Math.floor(fs.statSync(path.win32.join(jobsDir, rf)).mtimeMs / 1000);
          if (mt > newestMtimeSec) newestMtimeSec = mt;
        } catch {
          // Ignore stat error
        }
      }
      if (newestMtimeSec > 0 && nowSec - newestMtimeSec > 7200) {
        for (const rf of related) {
          try {
            fs.unlinkSync(path.win32.join(jobsDir, rf));
          } catch {
            // Ignore unlink error
          }
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  // C9: Handle isolate: true through S1's prepareIsolatedJob
  let isolatedWorktree: WorktreeRecord | null = null;
  let effectiveProjectPath = validatedProjectPath;
  if (body.isolate === true) {
    const wtCtx: MawFeatureContext = {
      paths,
      registry,
      readJobs: (opts?: { limit?: number }) => getRecentJobs(paths.jobsDir, opts?.limit ?? 8),
      startJob: (b: Record<string, unknown>) => handleRunJob(b, paths),
    };
    isolatedWorktree = await prepareIsolatedJob(wtCtx, {
      ...body,
      project_path: validatedProjectPath,
    });
    effectiveProjectPath = isolatedWorktree.worktree_path;
    info.project_path = effectiveProjectPath;
  }

  const metaDraft: Partial<JobMeta> & { project_path: string } = {
    mode,
    agent,
    role,
    model: modelOverride,
    effort: effortOverride,
    new_session: newSession,
    project_path: effectiveProjectPath,
  };
  if (teamArray) {
    metaDraft.team = teamArray;
  }
  if (effectiveReviewers) {
    metaDraft.reviewers = effectiveReviewers;
  }
  if (effectiveImplementer) {
    metaDraft.implementer = effectiveImplementer;
  }
  if (isolatedWorktree) {
    metaDraft.isolated_from = validatedProjectPath;
    metaDraft.worktree = {
      id: isolatedWorktree.id,
      path: isolatedWorktree.worktree_path,
      branch: isolatedWorktree.branch,
      port: isolatedWorktree.port,
    };
    metaDraft.branch = isolatedWorktree.branch;
  }
  if (
    typeof body.budget_usd === 'number' &&
    Number.isFinite(body.budget_usd) &&
    body.budget_usd >= 0
  ) {
    metaDraft.budget_usd = body.budget_usd;
  }
  if (
    typeof body.max_rounds === 'number' &&
    Number.isInteger(body.max_rounds) &&
    body.max_rounds >= 1
  ) {
    metaDraft.max_rounds = body.max_rounds;
  }
  if (body.source && typeof body.source === 'object' && !Array.isArray(body.source)) {
    const srcObj = body.source as Record<string, unknown>;
    metaDraft.source = {
      ...srcObj,
      feature: String(srcObj.feature ?? ''),
      ...(srcObj.task_id !== undefined ? { task_id: String(srcObj.task_id) } : {}),
    };
  }
  if (info.agent_profile_id) {
    metaDraft.agent_profile_id = info.agent_profile_id;
  }
  if (info.conversation_id) {
    metaDraft.conversation_id = info.conversation_id;
  }
  if (info.resume_token) {
    metaDraft.resume_token = info.resume_token;
    metaDraft.session_ref = { platform: agent || mode, id: info.resume_token };
  }

  let launched: { job_id: string; pid: number; command: string; meta: JobMeta };
  try {
    launched = await launchJob({
      meta: metaDraft,
      commandLine: ({ promptFile }) => buildCommandSpec(info, paths.scriptsDir, promptFile).preview,
      prompt,
      paths,
      env: info.env,
      cliArgs: info.cli_args,
      worktreePort: isolatedWorktree?.port,
    });
  } catch (err) {
    if (isolatedWorktree) {
      await gitRun(['worktree', 'remove', '--force', isolatedWorktree.worktree_path], {
        cwd: isolatedWorktree.project_path,
        allowFailure: true,
      });
      await gitRun(['branch', '-D', isolatedWorktree.branch], {
        cwd: isolatedWorktree.project_path,
        allowFailure: true,
      });
      const wtDataDir = paths.featureDataDir('worktrees');
      await withStoreLock(async () => {
        const store = await loadWorktreesStore(wtDataDir);
        store.worktrees = store.worktrees.filter((w) => w.id !== isolatedWorktree!.id);
        await saveWorktreesStore(wtDataDir, store);
      });
    }
    throw err;
  }

  if (isolatedWorktree && launched.job_id) {
    const wtDataDir = paths.featureDataDir('worktrees');
    await withStoreLock(async () => {
      const store = await loadWorktreesStore(wtDataDir);
      const rec = store.worktrees.find((w) => w.id === isolatedWorktree!.id);
      if (rec) {
        rec.job_id = launched.job_id;
        rec.updated_at = new Date().toISOString();
        await saveWorktreesStore(wtDataDir, store);
      }
    });
  }

  const runResp: Record<string, unknown> = {
    ok: true,
    job_id: launched.job_id,
    pid: launched.pid,
    mode,
    agent,
    role,
    status: 'RUNNING',
    command: launched.command,
  };
  if (teamArray) {
    runResp.team = teamArray;
  }
  if (effectiveReviewers) {
    runResp.reviewers = effectiveReviewers;
  }
  if (effectiveImplementer) {
    runResp.implementer = effectiveImplementer;
  }
  if (metaDraft.worktree) {
    runResp.worktree = metaDraft.worktree;
    runResp.isolated_from = metaDraft.isolated_from;
  }
  return runResp;
}

export function readSafeLogSlice(
  logFile: string,
  offset: number,
  maxBytes = 131072
): { chunk: string; nextOffset: number; fullSize: number } {
  if (!isFileSafe(logFile)) {
    return { chunk: '', nextOffset: offset, fullSize: 0 };
  }
  let fullSize = 0;
  try {
    fullSize = fs.statSync(logFile).size;
  } catch {
    return { chunk: '', nextOffset: offset, fullSize: 0 };
  }
  if (fullSize <= offset) {
    return { chunk: '', nextOffset: offset, fullSize };
  }

  const readBytes = Math.min(fullSize - offset, maxBytes);
  const fd = fs.openSync(logFile, 'r');
  let rawBuf: Buffer;
  try {
    const buf = Buffer.alloc(readBytes);
    const bytesRead = fs.readSync(fd, buf, 0, readBytes, offset);
    rawBuf = buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }

  const safeBuf = trimIncompleteUtf8Tail(rawBuf);
  const nextOffset = offset + safeBuf.length;
  let text = safeBuf.toString('utf8');
  if (offset === 0) {
    text = text.replace(/^\uFEFF/, '');
  }
  return {
    chunk: text,
    nextOffset,
    fullSize,
  };
}

export async function handleJobStatus(
  url: URL,
  paths: ServerPaths
): Promise<Record<string, unknown>> {
  const rawJobId = String(url.searchParams.get('job_id') ?? '');
  const jobId = rawJobId.replace(/[^a-zA-Z0-9_]/g, '');
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset') ?? 0) || 0));

  if (jobId === '' || !jobId.startsWith('job_')) {
    throw new ApiValidationError('Invalid job_id.', 400);
  }

  const metaFile = path.win32.join(paths.jobsDir, `${jobId}.json`);
  const logFile = path.win32.join(paths.jobsDir, `${jobId}.log`);
  if (!isFileSafe(metaFile)) {
    throw new ApiValidationError(`Job not found: ${jobId}`, 404);
  }

  let meta: JobMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
  } catch {
    throw new ApiValidationError(`Job not found: ${jobId}`, 404);
  }
  meta = await refreshJobMetaStatus(meta, paths.jobsDir);

  const { chunk, nextOffset, fullSize } = readSafeLogSlice(logFile, offset, 131072);
  const redactedChunk = redactJobLogChunk(chunk, paths, meta.project_path);
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(0, nowSec - Math.trunc(Number(meta.started_ts ?? nowSec) || nowSec));

  const statusResp: Record<string, unknown> = {
    ok: true,
    job_id: jobId,
    status: meta.status ?? 'UNKNOWN',
    exit_code: meta.exit_code ?? null,
    pid: meta.pid ?? 0,
    mode: meta.mode ?? '',
    agent: meta.agent ?? meta.mode ?? '',
    role: meta.role ?? '',
    project_path: meta.project_path ?? '',
    elapsed_sec: elapsed,
    log_chunk: redactedChunk,
    next_offset: nextOffset,
    full_log_size: fullSize,
  };
  if (meta.team && typeof meta.team === 'object' && !Array.isArray(meta.team)) {
    statusResp.team = meta.team;
  }
  if (Array.isArray(meta.reviewers) && meta.reviewers.length > 0) {
    statusResp.reviewers = meta.reviewers;
  }
  if (typeof meta.implementer === 'string' && meta.implementer !== '') {
    statusResp.implementer = meta.implementer;
  }
  if (meta.worktree !== undefined) {
    statusResp.worktree = meta.worktree;
  }
  if (meta.isolated_from !== undefined) {
    statusResp.isolated_from = meta.isolated_from;
  }
  if (meta.session_ref !== undefined) {
    statusResp.session_ref = meta.session_ref;
  }
  return statusResp;
}

export async function handleCancelJob(
  body: Record<string, unknown>,
  paths: ServerPaths
): Promise<Record<string, unknown>> {
  const rawJobId = String(body.job_id ?? '');
  const jobId = rawJobId.replace(/[^a-zA-Z0-9_]/g, '');
  if (jobId === '' || !jobId.startsWith('job_')) {
    throw new ApiValidationError('Invalid job_id.', 400);
  }

  const metaFile = path.win32.join(paths.jobsDir, `${jobId}.json`);
  const logFile = path.win32.join(paths.jobsDir, `${jobId}.log`);
  if (!isFileSafe(metaFile)) {
    throw new ApiValidationError('Job not found.', 404);
  }

  let meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
  meta = await refreshJobMetaStatus(meta, paths.jobsDir);

  if (meta.status !== 'RUNNING') {
    const err = new ApiValidationError('Job is not running.', 409);
    (err as unknown as Record<string, unknown>).status = meta.status ?? 'UNKNOWN';
    throw err;
  }

  const pid = Math.trunc(Number(meta.pid ?? 0) || 0);
  if (pid > 0) {
    await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 });
  }

  if (isFileSafe(logFile)) {
    try {
      fs.appendFileSync(logFile, '\r\n=== [JOB_CANCELLED_BY_USER] ===\r\n', 'utf8');
    } catch {
      // Ignore append error
    }
  }

  meta.status = 'CANCELLED';
  meta.exit_code = null;
  meta.finished_at = new Date().toISOString();
  fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');

  return {
    ok: true,
    job_id: jobId,
    status: 'CANCELLED',
  };
}
