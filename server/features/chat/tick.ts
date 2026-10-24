import fs from 'node:fs';
import path from 'node:path';
import { handleCancelJob, refreshJobMetaStatus, type JobMeta } from '../../actions/jobs.ts';
import { handleSpecGuard } from '../../actions/specGuard.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { isFileSafe } from '../../lib/paths.ts';
import { getWorktreeChangedFiles } from '../agents-ws/lib/git.ts';
import { matchesAnyScope } from '../agents-ws/lib/glob.ts';
import {
  parseHandoffDispatchBlock,
  parseStructuredHandoffResult,
} from '../agents-ws/lib/handoff-block.ts';
import {
  generateConversationId,
  generateHandoffId,
  generateMessageId,
} from '../agents-ws/lib/ids.ts';
import { parseJobLog } from '../agents-ws/lib/logparse.ts';
import { parseRoleMarkdown } from '../agents-ws/lib/markdown-roles.ts';
import { withS6State } from '../agents-ws/lib/mutex.ts';
import { buildPrompt, type PromptMemberInfo } from '../agents-ws/lib/prompt.ts';
import { readJsonStore, writeJsonStore } from '../agents-ws/lib/store.ts';
import type { Agent } from '../agents-ws/types.ts';
import type { Handoff, HandoffStatus } from '../handoffs/types.ts';
import { addMemoryEntry, getMemoryContext } from '../memory/index.ts';
import type { Team } from '../teams/types.ts';
import type { Conversation, Message, QueueItem } from './types.ts';

export const PLATFORM_WINDOW_TOKENS: Record<string, number> = {
  claude: 200000,
  codex: 272000,
  gemini: 1000000,
  antigravity: 1000000,
  cursor: 200000,
  aider: 128000,
};

export function getWindowTokens(platform: string): number {
  return PLATFORM_WINDOW_TOKENS[platform.toLowerCase()] ?? 128000;
}

