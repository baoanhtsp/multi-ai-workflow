import fs from 'node:fs';
import path from 'node:path';
import type { MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
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
  withItemsLock,
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
  const rawId = req.query.get('id');
  if (!rawId || rawId.trim() === '') {
    throw new ApiValidationError("Missing 'id' parameter.", 400);
  }
  const id = rawId.trim().toLowerCase();
  if (!/^i[0-9a-z]{6}$/i.test(id)) {
    throw new ApiValidationError(`Invalid inbox item id '${rawId}'. Expected format ^i[0-9a-z]{6}$.`, 400);
  }
  reconcilePendingClaim(ctx.paths, id);
  const item = getInboxItem(ctx.paths, id);
  if (!item) {
    throw new ApiValidationError(`Inbox item '${rawId}' not found.`, 404);
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

export interface InboxClaim {
  claimFile: string;
  keep: () => void;
  release: () => void;
}

export function reconcilePendingClaim(paths: ServerPaths, id: string): boolean {
  const normId = String(id ?? '').trim().toLowerCase();
  if (!/^i[0-9a-z]{6}$/i.test(normId)) {
    return false;
  }
  const claimsDir = path.win32.join(paths.featureDataDir('inbox'), 'claims');
  const claimFile = path.win32.join(claimsDir, `${normId}.lock`);
  if (!isFileSafe(claimFile)) {
    return false;
  }
  try {
    const raw = fs.readFileSync(claimFile, 'utf8');
    const data = JSON.parse(raw);
    if (data?.resolution?.job_id) {
      try {
        updateInboxItemStatus(paths, normId, 'done', data.resolution);
        try {
          fs.unlinkSync(claimFile);
        } catch {
          // ignore
        }
        return true;
      } catch {
        // Store may be temporarily busy, leave claim for next attempt
        return false;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function reconcilePendingClaims(paths: ServerPaths): number {
  const claimsDir = path.win32.join(paths.featureDataDir('inbox'), 'claims');
  if (!isDirectorySafe(claimsDir)) {
    return 0;
  }
  let count = 0;
  try {
    const files = fs.readdirSync(claimsDir);
    for (const f of files) {
      if (!f.endsWith('.lock')) continue;
      const id = f.slice(0, -5).toLowerCase();
      if (!/^i[0-9a-z]{6}$/i.test(id)) continue;
      if (reconcilePendingClaim(paths, id)) {
        count++;
      }
    }
  } catch {
    // ignore
  }
  return count;
}

const inFlightActionIds = new Set<string>();

function tryAcquireInboxClaim(paths: ServerPaths, id: string, isRetry = false): InboxClaim {
  const normId = String(id ?? '').trim().toLowerCase();
  if (!/^i[0-9a-z]{6}$/i.test(normId)) {
    throw new ApiValidationError(`Invalid inbox item id '${id}'. Expected format ^i[0-9a-z]{6}$.`, 400);
  }
  const claimsDir = path.win32.join(paths.featureDataDir('inbox'), 'claims');
  if (!fs.existsSync(claimsDir)) {
    fs.mkdirSync(claimsDir, { recursive: true });
  }
  const resolvedClaimsDir = path.win32.resolve(claimsDir);
  const claimFile = path.win32.resolve(path.win32.join(resolvedClaimsDir, `${normId}.lock`));
  if (!claimFile.startsWith(resolvedClaimsDir + '\\')) {
    throw new ApiValidationError(`Invalid inbox item id '${id}'. Path traversal detected.`, 400);
  }

  // Reconcile pending claim if one already exists (Codex Review #5 Item 2)
  reconcilePendingClaim(paths, normId);

  let fd: number | null = null;
  try {
    fd = fs.openSync(claimFile, 'wx');
    const claimData = JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n';
    fs.writeFileSync(fd, claimData, 'utf8');
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      // Check if existing claim records a pending resolution with job_id
      try {
        const raw = fs.readFileSync(claimFile, 'utf8');
        const data = JSON.parse(raw);
        if (data?.resolution?.job_id) {
          try {
            updateInboxItemStatus(paths, normId, 'done', data.resolution);
            try {
              fs.unlinkSync(claimFile);
            } catch {
              // ignore
            }
            throw new ApiValidationError(`Inbox item '${normId}' is already resolved (done).`, 409);
          } catch (updateErr: any) {
            if (updateErr instanceof ApiValidationError) throw updateErr;
            throw new ApiValidationError(`Inbox item '${normId}' is already being processed (pending store update).`, 409);
          }
        }
      } catch (parseErr: any) {
        if (parseErr instanceof ApiValidationError) throw parseErr;
      }

      if (!isRetry) {
        let isStale = false;
        let judgedPid: number | undefined;
        let judgedTs: number | undefined;
        let judgedRaw: string | undefined;

        try {
          judgedRaw = fs.readFileSync(claimFile, 'utf8');
          const data = JSON.parse(judgedRaw);
          const pid = Number(data?.pid);
          judgedPid = pid;
          judgedTs = Number(data?.ts);
          if (pid > 0) {
            if (!isProcessRunning(pid)) {
              isStale = true;
            }
          } else {
            const stat = fs.statSync(claimFile);
            if (Date.now() - stat.mtimeMs > 600_000) {
              isStale = true;
            }
          }
        } catch {
          // Corrupt or unreadable claim file: stale ONLY if > 10m old
          try {
            const stat = fs.statSync(claimFile);
            if (Date.now() - stat.mtimeMs > 600_000) {
              isStale = true;
            }
          } catch {
            // ignore
          }
        }

        if (isStale) {
          const staleFile = `${claimFile}.stale.${Date.now()}.${Math.random().toString(36).slice(2)}`;
          try {
            fs.renameSync(claimFile, staleFile);

            // Stale-lock TOCTOU protection (Codex Review #5 Item 1):
            // Between judging stale and renaming, another process may have replaced the file
            // with a live lock. After renaming, read the renamed file: if its pid/ts differ
            // from what was judged stale (i.e. it is someone's fresh lock), put it back
            // with fs.linkSync(staleFile, claimFile) (fails if a new lock already exists — then leave it)
            // and unlink the stale name only when it really was the stale one; then retry.
            let isSameAsJudged = false;
            try {
              const checkRaw = fs.readFileSync(staleFile, 'utf8');
              const checkData = JSON.parse(checkRaw);
              if (judgedPid !== undefined && judgedTs !== undefined) {
                isSameAsJudged = checkData?.pid === judgedPid && checkData?.ts === judgedTs;
              } else if (judgedRaw !== undefined) {
                isSameAsJudged = checkRaw === judgedRaw;
              } else {
                const stat = fs.statSync(staleFile);
                isSameAsJudged = Date.now() - stat.mtimeMs > 600_000;
              }
            } catch {
              isSameAsJudged = (judgedPid === undefined);
            }

            if (isSameAsJudged) {
              try {
                fs.unlinkSync(staleFile);
              } catch {
                // ignore
              }
            } else {
              // Live lock was swapped in before rename! Restore it.
              try {
                fs.linkSync(staleFile, claimFile);
              } catch {
                // Fails if a new lock already exists — then leave it
              }
            }
            return tryAcquireInboxClaim(paths, normId, true);
          } catch {
            // Another process won rename race, retry claim once
            return tryAcquireInboxClaim(paths, normId, true);
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

  let keepClaim = false;
  return {
    claimFile,
    keep: () => {
      keepClaim = true;
    },
    release: () => {
      if (!keepClaim) {
        try {
          fs.unlinkSync(claimFile);
        } catch {
          // Ignore unlink error
        }
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
  const normId = String(id ?? '').trim().toLowerCase();
  if (!/^i[0-9a-z]{6}$/i.test(normId)) {
    throw new ApiValidationError(
      `Invalid inbox item id '${id}'. Expected format ^i[0-9a-z]{6}$.`,
      400
    );
  }

  const normAction = action.trim().toLowerCase();
  const allowedActs = new Set(['dismiss', 'done', 'retry', 'approve', 'reject', 'reply']);
  if (!allowedActs.has(normAction)) {
    throw new ApiValidationError(
      `Invalid action '${action}'. Allowed: dismiss, done, retry, approve, reject, reply`,
      400
    );
  }

  // Acquire claim lock FIRST for every state-changing action (Codex Review #3 Item 2)
  const claim = tryAcquireInboxClaim(ctx.paths, normId);
  inFlightActionIds.add(normId);

  try {
    // Re-read item from disk AFTER acquiring the claim lock
    const item = getInboxItem(ctx.paths, normId);
    if (!item) {
      throw new ApiValidationError(`Inbox item '${normId}' not found.`, 404);
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
      throw new ApiValidationError(`Inbox item '${normId}' is already resolved (${item.status}).`, 409);
    }

    // Action must be in item.actions, unless it is dismiss (which is always allowed)
    if (normAction !== 'dismiss' && !item.actions.includes(normAction as InboxAction)) {
      throw new ApiValidationError(
        `Action '${normAction}' is not allowed for item '${normId}' (allowed: ${item.actions.join(', ')})`,
        400
      );
    }

    const resolvedBy = by || 'ui';
    const now = new Date().toISOString();
    logInboxAudit(ctx, normId, normAction, resolvedBy);

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

      const updated = updateInboxItemStatus(ctx.paths, normId, newStatus, resolution);
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
        throw new ApiValidationError(`Inbox item '${normId}' has no retry configuration.`, 400);
      }

      const jobResult = await ctx.startJob(item.retry as unknown as Record<string, unknown>);
      const newJobId = (jobResult.job_id as string) ?? '';

      const resolution = {
        action: 'retry',
        by: resolvedBy,
        at: now,
        job_id: newJobId,
      };

      // Before releasing the claim, if startJob succeeded, write the resolution (job_id) into the CLAIM file
      try {
        const claimContent = JSON.stringify({
          pid: process.pid,
          ts: Date.now(),
          resolution,
        }) + '\n';
        fs.writeFileSync(claim.claimFile, claimContent, 'utf8');
      } catch {
        // ignore
      }

      // Make the store update retry (up to 3 x 2s)
      let updated: InboxItem | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          updated = updateInboxItemStatus(ctx.paths, normId, 'done', resolution);
          break;
        } catch (err: any) {
          if (attempt === 2) {
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (updated) {
        await fireInboxResolved(updated);
        return {
          ok: true,
          item: updated,
          job_id: newJobId,
        };
      }

      // Store update failed all 3 attempts: KEEP the claim file and return pending_store_update
      claim.keep();
      return {
        ok: true,
        job_id: newJobId,
        pending_store_update: true,
      };
    }

    if (normAction === 'reply') {
      const rawText = String(text ?? '').trim();
      if (rawText.length < 1 || rawText.length > 4000) {
        throw new ApiValidationError("Reply text must be between 1 and 4000 characters.", 400);
      }

      let followUpJobId: string | null = null;
      if (item.retry) {
        const originalPrompt = item.retry.prompt ?? '';
        const followUpPrompt = `${originalPrompt}\n\n## Follow-up from the user\n${rawText}`.trim();
        const followUpBody = {
          ...item.retry,
          prompt: followUpPrompt,
        };
        const jobRes = await ctx.startJob(followUpBody as unknown as Record<string, unknown>);
        followUpJobId = (jobRes?.job_id as string) ?? null;
      }

      const resolution = {
        action: 'reply',
        text: rawText,
        by: resolvedBy,
        at: now,
        job_id: followUpJobId ?? undefined,
      };

      if (followUpJobId) {
        // Before releasing the claim, if startJob succeeded, write the resolution (job_id) into the CLAIM file
        try {
          const claimContent = JSON.stringify({
            pid: process.pid,
            ts: Date.now(),
            resolution,
          }) + '\n';
          fs.writeFileSync(claim.claimFile, claimContent, 'utf8');
        } catch {
          // ignore
        }
      }

      // Make the store update retry (up to 3 x 2s)
      let updated: InboxItem | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          updated = updateInboxItemStatus(ctx.paths, normId, 'done', resolution);
          break;
        } catch (err: any) {
          if (attempt === 2) {
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (updated) {
        await fireInboxResolved(updated);
        return {
          ok: true,
          item: updated,
          job_id: followUpJobId,
        };
      }

      if (followUpJobId) {
        // Store update failed, but follow-up job started: KEEP claim file and return pending_store_update
        // NEVER roll back to open once its follow-up job started!
        claim.keep();
        return {
          ok: true,
          job_id: followUpJobId,
          pending_store_update: true,
        };
      }

      throw new ApiValidationError("Inbox is busy, try again.", 503);
    }

    throw new ApiValidationError(`Unsupported action '${normAction}'.`, 400);
  } finally {
    inFlightActionIds.delete(normId);
    claim.release();
  }
}

export async function handleInboxAct(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const body = req.body;
  const rawId = String(body.id ?? '').trim();
  if (!rawId) {
    throw new ApiValidationError("Missing 'id' in request body.", 400);
  }
  const id = rawId.toLowerCase();
  if (!/^i[0-9a-z]{6}$/i.test(id)) {
    throw new ApiValidationError(
      `Invalid inbox item id '${rawId}'. Expected format ^i[0-9a-z]{6}$.`,
      400
    );
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
