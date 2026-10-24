import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature, MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import type { RecoveryData } from '../fallback/index.ts';
import {
  appendJsonl,
  createAttentionId,
  createDefaultPolicyConfig,
  isPathInsideProject,
  loadPolicyConfig,
  matchCommand,
  readJsonSafe,
  rebuildRunBody,
  redactSecrets,
  validatePolicyConfig,
  writeJsonAtomic,
  type AttentionAction,
  type AttentionItem,
  type PolicyConfig,
} from './lib/s4-core.ts';

// ============================================================================
// 1. Interfaces
// ============================================================================

export interface PolicyApproval {
  id: string;
  job_id: string;
  role: string;
  agent: string;
  project: string;
  command: string;
  prompt_sha256: string;
  created_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'used';
  approved_at?: string;
}

export interface PolicyViolation {
  id: string;
  ts: string;
  job_id: string;
  project: string;
  agent: string;
  role: string;
  kind: 'protected_path' | 'deny_command' | 'approve_command' | 'read_only_write' | 'secret';
  severity: 'high' | 'warn';
  detail: string;
  file?: string;
  line?: number;
  resolved?: boolean;
  resolved_at?: string;
  resolve_note?: string;
}

// ============================================================================
// 2. Helpers
// ============================================================================

export function writeRuntimeJson(ctx: MawFeatureContext, hostHeader?: string): void {
  try {
    const policyDir = ctx.paths.featureDataDir('policy');
    const runtimeFile = path.win32.join(policyDir, 'runtime.json');

    let port: number | null = null;
    if (hostHeader) {
      const match = /:(\d+)$/.exec(hostHeader);
      if (match && match[1]) {
        port = Number.parseInt(match[1], 10);
      }
    }

    const payload = {
      repo_root: ctx.paths.repoRoot,
      node: process.execPath,
      port,
      pid: process.pid,
      written_at: new Date().toISOString(),
    };

    writeJsonAtomic(runtimeFile, payload);
  } catch {
    // Ignore runtime write errors
  }
}

function appendPolicyAudit(
  ctx: MawFeatureContext,
  action: string,
  details: Record<string, unknown>
): void {
  const auditFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'audit.jsonl');
  appendJsonl(auditFile, {
    ts: new Date().toISOString(),
    action,
    by: 'dashboard',
    details,
  });
}

export function generatePolicyBrief(
  role: string,
  cfg: PolicyConfig,
  shortForm = false
): string {
  const normRole = role.toLowerCase();
  const globalCfg = cfg.global;
  const roleCfg = cfg.roles[normRole] || {};

  const protectedPaths = Array.from(
    new Set([...(globalCfg.protected_paths || []), ...(roleCfg.protected_paths || [])])
  );
  const denyCommands = Array.from(
    new Set([...(globalCfg.deny_commands || []), ...(roleCfg.deny_commands || [])])
  );
  const approveCommands = Array.from(
    new Set([...(globalCfg.approve_commands || []), ...(roleCfg.approve_commands || [])])
  );
  const readOnly = roleCfg.read_only !== undefined ? roleCfg.read_only : false;

  const lines: string[] = [];
  lines.push('<!-- MAW-S4-POLICY:BEGIN -->');
  lines.push(`## Policy for role ${role} (enforced by Mission Control)`);
  if (protectedPaths.length > 0) {
    lines.push(`- Never modify: ${protectedPaths.join(', ')}`);
  }
  if (denyCommands.length > 0) {
    lines.push(`- Never run: ${denyCommands.join(', ')}`);
  }
  if (!shortForm) {
    if (approveCommands.length > 0) {
      lines.push(
        `- Ask for approval before running: ${approveCommands.join(', ')} (stop and explain instead)`
      );
    }
    if (readOnly) {
      lines.push('- Read-only role: do not write files.');
    }
    lines.push('- Never print secrets, tokens or .env values.');
  }
  lines.push('<!-- MAW-S4-POLICY:END -->');
  return lines.join('\n');
}