export function newSessionFor(ctx: MawFeatureContext, platform: string): boolean {
  const regAgent = ctx.registry?.agents?.find((a) => a.id.toLowerCase() === platform.toLowerCase());
  return Boolean(regAgent?.capabilities?.new_session);
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

export function getConversationMessagesPath(chatDir: string, conversationId: string): string {
  return path.win32.join(chatDir, 'conv', `${conversationId}.jsonl`);
}

export function readConversationMessages(chatDir: string, conversationId: string): Message[] {
  const file = getConversationMessagesPath(chatDir, conversationId);
  if (!isFileSafe(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    const messages: Message[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        // Ignore unparseable line
      }
    }
    return messages;
  } catch {
    return [];
  }
}

export function appendConversationMessage(
  chatDir: string,
  conversationId: string,
  message: Message
): void {
  const file = getConversationMessagesPath(chatDir, conversationId);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(file, JSON.stringify(message) + '\n', 'utf8');
}

export function updateConversationMessages(
  chatDir: string,
  conversationId: string,
  messages: Message[]
): void {
  const file = getConversationMessagesPath(chatDir, conversationId);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
  fs.writeFileSync(file, content, 'utf8');
}

export function computeContextMeter(
  summary: string,
  messages: Message[],
  summarySeq: number,
  platform: string,
  lastTokensIn: number | null
): { used_tokens: number; window_tokens: number; pct: number } {
  const window_tokens = getWindowTokens(platform);
  let charCount = (summary || '').length;
  for (const m of messages) {
    if (m.seq > summarySeq) {
      charCount += (m.text || '').length;
    }
  }
  let used_tokens = Math.round(charCount / 3.8);
  if (typeof lastTokensIn === 'number' && lastTokensIn > used_tokens) {
    used_tokens = lastTokensIn;
  }
  const pct = Math.round((used_tokens / window_tokens) * 100) / 100;
  return { used_tokens, window_tokens, pct };
}

// Item 8: Centralized finalizeHandoff for all terminal transitions
export async function finalizeHandoff(
  ctx: MawFeatureContext,
  h: Handoff,
  status: HandoffStatus,
  options?: {
    summary?: string;
    actual_model?: string;
    parsed_reply?: string;
    parsed_cost?: number | null;
    tokens_in?: number | null;
    tokens_out?: number | null;
    note?: string;
    error?: string;
  },
  inMemoryConvsData?: { version: number; conversations: Conversation[] }
): Promise<void> {
  const handoffsDir = ctx.paths.featureDataDir('handoffs');
  const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
  const chatDir = ctx.paths.featureDataDir('chat');
  const convsFile = path.win32.join(chatDir, 'conversations.json');
  const agentsDir = ctx.paths.featureDataDir('agents-ws');
  const agentsFile = path.win32.join(agentsDir, 'agents.json');

  const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
    version: 1,
    handoffs: [],
  });
  const convsData =
    inMemoryConvsData ??
    (await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
      version: 1,
      conversations: [],
    }));
  const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
    version: 1,
    agents: [],
  });

  const target = handoffsData.handoffs.find((item) => item.id === h.id) ?? h;

  target.status = status;
  target.finished_at = new Date().toISOString();
  if (target.started_at) {
    target.duration_sec = Math.max(1, Math.round((Date.now() - new Date(target.started_at).getTime()) / 1000));
  } else {
    target.duration_sec = 1;
  }

  if (options?.actual_model) {
    target.actual_model = options.actual_model;
  }
  if (options?.error) {
    target.parse_error = options.error;
  }
  if (h.result) {
    target.result = h.result;
  }

  // Mutate passed object h as well so caller in-memory references stay updated
  h.status = target.status;
  h.finished_at = target.finished_at;
  h.duration_sec = target.duration_sec;
  h.actual_model = target.actual_model;
  h.parse_error = target.parse_error;
  h.result = target.result;

  // Add decisions to project memory if completed (Item 10)
  if (status === 'completed' && target.result?.decisions && target.result.decisions.length > 0) {
    const leadAgent = agentsData.agents.find((a) => a.id === target.lead_agent_id);
    if (leadAgent?.workdir) {
      for (const dec of target.result.decisions) {
        try {
          await addMemoryEntry(leadAgent.workdir, {
            title: dec.slice(0, 100),
            body: dec,
            tags: ['handoff', target.to_role],
            source: `handoff:${target.id}`,
            agent: target.platform,
          });
        } catch {}
      }
    }
  }

  // Append [Handoff ...] message to Lead conversation
  const leadConv = convsData.conversations.find((c) => c.id === target.lead_conversation_id);
  if (leadConv) {
    leadConv.seq++;
    const memberAgent = agentsData.agents.find((a) => a.id === target.to);
    const memberName = memberAgent ? memberAgent.name : target.to_role;
    const durStr = formatDuration(target.duration_sec ?? 1);
    const summaryText = (
      options?.summary ||
      target.result?.summary ||
      options?.parsed_reply ||
      target.parse_error ||
      ''
    ).slice(0, 600);
    const filesCount = target.result?.files_changed?.length ?? 0;
    const blockersCount = target.result?.blockers?.length ?? 0;

    const handoffMsgText = `[Handoff ${target.id}] ${target.to_role} · ${memberName} (${target.platform}) ${target.status} in ${durStr} — ${summaryText} · files: ${filesCount} · blockers: ${blockersCount}`;

    const handoffMsg: Message = {
      seq: leadConv.seq,
      id: generateMessageId(),
      role: 'handoff',
      text: handoffMsgText,
      ts: new Date().toISOString(),
      platform: target.platform,
      model: '',
      effort: '',
      actual_model: target.actual_model,
      job_id: target.job_id,
      status: target.status === 'completed' ? 'done' : 'failed',
      cost_usd: target.result?.cost ?? options?.parsed_cost ?? null,
      tokens_in: options?.tokens_in ?? null,
      tokens_out: options?.tokens_out ?? null,
      duration_sec: target.duration_sec,
      attachments: [],
      handoff_id: target.id,
      steered: false,
    };

    appendConversationMessage(chatDir, leadConv.id, handoffMsg);
    leadConv.updated_at = new Date().toISOString();

    // Check batch completion
    const batchHandoffs = handoffsData.handoffs.filter((item) => item.batch === target.batch);
    const allBatchTerminal = batchHandoffs.every(
      (item) => item.status !== 'started' && item.status !== 'running'
    );

    if (allBatchTerminal) {
      const leadAgent = agentsData.agents.find((a) => a.id === target.lead_agent_id);
      if (leadAgent?.workdir) {
        const teamFile = path.win32.join(leadAgent.workdir, '.maw', 'team.json');
        if (isFileSafe(teamFile)) {
          try {
            const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
            if (team.shared?.auto_continue) {
              const tableRows = batchHandoffs.map(
                (b) =>
                  `| ${b.id} | ${b.to_role} | ${b.status} | ${(b.result?.summary || b.parse_error || '').slice(0, 200)} | ${b.result?.files_changed?.length ?? 0} files | ${b.result?.blockers?.length ?? 0} blockers |`
              );
              const tableText =
                '### Member Handoff Results\n' +
                '| ID | Role | Status | Summary | Files | Blockers |\n|---|---|---|---|---|---|\n' +
                tableRows.join('\n') +
                '\n\nContinue the plan, dispatch fixes, or write the final summary.';

              // Item 23: queue with system_generated: true
              leadConv.queue.push({
                id: 'q_' + generateMessageId().slice(2, 8),
                text: tableText,
                ts: new Date().toISOString(),
                system_generated: true,
              });
              leadConv.updated_at = new Date().toISOString();
            }
          } catch {}
        }
      }
    }

    await writeJsonStore(convsFile, convsData);
  }

  await writeJsonStore(handoffsFile, handoffsData);
}

let isTicking = false;
let tickTimer: NodeJS.Timeout | null = null;
let lastKnownCtx: MawFeatureContext | null = null;

export function ensureTickStarted(ctx: MawFeatureContext): void {
  lastKnownCtx = ctx;
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      if (lastKnownCtx) {
        tick(lastKnownCtx).catch(() => {});
      }
    }, 2000);
    tickTimer.unref();
  }
}

export async function tick(ctx: MawFeatureContext): Promise<void> {
  lastKnownCtx = ctx;
  if (isTicking) {
    return;
  }
  isTicking = true;
  try {
    // Item 1: run entire tick inside withS6State lock
    await withS6State(async () => {
      await runTickCycle(ctx);
    });
  } finally {
    isTicking = false;
  }
}

