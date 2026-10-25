import fs from 'node:fs';
import path from 'node:path';
import { handleCancelJob, refreshJobMetaStatus, type JobMeta } from '../../actions/jobs.ts';
import { loadInternalNotifyConfig } from '../../actions/notify.ts';
import { getAuditStats } from '../../lib/audit.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { logServerError } from '../../lib/logger.ts';
import type { ServerPaths } from '../../lib/paths.ts';
import { isDirectorySafe, isFileSafe } from '../../lib/paths.ts';
import { isProcessRunning } from '../../lib/proc.ts';
import { readHealthCacheOnly } from '../health/probes.ts';
import { performInboxAction } from '../inbox/actions.ts';
import {
  getInboxItem,
  readInboxData,
  updateInboxItemStatus,
  writeInboxData,
  type InboxAction,
  type InboxItem,
} from '../inbox/store.ts';
import { TelegramClient } from './client.ts';
import type {
  TelegramConfigData,
  TelegramLockData,
  TelegramStateData,
  TelegramUpdate,
} from './types.ts';

let capturedHost = '127.0.0.1:4317';

export function setCapturedHost(host: string): void {
  if (host && host.trim()) {
    capturedHost = host.trim();
  }
}

export function getCapturedHost(): string {
  return capturedHost;
}

const DEFAULT_CONFIG: TelegramConfigData = {
  inbound: false,
  push_inbox: true,
  digest: {
    enabled: false,
    morning: '08:30',
    evening: '18:00',
  },
};

const DEFAULT_STATE: TelegramStateData = {
  offset: 0,
  last_digest: {
    morning: '',
    evening: '',
  },
  msg_map: {},
};