export function collectAttentionItems(ctx: MawFeatureContext): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  // Read dismissed IDs (newest 1000)
  const dismissedFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'attention-dismissed.json');
  const dismissed = readJsonSafe<string[]>(dismissedFile, []).data;
  const dismissedSet = new Set(dismissed);

  // 1. Fallback recovery items
  const fallbackDir = ctx.paths.featureDataDir('fallback');
  const recFile = path.win32.join(fallbackDir, 'recovery.json');
  if (fs.existsSync(recFile)) {
    const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;
    for (const rec of recData.items || []) {
      const recMs = new Date(rec.created_at).getTime();
      if (!Number.isNaN(recMs) && recMs < sevenDaysAgo) continue;

      const attId = createAttentionId(rec.created_at, rec.kind || 'recovery', rec.source_job_id);
      if (dismissedSet.has(attId)) continue;

      if (rec.status === 'suggested') {
        items.push({
          id: attId,
          ts: rec.created_at,
          source: 'fallback',
          kind: 'fallback_suggest',
          severity: 'warn',
          title: `Fallback suggested for job ${rec.source_job_id}`,
          detail: rec.reason || `Agent ${rec.agent} failed. Fallback to ${rec.fallback_agent} suggested.`,
          job_id: rec.source_job_id,
          actions: [
            {
              id: 'apply',
              label: `Run with ${rec.fallback_agent}`,
              action: 'recovery_apply',
              body: { id: rec.id },
            },
            {
              id: 'cancel',
              label: 'Cancel',
              action: 'recovery_cancel',
              body: { id: rec.id },
            },
          ],
        });
      } else if (rec.status === 'waiting') {
        items.push({
          id: attId,
          ts: rec.created_at,
          source: 'fallback',
          kind: 'waiting',
          severity: 'info',
          title: `Job ${rec.source_job_id} waiting to recover`,
          detail: `Next attempt at ${rec.next_at || 'soon'}. Reason: ${rec.reason}`,
          job_id: rec.source_job_id,
          actions: [
            {
              id: 'apply_now',
              label: 'Run now',
              action: 'recovery_apply',
              body: { id: rec.id },
            },
            {
              id: 'cancel',
              label: 'Cancel',
              action: 'recovery_cancel',
              body: { id: rec.id },
            },
          ],
        });
      } else if (rec.status === 'gave_up') {
        items.push({
          id: attId,
          ts: rec.created_at,
          source: 'fallback',
          kind: 'recovery_gave_up',
          severity: 'error',
          title: `Recovery gave up on job ${rec.source_job_id}`,
          detail: rec.reason,
          job_id: rec.source_job_id,
        });
      } else if (rec.status === 'failed') {
        items.push({
          id: attId,
          ts: rec.created_at,
          source: 'fallback',
          kind: 'recovery_failed',
          severity: 'error',
          title: `Recovery failed for job ${rec.source_job_id}`,
          detail: rec.error || 'Failed to start recovery job',
          job_id: rec.source_job_id,
        });
      }
    }
  }

  // 2. Budget blocks and warnings from blocks.jsonl
  const budgetBlocksFile = path.win32.join(ctx.paths.featureDataDir('budget'), 'blocks.jsonl');
  if (fs.existsSync(budgetBlocksFile)) {
    try {
      const lines = fs
        .readFileSync(budgetBlocksFile, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as {
            ts: string;
            kind: string;
            scope?: string;
            agent?: string;
            role?: string;
            job_id?: string;
            project_path?: string;
            reason: string;
          };

          const ms = new Date(entry.ts).getTime();
          if (!Number.isNaN(ms) && ms < sevenDaysAgo) continue;

          const attId = createAttentionId(entry.ts, entry.kind, entry.job_id, entry.scope);
          if (dismissedSet.has(attId)) continue;

          const isBlock = entry.kind.endsWith('_block');
          items.push({
            id: attId,
            ts: entry.ts,
            source: 'budget',
            kind: entry.kind,
            severity: isBlock ? 'error' : 'warn',
            title: isBlock
              ? `Budget ${entry.kind === 'cooldown_block' ? 'cooldown' : 'cap'} blocked ${entry.agent || 'agent'}`
              : `Budget warning for ${entry.scope || 'scope'}`,
            detail: entry.reason,
            job_id: entry.job_id,
            project_path: entry.project_path,
          });
        } catch {
          // Ignore parse errors
        }
      }
    } catch {
      // Ignore
    }
  }

  // 3. Pending approvals from approvals.json
  const approvalsFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'approvals.json');
  if (fs.existsSync(approvalsFile)) {
    const approvals = readJsonSafe<PolicyApproval[]>(approvalsFile, []).data;
    for (const apr of approvals) {
      if (apr.status !== 'pending') continue;

      const ms = new Date(apr.created_at).getTime();
      if (!Number.isNaN(ms) && ms < sevenDaysAgo) continue;

      const attId = createAttentionId(apr.created_at, 'approval', apr.job_id);
      if (dismissedSet.has(attId)) continue;

      items.push({
        id: attId,
        ts: apr.created_at,
        source: 'policy',
        kind: 'approval_pending',
        severity: 'warn',
        title: `Approval needed: "${apr.command}" for role ${apr.role}`,
        detail: `Agent ${apr.agent} requested command: ${apr.command}`,
        job_id: apr.job_id,
        project_path: apr.project,
        actions: [
          {
            id: 'approve',
            label: 'Approve & run',
            action: 'policy_approve',
            body: { id: apr.id, rerun: true },
          },
          {
            id: 'reject',
            label: 'Reject',
            action: 'policy_reject',
            body: { id: apr.id },
          },
        ],
      });
    }
  }

  // 4. Open high violations from violations.jsonl
  const violationsFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'violations.jsonl');
  if (fs.existsSync(violationsFile)) {
    try {
      const lines = fs
        .readFileSync(violationsFile, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const viol = JSON.parse(line) as PolicyViolation;
          if (viol.severity !== 'high' || viol.resolved) continue;

          const ms = new Date(viol.ts).getTime();
          if (!Number.isNaN(ms) && ms < sevenDaysAgo) continue;

          const attId = createAttentionId(viol.ts, viol.kind, viol.job_id);
          if (dismissedSet.has(attId)) continue;

          items.push({
            id: attId,
            ts: viol.ts,
            source: 'policy',
            kind: 'policy_violation',
            severity: 'error',
            title: `Policy violation: ${viol.kind}`,
            detail: viol.detail,
            job_id: viol.job_id,
            project_path: viol.project,
            actions: [
              {
                id: 'resolve',
                label: 'Resolve',
                action: 'policy_resolve',
                body: { id: viol.id },
              },
            ],
          });
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }

  // 5. Red quality gates from checks summary
  const checksSummaryFile = path.win32.join(ctx.paths.featureDataDir('checks'), 'summary.json');
  if (fs.existsSync(checksSummaryFile)) {
    const summary = readJsonSafe<Record<string, { green: boolean; at: string }>>(
      checksSummaryFile,
      {}
    ).data;

    for (const [proj, val] of Object.entries(summary)) {
      if (val.green) continue;
      const ms = new Date(val.at).getTime();
      if (!Number.isNaN(ms) && ms < sevenDaysAgo) continue;

      const attId = createAttentionId(val.at, 'checks_gate', undefined, proj);
      if (dismissedSet.has(attId)) continue;

      items.push({
        id: attId,
        ts: val.at,
        source: 'checks',
        kind: 'gate_red',
        severity: 'error',
        title: `Quality gate red for ${path.basename(proj)}`,
        detail: `Test gate failed at ${val.at}`,
        project_path: proj,
      });
    }
  }

  // Add dismiss action to every item
  for (const item of items) {
    if (!item.actions) {
      item.actions = [];
    }
    const hasDismiss = item.actions.some((a) => a.id === 'dismiss');
    if (!hasDismiss) {
      item.actions.push({
        id: 'dismiss',
        label: 'Dismiss',
        action: 's4_attention_dismiss',
        body: { id: item.id },
      });
    }
  }

  // Sort newest first
  items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return items;
}

// ============================================================================
// Feature Export
// ============================================================================

export const feature: MawFeature = {
  name: 'policy',
  ui: {
    script: 'feat-policy.js',
    style: 'feat-policy.css',
  },
  routes: {
    policy_get: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext) => {
        const { config, warnings } = loadPolicyConfig(ctx.paths.featureDataDir('policy'));
        const defaults = createDefaultPolicyConfig();
        const baseRoles = ['backend', 'frontend', 'reviewer', 'architect', 'leader', 'tester'];
        const configuredRoles = Object.keys(config.roles || {});
        const rolesKnown = Array.from(new Set([...baseRoles, ...configuredRoles]));

        return {
          ok: true,
          config,
          defaults,
          roles_known: rolesKnown,
          warnings,
        };
      },
    },

    policy_save: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const rawConfig = body.config ?? body;
        const valRes = validatePolicyConfig(rawConfig);

        const policyDir = ctx.paths.featureDataDir('policy');
        const policyFile = path.win32.join(policyDir, 'policies.json');
        writeJsonAtomic(policyFile, valRes.config);

        appendPolicyAudit(ctx, 'policy_save', { config: valRes.config });

        return {
          ok: true,
          config: valRes.config,
          warnings: valRes.warnings,
        };
      },
    },

    policy_preview: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const role = String(body.role || 'backend').trim().toLowerCase();
        const text = typeof body.text === 'string' ? body.text : undefined;

        const { config } = loadPolicyConfig(ctx.paths.featureDataDir('policy'));
        const brief = generatePolicyBrief(role, config);

        let redacted: string | undefined;
        const matches: { deny: string[]; approve: string[] } = { deny: [], approve: [] };

        if (text !== undefined) {
          redacted = redactSecrets(text);
          const globalCfg = config.global;
          const roleCfg = config.roles[role] || {};
          const allowCmds = Array.from(
            new Set([...(globalCfg.allow_commands || []), ...(roleCfg.allow_commands || [])])
          );
          const denyCmds = Array.from(
            new Set([...(globalCfg.deny_commands || []), ...(roleCfg.deny_commands || [])])
          );
          const approveCmds = Array.from(
            new Set([...(globalCfg.approve_commands || []), ...(roleCfg.approve_commands || [])])
          );

          for (const cmd of denyCmds) {
            if (matchCommand(text, cmd, allowCmds)) {
              matches.deny.push(cmd);
            }
          }
          for (const cmd of approveCmds) {
            if (matchCommand(text, cmd, allowCmds)) {
              matches.approve.push(cmd);
            }
          }
        }

        return {
          ok: true,
          brief,
          ...(redacted !== undefined ? { redacted } : {}),
          matches,
        };
      },
    },

    policy_violations: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const rawProj = (req.query.get('project_path') || '').trim();
        const jobId = (req.query.get('job_id') || '').trim();
        const rawLimit = req.query.get('limit');
        const limit = rawLimit ? Math.max(1, parseInt(rawLimit, 10)) : 100;
        const includeResolved = req.query.get('include_resolved') === '1';

        let projectPath = '';
        if (rawProj) {
          projectPath = resolveProjectPath(rawProj, ctx.paths.projectsRoot) || rawProj;
        }

        const violationsFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'violations.jsonl');
        const items: PolicyViolation[] = [];

        if (fs.existsSync(violationsFile)) {
          try {
            const lines = fs
              .readFileSync(violationsFile, 'utf8')
              .split(/\r?\n/)
              .filter((l) => l.trim().length > 0)
              .reverse();

            for (const l of lines) {
              try {
                const v = JSON.parse(l) as PolicyViolation;
                if (!includeResolved && v.resolved) continue;
                if (jobId && v.job_id !== jobId) continue;
                if (projectPath && v.project && !isPathInsideProject(projectPath, v.project)) {
                  continue;
                }
                items.push(v);
                if (items.length >= limit) break;
              } catch {
                // Ignore parse errors
              }
            }
          } catch {
            // Ignore
          }
        }

        return {
          ok: true,
          items,
        };
      },
    },

    policy_resolve: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const id = String(body.id || '').trim();
        const note = String(body.note || '').trim();
        if (!id) {
          throw new ApiValidationError('id is required.', 400);
        }

        const violFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'violations.jsonl');
        let found = false;

        if (fs.existsSync(violFile)) {
          const content = fs.readFileSync(violFile, 'utf8');
          const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const updated: string[] = [];

          for (const l of lines) {
            try {
              const v = JSON.parse(l) as PolicyViolation;
              if (v.id === id) {
                v.resolved = true;
                v.resolved_at = new Date().toISOString();
                if (note) v.resolve_note = note;
                found = true;
              }
              updated.push(JSON.stringify(v));
            } catch {
              updated.push(l);
            }
          }

          if (found) {
            fs.writeFileSync(violFile, updated.join('\n') + '\n', 'utf8');
          }
        }

        if (!found) {
          throw new ApiValidationError(`Unknown violation id: ${id}`, 404);
        }

        appendPolicyAudit(ctx, 'policy_resolve', { id, note });
        return { ok: true };
      },
    },

    policy_approvals: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const status = (req.query.get('status') || 'pending').trim().toLowerCase();
        const approvalsFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'approvals.json');
        const approvals = readJsonSafe<PolicyApproval[]>(approvalsFile, []).data;

        const filtered = status
          ? approvals.filter((a) => a.status.toLowerCase() === status)
          : approvals;

        return {
          ok: true,
          items: filtered.reverse(),
        };
      },
    },

    policy_approve: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const id = String(body.id || '').trim();
        if (!id) {
          throw new ApiValidationError('id is required.', 400);
        }
        const rerun = body.rerun !== undefined ? Boolean(body.rerun) : true;

        const approvalsFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'approvals.json');
        const approvals = readJsonSafe<PolicyApproval[]>(approvalsFile, []).data;
        const apr = approvals.find((a) => a.id === id);
        if (!apr) {
          throw new ApiValidationError(`Unknown approval id: ${id}`, 404);
        }

        apr.status = 'approved';
        apr.approved_at = new Date().toISOString();
        writeJsonAtomic(approvalsFile, approvals);

        let newJobId: string | undefined;
        if (rerun) {
          const jobs = await ctx.readJobs();
          const sourceJob = jobs.find((j) => String(j.job_id) === apr.job_id);
          if (sourceJob) {
            const promptFile = path.win32.join(ctx.paths.jobsDir, `${apr.job_id}.prompt.txt`);
            const runBody = rebuildRunBody(sourceJob, promptFile);
            const started = await ctx.startJob(runBody);
            newJobId = String(started.job_id || '');
          }
        }

        appendPolicyAudit(ctx, 'policy_approve', { id, rerun, new_job_id: newJobId });

        return {
          ok: true,
          item: apr,
          ...(newJobId ? { job_id: newJobId } : {}),
        };
      },
    },

    policy_reject: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const id = String(body.id || '').trim();
        if (!id) {
          throw new ApiValidationError('id is required.', 400);
        }

        const approvalsFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'approvals.json');
        const approvals = readJsonSafe<PolicyApproval[]>(approvalsFile, []).data;
        const apr = approvals.find((a) => a.id === id);
        if (!apr) {
          throw new ApiValidationError(`Unknown approval id: ${id}`, 404);
        }

        apr.status = 'rejected';
        writeJsonAtomic(approvalsFile, approvals);
        appendPolicyAudit(ctx, 'policy_reject', { id });

        return { ok: true };
      },
    },

    s4_attention: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        writeRuntimeJson(ctx, req.req?.headers?.host);
        const since = (req.query.get('since') ?? '').trim();
        let items = collectAttentionItems(ctx);

        if (since) {
          const sinceMs = new Date(since).getTime();
          if (!Number.isNaN(sinceMs)) {
            items = items.filter((it) => new Date(it.ts).getTime() >= sinceMs);
          }
        }

        return {
          ok: true,
          items,
        };
      },
    },

    s4_attention_dismiss: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const id = String(body.id || '').trim();
        if (!id) {
          throw new ApiValidationError('id is required.', 400);
        }

        const dismissedFile = path.win32.join(
          ctx.paths.featureDataDir('policy'),
          'attention-dismissed.json'
        );
        const dismissed = readJsonSafe<string[]>(dismissedFile, []).data;
        if (!dismissed.includes(id)) {
          dismissed.push(id);
        }

        const bounded = dismissed.slice(-1000);
        writeJsonAtomic(dismissedFile, bounded);

        return { ok: true };
      },
    },
  },
  status: async (ctx: MawFeatureContext) => {
    writeRuntimeJson(ctx, ctx.req?.headers?.host);

    const policyDir = ctx.paths.featureDataDir('policy');
    const runtimeFile = path.win32.join(policyDir, 'runtime.json');
    const runtimeOk = fs.existsSync(runtimeFile);

    // Count pending approvals
    const approvalsFile = path.win32.join(policyDir, 'approvals.json');
    const approvals = readJsonSafe<PolicyApproval[]>(approvalsFile, []).data;
    const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;

    // Count open high violations
    let openHigh = 0;
    const violationsFile = path.win32.join(policyDir, 'violations.jsonl');
    if (fs.existsSync(violationsFile)) {
      try {
        const lines = fs
          .readFileSync(violationsFile, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0);
        for (const l of lines) {
          try {
            const v = JSON.parse(l) as PolicyViolation;
            if (v.severity === 'high' && !v.resolved) {
              openHigh++;
            }
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }

    const attentionItems = collectAttentionItems(ctx);
    const attentionCount = attentionItems.filter(
      (it) => it.severity === 'warn' || it.severity === 'error'
    ).length;

    return {
      enabled: true,
      pending_approvals: pendingApprovals,
      open_high: openHigh,
      attention_count: attentionCount,
      warnings: [],
      runtime_ok: runtimeOk,
    };
  },
};
