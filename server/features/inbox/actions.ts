import fs from 'node:fs';
import path from 'node:path';
import {
  appendActionAudit,
  type MawFeatureContext,
  type MawFeatureRequest,
} from '../../lib/feature.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { isProcessRunning } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { acquireFileLock, acquireRecoverMutex } from './lockfile.ts';
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
  appendActionAudit(ctx.paths, {
    feature: 'inbox',
    action,
    id,
    by,
  });
}

function atomicWriteJournal(claimFile: string, data: Record<string, unknown>): void {
  const tmpFile = `${claimFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(data) + '\n', 'utf8');
  fs.renameSync(tmpFile, claimFile);
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
  pid: number;
  ts: number;
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

  let raw = '';
  let data: any = null;
  let isCorrupt = false;
  try {
    raw = fs.readFileSync(claimFile, 'utf8');
    data = JSON.parse(raw);
  } catch {
    isCorrupt = true;
  }

  if (!isCorrupt) {
    const pid = Number(data?.pid);
    const isDead = pid > 0 ? !isProcessRunning(pid) : false;
    const hasResolution = Boolean(data?.resolution?.job_id || data?.resolution);

    // If owner is alive and does not have a pending completed resolution, leave it alone
    if (!isDead && !hasResolution) {
      return false;
    }
  }

  const recoverPath = claimFile + '.recover';
  const mutex = acquireRecoverMutex(recoverPath, 10_000);
  if (!mutex) {
    return false;
  }

  try {
    // Under .recover mutex: RE-READ claimFile and re-decide (Codex Review #7 Item 1)
    let currentRaw = '';
    let currentData: any = null;
    let currentCorrupt = false;
    try {
      currentRaw = fs.readFileSync(claimFile, 'utf8');
      currentData = JSON.parse(currentRaw);
    } catch {
      currentCorrupt = true;
    }

    let finalResolution: any = null;

    if (currentCorrupt) {
      // Codex Review #7 Item 2: treat corrupt claim like an interrupted one
      finalResolution = {
        action: 'retry',
        by: 'ui',
        at: new Date().toISOString(),
        note: 'interrupted \u2014 check the job list',
      };
    } else {
      const currentPid = Number(currentData?.pid);
      const currentDead = currentPid > 0 ? !isProcessRunning(currentPid) : false;
      const currentHasResolution = Boolean(currentData?.resolution);

      if (!currentHasResolution) {
        // Re-decide: must be same content AND owner PID still dead
        if (currentRaw !== raw || !currentDead) {
          // Release mutex and go back to normal acquire path
          return false;
        }
      }

      if (currentHasResolution) {
        finalResolution = currentData.resolution;
      } else if (currentData?.state === 'replying') {
        // Codex Review #7 Item 3: recovered "replying" claim resolves to done with stored reply and note
        finalResolution = {
          action: 'reply',
          text: currentData.text || '',
          by: currentData.by || 'ui',
          at: currentData.at || new Date().toISOString(),
          note: 'interrupted before follow-up',
        };
      } else if (currentData?.state === 'starting' || currentData?.state === 'started') {
        finalResolution = {
          action: currentData.action || 'retry',
          by: currentData.by || 'ui',
          at: currentData.at || new Date().toISOString(),
          ...(currentData.job_id ? { job_id: currentData.job_id } : {}),
          note: 'interrupted \u2014 check the job list',
        };
      } else if (currentDead) {
        // Dead owner before dispatch, no state or resolution. Just unlink stale claim file
        try { fs.unlinkSync(claimFile); } catch {}
        return true;
      } else {
        return false;
      }
    }

    try {
      const updated = updateInboxItemStatus(paths, normId, 'done', finalResolution);
      if (updated) {
        void fireInboxResolved(updated);
      }
      try { fs.unlinkSync(claimFile); } catch {}
      return true;
    } catch {
      return false;
    }
  } finally {
    mutex.release();
  }
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

function tryAcquireInboxClaim(paths: ServerPaths, id: string): InboxClaim {
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

  const handle = acquireFileLock(claimFile, {
    timeoutMs: 0,
    onRecoverDeadOwner: (deadContent, deadParsed) => {
      let res: any = null;
      if (!deadParsed) {
        res = {
          action: 'retry',
          by: 'ui',
          at: new Date().toISOString(),
          note: 'interrupted \u2014 check the job list',
        };
      } else if (deadParsed.resolution) {
        res = deadParsed.resolution;
      } else if (deadParsed.state === 'replying') {
        res = {
          action: 'reply',
          text: deadParsed.text || '',
          by: deadParsed.by || 'ui',
          at: deadParsed.at || new Date().toISOString(),
          note: 'interrupted before follow-up',
        };
      } else if (deadParsed.state === 'starting' || deadParsed.state === 'started') {
        res = {
          action: deadParsed.action || 'retry',
          by: deadParsed.by || 'ui',
          at: deadParsed.at || new Date().toISOString(),
          ...(deadParsed.job_id ? { job_id: deadParsed.job_id } : {}),
          note: 'interrupted \u2014 check the job list',
        };
      }

      if (res) {
        const updated = updateInboxItemStatus(paths, normId, 'done', res);
        if (updated) {
          void fireInboxResolved(updated);
        }
        try { fs.unlinkSync(claimFile); } catch {}
        throw new ApiValidationError(`Inbox item '${normId}' is already resolved (done).`, 409);
      }
    },
  });

  return {
    claimFile,
    pid: handle.pid,
    ts: handle.ts,
    keep: handle.keep,
    release: handle.release,
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

      // 1. Journal BEFORE dispatch atomically (Codex Review #6 Item 2 & Review #7 Item 2)
      try {
        atomicWriteJournal(claim.claimFile, {
          pid: claim.pid,
          ts: claim.ts,
          state: 'starting',
          action: 'retry',
          by: resolvedBy,
          at: now,
        });
      } catch {
        throw new ApiValidationError("Failed to journal action before job start.", 503);
      }

      // 2. Dispatch job
      const jobResult = await ctx.startJob({
        ...(item.retry as unknown as Record<string, unknown>),
        source: { feature: 'inbox', inbox_id: normId },
      });
      const newJobId = (jobResult.job_id as string) ?? '';

      const resolution = {
        action: 'retry',
        by: resolvedBy,
        at: now,
        job_id: newJobId,
      };

      // 3. Journal AFTER dispatch atomically
      try {
        atomicWriteJournal(claim.claimFile, {
          pid: claim.pid,
          ts: claim.ts,
          state: 'started',
          action: 'retry',
          by: resolvedBy,
          at: now,
          job_id: newJobId,
          resolution,
        });
      } catch {
        // ignore
      }

      // 4. Update store (retry up to 3 x 2s)
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

      // Step 1: Journal { state: "replying", text } atomically BEFORE anything else (Codex Review #7 Item 3)
      try {
        atomicWriteJournal(claim.claimFile, {
          pid: claim.pid,
          ts: claim.ts,
          state: 'replying',
          action: 'reply',
          by: resolvedBy,
          at: now,
          text: rawText,
        });
      } catch {
        throw new ApiValidationError("Failed to journal reply before action.", 503);
      }

      const resolution = {
        action: 'reply',
        text: rawText,
        by: resolvedBy,
        at: now,
        job_id: undefined as string | undefined,
      };

      // Step 2: Fire listeners
      const tempItem: InboxItem = {
        ...item,
        status: 'done',
        resolution,
      };
      const handled = await fireInboxResolved(tempItem);

      // Step 3: If handled (or item has no retry): save done now
      if (handled || !item.retry) {
        let updated: InboxItem | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            updated = updateInboxItemStatus(ctx.paths, normId, 'done', resolution);
            break;
          } catch {
            if (attempt === 2) break;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        if (!updated) {
          throw new ApiValidationError("Inbox is busy, try again.", 503);
        }
        return {
          ok: true,
          item: updated,
        };
      }

      // Else: not handled AND item has retry:
      // a. Journal "starting" atomically
      try {
        atomicWriteJournal(claim.claimFile, {
          pid: claim.pid,
          ts: claim.ts,
          state: 'starting',
          action: 'reply',
          by: resolvedBy,
          at: now,
          text: rawText,
        });
      } catch {
        throw new ApiValidationError("Failed to journal action before job start.", 503);
      }

      // b. startJob
      const originalPrompt = item.retry.prompt ?? '';
      const followUpPrompt = `${originalPrompt}\n\n## Follow-up from the user\n${rawText}`.trim();
      const followUpBody = {
        ...item.retry,
        prompt: followUpPrompt,
        source: { feature: 'inbox', inbox_id: normId },
      };
      let followUpJobId = '';
      try {
        const jobRes = await ctx.startJob(followUpBody as unknown as Record<string, unknown>);
        followUpJobId = (jobRes?.job_id as string) ?? '';
      } catch (startErr) {
        // If follow-up job failed to start, roll back status to 'open' and re-throw
        unmarkInboxResolved(normId);
        try {
          updateInboxItemStatus(ctx.paths, normId, 'open', null as any);
        } catch {}
        throw startErr;
      }

      resolution.job_id = followUpJobId;

      // c. Journal "started" + job_id atomically
      try {
        atomicWriteJournal(claim.claimFile, {
          pid: claim.pid,
          ts: claim.ts,
          state: 'started',
          action: 'reply',
          by: resolvedBy,
          at: now,
          job_id: followUpJobId,
          text: rawText,
          resolution,
        });
      } catch {
        // ignore
      }

      // d. Save done with job_id
      let jobUpdated: InboxItem | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          jobUpdated = updateInboxItemStatus(ctx.paths, normId, 'done', resolution);
          break;
        } catch {
          if (attempt === 2) break;
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (jobUpdated) {
        return {
          ok: true,
          item: jobUpdated,
          job_id: followUpJobId,
        };
      }

      // Store update failed, follow-up job started: keep claim file
      claim.keep();
      return {
        ok: true,
        job_id: followUpJobId,
        pending_store_update: true,
      };
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
