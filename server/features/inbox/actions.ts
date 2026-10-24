import fs from 'node:fs';
import path from 'node:path';
import type { MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { isProcessRunning } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { getJobFlags, runJobScanner } from './scanner.ts';
import {
  addInboxItem,
  clearInboxItems,
  fireInboxResolved,
  getInboxItem,
  readInboxData,
  unmarkInboxResolved,
  updateInboxItemStatus,
  writeInboxData,
  type InboxAction,
  type InboxItem,
  type InboxKind,
  type InboxSeverity,
  type InboxStatus,
} from './store.ts';

const VALID_KINDS = new Set<InboxKind>([
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

const VALID_ACTIONS = new Set<InboxAction>([
  'open',
  'retry',
  'login',
  'approve',
  'reject',
  'reply',
  'dismiss',
]);

function logInboxAudit(
  ctx: MawFeatureContext,
  id: string,
  action: string,
  by: string
): void {
  try {
    const dataDir = ctx.paths.featureDataDir('inbox');
    const auditFile = path.win32.join(dataDir, 'audit.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      id,
      action,
      by,
    }) + '\n';
    fs.appendFileSync(auditFile, line, 'utf8');
  } catch {
    // Ignore audit log error
  }
}

export async function handleInboxList(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  // Run scanner on list call to pick up fresh jobs
  await runJobScanner(ctx.paths);

  const query = req.query;
  const statusParam = (query.get('status') ?? 'open').trim().toLowerCase();
  const kindParam = query.get('kind')?.trim().toLowerCase();
  const sourceParam = query.get('source')?.trim().toLowerCase();
  const limitParam = Number.parseInt(query.get('limit') ?? '50', 10);
  const limit = Math.max(1, Math.min(500, Number.isInteger(limitParam) ? limitParam : 50));

  const data = readInboxData(ctx.paths);
  let filtered = data.items;

  if (statusParam === 'open') {
    filtered = filtered.filter((it) => it.status === 'open');
  }

  if (kindParam) {
    filtered = filtered.filter((it) => it.kind.toLowerCase() === kindParam);
  }

  if (sourceParam) {
    filtered = filtered.filter((it) => it.source.toLowerCase() === sourceParam);
  }

  const countsByKind: Record<string, number> = {};
  let openCount = 0;
  for (const it of data.items) {
    if (it.status === 'open') {
      openCount++;
      countsByKind[it.kind] = (countsByKind[it.kind] ?? 0) + 1;
    }
  }

  const resultItems = filtered.slice(0, limit);

  return {
    ok: true,
    items: resultItems,
    counts: {
      open: openCount,
      by_kind: countsByKind,
    },
  };
}

export function handleInboxGet(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const id = req.query.get('id');
  if (!id || id.trim() === '') {
    throw new ApiValidationError("Missing 'id' parameter.", 400);
  }
  const item = getInboxItem(ctx.paths, id.trim());
  if (!item) {
    throw new ApiValidationError(`Inbox item '${id}' not found.`, 404);
  }
  return {
    ok: true,
    item,
  };
}

export function handleInboxAdd(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const body = req.body;
  const kind = String(body.kind ?? '').trim() as InboxKind;
  if (!VALID_KINDS.has(kind)) {
    throw new ApiValidationError(
      `Invalid kind '${kind}'. Allowed: ${Array.from(VALID_KINDS).join(', ')}`,
      400
    );
  }

  const title = String(body.title ?? '').trim();
  if (title.length < 1 || title.length > 200) {
    throw new ApiValidationError("Title must be between 1 and 200 characters.", 400);
  }

  let detail: string | undefined;
  if (body.detail !== undefined && body.detail !== null) {
    detail = String(body.detail).slice(0, 2000);
  }

  let refObj: Record<string, unknown> | undefined;
  if (body.ref !== undefined && body.ref !== null) {
    if (typeof body.ref !== 'object' || Array.isArray(body.ref)) {
      throw new ApiValidationError("Property 'ref' must be an object.", 400);
    }
    const refStr = JSON.stringify(body.ref);
    if (refStr.length > 4096) {
      throw new ApiValidationError("Property 'ref' must not exceed 4 KB.", 400);
    }
    refObj = body.ref as Record<string, unknown>;
  }

  let actionsList: InboxAction[] | undefined;
  if (body.actions !== undefined && body.actions !== null) {
    if (!Array.isArray(body.actions)) {
      throw new ApiValidationError("Property 'actions' must be an array.", 400);
    }
    for (const a of body.actions) {
      if (!VALID_ACTIONS.has(a as InboxAction)) {
        throw new ApiValidationError(
          `Invalid action '${String(a)}'. Allowed: ${Array.from(VALID_ACTIONS).join(', ')}`,
          400
        );
      }
    }
    actionsList = body.actions as InboxAction[];
  }

  let severity: InboxSeverity | undefined;
  if (body.severity) {
    const sev = String(body.severity).trim().toLowerCase() as InboxSeverity;
    if (sev === 'info' || sev === 'warn' || sev === 'error') {
      severity = sev;
    }
  }

  const { item, created } = addInboxItem(ctx.paths, {
    kind,
    title,
    severity,
    detail,
    agent: body.agent ? String(body.agent).trim() : undefined,
    role: body.role ? String(body.role).trim() : undefined,
    job_id: body.job_id ? String(body.job_id).trim() : undefined,
    project: body.project ? String(body.project).trim() : undefined,
    source: body.source ? String(body.source).trim() : 'api',
    ref: refObj,
    actions: actionsList,
    dedupe_key: body.dedupe_key ? String(body.dedupe_key).trim() : undefined,
  });

  return {
    ok: true,
    item,
    created,
  };
}

const inFlightActionIds = new Set<string>();

function tryAcquireInboxClaim(paths: ServerPaths, id: string, isRetry = false): { release: () => void } {
  const claimsDir = path.win32.join(paths.featureDataDir('inbox'), 'claims');
  if (!fs.existsSync(claimsDir)) {
    fs.mkdirSync(claimsDir, { recursive: true });
  }
  const claimFile = path.win32.join(claimsDir, `${id}.lock`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(claimFile, 'wx');
    const claimData = JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n';
    fs.writeFileSync(fd, claimData, 'utf8');
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      if (!isRetry) {
        let isStale = false;
        try {
          const raw = fs.readFileSync(claimFile, 'utf8');
          const data = JSON.parse(raw);
          const pid = Number(data.pid);
          const ts = Number(data.ts);
          if (ts && Date.now() - ts > 120_000) {
            isStale = true;
          } else if (pid && !isProcessRunning(pid)) {
            isStale = true;
          }
        } catch {
          // Corrupt or unreadable claim file is treated as stale
          isStale = true;
        }

        if (isStale) {
          const staleFile = `${claimFile}.stale.${Date.now()}.${Math.random().toString(36).slice(2)}`;
          try {
            fs.renameSync(claimFile, staleFile);
            try {
              fs.unlinkSync(staleFile);
            } catch {
              // ignore
            }
            return tryAcquireInboxClaim(paths, id, true);
          } catch {
            // Another process won rename race, retry claim once
            return tryAcquireInboxClaim(paths, id, true);
          }
        }
      }
      throw new ApiValidationError(`Inbox item '${id}' is already being processed.`, 409);
    }
    throw err;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  return {
    release: () => {
      try {
        fs.unlinkSync(claimFile);
      } catch {
        // Ignore unlink error
      }
    },
  };
}

export async function performInboxAction(
  ctx: MawFeatureContext,
  id: string,
  action: string,
  text?: string,
  by?: string
): Promise<Record<string, unknown>> {
  const normAction = action.trim().toLowerCase();
  const allowedActs = new Set(['dismiss', 'done', 'retry', 'approve', 'reject', 'reply']);
  if (!allowedActs.has(normAction)) {
    throw new ApiValidationError(
      `Invalid action '${action}'. Allowed: dismiss, done, retry, approve, reject, reply`,
      400
    );
  }

  // Acquire claim lock FIRST for every state-changing action (Codex Review #3 Item 2)
  const claim = tryAcquireInboxClaim(ctx.paths, id);
  inFlightActionIds.add(id);

  try {
    // Re-read item from disk AFTER acquiring the claim lock
    const item = getInboxItem(ctx.paths, id);
    if (!item) {
      throw new ApiValidationError(`Inbox item '${id}' not found.`, 404);
    }

    // Check status after claim acquisition
    if (item.status !== 'open') {
      // Dismiss on an already-dismissed item is idempotent
      if (normAction === 'dismiss' && item.status === 'dismissed') {
        return {
          ok: true,
          item,
        };
      }
      throw new ApiValidationError(`Inbox item '${id}' is already resolved (${item.status}).`, 409);
    }

    // Action must be in item.actions, unless it is dismiss (which is always allowed)
    if (normAction !== 'dismiss' && !item.actions.includes(normAction as InboxAction)) {
      throw new ApiValidationError(
        `Action '${normAction}' is not allowed for item '${id}' (allowed: ${item.actions.join(', ')})`,
        400
      );
    }

    const resolvedBy = by || 'ui';
    const now = new Date().toISOString();
    logInboxAudit(ctx, id, normAction, resolvedBy);

    if (normAction === 'dismiss' || normAction === 'done' || normAction === 'approve' || normAction === 'reject') {
      const newStatus: InboxStatus =
        normAction === 'dismiss'
          ? 'dismissed'
          : normAction === 'done'
            ? 'done'
            : normAction === 'approve'
              ? 'approved'
              : 'rejected';

      const resolution = {
        action: normAction,
        text: text ? String(text).slice(0, 4000) : undefined,
        by: resolvedBy,
        at: now,
      };

      const updated = updateInboxItemStatus(ctx.paths, id, newStatus, resolution);
      if (updated) {
        await fireInboxResolved(updated);
      }
      return {
        ok: true,
        item: updated,
      };
    }

    if (normAction === 'retry') {
      if (!item.retry) {
        throw new ApiValidationError(`Inbox item '${id}' has no retry configuration.`, 400);
      }

      const jobResult = await ctx.startJob(item.retry as unknown as Record<string, unknown>);
      const newJobId = (jobResult.job_id as string) ?? '';

      const resolution = {
        action: 'retry',
        by: resolvedBy,
        at: now,
        job_id: newJobId,
      };

      const updated = updateInboxItemStatus(ctx.paths, id, 'done', resolution);
      if (updated) {
        await fireInboxResolved(updated);
      }

      return {
        ok: true,
        item: updated,
        job_id: newJobId,
      };
    }

    if (normAction === 'reply') {
      const rawText = String(text ?? '').trim();
      if (rawText.length < 1 || rawText.length > 4000) {
        throw new ApiValidationError("Reply text must be between 1 and 4000 characters.", 400);
      }

      const resolution = {
        action: 'reply',
        text: rawText,
        by: resolvedBy,
        at: now,
      };

      const updated = updateInboxItemStatus(ctx.paths, id, 'done', resolution);
      try {
        let handled = false;
        if (updated) {
          handled = await fireInboxResolved(updated);
        }

        let followUpJobId: string | null = null;
        if (!handled && item.retry) {
          const originalPrompt = item.retry.prompt ?? '';
          const followUpPrompt = `${originalPrompt}\n\n## Follow-up from the user\n${rawText}`.trim();
          const followUpBody = {
            ...item.retry,
            prompt: followUpPrompt,
          };
          const jobRes = await ctx.startJob(followUpBody as unknown as Record<string, unknown>);
          followUpJobId = (jobRes?.job_id as string) ?? null;
          if (updated && followUpJobId) {
            updated.resolution = {
              ...resolution,
              job_id: followUpJobId,
            };
            const data = readInboxData(ctx.paths);
            const idx = data.items.findIndex((it) => it.id === updated.id);
            if (idx !== -1) {
              data.items[idx] = updated;
              writeInboxData(ctx.paths, data);
            }
          }
        }

        return {
          ok: true,
          item: updated,
          job_id: followUpJobId,
        };
      } catch (err) {
        // Roll back to 'open' and clear resolution if follow-up job start fails
        updateInboxItemStatus(ctx.paths, id, 'open', null);
        unmarkInboxResolved(id);
        throw err;
      }
    }

    throw new ApiValidationError(`Unsupported action '${normAction}'.`, 400);
  } finally {
    inFlightActionIds.delete(id);
    claim.release();
  }
}

export async function handleInboxAct(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const body = req.body;
  const id = String(body.id ?? '').trim();
  if (!id) {
    throw new ApiValidationError("Missing 'id' in request body.", 400);
  }

  const action = String(body.action ?? '').trim().toLowerCase();
  const text = body.text !== undefined && body.text !== null ? String(body.text) : undefined;

  // Always force by = 'ui' for inbox_act HTTP calls (Item 12)
  return await performInboxAction(ctx, id, action, text, 'ui');
}

export function handleInboxClear(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const statusParam = String(req.body.status ?? '').trim().toLowerCase();
  if (statusParam !== 'dismissed' && statusParam !== 'done') {
    throw new ApiValidationError("Status to clear must be 'dismissed' or 'done'.", 400);
  }

  const removed = clearInboxItems(ctx.paths, statusParam);
  return {
    ok: true,
    removed,
  };
}

export function buildInboxStatusContribution(paths: ServerPaths): Record<string, unknown> {
  const data = readInboxData(paths);
  const bySeverity = { error: 0, warn: 0, info: 0 };
  const openItems: InboxItem[] = [];

  for (const it of data.items) {
    if (it.status === 'open') {
      openItems.push(it);
      if (it.severity in bySeverity) {
        bySeverity[it.severity]++;
      }
    }
  }

  // 5 newest open items, without retry.prompt
  const latestFive = openItems.slice(0, 5).map((it) => {
    const clone = { ...it };
    if (clone.retry) {
      const retryClone = { ...clone.retry };
      delete retryClone.prompt;
      clone.retry = retryClone;
    }
    return clone;
  });

  return {
    open: openItems.length,
    by_severity: bySeverity,
    latest: latestFive,
    job_flags: getJobFlags(),
  };
}
