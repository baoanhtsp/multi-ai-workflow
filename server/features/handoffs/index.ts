import fs from 'node:fs';
import path from 'node:path';
import { handleCancelJob } from '../../actions/jobs.ts';
import type { MawFeature } from '../../lib/feature.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { generateBatchId, generateHandoffId, HANDOFF_ID_REGEX } from '../agents-ws/lib/ids.ts';
import { withS6State } from '../agents-ws/lib/mutex.ts';
import { appendAuditLog, readJsonStore, writeJsonStore } from '../agents-ws/lib/store.ts';
import type { Agent } from '../agents-ws/types.ts';
import { finalizeHandoff, tick } from '../chat/tick.ts';
import type { Conversation } from '../chat/types.ts';
import type { Team } from '../teams/types.ts';
import type { Handoff, HandoffStatus } from './types.ts';

export const feature: MawFeature = {
  name: 'handoffs',
  status: async (ctx) => {
    const handoffsDir = ctx.paths.featureDataDir('handoffs');
    const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
    const data = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
      version: 1,
      handoffs: [],
    });

    const pending = data.handoffs.filter((h) => h.status === 'started').length;
    const running = data.handoffs.filter((h) => h.status === 'running').length;
    const recent = data.handoffs
      .filter((h) => h.finished_at)
      .slice(0, 10)
      .map((h) => ({
        id: h.id,
        to_role: h.to_role,
        status: h.status,
        summary: (h.result?.summary || h.parse_error || '').slice(0, 100),
        finished_at: h.finished_at,
      }));

    return {
      pending,
      running,
      recent,
    };
  },
  routes: {
    handoff_list: {
      method: 'GET',
      handler: async (ctx) => {
        await tick(ctx);

        const handoffsDir = ctx.paths.featureDataDir('handoffs');
        const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
        const data = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
          version: 1,
          handoffs: [],
        });

        const counts: Record<HandoffStatus, number> = {
          started: 0,
          running: 0,
          completed: 0,
          failed: 0,
          blocked: 0,
          needs_review: 0,
          cancelled: 0,
        };

        for (const h of data.handoffs) {
          if (h.status in counts) {
            counts[h.status]++;
          }
        }

        const convId = String(ctx.query?.get('conversation_id') ?? '').trim();
        const teamId = String(ctx.query?.get('team_id') ?? '').trim();
        const status = String(ctx.query?.get('status') ?? '').trim().toLowerCase();
        const limitRaw = ctx.query?.get('limit');
        const limit = Math.max(1, Math.min(500, Number.parseInt(String(limitRaw ?? '100'), 10) || 100));

        let filtered = data.handoffs;

        if (convId) {
          filtered = filtered.filter(
            (h) => h.lead_conversation_id === convId || h.member_conversation_id === convId
          );
        }

        if (teamId) {
          filtered = filtered.filter((h) => h.team_id === teamId);
        }

        if (status) {
          filtered = filtered.filter((h) => h.status === status);
        }

        return {
          ok: true,
          handoffs: filtered.slice(0, limit),
          counts,
        };
      },
    },

    handoff_dispatch: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const leadConvId = String(body.lead_conversation_id ?? '').trim();
          const to = String(body.to ?? '').trim();
          const task = String(body.task ?? '').trim();
          const acceptance = String(body.acceptance ?? '').trim().slice(0, 1000);
          const thread = body.thread !== undefined && body.thread !== null ? String(body.thread).trim().slice(0, 60) : '';

          if (!leadConvId) {
            throw new ApiValidationError('Missing lead_conversation_id.', 400);
          }
          if (!to) {
            throw new ApiValidationError('Missing "to" target member.', 400);
          }
          if (!task || task.length > 8000) {
            throw new ApiValidationError('Task is required and must be 1-8000 characters.', 400);
          }

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          const conv = convsData.conversations.find((c) => c.id === leadConvId && c.deleted_at === null);
          if (!conv) {
            throw new ApiValidationError(`Conversation '${leadConvId}' not found.`, 404);
          }

          const agentsDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(agentsDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          const leadAgent = agentsData.agents.find((a) => a.id === conv.agent_id);
          if (!leadAgent || !leadAgent.team_id) {
            throw new ApiValidationError(
              'Conversation agent is not part of a team. Only team members can dispatch handoffs.',
              400
            );
          }
          if (leadAgent.deleted_at !== null) {
            throw new ApiValidationError('Agent deleted.', 409);
          }

          let teamId = leadAgent.team_id;
          let memberAgent = agentsData.agents.find(
            (a) =>
              a.deleted_at === null &&
              a.team_id === teamId &&
              (a.team_role === to || a.name.toLowerCase() === to.toLowerCase() || a.id === to)
          );

          let toRole = to;
          let memberPlatform = memberAgent?.platform || 'codex';
          let mayDelegate: boolean | null = null;
          let roleWriteScope: string[] | undefined;

          if (leadAgent.workdir) {
            const teamFile = path.win32.join(leadAgent.workdir, '.maw', 'team.json');
            if (fs.existsSync(teamFile)) {
              try {
                const team = JSON.parse(fs.readFileSync(teamFile, 'utf8')) as Team;
                if (team.id) {
                  teamId = team.id;
                }
                const leadRole = team.roles.find(
                  (r) => r.key === leadAgent.team_role || r.agent_id === leadAgent.id
                );
                if (leadRole) {
                  mayDelegate = Boolean(leadRole.may_delegate);
                }
                const r = team.roles.find(
                  (role) => role.key === to || role.name.toLowerCase() === to.toLowerCase() || role.agent_id === to
                );
                if (r) {
                  toRole = r.key;
                  if (r.override?.write_scope !== undefined) {
                    roleWriteScope = r.override.write_scope;
                  } else if (team.shared?.write_scope !== undefined) {
                    roleWriteScope = team.shared.write_scope;
                  }
                  if (!memberAgent && r.agent_id) {
                    memberAgent = agentsData.agents.find((a) => a.id === r.agent_id && a.deleted_at === null);
                  }
                }
                memberPlatform = memberAgent?.platform || team.shared.platform || 'codex';
              } catch {}
            }
          }

          if (mayDelegate === null) {
            mayDelegate = leadAgent.team_role === 'lead' || leadAgent.team_role === 'deputy';
          }

          // Item 5 (Codex Pass 5): handoff_dispatch must require the dispatching agent's role to have may_delegate: true (403/400 otherwise)
          if (!mayDelegate) {
            throw new ApiValidationError(
              'Dispatching agent does not have permission to delegate (may_delegate: false).',
              403
            );
          }

          // Fallback: match by lead workdir + team_role if team ID changed (e.g. after import)
          if (!memberAgent && leadAgent.workdir) {
            memberAgent = agentsData.agents.find(
              (a) =>
                a.deleted_at === null &&
                a.workdir.toLowerCase() === leadAgent.workdir.toLowerCase() &&
                (a.team_role === toRole || a.team_role === to || a.name.toLowerCase() === to.toLowerCase() || a.id === to)
            );
          }

          if (!memberAgent) {
            const wasDeleted = agentsData.agents.find(
              (a) =>
                a.deleted_at !== null &&
                (a.id === to || a.name.toLowerCase() === to.toLowerCase() || a.team_role === to || a.team_role === toRole)
            );
            if (wasDeleted) {
              throw new ApiValidationError(`Target member agent '${to}' is deleted.`, 409);
            }
          }

          const handoffsDir = ctx.paths.featureDataDir('handoffs');
          const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
          const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
            version: 1,
            handoffs: [],
          });

          const newHandoff: Handoff = {
            id: generateHandoffId(),
            team_id: teamId,
            lead_agent_id: leadAgent.id,
            lead_conversation_id: conv.id,
            lead_seq: conv.seq,
            batch: generateBatchId(),
            from: leadAgent.id,
            to: memberAgent ? memberAgent.id : to,
            to_role: toRole,
            task,
            acceptance,
            status: 'started',
            job_id: '',
            member_conversation_id: '',
            isolated: false,
            worktree: '',
            branch: '',
            platform: memberPlatform,
            actual_model: '',
            created_at: new Date().toISOString(),
            started_at: '',
            finished_at: '',
            duration_sec: null,
            result: null,
            parse_error: '',
            scope_violations: [],
            attempts: 0,
            thread: thread || undefined,
            write_scope: Array.isArray(roleWriteScope) ? [...roleWriteScope] : undefined,
          };

          handoffsData.handoffs.unshift(newHandoff);
          if (handoffsData.handoffs.length > 500) {
            handoffsData.handoffs = handoffsData.handoffs.slice(0, 500);
          }
          await writeJsonStore(handoffsFile, handoffsData);

          // Attempt immediate dispatch
          await tick(ctx);

          return {
            ok: true,
            handoff: newHandoff,
          };
        });
      },
    },

    handoff_cancel: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!HANDOFF_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid handoff id.', 400);
          }

          const handoffsDir = ctx.paths.featureDataDir('handoffs');
          const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
          const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
            version: 1,
            handoffs: [],
          });

          const handoff = handoffsData.handoffs.find((h) => h.id === id);
          if (!handoff) {
            throw new ApiValidationError(`Handoff '${id}' not found.`, 404);
          }

          if (handoff.status !== 'started' && handoff.status !== 'running') {
            throw new ApiValidationError(
              `Cannot cancel handoff '${id}' in status '${handoff.status}'. Must be 'started' or 'running'.`,
              409
            );
          }

          let cancelSucceeded = false;
          let alreadyFinished = false;
          if (handoff.status === 'running' && handoff.job_id) {
            try {
              await handleCancelJob({ job_id: handoff.job_id }, ctx.paths);
              cancelSucceeded = true;
            } catch (err: unknown) {
              // Item 2 (Pass 5): Stop / cancel race: when handleCancelJob answers 409 with a terminal status (DONE / FAILED / CANCELLED),
              // do NOT clear active_job_id and do NOT mark the handoff cancelled — run tick() so the real result is recorded,
              // and return { ok: true, already_finished: true }. Only a successful cancel finalizes as cancelled.
              if (
                err instanceof ApiValidationError &&
                err.statusCode === 409 &&
                typeof (err as unknown as Record<string, unknown>).status === 'string'
              ) {
                const termStatus = String((err as unknown as Record<string, unknown>).status);
                if (['DONE', 'FAILED', 'CANCELLED'].includes(termStatus)) {
                  alreadyFinished = true;
                } else {
                  cancelSucceeded = true;
                }
              } else {
                throw err;
              }
            }
          } else {
            cancelSucceeded = true;
          }

          if (alreadyFinished) {
            await tick(ctx);
            return {
              ok: true,
              already_finished: true,
            };
          }

          if (cancelSucceeded) {
            await finalizeHandoff(ctx, handoff, 'cancelled');

            await appendAuditLog(handoffsDir, {
              action: 'handoff_cancel',
              target: id,
              detail: { job_id: handoff.job_id },
            });
          }

          return {
            ok: true,
          };
        });
      },
    },

    handoff_retry: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!HANDOFF_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid handoff id.', 400);
          }

          const handoffsDir = ctx.paths.featureDataDir('handoffs');
          const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
          const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
            version: 1,
            handoffs: [],
          });

          const handoff = handoffsData.handoffs.find((h) => h.id === id);
          if (!handoff) {
            throw new ApiValidationError(`Handoff '${id}' not found.`, 404);
          }

          // Item 5 (Codex Pass 7): handoff_retry only for failed | blocked | needs_review | cancelled (409 otherwise)
          const RETRYABLE_STATUSES: HandoffStatus[] = ['failed', 'blocked', 'needs_review', 'cancelled'];
          if (!RETRYABLE_STATUSES.includes(handoff.status)) {
            throw new ApiValidationError(
              `Cannot retry handoff '${id}' in status '${handoff.status}'. Must be failed, blocked, needs_review, or cancelled.`,
              409
            );
          }

          handoff.attempts++;
          handoff.status = 'started';
          handoff.started_at = '';
          handoff.finished_at = '';
          handoff.duration_sec = null;
          handoff.job_id = '';
          handoff.result = null;
          handoff.parse_error = '';
          handoff.scope_violations = [];
          handoff.base_commit = undefined;
          handoff.dirty_baseline = undefined;
          handoff.baseline_error = undefined;
          handoff.lead_notified_at = undefined;
          handoff.lead_notified_outcome = undefined;

          await writeJsonStore(handoffsFile, handoffsData);

          await tick(ctx);

          return {
            ok: true,
            handoff,
          };
        });
      },
    },

    handoff_accept: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!HANDOFF_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid handoff id.', 400);
          }

          const handoffsDir = ctx.paths.featureDataDir('handoffs');
          const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
          const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
            version: 1,
            handoffs: [],
          });

          const handoff = handoffsData.handoffs.find((h) => h.id === id);
          if (!handoff) {
            throw new ApiValidationError(`Handoff '${id}' not found.`, 404);
          }

          if (handoff.status !== 'needs_review') {
            throw new ApiValidationError(
              `Cannot accept handoff '${id}' in status '${handoff.status}'. Must be 'needs_review'.`,
              409
            );
          }

          const note = String(body.note ?? '').trim();
          const overrideToken = String(body.override_token ?? body.checks_override_token ?? '').trim();

          // Consult checks_gate when merging / accepting an isolated worktree or a project with .maw/checks.json (Item B8)
          const agentsDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(agentsDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });
          const memberAgent = agentsData.agents.find((a) => a.id === handoff.to);
          const leadAgent = agentsData.agents.find((a) => a.id === handoff.lead_agent_id);
          const gateProjectPath = handoff.worktree || memberAgent?.workdir || leadAgent?.workdir || '';

          if (ctx.callAction && gateProjectPath && (handoff.isolated || body.merge === true || fs.existsSync(path.win32.join(gateProjectPath, '.maw', 'checks.json')))) {
            let gateRes: Record<string, unknown> | null = null;
            try {
              gateRes = await ctx.callAction('checks_gate', {
                query: {
                  project_path: gateProjectPath,
                  ...(overrideToken ? { override_token: overrideToken, scope: 'merge' } : {}),
                },
              });
            } catch (err: unknown) {
              if (err instanceof ApiValidationError && err.message.startsWith("Unknown API action 'checks_gate'")) {
                gateRes = null;
              } else {
                throw err;
              }
            }
            if (gateRes && gateRes.green === false) {
              const failing = Array.isArray(gateRes.items)
                ? (gateRes.items as Array<{ id?: string; state?: string; detail?: string }>)
                    .filter((i) => i.state !== 'pass')
                    .map((i) => `${i.id}: ${i.state}${i.detail ? ` (${i.detail})` : ''}`)
                    .join('; ')
                : 'checks failed';
              throw new ApiValidationError(
                `Checks gate is red (${failing || 'checks failed'}). Provide override_token to accept/merge.`,
                409
              );
            }
          }

          handoff.parse_error = '';
          handoff.scope_violations = [];
          // Item 6 (Codex Pass 7): Short Lead message "[Handoff <id>] accepted by user (was needs_review)" and no member-conversation message
          await finalizeHandoff(ctx, handoff, 'completed', {
            note,
            skipMemberMessage: true,
            leadMessageText: `[Handoff ${handoff.id}] accepted by user (was needs_review)${note ? ` — note: ${note}` : ''}`,
          });

          await appendAuditLog(handoffsDir, {
            action: 'handoff_accept',
            target: id,
            detail: { note },
          });

          return {
            ok: true,
            handoff,
          };
        });
      },
    },

    handoff_merge: {
      method: 'POST',
      handler: async (ctx) => {
        return await withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!HANDOFF_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid handoff id.', 400);
          }

          const handoffsDir = ctx.paths.featureDataDir('handoffs');
          const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
          const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
            version: 1,
            handoffs: [],
          });

          const handoff = handoffsData.handoffs.find((h) => h.id === id);
          if (!handoff) {
            throw new ApiValidationError(`Handoff '${id}' not found.`, 404);
          }

          const overrideToken = String(body.override_token ?? body.checks_override_token ?? '').trim();
          const agentsDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(agentsDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });
          const memberAgent = agentsData.agents.find((a) => a.id === handoff.to);
          const leadAgent = agentsData.agents.find((a) => a.id === handoff.lead_agent_id);
          const gateProjectPath = handoff.worktree || memberAgent?.workdir || leadAgent?.workdir || '';

          if (gateProjectPath && ctx.callAction) {
            const gateRes = await ctx.callAction('checks_gate', {
              query: {
                project_path: gateProjectPath,
                ...(overrideToken ? { override_token: overrideToken, scope: 'merge' } : {}),
              },
            });
            if (gateRes && gateRes.green === false) {
              throw new ApiValidationError(
                'Checks gate is red. Fix failing checks or provide an override_token.',
                409
              );
            }
          }

          if (handoff.status === 'needs_review') {
            handoff.parse_error = '';
            handoff.scope_violations = [];
            await finalizeHandoff(ctx, handoff, 'completed', {
              note: String(body.note ?? 'Merged'),
              skipMemberMessage: true,
              leadMessageText: `[Handoff ${handoff.id}] merged by user`,
            });
          }

          await appendAuditLog(handoffsDir, {
            action: 'handoff_merge',
            target: id,
            detail: { worktree: handoff.worktree, branch: handoff.branch },
          });

          return {
            ok: true,
            handoff,
          };
        });
      },
    },
  },
};
