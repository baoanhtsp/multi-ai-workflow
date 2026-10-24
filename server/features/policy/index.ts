import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature, MawFeatureContext } from '../../lib/feature.ts';
import type { RecoveryData } from '../fallback/index.ts';
import {
  readJsonSafe,
  writeJsonAtomic,
  type AttentionItem,
} from './lib/s4-core.ts';

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

export function collectAttentionItems(ctx: MawFeatureContext): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 1. Fallback recovery items
  const fallbackDir = ctx.paths.featureDataDir('fallback');
  const recFile = path.win32.join(fallbackDir, 'recovery.json');
  if (fs.existsSync(recFile)) {
    const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;
    for (const rec of recData.items || []) {
      if (rec.status === 'suggested') {
        items.push({
          id: `att_${rec.id}`,
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
          id: `att_${rec.id}`,
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
          id: `att_${rec.id}`,
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
          id: `att_${rec.id}`,
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

  // 2. Budget blocks from budget audit log
  const budgetDir = ctx.paths.featureDataDir('budget');
  const budgetAuditFile = path.win32.join(budgetDir, 'audit.jsonl');
  if (fs.existsSync(budgetAuditFile)) {
    try {
      const lines = fs
        .readFileSync(budgetAuditFile, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as {
            ts: string;
            action: string;
            details?: Record<string, unknown>;
          };
          if (entry.action === 'budget_block') {
            items.push({
              id: `att_budget_${entry.ts}_${Math.random().toString(36).substring(2, 7)}`,
              ts: entry.ts,
              source: 'budget',
              kind: 'budget_block',
              severity: 'error',
              title: `Budget limit blocked agent execution`,
              detail: String(entry.details?.reason || 'Budget cap exceeded'),
              job_id: entry.details?.job_id ? String(entry.details.job_id) : undefined,
              project_path: entry.details?.project_path ? String(entry.details.project_path) : undefined,
            });
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }

  // Sort newest first
  items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return items;
}

export const feature: MawFeature = {
  name: 'policy',
  ui: {
    script: 'feat-policy.js',
    style: 'feat-policy.css',
  },
  routes: {
    s4_attention: {
      method: 'GET',
      handler: async (ctx, req) => {
        writeRuntimeJson(ctx, req.req?.headers?.host);
        const since = (req.url.searchParams.get('since') ?? '').trim();
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
  },
  status: async (ctx) => {
    writeRuntimeJson(ctx, ctx.req?.headers?.host);

    const policyDir = ctx.paths.featureDataDir('policy');
    const runtimeFile = path.win32.join(policyDir, 'runtime.json');
    const runtimeOk = fs.existsSync(runtimeFile);

    const attentionItems = collectAttentionItems(ctx);

    return {
      enabled: true,
      pending_approvals: 0,
      open_high: 0,
      warnings: [],
      runtime_ok: runtimeOk,
      attention_count: attentionItems.length,
    };
  },
};
