import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../lib/paths.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { redactSecrets } from '../health/probes.ts';

export type InboxKind =
  | 'needs_login'
  | 'needs_input'
  | 'failed'
  | 'blocked'
  | 'rate_limited'
  | 'review_changes'
  | 'budget_block'
  | 'approval'
  | 'handoff_done'
  | 'custom';

export type InboxSeverity = 'info' | 'warn' | 'error';

export type InboxAction =
  | 'open'
  | 'retry'
  | 'login'
  | 'approve'
  | 'reject'
  | 'reply'
  | 'dismiss';

export type InboxStatus =
  | 'open'
  | 'dismissed'
  | 'done'
  | 'approved'
  | 'rejected';

export interface InboxRetryInfo {
  mode?: string;
  agent?: string;
  role?: string;
  project_path?: string;
  prompt?: string;
  model?: string;
  effort?: string;
  team?: Record<string, string>;
  reviewers?: string[];
  implementer?: string;
}

export interface InboxResolution {
  action: string;
  text?: string;
  by: 'ui' | 'telegram' | string;
  at: string;
  job_id?: string;
}

export interface InboxItem {
  id: string; // ^i[0-9a-z]{6}$
  kind: InboxKind;
  severity: InboxSeverity;
  title: string;
  detail: string;
  agent?: string;
  role?: string;
  job_id?: string;
  project?: string;
  source: string;
  ref?: Record<string, unknown>;
  actions: InboxAction[];
  retry?: InboxRetryInfo;
  status: InboxStatus;
  resolution: InboxResolution | null;
  dedupe_key?: string;
  created_at: string;
  updated_at: string;
}

export interface InboxDataFile {
  version: number;
  items: InboxItem[];
}

export type InboxResolvedListener = (
  item: InboxItem
) => Promise<boolean | void> | boolean | void;

const listeners = new Set<InboxResolvedListener>();
const resolvedFiredIds = new Set<string>();

export function onInboxResolved(listener: InboxResolvedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function unmarkInboxResolved(id: string): void {
  resolvedFiredIds.delete(id);
}

export function resetInboxResolvedTracker(): void {
  resolvedFiredIds.clear();
}

export async function fireInboxResolved(item: InboxItem): Promise<boolean> {
  if (resolvedFiredIds.has(item.id)) {
    return false;
  }
  resolvedFiredIds.add(item.id);
  let handled = false;
  for (const listener of listeners) {
    try {
      const res = await listener(item);
      if (res === true) {
        handled = true;
      }
    } catch {
      // Ignore listener error
    }
  }
  return handled;
}

export function generateInboxId(): string {
  // ^i[0-9a-z]{6}$
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = 'i';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    out += chars[bytes[i]! % chars.length];
  }
  return out;
}

export function readInboxData(paths: ServerPaths): InboxDataFile {
  const dataDir = paths.featureDataDir('inbox');
  const itemsFile = path.win32.join(dataDir, 'items.json');
  if (!isFileSafe(itemsFile)) {
    return { version: 1, items: [] };
  }
  try {
    const raw = fs.readFileSync(itemsFile, 'utf8');
    const parsed = JSON.parse(raw) as InboxDataFile;
    if (parsed && Array.isArray(parsed.items)) {
      return parsed;
    }
  } catch {
    // Return empty on parse error
  }
  return { version: 1, items: [] };
}