async function runTickCycle(ctx: MawFeatureContext): Promise<void> {
  const chatDir = ctx.paths.featureDataDir('chat');
  const convsFile = path.win32.join(chatDir, 'conversations.json');
  const settingsFile = path.win32.join(chatDir, 'settings.json');
  const agentsDir = ctx.paths.featureDataDir('agents-ws');
  const agentsFile = path.win32.join(agentsDir, 'agents.json');
  const handoffsDir = ctx.paths.featureDataDir('handoffs');
  const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');

  const settings = await readJsonStore<{ compact_threshold: number }>(settingsFile, {
    compact_threshold: 0.7,
  });
  const compactThreshold = typeof settings.compact_threshold === 'number' ? settings.compact_threshold : 0.7;

  const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(
    convsFile,
    { version: 1, conversations: [] }
  );

  const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
    version: 1,
    agents: [],
  });

  const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
    version: 1,
    handoffs: [],
  });

  let convsDirty = false;
  let handoffsDirty = false;

  // 1. Check active conversation jobs
  for (const conv of convsData.conversations) {
    if (!conv.active_job_id) {
      continue;
    }

    const metaFile = path.win32.join(ctx.paths.jobsDir, `${conv.active_job_id}.json`);
    const logFile = path.win32.join(ctx.paths.jobsDir, `${conv.active_job_id}.log`);

    // Item 11: Missing job meta check (> 10 min)
    if (!isFileSafe(metaFile)) {
      if (conv.active_started_at && Date.now() - new Date(conv.active_started_at).getTime() > 10 * 60 * 1000) {
        conv.seq++;
        const failMsg: Message = {
          seq: conv.seq,
          id: generateMessageId(),
          role: 'assistant',
          text: 'Job record missing (expired or removed).',
          ts: new Date().toISOString(),
          platform: conv.platform,
          model: conv.model,
          effort: conv.effort,
          actual_model: '',
          job_id: conv.active_job_id,
          status: 'failed',
          cost_usd: null,
          tokens_in: null,
          tokens_out: null,
          duration_sec: null,
          attachments: [],
          handoff_id: '',
          steered: false,
        };
        appendConversationMessage(chatDir, conv.id, failMsg);
        conv.last_status = 'failed';
        conv.last_error = 'job record missing';
        conv.active_job_id = '';
        conv.active_kind = '';
        conv.active_started_at = '';
        conv.updated_at = new Date().toISOString();
        convsDirty = true;
      }
      continue;
    }

    let meta: JobMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
      meta = await refreshJobMetaStatus(meta, ctx.paths.jobsDir);
    } catch {
      continue;
    }

    const statusUpper = String(meta.status ?? '').toUpperCase();
    if (statusUpper !== 'DONE' && statusUpper !== 'FAILED' && statusUpper !== 'CANCELLED') {
      continue;
    }

    let logText = '';
    if (isFileSafe(logFile)) {
      try {
        logText = fs.readFileSync(logFile, 'utf8');
      } catch {
        logText = '';
      }
    }

    // Item 12: Auth error detection only for FAILED jobs
    const parsed = parseJobLog(logText, { isFailed: statusUpper === 'FAILED' });
    const elapsedSec = conv.active_started_at
      ? Math.max(1, Math.round((Date.now() - new Date(conv.active_started_at).getTime()) / 1000))
      : 1;

    if (conv.active_kind === 'turn') {
      conv.seq++;
      const assistantMsg: Message = {
        seq: conv.seq,
        id: generateMessageId(),
        role: 'assistant',
        text: parsed.reply,
        ts: new Date().toISOString(),
        platform: conv.platform,
        model: conv.model,
        effort: conv.effort,
        actual_model: parsed.actual_model,
        job_id: conv.active_job_id,
        status: statusUpper.toLowerCase() as Message['status'],
        cost_usd: parsed.cost_usd,
        tokens_in: parsed.tokens_in,
        tokens_out: parsed.tokens_out,
        duration_sec: elapsedSec,
        attachments: [],
        handoff_id: '',
        steered: false,
      };

      appendConversationMessage(chatDir, conv.id, assistantMsg);

      if (parsed.cost_usd) conv.cost_usd = Math.round((conv.cost_usd + parsed.cost_usd) * 10000) / 10000;
      if (parsed.tokens_in) conv.tokens_in += parsed.tokens_in;
      if (parsed.tokens_out) conv.tokens_out += parsed.tokens_out;

      if (parsed.resume_token) {
        conv.resume = {
          platform: conv.platform,
          token: parsed.resume_token,
          session: conv.session,
        };
      }

      conv.last_status = statusUpper.toLowerCase();
      conv.last_error = statusUpper === 'FAILED' ? parsed.reply.slice(0, 500) : '';

      const msgs = readConversationMessages(chatDir, conv.id);
      conv.context = computeContextMeter(
        conv.summary,
        msgs,
        conv.summary_seq,
        conv.platform,
        parsed.tokens_in
      );

      conv.active_job_id = '';
      conv.active_kind = '';
      conv.active_started_at = '';
      conv.updated_at = new Date().toISOString();
      convsDirty = true;

      const agent = agentsData.agents.find((a) => a.id === conv.agent_id);

      // Item 7: Retry policy implementation
      if (statusUpper === 'FAILED' && agent && agent.retry_policy?.max_attempts) {
        const attempts = conv.retry_attempts ?? 0;
        if (attempts < agent.retry_policy.max_attempts) {
          conv.retry_attempts = attempts + 1;
          const backoffSec = agent.retry_policy.backoff_sec || 0;

          conv.seq++;
          const retrySysMsg: Message = {
            seq: conv.seq,
            id: generateMessageId(),
            role: 'system',
            text: `Thử lại lần ${conv.retry_attempts}`,
            ts: new Date().toISOString(),
            platform: conv.platform,
            model: conv.model,
            effort: conv.effort,
            actual_model: '',
            job_id: '',
            status: 'done',
            cost_usd: null,
            tokens_in: null,
            tokens_out: null,
            duration_sec: null,
            attachments: [],
            handoff_id: '',
            steered: false,
          };
          appendConversationMessage(chatDir, conv.id, retrySysMsg);

          // Find the failed user message text to re-run
          let lastUserText = '';
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.role === 'user') {
              lastUserText = msgs[i]!.text;
              break;
            }
          }

          if (lastUserText) {
            conv.queue.push({
              id: 'q_' + generateMessageId().slice(2, 8),
              text: lastUserText,
              ts: new Date(Date.now() + backoffSec * 1000).toISOString(),
            });
          }
        }
      } else if (statusUpper === 'DONE') {
        conv.retry_attempts = 0;
      }

      // Check if lead reply contains handoffs
      if (agent && agent.team_id && statusUpper === 'DONE') {
        const teamFile = path.win32.join(agent.workdir, '.maw', 'team.json');
        if (isFileSafe(teamFile)) {
          try {
            const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
            const role = team.roles.find((r) => r.key === agent.team_role || r.agent_id === agent.id);
            if (role && role.may_delegate) {
              const dispatchRes = parseHandoffDispatchBlock(parsed.reply);
              if (dispatchRes.ok && dispatchRes.handoffs.length > 0) {
                const batchId = 'b_' + generateHandoffId().slice(2, 8);
                for (const item of dispatchRes.handoffs) {
                  let targetRole = team.roles.find(
                    (r) => r.key === item.to || r.name.toLowerCase() === item.to.toLowerCase() || r.agent_id === item.to
                  );
                  let targetAgent = targetRole?.agent_id
                    ? agentsData.agents.find((a) => a.id === targetRole!.agent_id)
                    : agentsData.agents.find(
                        (a) =>
                          a.team_id === team.id &&
                          (a.team_role === item.to || a.name.toLowerCase() === item.to.toLowerCase() || a.id === item.to)
                      );

                  const hRecord: Handoff = {
                    id: generateHandoffId(),
                    team_id: team.id,
                    lead_agent_id: agent.id,
                    lead_conversation_id: conv.id,
                    lead_seq: conv.seq,
                    batch: batchId,
                    from: agent.id,
                    to: targetAgent?.id ?? item.to,
                    to_role: targetRole?.key ?? item.to,
                    task: item.task,
                    acceptance: item.acceptance || '',
                    status: 'started',
                    job_id: '',
                    member_conversation_id: '',
                    isolated: false,
                    worktree: '',
                    branch: '',
                    platform: targetAgent?.platform || team.shared.platform || 'codex',
                    actual_model: '',
                    created_at: new Date().toISOString(),
                    started_at: '',
                    finished_at: '',
                    duration_sec: null,
                    result: null,
                    parse_error: '',
                    scope_violations: [],
                    attempts: 0,
                  };

                  handoffsData.handoffs.unshift(hRecord);
                  handoffsDirty = true;
                }
                if (handoffsData.handoffs.length > 500) {
                  handoffsData.handoffs = handoffsData.handoffs.slice(0, 500);
                }
              }
            }
          } catch {}
        }
      }
    } else if (conv.active_kind === 'compact') {
      if (statusUpper === 'DONE') {
        conv.summary = parsed.reply;
        conv.summary_seq = conv.seq;
        conv.session++;
        conv.resume = null;
        conv.compact_error = undefined;
        conv.compact_failed_at = undefined;

        conv.seq++;
        const sysMsg: Message = {
          seq: conv.seq,
          id: generateMessageId(),
          role: 'system',
          text: `Đã nén ngữ cảnh (phiên ${conv.session})`,
          ts: new Date().toISOString(),
          platform: conv.platform,
          model: conv.model,
          effort: conv.effort,
          actual_model: '',
          job_id: '',
          status: 'done',
          cost_usd: null,
          tokens_in: null,
          tokens_out: null,
          duration_sec: elapsedSec,
          attachments: [],
          handoff_id: '',
          steered: false,
        };
        appendConversationMessage(chatDir, conv.id, sysMsg);
      } else {
        // Item 5: record compact failure and back off
        conv.compact_error = parsed.reply || 'Compaction failed';
        conv.compact_failed_at = new Date().toISOString();
      }

      conv.active_job_id = '';
      conv.active_kind = '';
      conv.active_started_at = '';
      conv.updated_at = new Date().toISOString();

      const msgs = readConversationMessages(chatDir, conv.id);
      conv.context = computeContextMeter(
        conv.summary,
        msgs,
        conv.summary_seq,
        conv.platform,
        parsed.tokens_in
      );
      convsDirty = true;
    }
  }

  // 2. Process running handoffs
  for (const h of handoffsData.handoffs) {
    if (h.status !== 'running' || !h.job_id) {
      continue;
    }

    const metaFile = path.win32.join(ctx.paths.jobsDir, `${h.job_id}.json`);
    const logFile = path.win32.join(ctx.paths.jobsDir, `${h.job_id}.log`);

    // Item 11: Missing job meta for running handoff
    if (!isFileSafe(metaFile)) {
      if (h.started_at && Date.now() - new Date(h.started_at).getTime() > 10 * 60 * 1000) {
        await finalizeHandoff(ctx, h, 'failed', { error: 'Job record missing' }, convsData);
        handoffsDirty = true;
      }
      continue;
    }

    let meta: JobMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
      meta = await refreshJobMetaStatus(meta, ctx.paths.jobsDir);
    } catch {
      continue;
    }

    const statusUpper = String(meta.status ?? '').toUpperCase();
    if (statusUpper !== 'DONE' && statusUpper !== 'FAILED' && statusUpper !== 'CANCELLED') {
      continue;
    }

    let logText = '';
    if (isFileSafe(logFile)) {
      try {
        logText = fs.readFileSync(logFile, 'utf8');
      } catch {
        logText = '';
      }
    }

    const parsed = parseJobLog(logText, { isFailed: statusUpper === 'FAILED' });
    const metaAny = meta as unknown as Record<string, unknown>;
    if (typeof metaAny.worktree === 'string' && metaAny.worktree) {
      h.isolated = true;
      h.worktree = metaAny.worktree;
      h.branch = String(metaAny.branch ?? '');
    }

    if (statusUpper === 'CANCELLED') {
      await finalizeHandoff(ctx, h, 'cancelled', {
        actual_model: parsed.actual_model,
        parsed_reply: parsed.reply,
        parsed_cost: parsed.cost_usd,
        tokens_in: parsed.tokens_in,
        tokens_out: parsed.tokens_out,
      }, convsData);
    } else if (statusUpper === 'FAILED' && !logText.includes('```json')) {
      await finalizeHandoff(ctx, h, 'failed', {
        actual_model: parsed.actual_model,
        parsed_reply: parsed.reply,
        parsed_cost: parsed.cost_usd,
        tokens_in: parsed.tokens_in,
        tokens_out: parsed.tokens_out,
        error: 'Job failed without json block',
      }, convsData);
    } else {
      const parsedRes = parseStructuredHandoffResult(parsed.reply, parsed.cost_usd);
      if (!parsedRes.ok) {
        h.result = parsedRes.fallbackResult;
        await finalizeHandoff(ctx, h, 'needs_review', {
          actual_model: parsed.actual_model,
          parsed_reply: parsed.reply,
          parsed_cost: parsed.cost_usd,
          tokens_in: parsed.tokens_in,
          tokens_out: parsed.tokens_out,
          error: parsedRes.error,
        }, convsData);
      } else {
        h.result = parsedRes.result;

        // Write scope check when isolated
        let finalStatus: HandoffStatus = h.result.status;
        if (h.isolated && h.worktree) {
          const changedFiles = await getWorktreeChangedFiles(h.worktree);
          const unionFiles = new Set([...changedFiles, ...h.result.files_changed]);

          const targetAgent = agentsData.agents.find((a) => a.id === h.to);
          let writeScope: string[] = ['**'];
          if (targetAgent?.workdir) {
            const teamFile = path.win32.join(targetAgent.workdir, '.maw', 'team.json');
            if (isFileSafe(teamFile)) {
              try {
                const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
                const role = team.roles.find((r) => r.key === h.to_role);
                writeScope = role?.override?.write_scope ?? team.shared.write_scope ?? ['**'];
              } catch {}
            }
          }

          const violations: string[] = [];
          for (const f of unionFiles) {
            if (!matchesAnyScope(f, writeScope)) {
              violations.push(f);
            }
          }

          try {
            const guardRes = await handleSpecGuard(
              { project_path: h.worktree, owner: h.platform },
              ctx.paths
            );
            if (guardRes && guardRes.verdict === 'FAIL') {
              const guardViolations = Array.isArray(guardRes.violations)
                ? (guardRes.violations as Array<{ path?: string }>)
                    .map((v) => String(v.path ?? ''))
                    .filter((p) => p.length > 0)
                : [];
              for (const gv of guardViolations) {
                if (!violations.includes(gv)) {
                  violations.push(gv);
                }
              }
            }
          } catch {}

          if (violations.length > 0) {
            h.scope_violations = violations;
            finalStatus = 'needs_review';
          }
        }

        await finalizeHandoff(ctx, h, finalStatus, {
          actual_model: parsed.actual_model,
          parsed_reply: parsed.reply,
          parsed_cost: parsed.cost_usd,
          tokens_in: parsed.tokens_in,
          tokens_out: parsed.tokens_out,
        }, convsData);
      }
    }

    handoffsDirty = true;
  }

  // 3. Dispatch waiting handoffs (started -> running) within max_parallel
  const teamHandoffMap = new Map<string, Handoff[]>();
  for (const h of handoffsData.handoffs) {
    if (h.status === 'started' || h.status === 'running') {
      const list = teamHandoffMap.get(h.team_id) ?? [];
      list.push(h);
      teamHandoffMap.set(h.team_id, list);
    }
  }

  for (const [teamId, handoffsList] of teamHandoffMap.entries()) {
    const leadAgent = agentsData.agents.find((a) => a.team_id === teamId);
    let maxParallel = 3;
    let isolate = true;
    let teamObj: Team | null = null;
    if (leadAgent?.workdir) {
      const teamFile = path.win32.join(leadAgent.workdir, '.maw', 'team.json');
      if (isFileSafe(teamFile)) {
        try {
          teamObj = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
          maxParallel = teamObj.shared?.max_parallel || 3;
          isolate = teamObj.shared?.isolate !== false;
        } catch {}
      }
    }

    let runningCount = handoffsList.filter((h) => h.status === 'running').length;
    const startedList = handoffsList.filter((h) => h.status === 'started');

    for (const h of startedList) {
      if (runningCount >= maxParallel) {
        break;
      }

      const memberAgent = agentsData.agents.find((a) => a.id === h.to);
      // Item 8: start failures finalize handoff immediately
      if (!memberAgent) {
        await finalizeHandoff(ctx, h, 'failed', { error: `Member agent '${h.to}' not found.` });
        handoffsDirty = true;
        continue;
      }

      let memberConv: Conversation | undefined;
      if (h.member_conversation_id) {
        memberConv = convsData.conversations.find((c) => c.id === h.member_conversation_id);
      }
      if (!memberConv) {
        memberConv = {
          id: generateConversationId(),
          agent_id: memberAgent.id,
          title: `Handoff: ${h.task.slice(0, 40)}`,
          kind: 'handoff',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
          seq: 0,
          session: 1,
          platform: memberAgent.platform,
          model: memberAgent.model,
          effort: memberAgent.effort,
          resume: null,
          summary: '',
          summary_seq: 0,
          active_job_id: '',
          active_kind: '',
          active_started_at: '',
          queue: [],
          cost_usd: 0,
          tokens_in: 0,
          tokens_out: 0,
          context: { used_tokens: 0, window_tokens: getWindowTokens(memberAgent.platform), pct: 0 },
          last_status: '',
          last_error: '',
        };
        convsData.conversations.unshift(memberConv);
        convsDirty = true;
      }

      h.member_conversation_id = memberConv.id;

      // Item 9: Member brief includes role profile sections and memory context
      let roleSections: any = undefined;
      if (memberAgent.workdir) {
        const roleFile = path.win32.join(memberAgent.workdir, '.maw', 'roles', `${h.to_role}.md`);
        if (isFileSafe(roleFile)) {
          try {
            roleSections = parseRoleMarkdown(fs.readFileSync(roleFile, 'utf8')).sections;
          } catch {}
        }
      }

      let memContext = '';
      try {
        const memRes = await getMemoryContext(memberAgent.workdir, h.task, 2500);
        memContext = memRes.text;
      } catch {}

      const promptLines: string[] = [
        `# Task for ${h.to_role}`,
        `Task: ${h.task}`,
      ];
      if (h.acceptance) {
        promptLines.push(`Acceptance criteria: ${h.acceptance}`);
      }
      promptLines.push(
        '\nFinish with exactly one fenced ```json block:\n' +
          '```json\n' +
          '{\n' +
          '  "status": "completed" | "failed" | "blocked",\n' +
          '  "summary": "<summary <= 1500 chars>",\n' +
          '  "files_changed": ["relative/path", ...],\n' +
          '  "evidence": "<test output / commands run <= 3000 chars>",\n' +
          '  "blockers": ["..."],\n' +
          '  "cost": null,\n' +
          '  "decisions": ["..."]\n' +
          '}\n' +
          '```'
      );

      const memberPrompt = buildPrompt({
        agent: {
          name: memberAgent.name,
          persona: memberAgent.persona,
          team_role: memberAgent.team_role,
          role_sections: roleSections,
        },
        memoryContext: memContext,
        newMessageText: promptLines.join('\n'),
      });

      const execRole = memberAgent.role || 'backend';
      // Item 4: new_session true for new_session-capable platform (antigravity)
      const newSession = newSessionFor(ctx, memberAgent.platform);

      try {
        const jobRes = await ctx.startJob({
          mode: 'task',
          agent: memberAgent.platform,
          role: execRole,
          model: memberAgent.model || undefined,
          effort: memberAgent.effort || undefined,
          new_session: newSession,
          project_path: memberAgent.workdir,
          prompt: memberPrompt,
          isolate,
        });

        h.status = 'running';
        h.job_id = String(jobRes.job_id ?? '');
        h.started_at = new Date().toISOString();
        runningCount++;
        handoffsDirty = true;
      } catch (err: unknown) {
        // Item 8: start error routes through finalizeHandoff
        await finalizeHandoff(ctx, h, 'failed', {
          error: 'Failed to start job: ' + (err instanceof Error ? err.message : String(err)),
        }, convsData);
        handoffsDirty = true;
      }
    }
  }

  // 4. Start queued messages of idle conversations
  for (const conv of convsData.conversations) {
    if (conv.active_job_id || conv.deleted_at !== null || conv.queue.length === 0) {
      continue;
    }

    // Check backoff if item has delayed ts
    const nextItem = conv.queue[0]!;
    if (nextItem.ts && new Date(nextItem.ts).getTime() > Date.now()) {
      continue;
    }

    conv.queue.shift();
    convsDirty = true;

    const agent = agentsData.agents.find((a) => a.id === conv.agent_id);
    if (!agent) {
      continue;
    }

    // Item 6: Wrap queue start per conversation: drop item on error and record system message
    try {
      await startTurnJob(ctx, conv, nextItem, agent, chatDir);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      conv.seq++;
      const sysMsg: Message = {
        seq: conv.seq,
        id: generateMessageId(),
        role: 'system',
        text: `Lỗi khởi chạy tác vụ: ${errMsg}`,
        ts: new Date().toISOString(),
        platform: conv.platform || agent.platform,
        model: conv.model,
        effort: conv.effort,
        actual_model: '',
        job_id: '',
        status: 'failed',
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        duration_sec: null,
        attachments: [],
        handoff_id: '',
        steered: false,
      };
      appendConversationMessage(chatDir, conv.id, sysMsg);
      conv.last_status = 'failed';
      conv.last_error = errMsg;
      conv.active_job_id = '';
      conv.active_kind = '';
      conv.updated_at = new Date().toISOString();
    }
  }

  // 5. Check compaction trigger for idle conversations
  for (const conv of convsData.conversations) {
    if (conv.active_job_id || conv.deleted_at !== null) {
      continue;
    }

    // Item 5: Backoff 10 minutes on compaction failure
    if (conv.compact_failed_at) {
      const failedTime = new Date(conv.compact_failed_at).getTime();
      if (Date.now() - failedTime < 10 * 60 * 1000) {
        continue;
      }
    }

    const msgs = readConversationMessages(chatDir, conv.id);
    const msgsAfterSummary = msgs.filter((m) => m.seq > conv.summary_seq);
    const replayChars = msgsAfterSummary.reduce((sum, m) => sum + (m.text || '').length, 0) + (conv.summary || '').length;

    // Trigger A: pct >= compactThreshold
    // Trigger B: messages after summary_seq no longer fit replay budget (> 13 000 chars)
    const pctTrigger = conv.context.pct >= compactThreshold;
    const replayOverflowTrigger = replayChars > 13000;

    if (pctTrigger || replayOverflowTrigger) {
      await startCompactionJob(ctx, conv, chatDir, agentsData.agents);
      convsDirty = true;
    }
  }

  if (convsDirty) {
    await writeJsonStore(convsFile, convsData);
  }
  if (handoffsDirty) {
    await writeJsonStore(handoffsFile, handoffsData);
  }
}

