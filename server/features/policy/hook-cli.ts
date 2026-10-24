import child_process from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveServerPaths, type ServerPaths } from '../../lib/paths.ts';
import { loadAgentRegistry } from '../../lib/registry.ts';
import { detectRegistryAgents } from '../../lib/versions.ts';
import {
  computeCheckCommandSha,
  computeGate,
  getGitInfo,
  getProjectChecksSha256,
  isProjectChecksTrusted,
  runCheckProcess,
  saveLastSummary,
  saveStoredResults,
  validateChecksConfig,
  type CheckRunResult,
} from '../checks/lib/checks-core.ts';
import {
  generatePolicyBrief,
  type PolicyApproval,
  type PolicyViolation,
} from './index.ts';
import {
  appendJsonl,
  calculateAgentDaySpend,
  calculateDaySpend,
  calculateJobSpendFromOffset,
  calculateProjectSpend,
  calculateTeamRunSpend,
  cleanPromptText,
  createDefaultBudgetConfig,
  createDefaultFallbackConfig,
  createDefaultPolicyConfig,
  estimateNextCallCost,
  extractProjectEnvSecrets,
  findProjectOverride,
  isPathInsideProject,
  loadBudgetConfig,
  loadFallbackConfig,
  loadPolicyConfig,
  matchCommand,
  matchGlob,
  parsePorcelainPaths,
  pickFallback,
  readAuditRows,
  readJsonSafe,
  redactSecrets,
  writeJsonAtomic,
  type BudgetConfig,
  type FallbackAgentInfo,
  type FallbackConfig,
  type PolicyConfig,
} from './lib/s4-core.ts';

interface HookResult {
  block: boolean;
  reason: string;
  lines: string[];
  env?: Record<string, string>;
}

function outputResult(result: HookResult): void {
  try {
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // Ignore write error
  }
  process.exit(0);
}

