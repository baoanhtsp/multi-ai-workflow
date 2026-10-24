import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JobMeta } from '../../actions/jobs.ts';
import { psq } from '../../lib/commands.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import type { LoadedRegistry } from '../../lib/registry.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { detectRegistryAgents } from '../../lib/versions.ts';

function formatJobTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}${m}${day}_${h}${min}${s}`;
}

function formatHumanDateTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export type SteerLauncherFn = (runnerFile: string) => Promise<number>;

export async function launchSteerJob(options: {
  parentJobId: string;
  agent: string;
  role: string;
  model?: string;
  effort?: string;
  projectPath: string;
  prompt: string;
  commandExe: string;
  commandArgs: string[];
  promptVia?: 'stdin' | 'file_arg';
  paths: ServerPaths;
  registry: LoadedRegistry;
  strategy: 'resume' | 'summary';
  customLauncher?: SteerLauncherFn;
  skipAgentDetection?: boolean;
}): Promise<{ job_id: string; pid: number; meta: JobMeta & { parent_job_id: string; steer_strategy: string } }> {
  const {
    parentJobId,
    agent,
    role,
    model,
    effort,
    projectPath,
    prompt,
    commandExe,
    commandArgs,
    promptVia,
    paths,
    registry,
    strategy,
    customLauncher,
    skipAgentDetection,
  } = options;

  // 1. Verify agent is installed
  if (!skipAgentDetection) {
    const detectedMap = await detectRegistryAgents(paths, registry.agents);
    const detected = detectedMap.get(agent);
    const agentEntry = registry.agents.find((a) => a.id === agent);
    const label = agentEntry?.label ?? agent;

    if (detected && !detected.installed) {
      throw new ApiValidationError(`${label} is not installed.`, 400);
    }
  }

  // 2. Prepare paths
  const jobsDir = paths.jobsDir;
  if (!fs.existsSync(jobsDir)) {
    fs.mkdirSync(jobsDir, { recursive: true });
  }

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const jobId = `job_${formatJobTimestamp(now)}_${crypto.randomBytes(3).toString('hex')}`;

  const promptFile = path.win32.join(jobsDir, `${jobId}.prompt.txt`);
  const logFile = path.win32.join(jobsDir, `${jobId}.log`);
  const runnerFile = path.win32.join(jobsDir, `${jobId}.runner.ps1`);
  const metaFile = path.win32.join(jobsDir, `${jobId}.json`);

  // Write prompt with UTF-8 BOM
  fs.writeFileSync(promptFile, '\uFEFF' + prompt, 'utf8');

  // Write initial log
  const headerLine =
    `=== [MISSION CONTROL JOB ${jobId}] ===\n` +
    `Mode: STEER | Agent: ${agent} | Role: ${role} | Project: ${projectPath}\n` +
    `Parent: ${parentJobId} | Strategy: ${strategy}\n` +
    `Started: ${formatHumanDateTime(now)}\n` +
    `------------------------------------------------------------\n`;
  fs.writeFileSync(logFile, '\uFEFF' + headerLine, 'utf8');

  // 3. Command construction
  const effectiveArgs = commandArgs.map((a) => (a === '{prompt_file}' ? promptFile : a));
  const formattedArgs = effectiveArgs.map((a) => psq(a)).join(' ');

  let pipelineCmd = '';
  if (promptVia === 'file_arg') {
    pipelineCmd =
      `Set-Location -LiteralPath ${psq(projectPath)}; ` +
      `& ${psq(commandExe)}${formattedArgs ? ' ' + formattedArgs : ''}`;
  } else {
    pipelineCmd =
      `Set-Location -LiteralPath ${psq(projectPath)}; ` +
      `Get-Content -Raw -Encoding UTF8 -LiteralPath ${psq(promptFile)} | & ${psq(commandExe)}${formattedArgs ? ' ' + formattedArgs : ''}`;
  }

  const notifyScript = path.win32.join(paths.scriptsDir, 'send-notification.ps1');
  const hooksLib = path.win32.join(paths.scriptsDir, 'lib', 'maw-hooks.ps1');
  const projShort = path.basename(projectPath);

  // Runner script matching handleRunJob template with UTF-8 encoding without BOM
  const runnerCode =
    `$ErrorActionPreference = 'Continue'\n` +
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n` +
    `$OutputEncoding = New-Object System.Text.UTF8Encoding $false\n` +
    `$logPath = ${psq(logFile)}\n` +
    `if (Test-Path -LiteralPath ${psq(hooksLib)}) {\n` +
    `    try { . ${psq(hooksLib)} } catch {}\n` +
    `}\n` +
    `$code = 0\n` +
    `$hookBlocked = $false\n` +
    `if (Get-Command Invoke-MawHooks -ErrorAction SilentlyContinue) {\n` +
    `    try {\n` +
    `        $startRes = @(Invoke-MawHooks -Event 'job-start' -Context @{ job_id = ${psq(jobId)}; mode = 'steer'; agent = ${psq(agent)}; role = ${psq(role)}; project = ${psq(projectPath)}; exit_code = $null })\n` +
    `        foreach ($item in $startRes) {\n` +
    `            if ($item -is [string] -and $item.Trim()) {\n` +
    `                [System.IO.File]::AppendAllText($logPath, $item + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `            } elseif ($null -ne $item -and $item.Block) {\n` +
    `                $hookBlocked = $true\n` +
    `                [System.IO.File]::AppendAllText($logPath, "[HOOK BLOCKED: job-start] " + [string]$item.Reason + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `                $code = 4\n` +
    `            }\n` +
    `        }\n` +
    `    } catch {}\n` +
    `}\n` +
    `if (-not $hookBlocked) {\n` +
    `    try {\n` +
    `        ${pipelineCmd} *>&1 | ForEach-Object {\n` +
    `            $line = $_.ToString()\n` +
    `            [System.IO.File]::AppendAllText($logPath, $line + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `        }\n` +
    `        $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }\n` +
    `    } catch {\n` +
    `        [System.IO.File]::AppendAllText($logPath, "[ERROR] " + $_.Exception.Message + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `        $code = 1\n` +
    `    }\n` +
    `}\n` +
    `if (Get-Command Invoke-MawHooks -ErrorAction SilentlyContinue) {\n` +
    `    try {\n` +
    `        $finRes = @(Invoke-MawHooks -Event 'job-finish' -Context @{ job_id = ${psq(jobId)}; mode = 'steer'; agent = ${psq(agent)}; role = ${psq(role)}; project = ${psq(projectPath)}; exit_code = $code })\n` +
    `        foreach ($item in $finRes) {\n` +
    `            if ($item -is [string] -and $item.Trim()) {\n` +
    `                [System.IO.File]::AppendAllText($logPath, $item + "\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `            }\n` +
    `        }\n` +
    `    } catch {}\n` +
    `}\n` +
    `[System.IO.File]::AppendAllText($logPath, "\`r\`n=== [JOB_FINISHED exit_code=$code] ===\`r\`n", [System.Text.Encoding]::UTF8)\n` +
    `if (Test-Path -LiteralPath ${psq(notifyScript)}) {\n` +
    `    $finalStatus = if ($code -eq 0) { 'DONE' } else { 'FAILED' }\n` +
    `    try {\n` +
    `        & ${psq(notifyScript)} -JobId ${psq(jobId)} -Status $finalStatus -Mode 'steer' -Role ${psq(role)} -Project ${psq(projShort)} -ExitCode $code -ConfigFile ${psq(paths.notifyCfgFile)} *>$null\n` +
    `    } catch {}\n` +
    `}\n` +
    `exit $code\n`;

  fs.writeFileSync(runnerFile, '\uFEFF' + runnerCode, 'utf8');

  // 4. Launch runner
  let pid = 0;
  if (customLauncher) {
    pid = await customLauncher(runnerFile);
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

  const meta: JobMeta & { parent_job_id: string; steer_strategy: string } = {
    job_id: jobId,
    pid,
    mode: 'steer',
    agent,
    role,
    model,
    effort,
    project_path: projectPath,
    command: pipelineCmd,
    status: 'RUNNING',
    exit_code: null,
    started_at: now.toISOString(),
    started_ts: nowSec,
    parent_job_id: parentJobId,
    steer_strategy: strategy,
  };

  fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');

  return {
    job_id: jobId,
    pid,
    meta,
  };
}