export async function startTurnJob(
  ctx: MawFeatureContext,
  conv: Conversation,
  item: QueueItem,
  agent: Agent,
  chatDir: string
): Promise<void> {
  const targetPlatform = item.platform || conv.platform || agent.platform;
  const targetModel = item.model || conv.model || agent.model;
  const targetEffort = item.effort || conv.effort || agent.effort;

  const msgs = readConversationMessages(chatDir, conv.id);

  // Item 16: Platform switch applies when turn starts
  if (conv.platform && conv.platform.toLowerCase() !== targetPlatform.toLowerCase()) {
    const oldPlatform = conv.platform;
    conv.session++;
    conv.platform = targetPlatform;
    conv.resume = null;

    if (!conv.summary && msgs.length > 0) {
      const last8 = msgs.slice(-8).map((m) => `${m.role}: ${m.text.slice(0, 300)}`);
      conv.summary = last8.join('\n');
      conv.summary_seq = conv.seq;
    }

    conv.seq++;
    const sysMsg: Message = {
      seq: conv.seq,
      id: generateMessageId(),
      role: 'system',
      text: `Đổi nền tảng ${oldPlatform} → ${targetPlatform} (phiên mới, kèm tóm tắt)`,
      ts: new Date().toISOString(),
      platform: targetPlatform,
      model: targetModel,
      effort: targetEffort,
      actual_model: '',
      job_id: '',
      status: 'done',
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      duration_sec: null,
      attachments: [],
      handoff_id: '',
      steered: false,
    };
    appendConversationMessage(chatDir, conv.id, sysMsg);
  }

  // Item 3: history = every message after summary_seq
  const relevantHistory = msgs
    .filter((m) => m.seq > conv.summary_seq)
    .map((m) => ({
      seq: m.seq,
      role: m.role,
      text: m.text,
      handoff_id: m.handoff_id,
    }));

  // Read memory context
  let memContext = '';
  try {
    const memRes = await getMemoryContext(agent.workdir, item.text, 2500);
    memContext = memRes.text;
  } catch {}

  // Item 9: may_delegate from team role + teamMembers list
  let mayDelegate = false;
  let teamMembers: PromptMemberInfo[] = [];

  if (agent.team_id && agent.workdir) {
    const teamFile = path.win32.join(agent.workdir, '.maw', 'team.json');
    if (isFileSafe(teamFile)) {
      try {
        const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
        const myRole = team.roles.find((r) => r.key === agent.team_role || r.agent_id === agent.id);
        mayDelegate = Boolean(myRole?.may_delegate);

        if (mayDelegate) {
          for (const r of team.roles) {
            if (r.key === myRole?.key || !r.enabled) continue;
            let respOneLiner = '';
            const rFile = path.win32.join(agent.workdir, '.maw', 'roles', `${r.key}.md`);
            if (isFileSafe(rFile)) {
              try {
                const parsedR = parseRoleMarkdown(fs.readFileSync(rFile, 'utf8'));
                respOneLiner = parsedR.sections.responsibility.slice(0, 150).replace(/\r?\n/g, ' ');
              } catch {}
            }
            teamMembers.push({
              key: r.key,
              name: r.name,
              platform: r.override?.platform || team.shared.platform || 'codex',
              responsibility: respOneLiner,
            });
          }
        }
      } catch {}
    }
  }

  const promptText = buildPrompt({
    agent: {
      name: agent.name,
      persona: agent.persona,
      team_role: agent.team_role,
      hooks: agent.hooks,
      may_delegate: mayDelegate,
    },
    newMessageText: item.text,
    summary: conv.summary,
    session: conv.session,
    memoryContext: memContext,
    recentMessages: relevantHistory,
    teamMembers,
    attachmentLines: (item.attachments ?? []).map((a) => `Attached image: ${a.path || a.name}`),
  });

  // Item 4: new_session helper
  const newSession = newSessionFor(ctx, targetPlatform);

  let jobRes: Record<string, unknown>;
  try {
    jobRes = await ctx.startJob({
      mode: 'task',
      agent: targetPlatform,
      role: agent.role || 'backend',
      model: targetModel || undefined,
      effort: targetEffort || undefined,
      new_session: newSession,
      project_path: agent.workdir,
      prompt: promptText,
      isolate: false,
    });
  } catch (err: unknown) {
    // If startJob fails, message status becomes failed
    conv.seq++;
    const failedUserMsg: Message = {
      seq: conv.seq,
      id: generateMessageId(),
      role: 'user',
      text: item.text,
      ts: new Date().toISOString(),
      platform: targetPlatform,
      model: targetModel,
      effort: targetEffort,
      actual_model: '',
      job_id: '',
      status: 'failed',
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      duration_sec: null,
      attachments: (item.attachments ?? []).map((a) => ({ name: a.name, path: a.path ?? '' })),
      handoff_id: '',
      steered: false,
      system_generated: Boolean(item.system_generated),
    };
    appendConversationMessage(chatDir, conv.id, failedUserMsg);
    throw err;
  }

  const jobId = String(jobRes.job_id ?? '');

  // Item 2: User message becomes 'done' once job has started
  conv.seq++;
  const userMsg: Message = {
    seq: conv.seq,
    id: generateMessageId(),
    role: 'user',
    text: item.text,
    ts: new Date().toISOString(),
    platform: targetPlatform,
    model: targetModel,
    effort: targetEffort,
    actual_model: '',
    job_id: jobId,
    status: 'done',
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    duration_sec: null,
    attachments: (item.attachments ?? []).map((a) => ({ name: a.name, path: a.path ?? '' })),
    handoff_id: '',
    steered: false,
    system_generated: Boolean(item.system_generated),
  };
  appendConversationMessage(chatDir, conv.id, userMsg);

  conv.active_job_id = jobId;
  conv.active_kind = 'turn';
  conv.active_started_at = new Date().toISOString();
  conv.platform = targetPlatform;
  conv.model = targetModel;
  conv.effort = targetEffort;
  conv.updated_at = new Date().toISOString();
}

