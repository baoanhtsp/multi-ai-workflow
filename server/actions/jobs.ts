import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildCommandSpec, psq } from '../lib/commands.ts';
import {
  isDirectorySafe,
  isFileSafe,
  trimIncompleteUtf8Tail,
  type ServerPaths,
} from '../lib/paths.ts';
import { isProcessRunning, runCommand } from '../lib/proc.ts';
import { ApiValidationError, buildValidatedCommand } from '../lib/validate.ts';

export interface JobMeta {
  job_id: string;
  pid: number;
  mode: string;
  agent?: string;
  role: string;
  model?: string;
  effort?: string;
  new_session?: boolean;
  team?: Record<string, string>;
  project_path: string;
  command: string;
  status: 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED' | string;
  exit_code: number | null;
  started_at: string;
  started_ts: number;
  finished_at?: string;
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
  if (meta.status !== 'RUNNING') {
    if (meta.exit_code === undefined) {
      meta.exit_code = null;
    }
    return meta;
  }

  const jobId = String(meta.job_id ?? '');
  const logFile = path.win32.join(jobsDir, `${jobId}.log`);
  const metaFile = path.win32.join(jobsDir, `${jobId}.json`);
  const pid = Math.trunc(Number(meta.pid ?? 0) || 0);

  const tail = readLogTail(logFile, 1024);
  const marker = parseTerminalMarker(tail);
  if (marker) {
    meta.status = marker.status;
    meta.exit_code = marker.status === 'CANCELLED' ? (meta.exit_code ?? null) : marker.exitCode;
    meta.finished_at = new Date().toISOString();
    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    } catch {
      // Ignore write error
    }
    return meta;
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

export async function getRecentJobs(jobsDir: string): Promise<Array<Record<string, unknown>>> {
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
  const jobs: Array<Record<string, unknown>> = [];

  for (const item of entries.slice(0, 8)) {
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
      project_name: path.basename(String(meta.project_path ?? '')),
      status: meta.status ?? 'UNKNOWN',
      exit_code: meta.exit_code ?? null,
      started_at: meta.started_at ?? '',
      pid: meta.pid ?? null,
    };
    if (meta.team && typeof meta.team === 'object' && !Array.isArray(meta.team)) {
      row.team = meta.team;
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
    command: cmd,
  } = info;

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

  const now = new Date();
  const jobId = `job_${formatJobTimestamp(now)}_${crypto.randomBytes(3).toString('hex')}`;
  const promptFile = path.win32.join(jobsDir, `${jobId}.prompt.txt`);
  const logFile = path.win32.join(jobsDir, `${jobId}.log`);
  const runnerFile = path.win32.join(jobsDir, `${jobId}.runner.ps1`);
  const metaFile = path.win32.join(jobsDir, `${jobId}.json`);

  fs.writeFileSync(promptFile, '\uFEFF' + prompt, 'utf8');
  const headerLine =
    `=== [MISSION CONTROL JOB ${jobId}] ===\n` +
    `Mode: ${mode.toUpperCase()} | Agent: ${agent} | Role: ${role} | Project: ${validatedProjectPath}\n` +
    `Started: ${formatHumanDateTime(now)}\n` +
    `------------------------------------------------------------\n`;
  fs.writeFileSync(logFile, '\uFEFF' + headerLine, 'utf8');

  const spec = buildCommandSpec(info, paths.scriptsDir, promptFile);
  const notifyScript = path.win32.join(paths.scriptsDir, 'send-notification.ps1');
  const projShort = path.basename(validatedProjectPath);

  // C1 + C2 fix: Write self-contained PowerShell runner script that streams output to logFile,
  // records the real $LASTEXITCODE in JOB_FINISHED, and triggers send-notification.ps1 independently of Node.
  const runnerCode =
    `$ErrorActionPreference = 'Continue'\n` +
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n` +
    `$OutputEncoding = [System.Text.Encoding]::UTF8\n` +
    `$logPath = ${psq(logFile)}\n` +
    `try {\n` +
    `    ${spec.preview} *>&1 | ForEach-Object {\n` +
    `        $line = $_.ToString()\n` +
    `        [System.IO.File]::AppendAllText($logPath, $line + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `    }\n` +
    `    $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }\n` +
    `} catch {\n` +
    `    [System.IO.File]::AppendAllText($logPath, "[ERROR] " + $_.Exception.Message + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `    $code = 1\n` +
    `}\n` +
    `[System.IO.File]::AppendAllText($logPath, "\`r\`n=== [JOB_FINISHED exit_code=$code] ===\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `if (Test-Path -LiteralPath ${psq(notifyScript)}) {\n` +
    `    $finalStatus = if ($code -eq 0) { 'DONE' } else { 'FAILED' }\n` +
    `    try {\n` +
    `        & ${psq(notifyScript)} -JobId ${psq(jobId)} -Status $finalStatus -Mode ${psq(mode)} -Role ${psq(role)} -Project ${psq(projShort)} -ExitCode $code -ConfigFile ${psq(paths.notifyCfgFile)} *>$null\n` +
    `    } catch {}\n` +
    `}\n` +
    `exit $code\n`;

  fs.writeFileSync(runnerFile, '\uFEFF' + runnerCode, 'utf8');

  // C1 + C2 fix: Spawn a short non-detached launcher (argument array, shell: false) that uses Start-Process
  // so the grandchild runner breaks away from libuv's KILL_ON_JOB_CLOSE job object and survives server restarts.
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

  let pid = 0;
  const pidMatch = /(\d+)/.exec(launchRes.stdout.trim());
  if (pidMatch) {
    pid = Number.parseInt(pidMatch[1]!, 10) || 0;
  }

  const meta: JobMeta = {
    job_id: jobId,
    pid,
    mode,
    agent,
    role,
    model: modelOverride,
    effort: effortOverride,
    new_session: newSession,
    project_path: validatedProjectPath,
    command: cmd,
    status: 'RUNNING',
    exit_code: null,
    started_at: now.toISOString(),
    started_ts: nowSec,
  };
  if (teamArray) {
    meta.team = teamArray;
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');

  const runResp: Record<string, unknown> = {
    ok: true,
    job_id: jobId,
    pid,
    mode,
    agent,
    role,
    status: 'RUNNING',
    command: cmd,
  };
  if (teamArray) {
    runResp.team = teamArray;
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
    elapsed_sec: elapsed,
    log_chunk: chunk,
    next_offset: nextOffset,
    full_log_size: fullSize,
  };
  if (meta.team && typeof meta.team === 'object' && !Array.isArray(meta.team)) {
    statusResp.team = meta.team;
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
