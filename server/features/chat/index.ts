import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { handleCancelJob } from '../../actions/jobs.ts';
import type { MawFeature } from '../../lib/feature.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { CONVERSATION_ID_REGEX, generateConversationId, generateMessageId, generateQueueId } from '../agents-ws/lib/ids.ts';
import { withS6State } from '../agents-ws/lib/mutex.ts';
import { appendAuditLog, readJsonStore, writeJsonStore } from '../agents-ws/lib/store.ts';
import type { Agent } from '../agents-ws/types.ts';
import {
  appendConversationMessage,
  ensureTickStarted,
  getWindowTokens,
  readConversationMessages,
  startCompactionJob,
  startTurnJob,
  tick,
  updateConversationMessages,
} from './tick.ts';
import type { Conversation, Message, QueueItem } from './types.ts';

const IMAGE_PLATFORMS = ['claude', 'codex', 'gemini', 'cursor'];

export const feature: MawFeature = {
  name: 'chat',
  routes: {
    chat_list: {
      method: 'GET',
      handler: async (ctx) => {
        ensureTickStarted(ctx);
        await tick(ctx);

        const chatDir = ctx.paths.featureDataDir('chat');
        const convsFile = path.win32.join(chatDir, 'conversations.json');
        const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
          version: 1,
          conversations: [],
        });

        const agentId = String(ctx.query?.get('agent_id') ?? '').trim();
        let list = convsData.conversations.filter((c) => c.deleted_at === null);

        if (agentId) {
          list = list.filter((c) => c.agent_id === agentId);
        } else {
          list = list.slice(0, 200);
        }

        list.sort(
          (a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime()
        );

        return {
          ok: true,
          conversations: list,
        };
      },
    },

    chat_get: {
      method: 'GET',
      handler: async (ctx) => {
        ensureTickStarted(ctx);
        await tick(ctx);

        const convId = String(ctx.query?.get('conversation_id') ?? '').trim();
        if (!convId || !CONVERSATION_ID_REGEX.test(convId)) {
          throw new ApiValidationError('Invalid or missing conversation_id.', 400);
        }

        const chatDir = ctx.paths.featureDataDir('chat');
        const convsFile = path.win32.join(chatDir, 'conversations.json');
        const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
          version: 1,
          conversations: [],
        });

        const conv = convsData.conversations.find((c) => c.id === convId && c.deleted_at === null);
        if (!conv) {
          throw new ApiValidationError(`Conversation '${convId}' not found.`, 404);
        }

        const afterSeq = Math.max(0, Number.parseInt(String(ctx.query?.get('after_seq') ?? '0'), 10) || 0);
        const allMsgs = readConversationMessages(chatDir, conv.id);
        const filteredMsgs = allMsgs.filter((m) => m.seq > afterSeq).slice(-300);

        let runningInfo: { job_id: string; kind: string; elapsed_sec: number; log_tail: string } | null = null;
        if (conv.active_job_id) {
          const logFile = path.win32.join(ctx.paths.jobsDir, `${conv.active_job_id}.log`);
          let logTail = '';
          if (fs.existsSync(logFile)) {
            try {
              const content = fs.readFileSync(logFile, 'utf8');
              logTail = content.slice(-1500);
            } catch {
              logTail = '';
            }
          }
          const elapsedSec = conv.active_started_at
            ? Math.max(1, Math.round((Date.now() - new Date(conv.active_started_at).getTime()) / 1000))
            : 1;

          runningInfo = {
            job_id: conv.active_job_id,
            kind: conv.active_kind,
            elapsed_sec: elapsedSec,
            log_tail: logTail,
          };
        }

        return {
          ok: true,
          conversation: conv,
          messages: filteredMsgs,
          running: runningInfo,
        };
      },
    },

    chat_create: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          ensureTickStarted(ctx);
          const body = ctx.body ?? {};
          const agentId = String(body.agent_id ?? '').trim();
          if (!agentId) {
            throw new ApiValidationError('Missing agent_id.', 400);
          }

          const agentsDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(agentsDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          const agent = agentsData.agents.find((a) => a.id === agentId && a.deleted_at === null);
          if (!agent) {
            throw new ApiValidationError(`Agent '${agentId}' not found.`, 404);
          }

          const title = String(body.title ?? 'Chat 1').trim().slice(0, 80) || 'Chat 1';
          const nowIso = new Date().toISOString();

          const newConv: Conversation = {
            id: generateConversationId(),
            agent_id: agent.id,
            title,
            kind: 'chat',
            created_at: nowIso,
            updated_at: nowIso,
            deleted_at: null,
            seq: 0,
            session: 1,
            platform: agent.platform,
            model: agent.model,
            effort: agent.effort,
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
            context: { used_tokens: 0, window_tokens: getWindowTokens(agent.platform), pct: 0 },
            last_status: '',
            last_error: '',
          };

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          convsData.conversations.unshift(newConv);
          await writeJsonStore(convsFile, convsData);

          return {
            ok: true,
            conversation: newConv,
          };
        });
      },
    },

    chat_rename: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const convId = String(body.conversation_id ?? '').trim();
          const title = String(body.title ?? '').trim();

          if (!convId || !CONVERSATION_ID_REGEX.test(convId)) {
            throw new ApiValidationError('Invalid conversation_id.', 400);
          }
          if (!title || title.length > 80) {
            throw new ApiValidationError('Title must be between 1 and 80 characters.', 400);
          }

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          const conv = convsData.conversations.find((c) => c.id === convId && c.deleted_at === null);
          if (!conv) {
            throw new ApiValidationError(`Conversation '${convId}' not found.`, 404);
          }

          conv.title = title;
          conv.updated_at = new Date().toISOString();
          await writeJsonStore(convsFile, convsData);

          return {
            ok: true,
            conversation: conv,
          };
        });
      },
    },

    chat_delete: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const convId = String(body.conversation_id ?? '').trim();
          if (!convId || !CONVERSATION_ID_REGEX.test(convId)) {
            throw new ApiValidationError('Invalid conversation_id.', 400);
          }

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          const conv = convsData.conversations.find((c) => c.id === convId && c.deleted_at === null);
          if (!conv) {
            throw new ApiValidationError(`Conversation '${convId}' not found.`, 404);
          }

          if (conv.active_job_id) {
            throw new ApiValidationError('Cannot delete conversation while a turn is running.', 409);
          }

          conv.deleted_at = new Date().toISOString();
          conv.updated_at = conv.deleted_at;
          await writeJsonStore(convsFile, convsData);

          await appendAuditLog(chatDir, {
            action: 'chat_delete',
            target: convId,
            detail: { title: conv.title },
          });

          return {
            ok: true,
          };
        });
      },
    },

    chat_send: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          ensureTickStarted(ctx);
          const body = ctx.body ?? {};
          const convId = String(body.conversation_id ?? '').trim();
          if (!convId || !CONVERSATION_ID_REGEX.test(convId)) {
            throw new ApiValidationError('Invalid conversation_id.', 400);
          }

          const text = String(body.text ?? '').trim();
          if (!text || text.length > 20000) {
            throw new ApiValidationError('Text is required and must be 1-20000 characters.', 400);
          }

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          const conv = convsData.conversations.find((c) => c.id === convId && c.deleted_at === null);
          if (!conv) {
            throw new ApiValidationError(`Conversation '${convId}' not found.`, 404);
          }

          const agentsDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(agentsDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          const agent = agentsData.agents.find((a) => a.id === conv.agent_id);
          if (!agent) {
            throw new ApiValidationError(`Agent '${conv.agent_id}' not found.`, 404);
          }

          const targetPlatform = String(body.platform ?? conv.platform ?? agent.platform).trim().toLowerCase();
          const registryAgent = ctx.registry.agents.find((a) => a.id === targetPlatform);
          if (!registryAgent) {
            throw new ApiValidationError(`Invalid platform '${targetPlatform}'.`, 400);
          }

          const targetModel = String(body.model ?? conv.model ?? agent.model).trim();
          if (targetModel && !registryAgent.models.includes(targetModel)) {
            throw new ApiValidationError(
              `Invalid model '${targetModel}'. Allowed: ${registryAgent.models.join(', ')}.`,
              400
            );
          }

          const targetEffort = String(body.effort ?? conv.effort ?? agent.effort).trim();
          if (targetEffort && !registryAgent.efforts.includes(targetEffort)) {
            throw new ApiValidationError(
              `Invalid effort '${targetEffort}'. Allowed: ${registryAgent.efforts.join(', ')}.`,
              400
            );
          }

          // Handle attachments (Item 18)
          const rawAttachments = body.attachments;
          const savedAttachments: Array<{ name: string; path: string }> = [];

          if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
            if (!IMAGE_PLATFORMS.includes(targetPlatform)) {
              throw new ApiValidationError(
                `Platform '${targetPlatform}' does not support image attachments. Supported: ${IMAGE_PLATFORMS.join(', ')}.`,
                400
              );
            }
            if (rawAttachments.length > 3) {
              throw new ApiValidationError('Maximum 3 attachments allowed.', 400);
            }

            const attachDir = path.win32.join(agent.workdir, '.maw', 'attachments', conv.id);
            if (!fs.existsSync(attachDir)) {
              fs.mkdirSync(attachDir, { recursive: true });
            }

            for (let i = 0; i < rawAttachments.length; i++) {
              const att = rawAttachments[i];
              if (!att || typeof att !== 'object') {
                throw new ApiValidationError(`Attachment at index ${i} is invalid.`, 400);
              }
              const attObj = att as { name?: string; data_url?: string };
              const dataUrl = String(attObj.data_url ?? '');
              const match = /^data:image\/(png|jpeg|webp|gif);base64,/i.exec(dataUrl);
              if (!match) {
                throw new ApiValidationError(
                  `Attachment at index ${i} must be a valid base64 data URL with type image/png, image/jpeg, image/webp, or image/gif.`,
                  400
                );
              }

              const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
              const defaultName = `image_${i + 1}.${ext}`;
              const name = String(attObj.name ?? defaultName).replace(/[^a-zA-Z0-9._-]/g, '_');
              const base64Data = dataUrl.slice(match[0].length);
              const buf = Buffer.from(base64Data, 'base64');
              if (buf.length > 150 * 1024) {
                throw new ApiValidationError(`Attachment '${name}' exceeds 150 KB limit.`, 400);
              }
              const savePath = path.win32.join(attachDir, `${i + 1}-${name}`);
              fs.writeFileSync(savePath, buf);
              const relPath = `.maw/attachments/${conv.id}/${i + 1}-${name}`;
              savedAttachments.push({ name, path: relPath });
            }
          }

          // Auto-set title from first message if title was default
          if (conv.seq === 0 && (conv.title === 'Chat 1' || conv.title === '')) {
            conv.title = text.slice(0, 48).trim();
          }

          // Busy check
          const isBusy = Boolean(conv.active_job_id);
          if (isBusy) {
            // Item 17: Steer check - only when active_kind === 'turn'
            const activePlatform = (conv.platform || agent.platform).toLowerCase();
            let antigravityCid = '';
            if (conv.resume?.platform === 'antigravity') {
              antigravityCid = conv.resume.token || '';
            }

            if (!antigravityCid && activePlatform === 'antigravity') {
              const logFile = path.win32.join(ctx.paths.jobsDir, `${conv.active_job_id}.log`);
              if (fs.existsSync(logFile)) {
                const m = /CONVERSATION_ID:\s*([a-zA-Z0-9._-]+)/i.exec(fs.readFileSync(logFile, 'utf8'));
                if (m) {
                  antigravityCid = m[1]!;
                }
              }
            }

            if (conv.active_kind === 'turn' && activePlatform === 'antigravity' && antigravityCid) {
              const scriptPath = path.win32.join(ctx.paths.scriptsDir, 'invoke-antigravity.ps1');
              const tmpFile = path.win32.join(
                ctx.paths.tempDir,
                `maw_steer_${crypto.randomBytes(4).toString('hex')}.txt`
              );
              let steerSuccess = false;

              try {
                fs.writeFileSync(tmpFile, '\uFEFF' + text, 'utf8');

                const steerArgs = [
                  '-NoProfile',
                  '-ExecutionPolicy',
                  'Bypass',
                  '-File',
                  scriptPath,
                  '-Action',
                  'send',
                  '-ConversationId',
                  antigravityCid,
                  '-NoWait',
                  '-PromptFile',
                  tmpFile,
                ];

                const steerRes = await runCommand('powershell.exe', steerArgs, { timeoutMs: 15000 });
                if (steerRes.code === 0) {
                  steerSuccess = true;
                }
              } catch {
                // Steer failure falls through to queue
              } finally {
                try {
                  if (fs.existsSync(tmpFile)) {
                    fs.unlinkSync(tmpFile);
                  }
                } catch {}
              }

              if (steerSuccess) {
                conv.seq++;
                const steerMsg: Message = {
                  seq: conv.seq,
                  id: generateMessageId(),
                  role: 'user',
                  text,
                  ts: new Date().toISOString(),
                  platform: activePlatform,
                  model: conv.model,
                  effort: conv.effort,
                  actual_model: '',
                  job_id: conv.active_job_id,
                  status: 'done',
                  cost_usd: null,
                  tokens_in: null,
                  tokens_out: null,
                  duration_sec: null,
                  attachments: savedAttachments,
                  handoff_id: '',
                  steered: true,
                };

                appendConversationMessage(chatDir, conv.id, steerMsg);
                conv.updated_at = new Date().toISOString();
                await writeJsonStore(convsFile, convsData);

                return {
                  ok: true,
                  message: steerMsg,
                  steered: true,
                };
              }
            }

            // Busy and not steered => Queue
            if (conv.queue.length >= 20) {
              throw new ApiValidationError('Queue is full (maximum 20 items).', 409);
            }

            const queueItem: QueueItem = {
              id: generateQueueId(),
              text,
              platform: targetPlatform,
              model: targetModel,
              effort: targetEffort,
              ts: new Date().toISOString(),
              attachments: savedAttachments,
            };

            conv.queue.push(queueItem);
            conv.updated_at = new Date().toISOString();
            await writeJsonStore(convsFile, convsData);

            return {
              ok: true,
              queued: true,
              queue_item: queueItem,
              queue_len: conv.queue.length,
            };
          }

          // Idle: start turn job directly
          const qItem: QueueItem = {
            id: generateQueueId(),
            text,
            platform: targetPlatform,
            model: targetModel,
            effort: targetEffort,
            ts: new Date().toISOString(),
            attachments: savedAttachments,
          };

          await startTurnJob(ctx, conv, qItem, agent, chatDir);
          await writeJsonStore(convsFile, convsData);

          const allMsgs = readConversationMessages(chatDir, conv.id);
          const latestMsg = allMsgs[allMsgs.length - 1]!;

          return {
            ok: true,
            message: latestMsg,
            job_id: conv.active_job_id,
            queued: false,
          };
        });
      },
    },

    chat_queue_remove: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const convId = String(body.conversation_id ?? '').trim();
          const queueId = String(body.queue_id ?? '').trim();

          if (!convId || !CONVERSATION_ID_REGEX.test(convId)) {
            throw new ApiValidationError('Invalid conversation_id.', 400);
          }
          if (!queueId) {
            throw new ApiValidationError('Missing queue_id.', 400);
          }

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          const conv = convsData.conversations.find((c) => c.id === convId && c.deleted_at === null);
          if (!conv) {
            throw new ApiValidationError(`Conversation '${convId}' not found.`, 404);
          }

          const idx = conv.queue.findIndex((q) => q.id === queueId);
          if (idx !== -1) {
            conv.queue.splice(idx, 1);
            conv.updated_at = new Date().toISOString();
            await writeJsonStore(convsFile, convsData);
          }

          return {
            ok: true,
            queue: conv.queue,
          };
        });
      },
    },

    chat_stop: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const convId = String(body.conversation_id ?? '').trim();
          if (!CONVERSATION_ID_REGEX.test(convId)) {
            throw new ApiValidationError('Invalid conversation_id.', 400);
          }

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          const conv = convsData.conversations.find((c) => c.id === convId && c.deleted_at === null);
          if (!conv) {
            throw new ApiValidationError(`Conversation '${convId}' not found.`, 404);
          }

          if (!conv.active_job_id) {
            throw new ApiValidationError('Conversation has no active job to stop.', 409);
          }

          const jobId = conv.active_job_id;
          try {
            await handleCancelJob({ job_id: jobId }, ctx.paths);
          } catch {
            // Best-effort cancel
          }

          // Mark running message cancelled
          const msgs = readConversationMessages(chatDir, conv.id);
          const runningMsg = msgs.find((m) => m.job_id === jobId);
          if (runningMsg) {
            runningMsg.status = 'cancelled';
            updateConversationMessages(chatDir, conv.id, msgs);
          }

          conv.active_job_id = '';
          conv.active_kind = '';
          conv.active_started_at = '';
          conv.updated_at = new Date().toISOString();
          await writeJsonStore(convsFile, convsData);

          await appendAuditLog(chatDir, {
            action: 'chat_stop',
            target: convId,
            detail: { cancelled_job_id: jobId },
          });

          return {
            ok: true,
            cancelled: jobId,
          };
        });
      },
    },

    chat_compact: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const convId = String(body.conversation_id ?? '').trim();
          if (!convId || !CONVERSATION_ID_REGEX.test(convId)) {
            throw new ApiValidationError('Invalid conversation_id.', 400);
          }

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          const conv = convsData.conversations.find((c) => c.id === convId && c.deleted_at === null);
          if (!conv) {
            throw new ApiValidationError(`Conversation '${convId}' not found.`, 404);
          }

          if (conv.active_job_id) {
            throw new ApiValidationError('Cannot compact conversation while a job is running.', 409);
          }

          const agentsDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(agentsDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          await startCompactionJob(ctx, conv, chatDir, agentsData.agents);
          await writeJsonStore(convsFile, convsData);

          return {
            ok: true,
            job_id: conv.active_job_id,
          };
        });
      },
    },
  },
};