export function writeInboxData(paths: ServerPaths, data: InboxDataFile): void {
  const dataDir = paths.featureDataDir('inbox');
  const itemsFile = path.win32.join(dataDir, 'items.json');

  // Prune items if > 500: dismissed / done are pruned first, oldest first
  if (data.items.length > 500) {
    const active: InboxItem[] = [];
    const closed: InboxItem[] = [];
    for (const item of data.items) {
      if (item.status === 'open') {
        active.push(item);
      } else {
        closed.push(item);
      }
    }
    const neededFromClosed = Math.max(0, 500 - active.length);
    const keptClosed = closed.slice(0, neededFromClosed);
    data.items = [...active, ...keptClosed].slice(0, 500);
  }

  const tempFile = `${itemsFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempFile, itemsFile);
}

export function getInboxItem(paths: ServerPaths, id: string): InboxItem | null {
  const normId = String(id ?? '').trim().toLowerCase();
  const data = readInboxData(paths);
  return data.items.find((item) => item.id.toLowerCase() === normId) ?? null;
}

export function addInboxItem(
  paths: ServerPaths,
  input: {
    kind: InboxKind;
    title: string;
    severity?: InboxSeverity;
    detail?: string;
    agent?: string;
    role?: string;
    job_id?: string;
    project?: string;
    source?: string;
    ref?: Record<string, unknown>;
    actions?: InboxAction[];
    retry?: InboxRetryInfo;
    dedupe_key?: string;
  },
  options?: {
    onlyIfAbsent?: boolean;
  }
): { item: InboxItem; created: boolean } {
  const data = readInboxData(paths);
  const now = new Date().toISOString();

  // Deduplication check
  if (input.dedupe_key && input.dedupe_key.trim() !== '') {
    if (options?.onlyIfAbsent) {
      // If onlyIfAbsent is true, skip if dedupe_key exists in ANY status (Item 11)
      const existingInAnyStatus = data.items.find(
        (it) => it.dedupe_key === input.dedupe_key
      );
      if (existingInAnyStatus) {
        return { item: existingInAnyStatus, created: false };
      }
    } else {
      // Normal dedupe: unique among open items (not dismissed or done)
      const existing = data.items.find(
        (it) => it.dedupe_key === input.dedupe_key && it.status !== 'dismissed' && it.status !== 'done'
      );
      if (existing) {
        existing.updated_at = now;
        if (input.detail !== undefined) {
          existing.detail = redactSecrets(input.detail, paths.userProfile).slice(0, 2000);
        }
        writeInboxData(paths, data);
        return { item: existing, created: false };
      }
    }
  }

  const id = generateInboxId();
  const defaultActions: InboxAction[] = ['open', 'dismiss'];
  if (input.kind === 'needs_login') {
    defaultActions.unshift('retry');
    defaultActions.unshift('login');
  } else if (input.kind === 'failed' || input.kind === 'blocked' || input.kind === 'rate_limited' || input.kind === 'review_changes') {
    defaultActions.unshift('retry');
  } else if (input.kind === 'needs_input') {
    defaultActions.unshift('reply');
  } else if (input.kind === 'approval') {
    defaultActions.unshift('reject');
    defaultActions.unshift('approve');
  }

  const defaultSeverity: InboxSeverity =
    input.kind === 'needs_login' || input.kind === 'failed'
      ? 'error'
      : input.kind === 'custom' || input.kind === 'handoff_done'
        ? 'info'
        : 'warn';

  const newItem: InboxItem = {
    id,
    kind: input.kind,
    severity: input.severity ?? defaultSeverity,
    title: String(input.title ?? '').trim().slice(0, 200),
    detail: redactSecrets(input.detail ?? '', paths.userProfile).slice(0, 2000),
    agent: input.agent,
    role: input.role,
    job_id: input.job_id,
    project: input.project,
    source: input.source ?? 'api',
    ref: input.ref,
    actions: input.actions ?? defaultActions,
    retry: input.retry,
    status: 'open',
    resolution: null,
    dedupe_key: input.dedupe_key,
    created_at: now,
    updated_at: now,
  };

  data.items.unshift(newItem);
  writeInboxData(paths, data);

  return { item: newItem, created: true };
}

export function updateInboxItemStatus(
  paths: ServerPaths,
  id: string,
  status: InboxStatus,
  resolution?: InboxResolution | null
): InboxItem | null {
  const data = readInboxData(paths);
  const item = data.items.find((it) => it.id.toLowerCase() === id.toLowerCase());
  if (!item) {
    return null;
  }
  item.status = status;
  item.updated_at = new Date().toISOString();
  if (resolution !== undefined) {
    item.resolution = resolution;
  }
  writeInboxData(paths, data);
  return item;
}

export function clearInboxItems(
  paths: ServerPaths,
  statusToClear: 'dismissed' | 'done'
): number {
  const data = readInboxData(paths);
  const initialLen = data.items.length;
  data.items = data.items.filter((it) => it.status !== statusToClear);
  const removed = initialLen - data.items.length;
  if (removed > 0) {
    writeInboxData(paths, data);
  }
  return removed;
}