function formatLocalHHMM(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function recordBlockOrWarn(
  paths: ServerPaths,
  entry: {
    ts: string;
    kind: 'budget_block' | 'cooldown_block' | 'budget_warn';
    scope?: string;
    agent?: string;
    role?: string;
    job_id?: string;
    project_path?: string;
    reason: string;
  }
): boolean {
  const file = path.win32.join(paths.featureDataDir('budget'), 'blocks.jsonl');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let existing: Array<Record<string, unknown>> = [];
  if (fs.existsSync(file)) {
    try {
      existing = fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      existing = [];
    }
  }

  // Deduplicate warnings per scope per local day
  if (entry.kind === 'budget_warn' && entry.scope) {
    const alreadyWarned = existing.some(
      (e) =>
        e.kind === 'budget_warn' &&
        e.scope === entry.scope &&
        typeof e.ts === 'string' &&
        e.ts.startsWith(todayStr)
    );
    if (alreadyWarned) return false;
  }

  existing.push(entry);
  const bounded = existing.slice(-500);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, bounded.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return true;
}

function appendToJobLog(jobsDir: string, jobId: string, lines: string[]): void {
  if (!jobId || lines.length === 0) return;
  const logFile = path.win32.join(jobsDir, `${jobId}.log`);
  try {
    const text = lines.join('\r\n') + '\r\n';
    fs.appendFileSync(logFile, text, 'utf8');
  } catch {
    // Ignore log append errors
  }
}

async function main(): Promise<void> {
  const event = (process.argv[2] || '').trim().toLowerCase();

  const chunks: Buffer[] = [];
  process.stdin.on('data', (c) => chunks.push(c));

  process.stdin.on('end', async () => {
    let context: Record<string, unknown> = {};
    try {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw) {
        context = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch (err) {
      if (event === 'before-review') {
        const msg = err instanceof Error ? err.message : String(err);
        outputResult({
          block: true,
          reason: `Test gate error: invalid stdin JSON: ${msg} [S4:gate]`,
          lines: [`Test gate error: invalid stdin JSON: ${msg} [S4:gate]`],
        });
        return;
      }
      outputResult({
        block: false,
        reason: '',
        lines: [
          `[S4] hook error: invalid stdin JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      });
      return;
    }

    try {
      const paths = resolveServerPaths();

      // ======================================================================
      // 1. job-start
      // ======================================================================
      if (event === 'job-start') {
        const jobId = String(context.job_id || process.env.MAW_JOB_ID || '').trim();
        const mode = String(context.mode || process.env.MAW_JOB_MODE || '').trim();
        const role = String(context.role || process.env.MAW_JOB_ROLE || 'backend').trim();
        const project = String(context.project || process.env.MAW_JOB_PROJECT || '').trim();

        // Policy Brief & Prompt Redaction (Design §5.2.1)
        if (jobId) {
          const promptFile = path.win32.join(paths.jobsDir, `${jobId}.prompt.txt`);
          if (fs.existsSync(promptFile)) {
            try {
              let rawPrompt = fs.readFileSync(promptFile, 'utf8');
              const hasBom = rawPrompt.charCodeAt(0) === 0xfeff;
              if (hasBom) rawPrompt = rawPrompt.slice(1);

              const { config: policyCfg } = loadPolicyConfig(paths.featureDataDir('policy'));
              if (policyCfg.enabled) {
                let cleaned = cleanPromptText(rawPrompt);
                if (policyCfg.global.redact_secrets !== false) {
                  const envSecrets =
                    policyCfg.global.redact_env_files !== false && project
                      ? extractProjectEnvSecrets(project)
                      : [];
                  cleaned = redactSecrets(
                    cleaned,
                    envSecrets,
                    policyCfg.global.secret_patterns || []
                  );
                }
                const redactedPrompt = cleaned;

                let brief = generatePolicyBrief(role, policyCfg, false);
                let fullPrompt = `${brief}\n\n${redactedPrompt}`;

                // If exceeds 20000 chars, use short form
                if (fullPrompt.length > 20000) {
                  brief = generatePolicyBrief(role, policyCfg, true);
                  fullPrompt = `${brief}\n\n${redactedPrompt}`;
                }

                const finalContent = hasBom ? `\ufeff${fullPrompt}` : fullPrompt;
                fs.writeFileSync(promptFile, finalContent, 'utf8');
              }
            } catch {
              // Ignore prompt rewrite errors
            }
          }

          // Git snapshot for diff scan in job-finish
          if (project) {
            try {
              const snapshotDir = path.win32.join(paths.featureDataDir('policy'), 'snapshots');
              if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
              const snapshotFile = path.win32.join(snapshotDir, `${jobId}.txt`);

              const gitRes = child_process
                .execFileSync('git', ['status', '--porcelain'], {
                  cwd: project,
                  shell: false,
                  windowsHide: true,
                  stdio: ['ignore', 'pipe', 'ignore'],
                })
                .toString('utf8');

              fs.writeFileSync(snapshotFile, gitRes, 'utf8');
            } catch {
              // Not a git repo or git error
            }
          }
        }

        // Team Run ID lookup (Item 12: retry up to 5x with 300ms pause if job is very new)
        let teamRunId = '';
        const recFile = path.win32.join(paths.featureDataDir('fallback'), 'recovery.json');

        let startedMs = Date.now();
        if (context.started_ts && typeof context.started_ts === 'number') {
          startedMs = context.started_ts;
        } else if (jobId) {
          const jobFile = path.win32.join(paths.jobsDir, `${jobId}.json`);
          if (fs.existsSync(jobFile)) {
            try {
              startedMs = fs.statSync(jobFile).mtimeMs;
            } catch {}
          }
        }
        const isVeryNew = Math.abs(Date.now() - startedMs) <= 10000;

        for (let attempt = 0; attempt < 5; attempt++) {
          if (fs.existsSync(recFile)) {
            const recData = readJsonSafe<{ items?: Array<{ new_job_id?: string; root_job_id?: string }> }>(
              recFile,
              { items: [] }
            );
            const matchItem = (recData.data.items || []).find((it) => it.new_job_id === jobId);
            if (matchItem && matchItem.root_job_id) {
              teamRunId = matchItem.root_job_id;
              break;
            }
          }
          if (!isVeryNew || attempt === 4) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        }

        if (!teamRunId) {
          if (context.team_run_id) {
            teamRunId = String(context.team_run_id).trim();
          } else if (process.env.MAW_TEAM_RUN_ID && process.env.MAW_TEAM_RUN_ID.trim()) {
            teamRunId = process.env.MAW_TEAM_RUN_ID.trim();
          } else {
            teamRunId = jobId;
          }
        }

        let auditOffset = 0;
        if (fs.existsSync(paths.auditFile)) {
          try {
            auditOffset = fs.statSync(paths.auditFile).size;
          } catch {
            auditOffset = 0;
          }
        }

        // Item 13: return lines: [] to .ps1
        outputResult({
          block: false,
          reason: '',
          lines: [],
          env: {
            MAW_JOB_ID: jobId,
            MAW_JOB_MODE: mode,
            MAW_JOB_ROLE: role,
            MAW_JOB_PROJECT: project,
            MAW_S4_AUDIT_OFFSET: String(auditOffset),
            MAW_TEAM_RUN_ID: teamRunId,
          },
        });
        return;
      }

      // ======================================================================
      // 2. before-agent
      // ======================================================================
      if (event === 'before-agent') {
        const agent = String(context.agent || '').trim().toLowerCase();
        const role = String(context.role || process.env.MAW_JOB_ROLE || 'backend').trim().toLowerCase();
        const workdir = String(context.workdir || context.project || process.env.MAW_JOB_PROJECT || '').trim();
        const jobId = String(context.job_id || process.env.MAW_JOB_ID || '').trim();
        const auditOffset = Number(process.env.MAW_S4_AUDIT_OFFSET || 0);
        const teamRunId = String(process.env.MAW_TEAM_RUN_ID || '').trim();

        const registry = loadAgentRegistry(paths);
        const fallbackCfg = loadFallbackConfig(paths.featureDataDir('fallback')).config;
        const roleFallbacks = fallbackCfg.roles[role]?.fallbacks || [];

        const cooldownFile = path.win32.join(paths.featureDataDir('fallback'), 'cooldowns.json');
        const cooldowns = readJsonSafe<Record<string, { until: string; reason?: string }>>(cooldownFile, {}).data;

        const now = new Date();

        // Lazy agent info map builder (Item 18)
        let agentInfoMapCache: Record<string, FallbackAgentInfo> | null = null;
        const getAgentInfoMap = async (): Promise<Record<string, FallbackAgentInfo>> => {
          if (agentInfoMapCache) return agentInfoMapCache;
          const detected = await detectRegistryAgents(paths, registry.agents);
          const map: Record<string, FallbackAgentInfo> = {};
          for (const a of registry.agents) {
            const det = detected.get(a.id);
            map[a.id] = {
              id: a.id,
              label: a.label,
              enabled: a.enabled,
              installed: det ? det.installed : true,
              capabilities: a.capabilities,
            };
          }
          agentInfoMapCache = map;
          return map;
        };

        // Budget config & audit data for spend checks and fallbacks
        const budgetCfg = loadBudgetConfig(paths.featureDataDir('budget')).config;
        const earlyAudit = readAuditRows(paths.auditFile, 0);

        // 1. Cooldown Check
        if (agent && cooldowns[agent]) {
          const cd = cooldowns[agent];
          const untilDate = new Date(cd.until);
          if (!Number.isNaN(untilDate.getTime()) && untilDate.getTime() > now.getTime()) {
            const hhmm = formatLocalHHMM(untilDate);
            const agentEntry = registry.agents.find((a) => a.id === agent);
            const agentLabel = agentEntry?.label || agent;
            const agentInfoMap = await getAgentInfoMap();
            const earlySpentMap: Record<string, number> = {};
            for (const ag of roleFallbacks) {
              earlySpentMap[ag] = calculateAgentDaySpend(earlyAudit.rows, ag, now).usd;
            }
            const fbResult = pickFallback({
              role,
              blockedAgent: agent,
              fallbacks: roleFallbacks,
              agents: agentInfoMap,
              cooldowns,
              agentDaySpentUsd: earlySpentMap,
              agentDayCapBlockUsd: budgetCfg.caps.agent_day?.usd?.block,
              now,
            });
            const fallbackId = fbResult ? fbResult.agent : 'none';
            const reason = `${agentLabel} is rate-limited until ${hhmm} [S4:cooldown agent=${agent} fallback=${fallbackId}]`;

            recordBlockOrWarn(paths, {
              ts: now.toISOString(),
              kind: 'cooldown_block',
              scope: 'cooldown',
              agent,
              role,
              job_id: jobId,
              project_path: workdir,
              reason,
            });

            outputResult({
              block: true,
              reason,
              lines: [reason],
            });
            return;
          }
        }

        // 2. Budget Check
        const lines: string[] = [];

        if (budgetCfg.enabled) {
          const rows = earlyAudit.rows;
          const est = budgetCfg.estimate_next_call ? estimateNextCallCost(rows, agent) : 0;
          const caps = budgetCfg.caps;

          // Scope: day
          if (caps.day) {
            const daySpend = calculateDaySpend(rows, now);
            const usdCap = caps.day.usd;
            if (usdCap && usdCap.block > 0 && daySpend.usd + est >= usdCap.block) {
              const reason = `Budget day exceeded: $${daySpend.usd.toFixed(2)} of $${usdCap.block.toFixed(2)} [S4:budget agent=${agent} fallback=none]`;
              recordBlockOrWarn(paths, {
                ts: now.toISOString(),
                kind: 'budget_block',
                scope: 'day',
                agent,
                role,
                job_id: jobId,
                project_path: workdir,
                reason,
              });
              outputResult({ block: true, reason, lines: [reason] });
              return;
            }
            const tokenCap = caps.day.tokens;
            if (tokenCap && tokenCap.block > 0 && daySpend.tokens >= tokenCap.block) {
              const reason = `Budget day tokens exceeded: ${daySpend.tokens} of ${tokenCap.block} [S4:budget agent=${agent} fallback=none]`;
              recordBlockOrWarn(paths, {
                ts: now.toISOString(),
                kind: 'budget_block',
                scope: 'day_tokens',
                agent,
                role,
                job_id: jobId,
                project_path: workdir,
                reason,
              });
              outputResult({ block: true, reason, lines: [reason] });
              return;
            }
            if (usdCap && usdCap.warn > 0 && daySpend.usd >= usdCap.warn) {
              const warnLine = `[S4] budget warning: day $${daySpend.usd.toFixed(2)} / warn $${usdCap.warn.toFixed(2)}`;
              const recorded = recordBlockOrWarn(paths, {
                ts: now.toISOString(),
                kind: 'budget_warn',
                scope: 'day',
                agent,
                role,
                job_id: jobId,
                project_path: workdir,
                reason: warnLine,
              });
              if (recorded) lines.push(warnLine);
            }
          }

          // Scope: agent_day
          if (caps.agent_day) {
            const agentSpend = calculateAgentDaySpend(rows, agent, now);
            const usdCap = caps.agent_day.usd;
            if (usdCap && usdCap.block > 0 && agentSpend.usd + est >= usdCap.block) {
              const agentInfoMap = await getAgentInfoMap();
              const agentSpentMap: Record<string, number> = {};
              for (const ag of roleFallbacks) {
                agentSpentMap[ag] = calculateAgentDaySpend(rows, ag, now).usd;
              }
              const fbResult = pickFallback({
                role,
                blockedAgent: agent,
                fallbacks: roleFallbacks,
                agents: agentInfoMap,
                cooldowns,
                agentDaySpentUsd: agentSpentMap,
                agentDayCapBlockUsd: usdCap.block,
                now,
              });
              const fallbackId = fbResult ? fbResult.agent : 'none';
              const reason = `Budget agent_day exceeded: $${agentSpend.usd.toFixed(2)} of $${usdCap.block.toFixed(2)} [S4:budget agent=${agent} fallback=${fallbackId}]`;
              recordBlockOrWarn(paths, {
                ts: now.toISOString(),
                kind: 'budget_block',
                scope: 'agent_day',
                agent,
                role,
                job_id: jobId,
                project_path: workdir,
                reason,
              });
              outputResult({ block: true, reason, lines: [reason] });
              return;
            }
            if (usdCap && usdCap.warn > 0 && agentSpend.usd >= usdCap.warn) {
              const warnLine = `[S4] budget warning: agent_day $${agentSpend.usd.toFixed(2)} / warn $${usdCap.warn.toFixed(2)}`;
              const recorded = recordBlockOrWarn(paths, {
                ts: now.toISOString(),
                kind: 'budget_warn',
                scope: 'agent_day',
                agent,
                role,
                job_id: jobId,
                project_path: workdir,
                reason: warnLine,
              });
              if (recorded) lines.push(warnLine);
            }
          }

          // Scope: project (Item 15)
          const targetProj = process.env.MAW_JOB_PROJECT || workdir;
          if (targetProj) {
            const projOverride = findProjectOverride(budgetCfg.projects, targetProj) ?? budgetCfg.caps.project;
            if (projOverride && projOverride.usd) {
              const period = projOverride.period || 'month';
              const projSpend = calculateProjectSpend(rows, targetProj, period, now);
              if (projOverride.usd.block > 0 && projSpend.usd + est >= projOverride.usd.block) {
                const reason = `Budget project exceeded: $${projSpend.usd.toFixed(2)} of $${projOverride.usd.block.toFixed(2)} [S4:budget agent=${agent} fallback=none]`;
                recordBlockOrWarn(paths, {
                  ts: now.toISOString(),
                  kind: 'budget_block',
                  scope: 'project',
                  agent,
                  role,
                  job_id: jobId,
                  project_path: workdir,
                  reason,
                });
                outputResult({ block: true, reason, lines: [reason] });
                return;
              }
              if (projOverride.usd.warn > 0 && projSpend.usd >= projOverride.usd.warn) {
                const warnLine = `[S4] budget warning: project $${projSpend.usd.toFixed(2)} / warn $${projOverride.usd.warn.toFixed(2)}`;
                const recorded = recordBlockOrWarn(paths, {
                  ts: now.toISOString(),
                  kind: 'budget_warn',
                  scope: 'project',
                  agent,
                  role,
                  job_id: jobId,
                  project_path: workdir,
                  reason: warnLine,
                });
                if (recorded) lines.push(warnLine);
              }
            }
          }

          // Scope: job
          let currentJobSpendUsd = 0;
          if (jobId && workdir && auditOffset >= 0) {
            const jobSpend = calculateJobSpendFromOffset(paths.auditFile, auditOffset, workdir);
            currentJobSpendUsd = jobSpend.usd;
            if (caps.job) {
              const usdCap = caps.job.usd;
              if (usdCap && usdCap.block > 0 && jobSpend.usd + est >= usdCap.block) {
                const reason = `Budget job exceeded: $${jobSpend.usd.toFixed(2)} of $${usdCap.block.toFixed(2)} [S4:budget agent=${agent} fallback=none]`;
                recordBlockOrWarn(paths, {
                  ts: now.toISOString(),
                  kind: 'budget_block',
                  scope: 'job',
                  agent,
                  role,
                  job_id: jobId,
                  project_path: workdir,
                  reason,
                });
                outputResult({ block: true, reason, lines: [reason] });
                return;
              }
              const tokenCap = caps.job.tokens;
              if (tokenCap && tokenCap.block > 0 && jobSpend.tokens >= tokenCap.block) {
                const reason = `Budget job tokens exceeded: ${jobSpend.tokens} of ${tokenCap.block} [S4:budget agent=${agent} fallback=none]`;
                recordBlockOrWarn(paths, {
                  ts: now.toISOString(),
                  kind: 'budget_block',
                  scope: 'job_tokens',
                  agent,
                  role,
                  job_id: jobId,
                  project_path: workdir,
                  reason,
                });
                outputResult({ block: true, reason, lines: [reason] });
                return;
              }
              if (usdCap && usdCap.warn > 0 && jobSpend.usd >= usdCap.warn) {
                const warnLine = `[S4] budget warning: job $${jobSpend.usd.toFixed(2)} / warn $${usdCap.warn.toFixed(2)}`;
                const recorded = recordBlockOrWarn(paths, {
                  ts: now.toISOString(),
                  kind: 'budget_warn',
                  scope: 'job',
                  agent,
                  role,
                  job_id: jobId,
                  project_path: workdir,
                  reason: warnLine,
                });
                if (recorded) lines.push(warnLine);
              }
            }
          }

          // Scope: team_run
          if (teamRunId && caps.team_run?.usd) {
            const ledgerFile = path.win32.join(paths.featureDataDir('budget'), 'ledger.jsonl');
            let ledgerRows: Array<Record<string, unknown>> = [];
            if (fs.existsSync(ledgerFile)) {
              try {
                ledgerRows = fs
                  .readFileSync(ledgerFile, 'utf8')
                  .split(/\r?\n/)
                  .filter((l) => l.trim().length > 0)
                  .map((l) => JSON.parse(l));
              } catch {
                ledgerRows = [];
              }
            }
            const teamSpend = calculateTeamRunSpend(ledgerRows, teamRunId, currentJobSpendUsd);
            const usdCap = caps.team_run.usd;
            if (usdCap.block > 0 && teamSpend.usd + est >= usdCap.block) {
              const reason = `Budget team_run exceeded: $${teamSpend.usd.toFixed(2)} of $${usdCap.block.toFixed(2)} [S4:budget agent=${agent} fallback=none]`;
              recordBlockOrWarn(paths, {
                ts: now.toISOString(),
                kind: 'budget_block',
                scope: 'team_run',
                agent,
                role,
                job_id: jobId,
                project_path: workdir,
                reason,
              });
              outputResult({ block: true, reason, lines: [reason] });
              return;
            }
            if (usdCap.warn > 0 && teamSpend.usd >= usdCap.warn) {
              const warnLine = `[S4] budget warning: team_run $${teamSpend.usd.toFixed(2)} / warn $${usdCap.warn.toFixed(2)}`;
              const recorded = recordBlockOrWarn(paths, {
                ts: now.toISOString(),
                kind: 'budget_warn',
                scope: 'team_run',
                agent,
                role,
                job_id: jobId,
                project_path: workdir,
                reason: warnLine,
              });
              if (recorded) lines.push(warnLine);
            }
          }
        }

        // 3. Policy Command Check (Design §5.2.2)
        const policyCfg = loadPolicyConfig(paths.featureDataDir('policy')).config;
        if (policyCfg.enabled && jobId) {
          const promptFile = path.win32.join(paths.jobsDir, `${jobId}.prompt.txt`);
          let promptText = '';
          if (fs.existsSync(promptFile)) {
            try {
              promptText = fs.readFileSync(promptFile, 'utf8');
            } catch {
              promptText = '';
            }
          }

          if (promptText) {
            const cleanPrompt = cleanPromptText(promptText);

            const globalCfg = policyCfg.global;
            const roleCfg = policyCfg.roles[role] || {};
            const profileRole = process.env.MAW_ROLE_PROFILE
              ? policyCfg.roles[process.env.MAW_ROLE_PROFILE.toLowerCase()] || {}
              : {};

            const allowCmds = Array.from(
              new Set([
                ...(globalCfg.allow_commands || []),
                ...(roleCfg.allow_commands || []),
                ...(profileRole.allow_commands || []),
              ])
            );
            const denyCmds = Array.from(
              new Set([
                ...(globalCfg.deny_commands || []),
                ...(roleCfg.deny_commands || []),
                ...(profileRole.deny_commands || []),
              ])
            );
            const approveCmds = Array.from(
              new Set([
                ...(globalCfg.approve_commands || []),
                ...(roleCfg.approve_commands || []),
                ...(profileRole.approve_commands || []),
              ])
            );

            // Check Deny Commands
            for (const denyCmd of denyCmds) {
              if (matchCommand(cleanPrompt, denyCmd, allowCmds)) {
                const reason = `Policy: role ${role} may not run "${denyCmd}" [S4:policy agent=${agent} fallback=none]`;
                outputResult({ block: true, reason, lines: [reason] });
                return;
              }
            }

            // Check Approve Commands
            for (const approveCmd of approveCmds) {
              if (matchCommand(cleanPrompt, approveCmd, allowCmds)) {
                const promptSha256 = crypto
                  .createHash('sha256')
                  .update(`${cleanPrompt}:${role}`, 'utf8')
                  .digest('hex');

                const approvalsFile = path.win32.join(paths.featureDataDir('policy'), 'approvals.json');
                const approvals = readJsonSafe<PolicyApproval[]>(approvalsFile, []).data;
                const nowMs = Date.now();
                const validCutoff = nowMs - 24 * 60 * 60 * 1000;

                const claimsDir = path.win32.join(paths.featureDataDir('policy'), 'approval-claims');
                if (!fs.existsSync(claimsDir)) {
                  try {
                    fs.mkdirSync(claimsDir, { recursive: true });
                  } catch {}
                }

                let claimed = false;
                for (let i = 0; i < approvals.length; i++) {
                  const a = approvals[i]!;
                  if (
                    a.prompt_sha256 === promptSha256 &&
                    a.role.toLowerCase() === role.toLowerCase() &&
                    a.status === 'approved' &&
                    new Date(a.created_at).getTime() >= validCutoff
                  ) {
                    try {
                      const claimFile = path.win32.join(claimsDir, a.id);
                      const fd = fs.openSync(claimFile, 'wx');
                      fs.closeSync(fd);
                      claimed = true;
                      a.status = 'used';
                      writeJsonAtomic(approvalsFile, approvals);
                      break;
                    } catch (e: any) {
                      if (e && e.code === 'EEXIST') {
                        a.status = 'used';
                        continue;
                      }
                    }
                  }
                }

                if (!claimed) {
                  // Create pending approval and block
                  const aprId = 'apr_' + crypto.randomBytes(6).toString('hex');
                  const newApr: PolicyApproval = {
                    id: aprId,
                    job_id: jobId,
                    role,
                    agent,
                    project: workdir,
                    command: approveCmd,
                    prompt_sha256: promptSha256,
                    created_at: new Date().toISOString(),
                    status: 'pending',
                  };
                  approvals.push(newApr);
                  writeJsonAtomic(approvalsFile, approvals);

                  const reason = `Approval needed: "${approveCmd}" for role ${role} — approve in the dashboard (${aprId}) [S4:approval agent=${agent} fallback=none]`;
                  outputResult({ block: true, reason, lines: [reason] });
                  return;
                }
              }
            }
          }
        }

        outputResult({
          block: false,
          reason: '',
          lines,
        });
        return;
      }

      // ======================================================================
      // 3. job-finish (Post-hoc Scan & Redaction)
      // ======================================================================
      if (event === 'job-finish') {
        const jobId = String(context.job_id || process.env.MAW_JOB_ID || '').trim();
        const role = String(context.role || process.env.MAW_JOB_ROLE || 'backend').trim().toLowerCase();
        const agent = String(context.agent || '').trim().toLowerCase();
        const project = String(context.project || context.workdir || process.env.MAW_JOB_PROJECT || '').trim();

        const violations: PolicyViolation[] = [];
        const policyCfg = loadPolicyConfig(paths.featureDataDir('policy')).config;

        if (policyCfg.enabled && jobId) {
          const logFile = path.win32.join(paths.jobsDir, `${jobId}.log`);
          let logContent = '';
          if (fs.existsSync(logFile)) {
            try {
              logContent = fs.readFileSync(logFile, 'utf8');
            } catch {
              logContent = '';
            }
          }

          const globalCfg = policyCfg.global;
          const roleCfg = policyCfg.roles[role] || {};
          const profileRole = (process.env.MAW_ROLE_PROFILE || '').trim().toLowerCase();
          const profileRoleCfg = (profileRole && policyCfg.roles[profileRole]) || {};

          const allowCmds = Array.from(
            new Set([
              ...(globalCfg.allow_commands || []),
              ...(roleCfg.allow_commands || []),
              ...(profileRoleCfg.allow_commands || []),
            ])
          );
          const denyCmds = Array.from(
            new Set([
              ...(globalCfg.deny_commands || []),
              ...(roleCfg.deny_commands || []),
              ...(profileRoleCfg.deny_commands || []),
            ])
          );
          const approveCmds = Array.from(
            new Set([
              ...(globalCfg.approve_commands || []),
              ...(roleCfg.approve_commands || []),
              ...(profileRoleCfg.approve_commands || []),
            ])
          );
          const protectedPaths = Array.from(
            new Set([
              ...(globalCfg.protected_paths || []),
              ...(roleCfg.protected_paths || []),
              ...(profileRoleCfg.protected_paths || []),
            ])
          );
          const readOnly = roleCfg.read_only === true || profileRoleCfg.read_only === true;

          // 1. Log scan for deny / approve commands
          if (logContent) {
            const lines = logContent.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!;
              if (line.includes('[S4:') || line.startsWith('<!-- MAW-S4-POLICY')) continue;

              for (const cmd of denyCmds) {
                if (matchCommand(line, cmd, allowCmds)) {
                  violations.push({
                    id: 'viol_' + crypto.randomBytes(6).toString('hex'),
                    ts: new Date().toISOString(),
                    job_id: jobId,
                    project,
                    agent,
                    role,
                    kind: 'deny_command',
                    severity: 'warn',
                    detail: `Denied command in log: ${cmd}`,
                    line: i + 1,
                  });
                }
              }

              for (const cmd of approveCmds) {
                if (matchCommand(line, cmd, allowCmds)) {
                  violations.push({
                    id: 'viol_' + crypto.randomBytes(6).toString('hex'),
                    ts: new Date().toISOString(),
                    job_id: jobId,
                    project,
                    agent,
                    role,
                    kind: 'approve_command',
                    severity: 'warn',
                    detail: `Approve command in log: ${cmd}`,
                    line: i + 1,
                  });
                }
              }
            }

            // In-place secret redaction of job log (Design §5.2.3)
            if (policyCfg.global.redact_secrets !== false) {
              const envSecrets =
                policyCfg.global.redact_env_files !== false && project
                  ? extractProjectEnvSecrets(project)
                  : [];
              const redacted = redactSecrets(
                logContent,
                envSecrets,
                policyCfg.global.secret_patterns || []
              );
              if (redacted !== logContent) {
                fs.writeFileSync(logFile, redacted, 'utf8');
              }
            }
          }

          // 2. Diff scan vs snapshot
          if (project) {
            const snapshotFile = path.win32.join(
              paths.featureDataDir('policy'),
              'snapshots',
              `${jobId}.txt`
            );
            let snapshotLines = new Set<string>();
            if (fs.existsSync(snapshotFile)) {
              try {
                const snapContent = fs.readFileSync(snapshotFile, 'utf8');
                snapshotLines = new Set(
                  snapContent
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter(Boolean)
                );
                fs.unlinkSync(snapshotFile);
              } catch {
                // Ignore
              }
            }

            try {
              const gitRes = child_process
                .execFileSync('git', ['status', '--porcelain'], {
                  cwd: project,
                  shell: false,
                  windowsHide: true,
                  stdio: ['ignore', 'pipe', 'ignore'],
                })
                .toString('utf8');

              const currentLines = gitRes
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean);

              for (const cl of currentLines) {
                if (!snapshotLines.has(cl)) {
                  // Newly modified files (handles renames & quoted paths)
                  const filePaths = parsePorcelainPaths(cl);
                  for (const filePath of filePaths) {
                    // Protected path check
                    for (const pattern of protectedPaths) {
                      if (matchGlob(filePath, pattern)) {
                        violations.push({
                          id: 'viol_' + crypto.randomBytes(6).toString('hex'),
                          ts: new Date().toISOString(),
                          job_id: jobId,
                          project,
                          agent,
                          role,
                          kind: 'protected_path',
                          severity: 'high',
                          detail: `Modified protected path: ${filePath}`,
                          file: filePath,
                        });
                        break;
                      }
                    }

                    // Read-only role check
                    if (readOnly) {
                      violations.push({
                        id: 'viol_' + crypto.randomBytes(6).toString('hex'),
                        ts: new Date().toISOString(),
                        job_id: jobId,
                        project,
                        agent,
                        role,
                        kind: 'read_only_write',
                        severity: 'high',
                        detail: `Read-only role modified file: ${filePath}`,
                        file: filePath,
                      });
                    }
                  }
                }
              }
            } catch {
              // Not a git repo
            }
          }

          // Append violations to violations.jsonl
          if (violations.length > 0) {
            const violFile = path.win32.join(paths.featureDataDir('policy'), 'violations.jsonl');
            for (const v of violations) {
              appendJsonl(violFile, v);
            }
            appendToJobLog(paths.jobsDir, jobId, [`[S4] policy: ${violations.length} violation(s)`]);
          }
        }

        outputResult({
          block: false,
          reason: '',
          lines: [],
        });
        return;
      }

      // ======================================================================
      // 4. before-review
      // ======================================================================
      if (event === 'before-review') {
        const workdir = String(context.workdir || context.project || process.env.MAW_JOB_PROJECT || '').trim();

        if (workdir) {
          // 1. Check unresolved high policy violations for this workdir (Design §5.2.4)
          const violFile = path.win32.join(paths.featureDataDir('policy'), 'violations.jsonl');
          if (fs.existsSync(violFile)) {
            try {
              const lines = fs
                .readFileSync(violFile, 'utf8')
                .split(/\r?\n/)
                .filter((l) => l.trim().length > 0);

              for (const l of lines) {
                const v = JSON.parse(l) as PolicyViolation;
                if (v.severity === 'high' && !v.resolved) {
                  if (v.project && isPathInsideProject(workdir, v.project)) {
                    const reason = `Policy violation: ${v.detail} [S4:policy]`;
                    outputResult({
                      block: true,
                      reason,
                      lines: [reason],
                    });
                    return;
                  }
                }
              }
            } catch {
              // Ignore
            }
          }

          // 2. Synchronously run configured checks in workdir (Design §3.4)
          const shaInfo = getProjectChecksSha256(workdir);
          if (!shaInfo) {
            outputResult({
              block: false,
              reason: '',
              lines: ['[S4] no checks configured'],
            });
            return;
          }

          const isTrusted = isProjectChecksTrusted(paths, workdir, shaInfo.sha256);
          if (!isTrusted) {
            const reason =
              'Test gate: .maw/checks.json changed and is not trusted — review and trust it in the dashboard (Checks tab) [S4:gate]';
            outputResult({
              block: true,
              reason,
              lines: [reason],
            });
            return;
          }

          let rawConfig: unknown = null;
          try {
            rawConfig = JSON.parse(shaInfo.content);
          } catch {
            const reason = 'Malformed .maw/checks.json [S4:gate]';
            outputResult({ block: true, reason, lines: [reason] });
            return;
          }

          const val = validateChecksConfig(rawConfig, workdir);
          if (val.errorField) {
            const reason = `Invalid .maw/checks.json: ${val.errorField} [S4:gate]`;
            outputResult({ block: true, reason, lines: [reason] });
            return;
          }
          const config = val.config;
          const gitInfo = getGitInfo(workdir);
          const results: CheckRunResult[] = [];

          // Run each check synchronously
          for (const check of config.checks) {
            const res = await runCheckProcess(check, workdir);
            results.push({
              id: check.id,
              label: check.label || check.id,
              state: res.state,
              exit_code: res.exit_code,
              duration_ms: res.duration_ms,
              output_tail: res.output_tail,
              at: new Date().toISOString(),
              head: gitInfo.head,
              command_sha: check.command_sha || computeCheckCommandSha(check),
            });
          }

          // Evaluate gate (skip spec_guard and review as per design 3.4)
          const gate = await computeGate(paths, workdir, config, results, true, true);
          const nowIso = new Date().toISOString();
          saveStoredResults(paths, workdir, results);
          saveLastSummary(paths, workdir, gate.green, nowIso);

          if (!gate.green) {
            const failedItems = gate.items.filter(
              (it) =>
                it.state === 'fail' ||
                it.state === 'timeout' ||
                it.state === 'stale' ||
                it.state === 'pending'
            );
            const failDetails = failedItems.map((it) => `${it.id} (${it.detail})`).join(', ');
            const reason = `Test gate red: ${failDetails || 'checks failed'} [S4:gate]`;
            outputResult({
              block: true,
              reason,
              lines: [reason],
            });
            return;
          }
        }

        outputResult({
          block: false,
          reason: '',
          lines: ['[S4] test gate green'],
        });
        return;
      }

      // Default for unhandled event
      outputResult({
        block: false,
        reason: '',
        lines: [],
      });
    } catch (err) {
      if (event === 'before-review') {
        const msg = err instanceof Error ? err.message : String(err);
        outputResult({
          block: true,
          reason: `Test gate error: ${msg} [S4:gate]`,
          lines: [`Test gate error: ${msg} [S4:gate]`],
        });
        return;
      }
      outputResult({
        block: false,
        reason: '',
        lines: [
          `[S4] hook error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      });
    }
  });
}

main().catch((err) => {
  const event = process.argv[2] || '';
  if (event === 'before-review') {
    const msg = err instanceof Error ? err.message : String(err);
    outputResult({
      block: true,
      reason: `Test gate error: ${msg} [S4:gate]`,
      lines: [`Test gate error: ${msg} [S4:gate]`],
    });
    return;
  }
  outputResult({
    block: false,
    reason: '',
    lines: [`[S4] hook fatal: ${err instanceof Error ? err.message : String(err)}`],
  });
});
