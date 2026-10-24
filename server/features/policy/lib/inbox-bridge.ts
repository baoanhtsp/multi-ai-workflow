import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFeatureContext, type MawFeatureContext } from '../../../lib/feature.ts';
import type { ServerPaths } from '../../../lib/paths.ts';
import {
  withRecoveryLock,
  type RecoveryData,
  type RecoveryItem,
} from '../../fallback/index.ts';
import {
  approvePolicyApproval,
  collectAttentionItems,
  dismissAttentionItem,
  rejectPolicyApproval,
  type PolicyApproval,
} from '../index.ts';
import {
  appendJsonl,
  readJsonSafe,
  rebuildRunBody,
  replaceAgent,
  writeJsonAtomic,
  type AttentionItem,
} from './s4-core.ts';

export const VALID_INBOX_KINDS = new Set([
  'needs_login',
  'needs_input',
  'failed',
  'blocked',
  'rate_limited',
  'review_changes',
  'budget_block',
  'approval',
  'handoff_done',
  'custom',
]);

export const VALID_INBOX_ACTIONS = new Set([
  'open',
  'retry',
  'login',
  'approve',
  'reject',
  'reply',
  'dismiss',
]);

export interface InboxItemInput {
  kind: string;
  title: string;
  severity?: string;
  detail?: string;
  agent?: string;
  role?: string;
  job_id?: string;
  project?: string;
  source?: string;
  ref?: Record<string, unknown>;
  actions?: string[];
  retry?: Record<string, unknown>;
  dedupe_key?: string;
}

export interface InboxItem {
  id: string;
  kind: string;
  severity: string;
  title: string;
  detail: string;
  agent?: string;
  role?: string;
  job_id?: string;
  project?: string;
  source: string;
  ref?: Record<string, unknown>;
  actions: string[];
  status: string;
  resolution: {
    action: string;
    text?: string;
    by: string;
    at: string;
    job_id?: string;
  } | null;
  dedupe_key?: string;
  created_at: string;
  updated_at: string;
}

export interface InboxModule {
  addInboxItem: (
    paths: ServerPaths,
    input: InboxItemInput,
    options?: { onlyIfAbsent?: boolean }
  ) => { item: InboxItem; created: boolean } | Promise<{ item: InboxItem; created: boolean }>;
  updateInboxItemStatus?: (
    paths: ServerPaths,
    id: string,
    status: string,
    resolution?: { action: string; by: string; at: string; text?: string; job_id?: string }
  ) => InboxItem | null;
  onInboxResolved?: (
    listener: (item: InboxItem) => Promise<boolean | void> | boolean | void
  ) => (() => void) | void;
}

export interface PushedEntry {
  s3_id: string;
  pushed_at: string;
}

let customInboxModulePath: string | null = null;
let cachedInboxModule: InboxModule | null = null;
let onResolvedRegistered = false;
let lastSyncTimeMs = 0;
let lastKnownContext: MawFeatureContext | null = null;
let lastKnownPaths: ServerPaths | null = null;

export function setInboxModulePathForTest(customPath: string | null): void {
  customInboxModulePath = customPath;
  cachedInboxModule = null;
  onResolvedRegistered = false;
}

export function resetInboxBridgeForTest(): void {
  customInboxModulePath = null;
  cachedInboxModule = null;
  onResolvedRegistered = false;
  lastSyncTimeMs = 0;
  lastKnownContext = null;
  lastKnownPaths = null;
}

