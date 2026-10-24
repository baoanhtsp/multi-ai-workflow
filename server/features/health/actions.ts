import fs from 'node:fs';
import path from 'node:path';
import { loadInternalNotifyConfig } from '../../actions/notify.ts';
import type { MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { isProcessRunning, runCommand } from '../../lib/proc.ts';
import type { AgentEntry } from '../../lib/registry.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  findClaudeExe,
  invalidateHealthCache,
  probeAgent,
  probeAllAgents,
  resolveCliExecutable,
  runCliWithShimFallback,
  type HealthAgentResult,
} from './probes.ts';

const DOCTOR_REQUIRED_SCRIPTS = [
  'invoke-agent.ps1',
  'invoke-claude.ps1',
  'invoke-codex.ps1',
  'invoke-antigravity.ps1',
  'invoke-council-review.ps1',
  'invoke-spec-guard.ps1',
  'invoke-auto-gate.ps1',
  'send-notification.ps1',
];

const PLATFORM_COMMANDS: Record<
  string,
  { install_cmd: string; update_cmd: string; npm_pkg?: string }
> = {
  codex: {
    install_cmd: 'npm i -g @openai/codex',
    update_cmd: 'npm i -g @openai/codex',
    npm_pkg: '@openai/codex',
  },
  gemini: {
    install_cmd: 'npm i -g @google/gemini-cli',
    update_cmd: 'npm i -g @google/gemini-cli',
    npm_pkg: '@google/gemini-cli',
  },
  claude: {
    install_cmd: 'irm https://claude.ai/install.ps1 | iex',
    update_cmd: 'claude update',
  },
  cursor: {
    install_cmd: "irm 'https://cursor.com/install?win32=true' | iex",
    update_cmd: 'cursor-agent update',
  },
  aider: {
    install_cmd: 'python -m pip install aider-install; aider-install',
    update_cmd: 'aider --upgrade',
  },
  antigravity: {
    install_cmd: 'Install the Antigravity IDE',
    update_cmd: '—',
  },
};

function psq(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function extractFirstVersion(raw: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[a-zA-Z0-9._]+)?)/.exec(raw);
  return m ? m[1]! : null;
}

export async function handleHealthCheck(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const query = req.query;
  const agentsParam = query.get('agents');
  const refresh = query.get('refresh') === '1';
  const teamParam = query.get('team');

  const enabledAgents = ctx.registry.agents;
  const enabledMap = new Map<string, AgentEntry>(enabledAgents.map((a: AgentEntry) => [a.id.toLowerCase(), a]));

  let targetAgents = enabledAgents;
  if (agentsParam && agentsParam.trim() !== '') {
    const requestedIds = agentsParam
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    const selected: AgentEntry[] = [];
    for (const rid of requestedIds) {
      const match = enabledMap.get(rid);
      if (!match) {
        throw new ApiValidationError(`Unknown or disabled agent '${rid}'.`, 400);
      }
      if (!selected.some((s) => s.id === match.id)) {
        selected.push(match);
      }
    }
    targetAgents = selected;
  }

  const { agents: probeResults, summary, cached, ms } = await probeAllAgents(
    targetAgents,
    ctx.paths,
    { bypassCache: refresh }
  );

  const resultMap = new Map<string, HealthAgentResult>(probeResults.map((r) => [r.id, r]));

  const response: Record<string, unknown> = {
    ok: true,
    agents: probeResults,
    summary,
    cached,
    ms,
  };

  if (teamParam && teamParam.trim() !== '') {
    let parsedTeam: Record<string, unknown>;
    try {
      parsedTeam = JSON.parse(teamParam) as Record<string, unknown>;
      if (!parsedTeam || typeof parsedTeam !== 'object' || Array.isArray(parsedTeam)) {
        throw new Error('Not an object');
      }
    } catch {
      throw new ApiValidationError('Invalid team JSON parameter.', 400);
    }

    const teamRows: Array<Record<string, unknown>> = [];
    for (const [role, val] of Object.entries(parsedTeam)) {
      let agentId = '';
      let modelOverride: string | null = null;
      if (typeof val === 'string') {
        agentId = val.trim().toLowerCase();
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        const obj = val as { agent?: string; model?: string };
        agentId = String(obj.agent ?? '').trim().toLowerCase();
        if (typeof obj.model === 'string' && obj.model.trim()) {
          modelOverride = obj.model.trim();
        }
      }

      let res = resultMap.get(agentId);
      if (!res) {
        const fallbackAgent = enabledMap.get(agentId);
        if (fallbackAgent) {
          res = await probeAgent(fallbackAgent, ctx.paths);
          resultMap.set(agentId, res);
        }
      }

      if (res) {
        teamRows.push({
          role,
          agent: res.id,
          label: res.label,
          platform: res.platform,
          model: modelOverride ?? res.model,
          model_source: modelOverride ? 'override' : res.model_source,
          status: res.status,
          reason: res.reason,
          fix: res.fix,
        });
      } else {
        teamRows.push({
          role,
          agent: agentId,
          label: agentId,
          platform: 'unknown',
          model: modelOverride,
          model_source: modelOverride ? 'override' : 'unknown',
          status: 'error',
          reason: `Agent '${agentId}' is not enabled or unknown.`,
          fix: undefined,
        });
      }
    }

    response.team_rows = teamRows;
  }

  return response;
}

