import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFeatureContext, type MawFeatureContext } from '../../../lib/feature.ts';
import type { ServerPaths } from '../../../lib/paths.ts';
import { applyRecoveryItem, type RecoveryData } from '../../fallback/index.ts';
import {
  approvePolicyApproval,
  collectAttentionItems,
  dismissAttentionItem,
  rejectPolicyApproval,
  type PolicyApproval,
} from '../index.ts';
import { readJsonSafe, writeJsonAtomic, type AttentionItem } from './s4-core.ts';

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
  onInboxResolved?: (
    listener: (item: InboxItem) => Promise<boolean | void> | boolean | void
  ) => (() => void) | void;
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
        await approvePolicyApproval(ctx, targetApr.id, true);
        return true;
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
      const fallbackDir = ctx.paths.featureDataDir('fallback');
      const recFile = path.win32.join(fallbackDir, 'recovery.json');
      const recData = readJsonSafe<RecoveryData>(recFile, { processed_jobs: [], items: [] }).data;

      let targetRec = recoveryId ? recData.items.find((r) => r.id === recoveryId) : undefined;
      if (!targetRec && item.job_id) {
        targetRec = recData.items.find(
          (r) =>
            r.source_job_id === item.job_id &&
            (r.status === 'waiting' || r.status === 'suggested' || r.status === 'failed' || r.status === 'gave_up')
        );
      }
      if (!targetRec) {
        targetRec = recData.items.find(
          (r) =>
            (r.id === item.id || r.source_job_id === item.id) &&
            (r.status === 'waiting' || r.status === 'suggested' || r.status === 'failed' || r.status === 'gave_up')
        );
      }

      if (targetRec) {
        await applyRecoveryItem(ctx, targetRec.id);
        return true;
      }
      return false;
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
  const pushedData = readJsonSafe<string[]>(pushedFile, []).data;
  const pushedSet = new Set(pushedData);

  const attentionItems = collectAttentionItems(ctx);
  let changed = false;

  for (const item of attentionItems) {
    if (pushedSet.has(item.id)) continue;

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
      dedupe_key: item.id,
    };

    try {
      await inbox.addInboxItem(ctx.paths, input, { onlyIfAbsent: true });
      pushedSet.add(item.id);
      pushedData.push(item.id);
      changed = true;
    } catch {
      // Ignore individual add errors
    }
  }

  if (changed) {
    const bounded = pushedData.slice(-2000);
    writeJsonAtomic(pushedFile, bounded);
  }
}