export async function loadInbox(defaultCtx?: MawFeatureContext): Promise<InboxModule | null> {
  if (defaultCtx) {
    lastKnownContext = defaultCtx;
    lastKnownPaths = defaultCtx.paths;
  }

  if (cachedInboxModule) {
    return cachedInboxModule;
  }

  let modulePath: string;
  if (customInboxModulePath) {
    modulePath = path.isAbsolute(customInboxModulePath)
      ? customInboxModulePath
      : path.resolve(customInboxModulePath);
  } else {
    // Default location: server/features/inbox/store.ts
    const repoRoot = lastKnownPaths?.repoRoot || process.cwd();
    modulePath = path.win32.join(repoRoot, 'server', 'features', 'inbox', 'store.ts');
  }

  if (!fs.existsSync(modulePath)) {
    return null;
  }

  try {
    const fileUrl = pathToFileURL(modulePath).href;
    const mod = (await import(fileUrl)) as InboxModule;
    cachedInboxModule = mod;

    if (!onResolvedRegistered && typeof mod.onInboxResolved === 'function') {
      mod.onInboxResolved(async (item: InboxItem) => {
        return await handleInboxResolved(item);
      });
      onResolvedRegistered = true;
    }

    return mod;
  } catch {
    // Feature detection: fail gracefully if S3 inbox cannot be loaded
    return null;
  }
}