export async function handleLoginOpen(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const body = req.body;
  const rawAgent = String(body.agent ?? '').trim().toLowerCase();
  if (!rawAgent) {
    throw new ApiValidationError("Missing 'agent' in request body.", 400);
  }

  const agentEntry = ctx.registry.agents.find((a: AgentEntry) => a.id.toLowerCase() === rawAgent);
  if (!agentEntry) {
    throw new ApiValidationError(`Agent '${rawAgent}' is unknown or disabled.`, 400);
  }

  if (rawAgent === 'antigravity' || rawAgent === 'aider') {
    throw new ApiValidationError(`${agentEntry.label} has no login command.`, 400);
  }

  let cmdArray: string[] = [];
  if (Array.isArray(agentEntry.login_cmd) && agentEntry.login_cmd.length > 0) {
    cmdArray = agentEntry.login_cmd.map(String);
  } else if (rawAgent === 'claude') {
    cmdArray = ['claude', '/login'];
  } else if (rawAgent === 'codex') {
    cmdArray = ['codex', 'login'];
  } else if (rawAgent === 'gemini') {
    cmdArray = ['gemini'];
  } else if (rawAgent === 'cursor') {
    cmdArray = ['cursor-agent', 'login'];
  } else {
    throw new ApiValidationError(`${agentEntry.label} has no login command.`, 400);
  }

  // Resolve binary path
  const first = cmdArray[0]!;
  let resolvedBin = first;
  if (rawAgent === 'claude') {
    const claudeExe = findClaudeExe(ctx.paths.userProfile);
    if (claudeExe) {
      resolvedBin = claudeExe;
    }
  } else {
    const shim = resolveCliExecutable(first, ctx.paths.userProfile);
    if (shim) {
      resolvedBin = shim;
    }
  }

  const renderedArgs = [resolvedBin, ...cmdArray.slice(1)];
  const displayCommand = cmdArray.join(' ');

  // Construct inner PowerShell command using single-quoted literals: & 'bin' 'arg1' 'arg2'
  const innerPs = `& ${renderedArgs.map(psq).join(' ')}`;
  // PowerShell launcher that spawns visible window and prints its PID
  const launcherPs = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoExit', '-Command', ${psq(innerPs)}) -PassThru; $p.Id`;
  const b64 = Buffer.from(launcherPs, 'utf16le').toString('base64');

  const execRes = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { timeoutMs: 10000 }
  );

  const pidNum = Number.parseInt(execRes.stdout.trim(), 10);
  if (!Number.isInteger(pidNum) || pidNum <= 0) {
    throw new Error(`Failed to open login terminal: ${execRes.stderr || execRes.stdout || 'Unknown error'}`);
  }

  // Write audit line in data/health/audit.jsonl
  try {
    const dataDir = ctx.paths.featureDataDir('health');
    const auditFile = path.win32.join(dataDir, 'audit.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action: 'login_open',
      agent: rawAgent,
      pid: pidNum,
    }) + '\n';
    fs.appendFileSync(auditFile, line, 'utf8');
  } catch {
    // Ignore audit write error
  }

  const platform = agentEntry.adapter || agentEntry.cli?.command || rawAgent;
  return {
    ok: true,
    platform,
    pid: pidNum,
    command: displayCommand,
  };
}

export async function handleLoginPoll(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const pidStr = req.query.get('pid');
  const pid = Number.parseInt(pidStr ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new ApiValidationError("Invalid or missing 'pid' parameter.", 400);
  }

  const running = isProcessRunning(pid);
  if (!running) {
    // Terminal window closed: invalidate health cache for platforms
    invalidateHealthCache();
  }

  return {
    ok: true,
    running,
  };
}