export async function startCompactionJob(
  ctx: MawFeatureContext,
  conv: Conversation,
  chatDir: string,
  agents: Agent[]
): Promise<void> {
  const agent = agents.find((a) => a.id === conv.agent_id);
  if (!agent) return;

  const msgs = readConversationMessages(chatDir, conv.id);
  const relevantMsgs = msgs.filter((m) => m.seq > conv.summary_seq);

  const historyLines: string[] = [];
  if (conv.summary) {
    historyLines.push(`Previous summary:\n${conv.summary}\n`);
  }
  historyLines.push('Conversation history:');
  for (const m of relevantMsgs) {
    historyLines.push(`${m.role.toUpperCase()}: ${m.text}`);
  }

  const header =
    'Summarize this conversation for your own continuation: goals, decisions, current state, open items, file paths. ≤ 1200 words.\n\n';
  let historyText = historyLines.join('\n');

  // Item 5: cap compaction prompt to 17000 chars (keeping newest)
  if (header.length + historyText.length > 17000) {
    while (relevantMsgs.length > 1 && header.length + historyText.length > 17000) {
      relevantMsgs.shift(); // drop oldest
      const trimmedLines = [
        conv.summary ? `Previous summary:\n${conv.summary}\n` : '',
        'Conversation history:',
        ...relevantMsgs.map((m) => `${m.role.toUpperCase()}: ${m.text}`),
      ];
      historyText = trimmedLines.join('\n');
    }
  }

  const prompt = header + historyText;
  const platform = conv.platform || agent.platform;
  const newSession = newSessionFor(ctx, platform);

  try {
    const jobRes = await ctx.startJob({
      mode: 'task',
      agent: platform,
      role: agent.role || 'backend',
      model: conv.model || undefined,
      effort: conv.effort || undefined,
      new_session: newSession,
      project_path: agent.workdir,
      prompt,
      isolate: false,
    });

    conv.active_job_id = String(jobRes.job_id ?? '');
    conv.active_kind = 'compact';
    conv.active_started_at = new Date().toISOString();
    conv.updated_at = new Date().toISOString();
    conv.compact_error = undefined;
    conv.compact_failed_at = undefined;
  } catch (err: unknown) {
    // Item 5: record compact_error and back off
    conv.compact_error = err instanceof Error ? err.message : String(err);
    conv.compact_failed_at = new Date().toISOString();
    conv.active_job_id = '';
    conv.active_kind = '';
    conv.active_started_at = '';
    conv.updated_at = new Date().toISOString();
  }
}