export async function handleInboxResolved(item: InboxItem): Promise<boolean> {
  if (!item) return false;
  const isS4 = item.source === 's4' || item.ref?.s4 === true;
  if (!isS4) return false;

  const action = String(item.resolution?.action ?? '').trim().toLowerCase();
  if (!action) return false;

  const ctx = lastKnownContext || (lastKnownPaths ? createFeatureContext(lastKnownPaths) : null);
  if (!ctx) return false;

  const ref = item.ref || {};
  const attentionId = String(ref.attention_id || item.dedupe_key || item.id || '').trim();
  const approvalId = String(ref.approval_id || '').trim();
  const recoveryId = String(ref.recovery_id || '').trim();

  try {
    if (action === 'approve') {
      const approvalsFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'approvals.json');
      const approvals = readJsonSafe<PolicyApproval[]>(approvalsFile, []).data;

      let targetApr = approvalId ? approvals.find((a) => a.id === approvalId) : undefined;
      if (!targetApr && item.job_id) {
        targetApr = approvals.find((a) => a.job_id === item.job_id && a.status === 'pending');
      }
      if (!targetApr) {
        targetApr = approvals.find((a) => a.id === item.id || a.job_id === item.id);
      }

      if (targetApr) {
        // N2: Shared approval logic; if startJob throws, reverts to pending and returns false
        const res = await approvePolicyApproval(ctx, targetApr.id, true);
        return res.ok;
      }
      return false;
    }

    if (action === 'reject') {
      const approvalsFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'approvals.json');
      const approvals = readJsonSafe<PolicyApproval[]>(approvalsFile, []).data;

      let targetApr = approvalId ? approvals.find((a) => a.id === approvalId) : undefined;
      if (!targetApr && item.job_id) {
        targetApr = approvals.find((a) => a.job_id === item.job_id && a.status === 'pending');
      }
      if (!targetApr) {
        targetApr = approvals.find((a) => a.id === item.id || a.job_id === item.id);
      }

      if (targetApr) {
        await rejectPolicyApproval(ctx, targetApr.id);
        return true;
      }
      return false;
    }

    if (action === 'retry') {
      // N1: S3 itself calls ctx.startJob(item.retry), then fires listener with resolution.job_id.
      // Do NOT start anything; inside withRecoveryLock mark the recovery item 'started'
      const fallbackDir = ctx.paths.featureDataDir('fallback');
      const recFile = path.win32.join(fallbackDir, 'recovery.json');
      const newJobId = item.resolution?.job_id || null;

      await withRecoveryLock(async () => {
        const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;
        let targetRec = recoveryId ? recData.items.find((r) => r.id === recoveryId) : undefined;
        if (!targetRec && item.job_id) {
          targetRec = recData.items.find((r) => r.source_job_id === item.job_id);
        }
        if (!targetRec) {
          targetRec = recData.items.find((r) => r.id === item.id || r.source_job_id === item.id);
        }

        if (targetRec) {
          if (targetRec.status === 'waiting' || targetRec.status === 'suggested') {
            targetRec.status = 'started';
            targetRec.new_job_id = newJobId;
            writeJsonAtomic(recFile, recData);
            appendJsonl(path.win32.join(fallbackDir, 'audit.jsonl'), {
              ts: new Date().toISOString(),
              action: 'recovery_apply',
              details: {
                id: targetRec.id,
                new_job_id: newJobId,
                from: 'inbox_retry',
              },
            });
          } else {
            // no-op if no longer waiting/suggested; log info audit
            appendJsonl(path.win32.join(fallbackDir, 'audit.jsonl'), {
              ts: new Date().toISOString(),
              action: 'inbox_retry_ignored',
              details: {
                id: targetRec.id,
                status: targetRec.status,
                job_id: targetRec.source_job_id,
              },
            });
          }
        }
      });
      return true;
    }

    if (action === 'dismiss') {
      if (attentionId) {
        dismissAttentionItem(ctx, attentionId);
        return true;
      }
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

export async function syncAttentionToInbox(ctx: MawFeatureContext, force = false): Promise<void> {
  lastKnownContext = ctx;
  lastKnownPaths = ctx.paths;

  const nowMs = Date.now();
  if (!force && nowMs - lastSyncTimeMs < 5000) {
    return;
  }
  lastSyncTimeMs = nowMs;

  const inbox = await loadInbox(ctx);
  if (!inbox || typeof inbox.addInboxItem !== 'function') {
    return;
  }

  const pushedFile = path.win32.join(ctx.paths.featureDataDir('policy'), 'inbox-pushed.json');
  const rawPushed = readJsonSafe<any>(pushedFile, {}).data;
  const pushedMap: Record<string, PushedEntry> = {};

  if (Array.isArray(rawPushed)) {
    for (const id of rawPushed) {
      if (typeof id === 'string') {
        pushedMap[id] = { s3_id: id, pushed_at: new Date().toISOString() };
      }
    }
  } else if (rawPushed && typeof rawPushed === 'object') {
    for (const [k, v] of Object.entries(rawPushed)) {
      if (v && typeof v === 'object' && 's3_id' in v) {
        pushedMap[k] = v as PushedEntry;
      } else {
        pushedMap[k] = { s3_id: String(v || k), pushed_at: new Date().toISOString() };
      }
    }
  }

  const attentionItems = collectAttentionItems(ctx);
  const currentAttIdSet = new Set(attentionItems.map((it) => it.id));
  let changed = false;

  // N3: Reconcile the inbox: close S3 items whose S4 attention item is gone
  for (const [attId, entry] of Object.entries(pushedMap)) {
    if (!currentAttIdSet.has(attId)) {
      if (typeof inbox.updateInboxItemStatus === 'function') {
        try {
          inbox.updateInboxItemStatus(ctx.paths, entry.s3_id, 'done', {
            action: 'done',
            by: 's4',
            at: new Date().toISOString(),
          });
        } catch {}
      }
      delete pushedMap[attId];
      changed = true;
    }
  }

  // Push open attention items to S3
  for (const item of attentionItems) {
    if (pushedMap[item.id]) continue;

    let kind = 'custom';
    let actions: string[] = ['dismiss'];
    const severity = item.severity || 'info';

    if (item.kind.includes('block')) {
      kind = 'budget_block';
      actions = ['open', 'dismiss'];
    } else if (item.kind.includes('warn')) {
      kind = 'custom';
      actions = ['dismiss'];
    } else if (item.kind === 'fallback_suggest') {
      kind = 'rate_limited';
      actions = ['retry', 'dismiss'];
    } else if (item.kind === 'waiting') {
      kind = 'rate_limited';
      actions = ['retry', 'dismiss'];
    } else if (item.kind === 'recovery_gave_up' || item.kind === 'recovery_failed') {
      kind = 'failed';
      actions = ['retry', 'dismiss'];
    } else if (item.kind === 'approval_pending') {
      kind = 'approval';
      actions = ['approve', 'reject'];
    } else if (item.kind === 'policy_violation') {
      kind = 'blocked';
      actions = ['open', 'dismiss'];
    } else if (item.kind === 'gate_red' || item.kind === 'checks_gate') {
      kind = 'blocked';
      actions = ['open', 'dismiss'];
    }

    if (!VALID_INBOX_KINDS.has(kind)) {
      kind = 'custom';
    }
    actions = actions.filter((act) => VALID_INBOX_ACTIONS.has(act));
    if (actions.length === 0) {
      actions = ['dismiss'];
    }

    const recAction = item.actions?.find((a) => a.action === 'recovery_apply');
    const recId = (recAction?.body as any)?.id;
    const aprAction = item.actions?.find((a) => a.action === 'policy_approve');
    const aprId = (aprAction?.body as any)?.id;

    // N1: Rebuild run body for recovery/fallback items so S3 can run it on retry
    let retryBody: Record<string, unknown> | null = null;
    if (recId) {
      const fallbackDir = ctx.paths.featureDataDir('fallback');
      const recFile = path.win32.join(fallbackDir, 'recovery.json');
      const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;
      const recItem = recData.items.find((r) => r.id === recId);
      if (recItem) {
        const sourceMetaFile = path.win32.join(ctx.paths.jobsDir, `${recItem.source_job_id}.json`);
        const promptFile = path.win32.join(ctx.paths.jobsDir, `${recItem.source_job_id}.prompt.txt`);
        let meta: Record<string, unknown> = {};
        if (fs.existsSync(sourceMetaFile)) {
          try {
            meta = JSON.parse(fs.readFileSync(sourceMetaFile, 'utf8'));
          } catch {}
        }
        if (Object.keys(meta).length > 0) {
          try {
            let body = rebuildRunBody(meta, promptFile);
            const targetAgent = recItem.fallback_agent || recItem.agent;
            const validAgentIds = new Set(ctx.registry.agents.map((a) => a.id.toLowerCase()));
            if (
              targetAgent &&
              targetAgent !== recItem.agent &&
              recItem.agent !== 'unknown' &&
              validAgentIds.has(recItem.agent) &&
              validAgentIds.has(targetAgent)
            ) {
              body = replaceAgent(body, recItem.agent, targetAgent);
            }
            retryBody = body;
          } catch {
            retryBody = null;
          }
        }
      }
    }

    // Only offer 'retry' when a run body can be rebuilt; otherwise offer [open, dismiss]
    if (actions.includes('retry')) {
      if (!retryBody) {
        actions = actions.filter((a) => a !== 'retry');
        if (!actions.includes('open')) {
          actions.unshift('open');
        }
      }
    }

    const input: InboxItemInput = {
      kind,
      title: item.title,
      severity,
      detail: item.detail,
      job_id: item.job_id,
      project: item.project_path,
      source: 's4',
      ref: {
        s4: true,
        attention_id: item.id,
        source_kind: item.kind,
        recovery_id: recId,
        approval_id: aprId,
        actions: item.actions,
      },
      actions,
      retry: retryBody ?? undefined,
      dedupe_key: item.id,
    };

    try {
      const res = await inbox.addInboxItem(ctx.paths, input, { onlyIfAbsent: true });
      const s3Id = (res as any)?.item?.id || item.id;
      pushedMap[item.id] = { s3_id: s3Id, pushed_at: new Date().toISOString() };
      changed = true;
    } catch {
      // Ignore individual add errors
    }
  }

  if (changed) {
    const entries = Object.entries(pushedMap);
    const boundedMap: Record<string, PushedEntry> = {};
    for (const [k, v] of entries.slice(-2000)) {
      boundedMap[k] = v;
    }
    writeJsonAtomic(pushedFile, boundedMap);
  }
}