export async function handleDoctorReport(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const updates = req.query.get('updates') === '1';

  // 1. Probes for all enabled agents
  const { agents: probeResults } = await probeAllAgents(ctx.registry.agents, ctx.paths);

  // Cache for npm latest versions
  const dataDir = ctx.paths.featureDataDir('health');
  const latestCacheFile = path.win32.join(dataDir, 'latest.json');
  let latestCache: Record<string, { version: string; ts: number }> = {};
  if (isFileSafe(latestCacheFile)) {
    try {
      latestCache = JSON.parse(fs.readFileSync(latestCacheFile, 'utf8')) as typeof latestCache;
    } catch {
      latestCache = {};
    }
  }

  const platforms: Array<Record<string, unknown>> = [];
  const now = Date.now();
  const sixHours = 6 * 3600 * 1000;
  let cacheDirty = false;

  for (const r of probeResults) {
    const cmds = PLATFORM_COMMANDS[r.id] ?? {
      install_cmd: '—',
      update_cmd: '—',
    };

    let latestVer: string | null = null;
    let updateAvailable = false;

    if (updates && cmds.npm_pkg) {
      const cached = latestCache[cmds.npm_pkg];
      if (cached && now - cached.ts < sixHours) {
        latestVer = cached.version;
      } else {
        const npmRes = await runCliWithShimFallback('npm', ['view', cmds.npm_pkg, 'version'], ctx.paths.userProfile, 8000);
        if (npmRes.code === 0 && npmRes.stdout.trim()) {
          latestVer = npmRes.stdout.trim();
          latestCache[cmds.npm_pkg] = { version: latestVer, ts: now };
          cacheDirty = true;
        }
      }
      if (latestVer && r.version && latestVer !== r.version) {
        updateAvailable = true;
      }
    }

    const agentDef = ctx.registry.agents.find((a: AgentEntry) => a.id === r.id);
    let loginCmdStr = agentDef?.login_cmd ? agentDef.login_cmd.join(' ') : null;
    const DEFAULT_LOGIN_CMDS: Record<string, string> = {
      cursor: 'cursor-agent login',
      claude: 'claude',
      codex: 'codex login',
      gemini: 'gemini',
    };
    if (!loginCmdStr && DEFAULT_LOGIN_CMDS[r.id]) {
      loginCmdStr = DEFAULT_LOGIN_CMDS[r.id];
    }

    platforms.push({
      id: r.id,
      label: r.label,
      installed: r.installed,
      version: r.version,
      login: r.login,
      status: r.status,
      reason: r.reason,
      latest: latestVer,
      update_available: updateAvailable,
      install_cmd: cmds.install_cmd,
      update_cmd: cmds.update_cmd,
      login_cmd: loginCmdStr,
    });
  }

  if (cacheDirty) {
    try {
      fs.writeFileSync(latestCacheFile, JSON.stringify(latestCache, null, 2), 'utf8');
    } catch {
      // Ignore
    }
  }

  // 2. Environment
  const [gitRes, ghRes, psRes] = await Promise.all([
    runCommand('git.exe', ['--version'], { timeoutMs: 3000 }),
    runCommand('gh.exe', ['--version'], { timeoutMs: 3000 }),
    runCommand('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      timeoutMs: 3000,
    }),
  ]);

  const environment = {
    node: process.version,
    git: extractFirstVersion(gitRes.stdout) ?? (gitRes.code === 0 ? gitRes.stdout.trim() : null),
    gh: extractFirstVersion(ghRes.stdout) ?? (ghRes.code === 0 ? ghRes.stdout.trim() : null),
    powershell: psRes.code === 0 ? psRes.stdout.trim() : null,
    maw_home: ctx.paths.mawHome,
    projects_root: ctx.paths.projectsRoot,
  };

  // 3. Scripts
  const requiredScripts = DOCTOR_REQUIRED_SCRIPTS.map((name) => ({
    name,
    present: isFileSafe(path.win32.join(ctx.paths.scriptsDir, name)),
  }));

  const agentsJsonFile = path.win32.join(ctx.paths.scriptsDir, '..', 'agents.json');
  const scripts = {
    scripts_dir: ctx.paths.scriptsDir,
    required: requiredScripts,
    agents_json_present: isFileSafe(agentsJsonFile) || isFileSafe(path.win32.join(ctx.paths.scriptsDir, 'agents.json')),
    registry_warnings: ctx.registry.warnings ?? [],
  };

  // 4. Hooks
  const hooksRoot = path.win32.join(ctx.paths.scriptsDir, 'hooks');
  const hooks: Record<string, string[]> = {};
  if (isDirectorySafe(hooksRoot)) {
    try {
      for (const evEntry of fs.readdirSync(hooksRoot, { withFileTypes: true })) {
        if (!evEntry.isDirectory()) continue;
        const evDir = path.win32.join(hooksRoot, evEntry.name);
        const files = fs
          .readdirSync(evDir)
          .filter((f) => f.endsWith('.ps1'))
          .sort();
        hooks[evEntry.name] = files;
      }
    } catch {
      // Ignore
    }
  }

  // 5. Notify
  const internalNotify = loadInternalNotifyConfig(ctx.paths.notifyCfgFile);
  const notify = {
    desktop_toast: Boolean(internalNotify.desktop_toast),
    webhook: Boolean(internalNotify.webhook_url && internalNotify.webhook_url.trim() !== ''),
    telegram: Boolean(
      internalNotify.telegram_bot_token &&
        internalNotify.telegram_bot_token.trim() !== '' &&
        internalNotify.telegram_chat_id &&
        internalNotify.telegram_chat_id.trim() !== ''
    ),
  };

  return {
    ok: true,
    platforms,
    environment,
    scripts,
    hooks,
    notify,
  };
}
