import fs from 'node:fs';
import path from 'node:path';
import { resolveServerPaths } from '../../lib/paths.ts';
import { loadAgentRegistry } from '../../lib/registry.ts';
import { detectRegistryAgents } from '../../lib/versions.ts';
import {
  calculateAgentDaySpend,
  calculateDaySpend,
  calculateJobSpendFromOffset,
  calculateProjectSpend,
  calculateTeamRunSpend,
  createDefaultBudgetConfig,
  createDefaultFallbackConfig,
  estimateNextCallCost,
  pickFallback,
  readAuditRows,
  readJsonSafe,
  type BudgetConfig,
  type FallbackAgentInfo,
  type FallbackConfig,
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

      if (event === 'job-start') {
        const jobId = String(context.job_id || process.env.MAW_JOB_ID || '').trim();
        const mode = String(context.mode || process.env.MAW_JOB_MODE || '').trim();
        const role = String(context.role || process.env.MAW_JOB_ROLE || '').trim();
        const project = String(context.project || process.env.MAW_JOB_PROJECT || '').trim();

        let teamRunId = '';
        const recFile = path.win32.join(paths.featureDataDir('fallback'), 'recovery.json');
        if (fs.existsSync(recFile)) {
          const recData = readJsonSafe<{ items?: Array<{ new_job_id?: string; root_job_id?: string }> }>(
            recFile,
            { items: [] }
          );
          const matchItem = (recData.data.items || []).find((it) => it.new_job_id === jobId);
          if (matchItem && matchItem.root_job_id) {
            teamRunId = matchItem.root_job_id;
          }
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

      if (event === 'before-agent') {
        const agent = String(context.agent || '').trim().toLowerCase();
        const role = String(context.role || process.env.MAW_JOB_ROLE || 'backend').trim().toLowerCase();
        const workdir = String(context.workdir || process.env.MAW_JOB_PROJECT || '').trim();
        const jobId = String(context.job_id || process.env.MAW_JOB_ID || '').trim();
        const auditOffset = Number(process.env.MAW_S4_AUDIT_OFFSET || 0);
        const teamRunId = String(process.env.MAW_TEAM_RUN_ID || '').trim();

        const registry = loadAgentRegistry(paths);
        const detected = await detectRegistryAgents(paths, registry.agents);
        const agentInfoMap: Record<string, FallbackAgentInfo> = {};
        for (const a of registry.agents) {
          const det = detected.get(a.id);
          agentInfoMap[a.id] = {
            id: a.id,
            label: a.label,
            enabled: a.enabled,
            installed: det ? det.installed : true,
            capabilities: a.capabilities,
          };
        }

        const fallbackCfgFile = path.win32.join(paths.featureDataDir('fallback'), 'routing.json');
        const fallbackCfg = readJsonSafe<FallbackConfig>(fallbackCfgFile, createDefaultFallbackConfig()).data;
        const roleFallbacks = fallbackCfg.roles[role]?.fallbacks || [];

        const cooldownFile = path.win32.join(paths.featureDataDir('fallback'), 'cooldowns.json');
        const cooldowns = readJsonSafe<Record<string, { until: string; reason?: string }>>(cooldownFile, {}).data;

        const now = new Date();

        // 1. Cooldown Check
        if (agent && cooldowns[agent]) {
          const cd = cooldowns[agent];
          const untilDate = new Date(cd.until);
          if (!Number.isNaN(untilDate.getTime()) && untilDate.getTime() > now.getTime()) {
            const hhmm = formatLocalHHMM(untilDate);
            const agentEntry = registry.agents.find((a) => a.id === agent);
            const agentLabel = agentEntry?.label || agent;
            const fbResult = pickFallback({
              role,
              blockedAgent: agent,
              fallbacks: roleFallbacks,
              agents: agentInfoMap,
              cooldowns,
              now,
            });
            const fallbackId = fbResult ? fbResult.agent : 'none';
            const reason = `${agentLabel} is rate-limited until ${hhmm} [S4:cooldown agent=${agent} fallback=${fallbackId}]`;
            outputResult({
              block: true,
              reason,
              lines: [reason],
            });
            return;
          }
        }

        // 2. Budget Check
        const budgetCfgFile = path.win32.join(paths.featureDataDir('budget'), 'budgets.json');
        const budgetCfg = readJsonSafe<BudgetConfig>(budgetCfgFile, createDefaultBudgetConfig()).data;

        const lines: string[] = [];

        if (budgetCfg.enabled) {
          const { rows } = readAuditRows(paths.auditFile, 0);
          const est = budgetCfg.estimate_next_call ? estimateNextCallCost(rows, agent) : 0;
          const caps = budgetCfg.caps;

          // Scope: day
          if (caps.day) {
            const daySpend = calculateDaySpend(rows, now);
            const usdCap = caps.day.usd;
            if (usdCap && usdCap.block > 0 && daySpend.usd + est >= usdCap.block) {
              const reason = `Budget day exceeded: $${daySpend.usd.toFixed(2)} of $${usdCap.block.toFixed(2)} [S4:budget agent=${agent} fallback=none]`;
              outputResult({ block: true, reason, lines: [reason] });
              return;
            }
            const tokenCap = caps.day.tokens;
            if (tokenCap && tokenCap.block > 0 && daySpend.tokens >= tokenCap.block) {
              const reason = `Budget day tokens exceeded: ${daySpend.tokens} of ${tokenCap.block} [S4:budget agent=${agent} fallback=none]`;
              outputResult({ block: true, reason, lines: [reason] });
              return;
            }
            if (usdCap && usdCap.warn > 0 && daySpend.usd >= usdCap.warn) {
              lines.push(`[S4] budget warning: day $${daySpend.usd.toFixed(2)} / warn $${usdCap.warn.toFixed(2)}`);
            }
          }

          // Scope: agent_day
          if (caps.agent_day) {
            const agentSpend = calculateAgentDaySpend(rows, agent, now);
            const usdCap = caps.agent_day.usd;
            if (usdCap && usdCap.block > 0 && agentSpend.usd + est >= usdCap.block) {
              const fbResult = pickFallback({
                role,
                blockedAgent: agent,
                fallbacks: roleFallbacks,
                agents: agentInfoMap,
                cooldowns,
                now,
              });
              const fallbackId = fbResult ? fbResult.agent : 'none';
              const reason = `Budget agent_day exceeded: $${agentSpend.usd.toFixed(2)} of $${usdCap.block.toFixed(2)} [S4:budget agent=${agent} fallback=${fallbackId}]`;
              outputResult({ block: true, reason, lines: [reason] });
              return;
            }
            if (usdCap && usdCap.warn > 0 && agentSpend.usd >= usdCap.warn) {
              lines.push(`[S4] budget warning: agent_day $${agentSpend.usd.toFixed(2)} / warn $${usdCap.warn.toFixed(2)}`);
            }
          }

          // Scope: project
          if (workdir) {
            const normWorkdir = workdir.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
            const projOverride = budgetCfg.projects?.[normWorkdir]?.project || caps.project;
            if (projOverride && projOverride.usd) {
              const period = projOverride.period || 'month';
              const projSpend = calculateProjectSpend(rows, workdir, period, now);
              if (projOverride.usd.block > 0 && projSpend.usd + est >= projOverride.usd.block) {
                const reason = `Budget project exceeded: $${projSpend.usd.toFixed(2)} of $${projOverride.usd.block.toFixed(2)} [S4:budget agent=${agent} fallback=none]`;
                outputResult({ block: true, reason, lines: [reason] });
                return;
              }
              if (projOverride.usd.warn > 0 && projSpend.usd >= projOverride.usd.warn) {
                lines.push(`[S4] budget warning: project $${projSpend.usd.toFixed(2)} / warn $${projOverride.usd.warn.toFixed(2)}`);
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
                outputResult({ block: true, reason, lines: [reason] });
                return;
              }
              const tokenCap = caps.job.tokens;
              if (tokenCap && tokenCap.block > 0 && jobSpend.tokens >= tokenCap.block) {
                const reason = `Budget job tokens exceeded: ${jobSpend.tokens} of ${tokenCap.block} [S4:budget agent=${agent} fallback=none]`;
                outputResult({ block: true, reason, lines: [reason] });
                return;
              }
              if (usdCap && usdCap.warn > 0 && jobSpend.usd >= usdCap.warn) {
                lines.push(`[S4] budget warning: job $${jobSpend.usd.toFixed(2)} / warn $${usdCap.warn.toFixed(2)}`);
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
              outputResult({ block: true, reason, lines: [reason] });
              return;
            }
            if (usdCap.warn > 0 && teamSpend.usd >= usdCap.warn) {
              lines.push(`[S4] budget warning: team_run $${teamSpend.usd.toFixed(2)} / warn $${usdCap.warn.toFixed(2)}`);
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

      if (event === 'job-finish') {
        outputResult({
          block: false,
          reason: '',
          lines: [],
        });
        return;
      }

      if (event === 'before-review') {
        outputResult({
          block: false,
          reason: '',
          lines: [],
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
  outputResult({
    block: false,
    reason: '',
    lines: [`[S4] hook fatal: ${err instanceof Error ? err.message : String(err)}`],
  });
});
