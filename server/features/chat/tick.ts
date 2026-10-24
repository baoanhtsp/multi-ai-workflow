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
import { getNextAdrId, parseDecisionsMarkdown, renderDecisionsMarkdown, type MemoryEntry } from '../agents-ws/lib/markdown-memory.ts';
import { buildPrompt, type PromptMemberInfo } from '../agents-ws/lib/prompt.ts';
import { readJsonStore, writeJsonStore } from '../agents-ws/lib/store.ts';
import type { Agent } from '../agents-ws/types.ts';
import { getMemoryContext } from '../memory/index.ts';
import type { Team } from '../teams/types.ts';
import type { Conversation, Message, QueueItem } from './types.ts';
import type { Handoff } from '../handoffs/types.ts';

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
    await runTickCycle(ctx);
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

    if (!isFileSafe(metaFile)) {
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

      // Check if lead reply contains handoffs
      const agent = agentsData.agents.find((a) => a.id === conv.agent_id);
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
                  // Find target member agent in team
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
          } catch {
            // Ignore team parsing error
          }
        }
      }
    } else if (conv.active_kind === 'compact') {
      if (statusUpper === 'DONE') {
        conv.summary = parsed.reply;
        conv.summary_seq = conv.seq;
        conv.session++;
        conv.resume = null;

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
    if (!isFileSafe(metaFile)) {
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
    h.finished_at = new Date().toISOString();
    h.duration_sec = h.started_at
      ? Math.max(1, Math.round((Date.now() - new Date(h.started_at).getTime()) / 1000))
      : 1;
    h.actual_model = parsed.actual_model;

    // Check if runner isolated worktree/branch
    const metaAny = meta as unknown as Record<string, unknown>;
    if (typeof metaAny.worktree === 'string' && metaAny.worktree) {
      h.isolated = true;
      h.worktree = metaAny.worktree;
      h.branch = String(metaAny.branch ?? '');
    }

    if (statusUpper === 'CANCELLED') {
      h.status = 'cancelled';
    } else if (statusUpper === 'FAILED' && !logText.includes('```json')) {
      h.status = 'failed';
    } else {
      const parsedRes = parseStructuredHandoffResult(parsed.reply, parsed.cost_usd);
      if (!parsedRes.ok) {
        h.status = 'needs_review';
        h.parse_error = parsedRes.error;
        h.result = parsedRes.fallbackResult;
      } else {
        h.result = parsedRes.result;

        // Write scope check when isolated
        if (h.isolated && h.worktree) {
          const changedFiles = await getWorktreeChangedFiles(h.worktree);
          const unionFiles = new Set([...changedFiles, ...h.result.files_changed]);

          // Look up write_scope from team.json
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

          // Spec guard check
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
          } catch {
            // Spec guard best-effort
          }

          if (violations.length > 0) {
            h.scope_violations = violations;
            h.status = 'needs_review';
          } else {
            h.status = h.result.status;
          }
        } else {
          h.status = h.result.status;
        }

        // Add decisions to project memory if completed
        if (h.status === 'completed' && h.result.decisions && h.result.decisions.length > 0) {
          const leadAgent = agentsData.agents.find((a) => a.id === h.lead_agent_id);
          if (leadAgent?.workdir) {
            const memDir = path.win32.join(leadAgent.workdir, '.maw', 'memory');
            const memFile = path.win32.join(memDir, 'decisions.md');
            try {
              let parsedMem = { preamble: '# Project decisions\n', entries: [] as MemoryEntry[] };
              if (isFileSafe(memFile)) {
                const rawMem = fs.readFileSync(memFile, 'utf8');
                parsedMem = parseDecisionsMarkdown(rawMem);
              }
              for (const dec of h.result.decisions) {
                const nextId = getNextAdrId(parsedMem.entries);
                parsedMem.entries.push({
                  id: nextId,
                  title: dec.slice(0, 100),
                  body: dec,
                  date: new Date().toISOString().slice(0, 10),
                  source: `handoff:${h.id}`,
                  agent: h.platform,
                  pinned: false,
                  tags: ['handoff', h.to_role],
                });
              }
              const rendered = renderDecisionsMarkdown(parsedMem.preamble, parsedMem.entries);
              if (!fs.existsSync(memDir)) {
                fs.mkdirSync(memDir, { recursive: true });
              }
              fs.writeFileSync(memFile, rendered, 'utf8');
            } catch {}
          }
        }
      }
    }

    handoffsDirty = true;

    // Terminal status: append handoff message to Lead conversation
    const leadConv = convsData.conversations.find((c) => c.id === h.lead_conversation_id);
    if (leadConv) {
      leadConv.seq++;
      const memberAgent = agentsData.agents.find((a) => a.id === h.to);
      const memberName = memberAgent ? memberAgent.name : h.to_role;
      const durStr = formatDuration(h.duration_sec ?? 1);
      const summaryText = (h.result?.summary || parsed.reply).slice(0, 600);
      const filesCount = h.result?.files_changed?.length ?? 0;
      const blockersCount = h.result?.blockers?.length ?? 0;

      const handoffMsgText = `[Handoff ${h.id}] ${h.to_role} · ${memberName} (${h.platform}) ${h.status} in ${durStr} — ${summaryText} · files: ${filesCount} · blockers: ${blockersCount}`;

      const handoffMsg: Message = {
        seq: leadConv.seq,
        id: generateMessageId(),
        role: 'handoff',
        text: handoffMsgText,
        ts: new Date().toISOString(),
        platform: h.platform,
        model: '',
        effort: '',
        actual_model: h.actual_model,
        job_id: h.job_id,
        status: h.status === 'completed' ? 'done' : 'failed',
        cost_usd: h.result?.cost ?? null,
        tokens_in: parsed.tokens_in,
        tokens_out: parsed.tokens_out,
        duration_sec: h.duration_sec,
        attachments: [],
        handoff_id: h.id,
        steered: false,
      };

      appendConversationMessage(chatDir, leadConv.id, handoffMsg);
      leadConv.updated_at = new Date().toISOString();
      convsDirty = true;

      // Check if all handoffs of batch are terminal
      const batchHandoffs = handoffsData.handoffs.filter((item) => item.batch === h.batch);
      const allBatchTerminal = batchHandoffs.every(
        (item) => item.status !== 'started' && item.status !== 'running'
      );

      if (allBatchTerminal) {
        const leadAgent = agentsData.agents.find((a) => a.id === h.lead_agent_id);
        if (leadAgent?.workdir) {
          const teamFile = path.win32.join(leadAgent.workdir, '.maw', 'team.json');
          if (isFileSafe(teamFile)) {
            try {
              const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
              if (team.shared?.auto_continue) {
                // Build compact table for batch summary
                const tableRows = batchHandoffs.map(
                  (b) =>
                    `| ${b.id} | ${b.to_role} | ${b.status} | ${(b.result?.summary || '').slice(0, 200)} | ${b.result?.files_changed?.length ?? 0} files | ${b.result?.blockers?.length ?? 0} blockers |`
                );
                const tableText =
                  '### Member Handoff Results\n' +
                  '| ID | Role | Status | Summary | Files | Blockers |\n|---|---|---|---|---|---|\n' +
                  tableRows.join('\n') +
                  '\n\nContinue the plan, dispatch fixes, or write the final summary.';

                leadConv.queue.push({
                  id: 'q_' + generateMessageId().slice(2, 8),
                  text: tableText,
                  ts: new Date().toISOString(),
                });
                leadConv.updated_at = new Date().toISOString();
                convsDirty = true;
              }
            } catch {}
          }
        }
      }
    }
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
    if (leadAgent?.workdir) {
      const teamFile = path.win32.join(leadAgent.workdir, '.maw', 'team.json');
      if (isFileSafe(teamFile)) {
        try {
          const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
          maxParallel = team.shared?.max_parallel || 3;
          isolate = team.shared?.isolate !== false;
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
      if (!memberAgent) {
        h.status = 'failed';
        h.parse_error = `Member agent '${h.to}' not found.`;
        handoffsDirty = true;
        continue;
      }

      // Member conversation setup
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

      // Build member task prompt
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
        },
        newMessageText: promptLines.join('\n'),
      });

      const execRole = memberAgent.role || 'backend';
      try {
        const jobRes = await ctx.startJob({
          mode: 'task',
          agent: memberAgent.platform,
          role: execRole,
          model: memberAgent.model || undefined,
          effort: memberAgent.effort || undefined,
          new_session: false,
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
        h.status = 'failed';
        h.parse_error = 'Failed to start job: ' + (err instanceof Error ? err.message : String(err));
        handoffsDirty = true;
      }
    }
  }

  // 4. Start queued messages of idle conversations
  for (const conv of convsData.conversations) {
    if (conv.active_job_id || conv.deleted_at !== null || conv.queue.length === 0) {
      continue;
    }

    const nextItem = conv.queue.shift()!;
    convsDirty = true;

    const agent = agentsData.agents.find((a) => a.id === conv.agent_id);
    if (!agent) {
      continue;
    }

    await startTurnJob(ctx, conv, nextItem, agent, chatDir);
  }

  // 5. Check compaction trigger for idle conversations
  for (const conv of convsData.conversations) {
    if (conv.active_job_id || conv.deleted_at !== null) {
      continue;
    }

    if (conv.context.pct >= compactThreshold) {
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
  const platform = item.platform || conv.platform || agent.platform;
  const model = item.model || conv.model || agent.model;
  const effort = item.effort || conv.effort || agent.effort;

  const msgs = readConversationMessages(chatDir, conv.id);

  conv.seq++;
  const userMsg: Message = {
    seq: conv.seq,
    id: generateMessageId(),
    role: 'user',
    text: item.text,
    ts: new Date().toISOString(),
    platform,
    model,
    effort,
    actual_model: '',
    job_id: '',
    status: 'running',
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    duration_sec: null,
    attachments: (item.attachments ?? []).map((a) => ({ name: a.name, path: a.path ?? '' })),
    handoff_id: '',
    steered: false,
  };
  appendConversationMessage(chatDir, conv.id, userMsg);

  // Read memory context
  let memContext = '';
  try {
    const memRes = await getMemoryContext(agent.workdir, item.text, 2500);
    memContext = memRes.text;
  } catch {}

  const recentHistory = msgs.slice(-10).map((m) => ({
    seq: m.seq,
    role: m.role,
    text: m.text,
    handoff_id: m.handoff_id,
  }));

  const promptText = buildPrompt({
    agent: {
      name: agent.name,
      persona: agent.persona,
      team_role: agent.team_role,
      hooks: agent.hooks,
      may_delegate: Boolean(agent.team_id),
    },
    newMessageText: item.text,
    summary: conv.summary,
    session: conv.session,
    memoryContext: memContext,
    recentMessages: recentHistory,
    attachmentLines: (item.attachments ?? []).map((a) => `Attached image: ${a.path || a.name}`),
  });

  const registryAgent = ctx.registry?.agents?.find((a) => a.id === platform);
  const newSession = Boolean(registryAgent?.capabilities?.new_session);

  const jobRes = await ctx.startJob({
    mode: 'task',
    agent: platform,
    role: agent.role || 'backend',
    model: model || undefined,
    effort: effort || undefined,
    new_session: newSession,
    project_path: agent.workdir,
    prompt: promptText,
    isolate: false,
  });

  const jobId = String(jobRes.job_id ?? '');
  userMsg.job_id = jobId;
  conv.active_job_id = jobId;
  conv.active_kind = 'turn';
  conv.active_started_at = new Date().toISOString();
  conv.platform = platform;
  conv.model = model;
  conv.effort = effort;
  conv.updated_at = new Date().toISOString();

  // Rewrite last message with job_id
  const updatedMsgs = readConversationMessages(chatDir, conv.id);
  if (updatedMsgs.length > 0 && updatedMsgs[updatedMsgs.length - 1]!.id === userMsg.id) {
    updatedMsgs[updatedMsgs.length - 1]!.job_id = jobId;
    updateConversationMessages(chatDir, conv.id, updatedMsgs);
  }
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

  const prompt =
    'Summarize this conversation for your own continuation: goals, decisions, current state, open items, file paths. ≤ 1200 words.\n\n' +
    historyLines.join('\n');

  try {
    const jobRes = await ctx.startJob({
      mode: 'task',
      agent: conv.platform || agent.platform,
      role: agent.role || 'backend',
      model: conv.model || undefined,
      effort: conv.effort || undefined,
      new_session: false,
      project_path: agent.workdir,
      prompt,
      isolate: false,
    });

    conv.active_job_id = String(jobRes.job_id ?? '');
    conv.active_kind = 'compact';
    conv.active_started_at = new Date().toISOString();
    conv.updated_at = new Date().toISOString();
  } catch {
    // Ignore compaction start error
  }
}