export function readTelegramConfig(paths: ServerPaths): TelegramConfigData {
  const dataDir = paths.featureDataDir('telegram');
  const cfgFile = path.win32.join(dataDir, 'config.json');
  if (!isFileSafe(cfgFile)) {
    return { ...DEFAULT_CONFIG, digest: { ...DEFAULT_CONFIG.digest } };
  }
  try {
    const raw = fs.readFileSync(cfgFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelegramConfigData>;
    return {
      inbound: Boolean(parsed.inbound),
      push_inbox: parsed.push_inbox !== undefined ? Boolean(parsed.push_inbox) : true,
      digest: {
        enabled: Boolean(parsed.digest?.enabled),
        morning: parsed.digest?.morning ?? '08:30',
        evening: parsed.digest?.evening ?? '18:00',
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG, digest: { ...DEFAULT_CONFIG.digest } };
  }
}

export function writeTelegramConfig(paths: ServerPaths, cfg: TelegramConfigData): void {
  const dataDir = paths.featureDataDir('telegram');
  const cfgFile = path.win32.join(dataDir, 'config.json');
  const tempFile = `${cfgFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tempFile, cfgFile);
}

export function readTelegramState(paths: ServerPaths): TelegramStateData {
  const dataDir = paths.featureDataDir('telegram');
  const stateFile = path.win32.join(dataDir, 'state.json');
  if (!isFileSafe(stateFile)) {
    return { ...DEFAULT_STATE, last_digest: { ...DEFAULT_STATE.last_digest }, msg_map: {} };
  }
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelegramStateData>;
    return {
      offset: Number(parsed.offset ?? 0) || 0,
      push_since: typeof parsed.push_since === 'string' ? parsed.push_since : undefined,
      last_digest: {
        morning: parsed.last_digest?.morning ?? '',
        evening: parsed.last_digest?.evening ?? '',
      },
      msg_map: parsed.msg_map && typeof parsed.msg_map === 'object' ? parsed.msg_map : {},
    };
  } catch {
    return { ...DEFAULT_STATE, last_digest: { ...DEFAULT_STATE.last_digest }, msg_map: {} };
  }
}

export function writeTelegramState(paths: ServerPaths, state: TelegramStateData): boolean {
  // Check ownership right before each write: only the process that owns poller.lock may write state.json.
  // Skip and log otherwise (Codex Review #3 Item 4).
  const lockStatus = getPollerLockStatus(paths);
  if (lockStatus.owner !== 'this') {
    console.warn(
      `[telegram] writeTelegramState: process ${process.pid} does not own poller.lock (owner: ${lockStatus.owner ?? 'none'}); write skipped.`
    );
    return false;
  }

  // Inside the process, keep read-merge-write fully synchronous (no await between read and rename)
  // to prevent race conditions and lost updates across concurrent operations in this process.
  const dataDir = paths.featureDataDir('telegram');
  const stateFile = path.win32.join(dataDir, 'state.json');

  // Re-read current disk state to prevent lost updates across concurrent callers (Round 2 Item 6)
  const diskState = readTelegramState(paths);

  // 1. offset: max of current and disk
  const mergedOffset = Math.max(Number(state.offset ?? 0), Number(diskState.offset ?? 0));

  // 2. msg_map: union of disk and memory (incoming caller overrides on key collision)
  const mergedMsgMap: Record<string, string> = {
    ...diskState.msg_map,
    ...state.msg_map,
  };

  // 3. push_since: newest ISO timestamp
  let mergedPushSince = state.push_since;
  if (diskState.push_since) {
    if (!mergedPushSince || diskState.push_since > mergedPushSince) {
      mergedPushSince = diskState.push_since;
    }
  }

  // 4. last_digest: newest morning and evening stamps
  const mergedDigest = {
    morning: (state.last_digest?.morning || diskState.last_digest?.morning)
      ? (state.last_digest?.morning > diskState.last_digest?.morning ? state.last_digest.morning : diskState.last_digest.morning)
      : '',
    evening: (state.last_digest?.evening || diskState.last_digest?.evening)
      ? (state.last_digest?.evening > diskState.last_digest?.evening ? state.last_digest.evening : diskState.last_digest.evening)
      : '',
  };

  const finalState: TelegramStateData = {
    offset: mergedOffset,
    push_since: mergedPushSince,
    last_digest: mergedDigest,
    msg_map: mergedMsgMap,
  };

  // Mutate caller state object so subsequent caller operations see merged values
  state.offset = finalState.offset;
  state.push_since = finalState.push_since;
  state.last_digest = finalState.last_digest;
  state.msg_map = finalState.msg_map;

  // Cap msg_map at 500
  const keys = Object.keys(finalState.msg_map);
  if (keys.length > 500) {
    const kept = keys.slice(keys.length - 500);
    const newMap: Record<string, string> = {};
    for (const k of kept) {
      newMap[k] = finalState.msg_map[k]!;
    }
    finalState.msg_map = newMap;
    state.msg_map = newMap;
  }

  const tempFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(finalState, null, 2), 'utf8');
  fs.renameSync(tempFile, stateFile);
  return true;
}

// Single-poller lock management with atomic 'wx' creation & stale rename (Round 3 Item 7)
export function refreshPollerHeartbeat(paths: ServerPaths): boolean {
  const dataDir = paths.featureDataDir('telegram');
  const lockFile = path.win32.join(dataDir, 'poller.lock');
  if (!isFileSafe(lockFile)) return false;
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as TelegramLockData;
    if (lock.pid === process.pid) {
      lock.heartbeat = Date.now();
      const tmp = `${lockFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(lock), 'utf8');
      fs.renameSync(tmp, lockFile);
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

export function tryAcquirePollerLock(
  paths: ServerPaths,
  port?: number,
  options?: { pid?: number; isHeartbeat?: boolean }
): boolean {
  const dataDir = paths.featureDataDir('telegram');
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.win32.join(dataDir, 'poller.lock');
  const now = Date.now();
  const myPid = options?.pid ?? process.pid;

  if (options?.isHeartbeat) {
    return refreshPollerHeartbeat(paths);
  }

  const lockData: TelegramLockData = {
    pid: myPid,
    port,
    heartbeat: now,
  };
  const lockContent = JSON.stringify(lockData);

  // 1. Try atomic create with 'wx' flag (fails if file already exists)
  try {
    const fd = fs.openSync(lockFile, 'wx');
    try {
      fs.writeFileSync(fd, lockContent, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    // Re-read after writing and keep only if pid matches
    try {
      const readBack = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as TelegramLockData;
      return readBack.pid === myPid;
    } catch {
      return false;
    }
  } catch (err: any) {
    if (err.code !== 'EEXIST') {
      return false;
    }
  }

  // 2. Lock file exists: check if lock is stale or owner is dead
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    const lock = JSON.parse(raw) as TelegramLockData;

    const isAlive = isProcessRunning(lock.pid);
    const isStale = now - (lock.heartbeat ?? 0) > 60000;
    if (isAlive && !isStale) {
      // Active poller owns the lock: acquisition fails
      return false;
    }

    // Stale or dead-owner lock: rename to unique .stale-<pid>-<ts> (only one process wins rename)
    const staleFile = `${lockFile}.stale-${myPid}-${now}`;
    try {
      fs.renameSync(lockFile, staleFile);
      try {
        fs.unlinkSync(staleFile);
      } catch {
        // Ignore unlink error
      }
    } catch {
      // Lost rename race
      return false;
    }

    // Now 'wx'-create atomically
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(fd, lockContent, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      const readBack = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as TelegramLockData;
      return readBack.pid === myPid;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export function releasePollerLock(paths: ServerPaths): void {
  const dataDir = paths.featureDataDir('telegram');
  const lockFile = path.win32.join(dataDir, 'poller.lock');
  if (isFileSafe(lockFile)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as TelegramLockData;
      if (lock.pid === process.pid) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Ignore
    }
  }
}

export function getPollerLockStatus(paths: ServerPaths): {
  owner: 'this' | 'other' | null;
  pid: number | null;
  heartbeatAgeSec: number | null;
} {
  const dataDir = paths.featureDataDir('telegram');
  const lockFile = path.win32.join(dataDir, 'poller.lock');
  if (!isFileSafe(lockFile)) {
    return { owner: null, pid: null, heartbeatAgeSec: null };
  }
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as TelegramLockData;
    const now = Date.now();
    const age = Math.round((now - (lock.heartbeat ?? 0)) / 1000);
    const alive = isProcessRunning(lock.pid);
    if (!alive || age > 60) {
      return { owner: null, pid: lock.pid, heartbeatAgeSec: age };
    }
    if (lock.pid === process.pid) {
      return { owner: 'this', pid: lock.pid, heartbeatAgeSec: age };
    }
    return { owner: 'other', pid: lock.pid, heartbeatAgeSec: age };
  } catch {
    return { owner: null, pid: null, heartbeatAgeSec: null };
  }
}

export class TelegramPoller {
  private readonly paths: ServerPaths;
  private ctx: MawFeatureContext | null = null;
  private client: TelegramClient | null = null;
  private isRunning = false;
  private abortController: AbortController | null = null;
  private lastUpdateAt: string | null = null;
  private lastError: string | null = null;
  private ignoredCount = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private digestTimer: NodeJS.Timeout | null = null;
  private customFetch?: typeof fetch;
  private customBaseUrl?: string;

  constructor(paths: ServerPaths, options?: { fetchFn?: typeof fetch; baseUrl?: string; ctx?: MawFeatureContext }) {
    this.paths = paths;
    this.customFetch = options?.fetchFn;
    this.customBaseUrl = options?.baseUrl;
    if (options?.ctx) {
      this.ctx = options.ctx;
    }
  }

  setContext(ctx: MawFeatureContext): void {
    this.ctx = ctx;
  }

  getStatus(): {
    configured: boolean;
    inbound: boolean;
    polling: boolean;
    owner: 'this' | 'other' | null;
    last_update_at: string | null;
    last_error: string | null;
    ignored: number;
    digest: TelegramConfigData['digest'];
    push_inbox: boolean;
  } {
    const notifyCfg = loadInternalNotifyConfig(this.paths.notifyCfgFile);
    const configured = Boolean(
      notifyCfg.telegram_bot_token.trim() && notifyCfg.telegram_chat_id.trim()
    );
    const tgCfg = readTelegramConfig(this.paths);
    const lockStatus = getPollerLockStatus(this.paths);

    return {
      configured,
      inbound: tgCfg.inbound,
      polling: this.isRunning,
      owner: lockStatus.owner,
      last_update_at: this.lastUpdateAt,
      last_error: this.lastError,
      ignored: this.ignoredCount,
      digest: tgCfg.digest,
      push_inbox: tgCfg.push_inbox,
    };
  }

  async start(): Promise<boolean> {
    const notifyCfg = loadInternalNotifyConfig(this.paths.notifyCfgFile);
    if (!notifyCfg.telegram_bot_token.trim() || !notifyCfg.telegram_chat_id.trim()) {
      this.lastError = 'Bot token or chat ID not configured.';
      return false;
    }

    const tgCfg = readTelegramConfig(this.paths);
    const needsTimers = Boolean(tgCfg.push_inbox || tgCfg.digest.enabled);
    const needsInbound = Boolean(tgCfg.inbound);

    if (!needsTimers && !needsInbound) {
      this.stop();
      return false;
    }

    // Acquire lock and initialize client + timers if not yet running
    if (!this.heartbeatTimer) {
      const acquired = tryAcquirePollerLock(this.paths);
      if (!acquired) {
        return false;
      }

      this.client = new TelegramClient({
        token: notifyCfg.telegram_bot_token,
        baseUrl: this.customBaseUrl,
        fetchFn: this.customFetch,
      });

      // Set push_since on initial start if not yet set
      const state = readTelegramState(this.paths);
      if (!state.push_since) {
        state.push_since = new Date().toISOString();
        writeTelegramState(this.paths, state);
      }

      // Start 20s heartbeat timer
      this.heartbeatTimer = setInterval(() => {
        try {
          refreshPollerHeartbeat(this.paths);
        } catch (err) {
          logServerError('telegram:heartbeat', err, this.paths.mawHome);
        }
      }, 20000);
      this.heartbeatTimer.unref();

      // Start 60s digest check timer
      this.digestTimer = setInterval(() => {
        try {
          void this.checkDigest().catch((err) => {
            logServerError('telegram:checkDigest', err, this.paths.mawHome);
          });
          void this.pushNewInboxItems().catch((err) => {
            logServerError('telegram:pushNewInboxItems', err, this.paths.mawHome);
          });
        } catch (err) {
          logServerError('telegram:digestTimer', err, this.paths.mawHome);
        }
      }, 60000);
      this.digestTimer.unref();

      if (tgCfg.push_inbox) {
        void this.pushNewInboxItems().catch((err) => {
          logServerError('telegram:initialPushInbox', err, this.paths.mawHome);
        });
      }
    }

    // Handle inbound loop
    if (needsInbound && !this.isRunning) {
      this.isRunning = true;
      this.abortController = new AbortController();
      void this.pollLoop().catch((err) => {
        logServerError('telegram:pollLoop', err, this.paths.mawHome);
      });
    } else if (!needsInbound && this.isRunning) {
      this.isRunning = false;
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
    }

    return true;
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.isRunning = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
    releasePollerLock(this.paths);
  }

  async sendTestMessage(): Promise<{ ok: boolean; sent: boolean; error?: string }> {
    const notifyCfg = loadInternalNotifyConfig(this.paths.notifyCfgFile);
    if (!notifyCfg.telegram_bot_token.trim() || !notifyCfg.telegram_chat_id.trim()) {
      return { ok: false, sent: false, error: 'Bot token or chat ID not configured.' };
    }

    const client =
      this.client ??
      new TelegramClient({
        token: notifyCfg.telegram_bot_token,
        baseUrl: this.customBaseUrl,
        fetchFn: this.customFetch,
      });

    const res = await client.sendMessage(
      notifyCfg.telegram_chat_id,
      'MAW two-way bot is connected ✓ — /help'
    );
    if (!res.ok) {
      return { ok: false, sent: false, error: res.error };
    }
    return { ok: true, sent: true };
  }

  private async pollLoop(): Promise<void> {
    let backoffMs = 5000;

    while (this.isRunning) {
      const notifyCfg = loadInternalNotifyConfig(this.paths.notifyCfgFile);
      const targetChatId = notifyCfg.telegram_chat_id.trim();
      const state = readTelegramState(this.paths);

      if (!this.client) break;

      const timeoutSignal = AbortSignal.timeout(35000);
      const combinedSignal = this.abortController
        ? AbortSignal.any([this.abortController.signal, timeoutSignal])
        : timeoutSignal;
      const res = await this.client.getUpdates(state.offset, 25, combinedSignal);

      if (!this.isRunning) break;

      if (!res.ok) {
        this.lastError = res.error ?? 'getUpdates error';
        if (res.status === 401) {
          this.lastError = 'bot token rejected';
          this.stop();
          break;
        }
        if (res.status === 409) {
          // Conflict with another poller: wait 60s
          await this.sleep(60000);
          continue;
        }
        await this.sleep(backoffMs);
        backoffMs = Math.min(60000, backoffMs * 2);
        continue;
      }

      backoffMs = 5000; // Reset backoff on success
      const updates = res.result ?? [];

      for (const update of updates) {
        if (update.update_id >= state.offset) {
          state.offset = update.update_id + 1;
        }
        this.lastUpdateAt = new Date().toISOString();

        // 1. Message update
        if (update.message) {
          const msg = update.message;
          const msgChatId = String(msg.chat.id ?? '');
          if (msgChatId !== targetChatId) {
            this.ignoredCount++;
            continue;
          }
          await this.handleIncomingMessage(msg, targetChatId, state);
        }

        // 2. Callback query update
        if (update.callback_query) {
          const cb = update.callback_query;
          const cbChatId = String(cb.message?.chat.id ?? cb.from.id);
          if (cbChatId !== targetChatId) {
            this.ignoredCount++;
            continue;
          }
          await this.handleCallbackQuery(cb);
        }
      }

      writeTelegramState(this.paths, state);

      if (updates.length === 0) {
        // Yield to macrotask queue so tests or timers can fire if fetch is mocked or returns immediately
        await this.sleep(50);
      }
    }
  }

  private async handleIncomingMessage(
    msg: NonNullable<TelegramUpdate['message']>,
    chatId: string,
    state: TelegramStateData
  ): Promise<void> {
    const rawText = String(msg.text ?? '').trim();
    if (!rawText) return;

    // Check if this is a reply to a bot message
    if (msg.reply_to_message) {
      const replyMsgId = String(msg.reply_to_message.message_id);
      const mappedId = state.msg_map[replyMsgId];
      const replySnippet = msg.reply_to_message.text ?? '';
      let targetInboxItem: InboxItem | null = null;

      if (mappedId) {
        targetInboxItem = getInboxItem(this.paths, mappedId);
      }

      if (!targetInboxItem) {
        // Try finding job_ id in replied snippet
        const m = /job_[a-zA-Z0-9_]+/.exec(replySnippet);
        if (m) {
          const jobId = m[0];
          const inboxData = readInboxData(this.paths);
          targetInboxItem =
            inboxData.items.find((it) => it.job_id === jobId && it.status === 'open') ?? null;
        }
      }

      if (targetInboxItem) {
        if (!targetInboxItem.actions.includes('reply')) {
          await this.client?.sendMessage(
            chatId,
            `This item needs /approve ${targetInboxItem.id} or /reject ${targetInboxItem.id}`
          );
          return;
        }

        if (!this.ctx) {
          await this.client?.sendMessage(chatId, `Cannot process reply: server context not ready.`);
          return;
        }

        try {
          await performInboxAction(this.ctx, targetInboxItem.id, 'reply', rawText, 'telegram');
          await this.client?.sendMessage(chatId, `Reply processed for ${targetInboxItem.title} ✓`);
        } catch (err) {
          await this.client?.sendMessage(chatId, `Reply failed: ${(err as Error)?.message ?? 'Unknown error'}`);
        }
        return;
      }
    }

    // Normal command processing (strip @botname)
    const cmdLine = rawText.replace(/@\w+/g, '').trim();
    const [firstWord, ...rest] = cmdLine.split(/\s+/);
    const cmd = firstWord?.toLowerCase();
    const arg = rest.join(' ').trim();

    if (cmd === '/help') {
      const help = [
        'MAW Multi-AI Bot Commands',
        '',
        '/status — System & job readiness',
        '/inbox — 10 newest attention items',
        '/approve <id> — Approve attention card',
        '/reject <id> — Reject card',
        '/retry <id> — Retry failed job',
        '/stop <job_id|inbox_id> — Cancel running job',
        '/task <text> — Create new board task',
        '/help — Show this cheat-sheet',
      ].join('\n');
      await this.client?.sendMessage(chatId, help);
    } else if (cmd === '/status') {
      const inboxData = readInboxData(this.paths);
      let openWarn = 0;
      let openErr = 0;
      for (const it of inboxData.items) {
        if (it.status === 'open') {
          if (it.severity === 'error') openErr++;
          else if (it.severity === 'warn') openWarn++;
        }
      }
      const health = readHealthCacheOnly(this.paths);

      // Read running jobs with refreshJobMetaStatus (Item 7)
      const runningJobLines: string[] = [];
      if (isDirectorySafe(this.paths.jobsDir)) {
        try {
          const jobFiles = fs.readdirSync(this.paths.jobsDir).filter((f) => f.startsWith('job_') && f.endsWith('.json'));
          for (const jf of jobFiles) {
            const jp = path.win32.join(this.paths.jobsDir, jf);
            try {
              let meta = JSON.parse(fs.readFileSync(jp, 'utf8')) as JobMeta;
              if (String(meta.status ?? '').toUpperCase() === 'RUNNING') {
                meta = await refreshJobMetaStatus(meta, this.paths.jobsDir);
                if (String(meta.status ?? '').toUpperCase() === 'RUNNING') {
                  const started = meta.started_at ? new Date(meta.started_at).getTime() : Date.now();
                  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
                  const proj = meta.project_path ? path.basename(meta.project_path) : 'unspecified';
                  runningJobLines.push(`- ${meta.job_id}: ${meta.agent ?? 'agent'} (${meta.role ?? 'role'}), ${proj}, ${elapsed}s elapsed`);
                }
              }
            } catch {
              // Ignore
            }
          }
        } catch {
          // Ignore
        }
      }

      const jobsText = runningJobLines.length > 0 ? `Running jobs:\n${runningJobLines.join('\n')}` : 'Running jobs: none';
      const text = [
        'Status Report',
        `Inbox Open: ${openErr + openWarn} (${openErr} error, ${openWarn} warn)`,
        `Health: ${health.summary.ok} ok, ${health.summary.warn} warn, ${health.summary.error} error`,
        jobsText,
      ].join('\n');
      await this.client?.sendMessage(chatId, text);
    } else if (cmd === '/inbox') {
      const inboxData = readInboxData(this.paths);
      const openItems = inboxData.items.filter((it) => it.status === 'open').slice(0, 10);
      if (openItems.length === 0) {
        await this.client?.sendMessage(chatId, 'Inbox is clear ✓');
      } else {
        const lines = openItems.map((it) => {
          const icon = it.severity === 'error' ? '❌' : '⚠️';
          return `${it.id} ${icon} ${it.title}`;
        });
        await this.client?.sendMessage(chatId, `Inbox Items:\n${lines.join('\n')}`);
      }
    } else if (cmd === '/approve' || cmd === '/reject' || cmd === '/retry') {
      const targetId = arg.trim();
      if (!targetId) {
        await this.client?.sendMessage(chatId, `Usage: ${cmd} <id>`);
        return;
      }
      const action = cmd.slice(1);
      if (!this.ctx) {
        await this.client?.sendMessage(chatId, `Cannot execute ${action}: system context not yet initialized.`);
        return;
      }
      try {
        const actRes = await performInboxAction(this.ctx, targetId, action, undefined, 'telegram');
        const extra = actRes.job_id ? ` (job ${String(actRes.job_id)})` : '';
        await this.client?.sendMessage(chatId, `Action '${action}' applied to ${targetId}${extra} ✓`);
      } catch (err) {
        await this.client?.sendMessage(chatId, `Action '${action}' failed: ${(err as Error)?.message ?? 'Unknown error'}`);
      }
    } else if (cmd === '/stop') {
      const target = arg.trim();
      if (!target) {
        await this.client?.sendMessage(chatId, 'Usage: /stop <job_id|inbox_id>');
        return;
      }
      let jobId = target;
      if (!target.startsWith('job_')) {
        const it = getInboxItem(this.paths, target);
        if (it?.job_id) {
          jobId = it.job_id;
        }
      }
      try {
        if (this.ctx?.cancelJob) {
          await this.ctx.cancelJob(jobId);
        } else {
          await handleCancelJob({ job_id: jobId }, this.paths);
        }
        await this.client?.sendMessage(chatId, `Job ${jobId} cancelled ✓`);
      } catch (err) {
        await this.client?.sendMessage(chatId, `Cancel failed: ${(err as Error)?.message}`);
      }
    } else if (cmd === '/task') {
      if (!arg) {
        await this.client?.sendMessage(chatId, 'Usage: /task <prompt>');
        return;
      }
      // Call task_create on local server
      const baseUrl = this.ctx?.serverUrl || `http://${getCapturedHost()}`;
      const title = arg.slice(0, 80);
      try {
        const resp = await globalThis.fetch(`${baseUrl}/api?action=task_create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-MAW-Request': '1',
          },
          body: JSON.stringify({
            title,
            prompt: arg,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (resp.status === 400 || !resp.ok) {
          await this.client?.sendMessage(chatId, 'Task board (S2) is not available');
        } else {
          await this.client?.sendMessage(chatId, `Task created: ${title} ✓`);
        }
      } catch {
        await this.client?.sendMessage(chatId, 'Task board (S2) is not available');
      }
    }
  }

  private async handleCallbackQuery(
    cb: NonNullable<TelegramUpdate['callback_query']>
  ): Promise<void> {
    const data = String(cb.data ?? '').trim();
    // Format: a:<action>:<id>
    const parts = data.split(':');
    if (parts.length >= 3 && parts[0] === 'a') {
      const action = parts[1]!.toLowerCase();
      const id = parts[2]!;
      const allowedButtons = new Set(['approve', 'reject', 'retry', 'dismiss']);
      if (!allowedButtons.has(action)) {
        await this.client?.answerCallbackQuery(cb.id, `Action '${action}' not supported via button`);
        return;
      }
      if (!this.ctx) {
        await this.client?.answerCallbackQuery(cb.id, 'Server context not ready');
        return;
      }
      try {
        await performInboxAction(this.ctx, id, action, undefined, 'telegram');
        await this.client?.answerCallbackQuery(cb.id, `Action ${action} executed ✓`);
        return;
      } catch (err) {
        await this.client?.answerCallbackQuery(cb.id, ((err as Error)?.message ?? 'Action failed').slice(0, 180));
        return;
      }
    }
    await this.client?.answerCallbackQuery(cb.id, 'Invalid callback query');
  }

  public async pushNewInboxItems(): Promise<void> {
    const tgCfg = readTelegramConfig(this.paths);
    if (!tgCfg.push_inbox) return;

    const notifyCfg = loadInternalNotifyConfig(this.paths.notifyCfgFile);
    if (!notifyCfg.telegram_chat_id || !notifyCfg.telegram_bot_token) return;

    if (!this.client) {
      this.client = new TelegramClient({
        token: notifyCfg.telegram_bot_token,
        fetchFn: this.customFetch,
        baseUrl: this.customBaseUrl,
      });
    }

    const state = readTelegramState(this.paths);
    if (!state.push_since) {
      state.push_since = new Date().toISOString();
      writeTelegramState(this.paths, state);
    }
    const pushSinceTime = new Date(state.push_since).getTime();

    const inboxData = readInboxData(this.paths);
    let stateChanged = false;
    let pushedCount = 0;

    const ACTIONABLE_BUTTONS = new Set(['approve', 'reject', 'retry', 'dismiss']);

    // Push open items with severity warn or error (excluding plain failed), max 10 per tick
    for (const item of inboxData.items) {
      if (pushedCount >= 10) break;
      if (item.status !== 'open') continue;
      if (item.severity !== 'warn' && item.severity !== 'error') continue;
      if (item.kind === 'failed') continue; // Plain failed is sent by send-notification.ps1

      // Only push items created after push_since (Item 8)
      const itemCreated = new Date(item.created_at).getTime();
      if (itemCreated < pushSinceTime) continue;

      // Check if already pushed
      const alreadyPushed = Object.values(state.msg_map).includes(item.id);
      if (alreadyPushed) continue;

      // Build inline buttons: only actionable buttons (Item 6)
      const buttons = item.actions
        .filter((act) => ACTIONABLE_BUTTONS.has(act))
        .slice(0, 3)
        .map((act) => ({
          text: act.toUpperCase(),
          callback_data: `a:${act}:${item.id}`.slice(0, 64),
        }));

      const replyMarkup =
        buttons.length > 0
          ? {
              inline_keyboard: [buttons],
            }
          : undefined;

      const text = `[${item.kind}] ${item.title}\n${item.detail}`;
      const res = await this.client.sendMessage(notifyCfg.telegram_chat_id, text, replyMarkup);
      if (res.ok && res.messageId) {
        state.msg_map[String(res.messageId)] = item.id;
        stateChanged = true;
        pushedCount++;
      }
    }

    if (stateChanged) {
      writeTelegramState(this.paths, state);
    }
  }

  private isWithinDigestWindow(configuredTime: string, now: Date): boolean {
    const [hStr, mStr] = configuredTime.split(':');
    const targetHour = Number.parseInt(hStr ?? '0', 10);
    const targetMin = Number.parseInt(mStr ?? '0', 10);
    if (Number.isNaN(targetHour) || Number.isNaN(targetMin)) return false;

    const targetDate = new Date(now);
    targetDate.setHours(targetHour, targetMin, 0, 0);

    const diffMs = now.getTime() - targetDate.getTime();
    const diffMin = diffMs / 60000;

    // now >= configured time and within 30 minutes after it (Item 9)
    return diffMin >= 0 && diffMin <= 30;
  }

  private async checkDigest(): Promise<void> {
    const tgCfg = readTelegramConfig(this.paths);
    if (!tgCfg.digest.enabled || !this.client) return;

    const notifyCfg = loadInternalNotifyConfig(this.paths.notifyCfgFile);
    if (!notifyCfg.telegram_chat_id) return;

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const state = readTelegramState(this.paths);

    const isMorning =
      this.isWithinDigestWindow(tgCfg.digest.morning, now) && state.last_digest.morning !== todayStr;
    const isEvening =
      this.isWithinDigestWindow(tgCfg.digest.evening, now) && state.last_digest.evening !== todayStr;

    if (!isMorning && !isEvening) return;

    // Build digest text
    const auditStats = getAuditStats(this.paths.auditFile);
    const health = readHealthCacheOnly(this.paths);
    const inboxData = readInboxData(this.paths);
    const openCount = inboxData.items.filter((it) => it.status === 'open').length;

    const label = isMorning ? 'Morning Digest' : 'Evening Digest';
    const text = [
      `${label} — ${todayStr}`,
      `Total Cost: $${auditStats.total_cost_usd.toFixed(4)}`,
      `Open Attention Items: ${openCount}`,
      `Health Status: ${health.summary.ok} OK, ${health.summary.warn} Warn, ${health.summary.error} Error`,
    ].join('\n');

    await this.client.sendMessage(notifyCfg.telegram_chat_id, text);

    if (isMorning) state.last_digest.morning = todayStr;
    if (isEvening) state.last_digest.evening = todayStr;
    writeTelegramState(this.paths, state);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (this.abortController) {
        this.abortController.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      }
    });
  }
}

let globalPoller: TelegramPoller | null = null;

export function getGlobalTelegramPoller(
  paths: ServerPaths,
  options?: { fetchFn?: typeof fetch; baseUrl?: string }
): TelegramPoller {
  if (!globalPoller) {
    globalPoller = new TelegramPoller(paths, options);
  }
  return globalPoller;
}
