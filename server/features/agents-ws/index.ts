import fs from 'node:fs';
import path from 'node:path';
import { getProjectGitInfo } from '../../actions/git.ts';
import type { MawFeature, MawFeatureContext } from '../../lib/feature.ts';
import { getTempDir, resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { detectRegistryAgents, getCodexModels, getDetectedToolVersions } from '../../lib/versions.ts';
import { isWorktreeFeatureAvailable, readConversationMessages, tick } from '../chat/tick.ts';
import type { Conversation } from '../chat/types.ts';
import type { Handoff } from '../handoffs/types.ts';
import { AGENT_ID_REGEX, generateAgentId, generateGroupId, GROUP_ID_REGEX } from './lib/ids.ts';
import { allowedModels } from './lib/models.ts';
import { withS6State } from './lib/mutex.ts';
import { validateReplyLanguage } from './lib/prompt.ts';
import { appendAuditLog, readJsonStore, writeJsonStore } from './lib/store.ts';
import type {
  Agent,
  AgentGitStatus,
  Group,
  LiveAgent,
  PlatformInfo,
} from './types.ts';

const ALLOWED_TASK_ROLES = ['architect', 'backend', 'frontend', 'reviewer', 'tester'];
const DENIED_ENV_KEYS = ['PATH', 'SYSTEMROOT', 'COMSPEC'];
const AUTH_PATTERNS = [
  /OAuth session expired/i,
  /Please set an Auth method/i,
  /not logged in/i,
  /401 Unauthorized/i,
  /login required/i,
];

const gitCache = new Map<string, { ts: number; git: AgentGitStatus }>();
let cachedPlatformsData: { ts: number; platforms: PlatformInfo[] } | null = null;

export function clearPlatformsCache(): void {
  cachedPlatformsData = null;
}

async function getCachedGitInfo(workdir: string): Promise<AgentGitStatus> {
  const norm = workdir.replace(/\//g, '\\').toLowerCase();
  const cached = gitCache.get(norm);
  const now = Date.now();
  if (cached && now - cached.ts < 30000) {
    return cached.git;
  }
  try {
    const raw = await getProjectGitInfo(workdir);
    const git: AgentGitStatus = {
      branch: raw.current_branch,
      ahead: raw.ahead,
      behind: raw.behind,
      modified: raw.modified_count,
    };
    gitCache.set(norm, { ts: now, git });
    return git;
  } catch {
    return { branch: null, ahead: 0, behind: 0, modified: 0 };
  }
}

// Item 15: use enabled agents list (ctx.registry.agents)
async function getPlatformsList(ctx: MawFeatureContext, forceRefresh = false): Promise<PlatformInfo[]> {
  const registry = ctx.registry;
  const versions = await getDetectedToolVersions(ctx.paths.userProfile);
  const enabledAgents = registry.agents;
  const detectedMap = await detectRegistryAgents(ctx.paths, enabledAgents, versions);

  return enabledAgents.map((entry) => {
    const det = detectedMap.get(entry.id) ?? { installed: false, version: null };
    const models = allowedModels(ctx, entry.id);
    return {
      id: entry.id,
      label: entry.label,
      color: entry.color,
      installed: det.installed,
      version: det.version,
      models,
      efforts: [...entry.efforts],
      capabilities: {
        write: entry.capabilities.write,
        review: entry.capabilities.review,
        new_session: entry.capabilities.new_session,
        sessions: entry.capabilities.sessions,
        ide_send: entry.capabilities.ide_send,
      },
    };
  });
}

function validateAgentFields(agent: Agent, ctx: MawFeatureContext): void {
  const name = String(agent.name ?? '').trim();
  if (!name || name.length > 60) {
    throw new ApiValidationError('Agent name is required and must be 1-60 characters.', 400);
  }

  const rawWorkdir = String(agent.workdir ?? '').trim();
  const workdir = resolveProjectPath(rawWorkdir, ctx.paths.projectsRoot);
  if (!workdir) {
    throw new ApiValidationError('Invalid or missing workdir (must be strictly inside projectsRoot).', 400);
  }
  agent.workdir = workdir;

  const platform = String(agent.platform ?? '').trim().toLowerCase();
  const registryAgent = ctx.registry.agents.find((a) => a.id === platform);
  if (!registryAgent) {
    throw new ApiValidationError(`Invalid platform '${platform}'. Must be an enabled registry agent.`, 400);
  }

  const model = String(agent.model ?? '').trim();
  const allowed = allowedModels(ctx, platform);
  if (model && !allowed.includes(model)) {
    throw new ApiValidationError(
      `Invalid model '${model}' for platform '${platform}'. Allowed: ${allowed.join(', ')}.`,
      400
    );
  }

  const effort = String(agent.effort ?? '').trim();
  if (effort && !registryAgent.efforts.includes(effort)) {
    throw new ApiValidationError(
      `Invalid effort '${effort}' for platform '${platform}'. Allowed: ${registryAgent.efforts.join(', ')}.`,
      400
    );
  }

  const role = String(agent.role ?? 'backend').trim().toLowerCase();
  if (!ALLOWED_TASK_ROLES.includes(role)) {
    throw new ApiValidationError(
      `Invalid role '${role}'. Must be one of: ${ALLOWED_TASK_ROLES.join(', ')}.`,
      400
    );
  }

  agent.reply_language = validateReplyLanguage(agent.reply_language, {
    allowEmpty: true,
    fieldName: 'reply_language',
  });

  if (Array.isArray(agent.cli_args)) {
    if (agent.cli_args.length > 20) {
      throw new ApiValidationError('cli_args cannot exceed 20 items.', 400);
    }
    for (const arg of agent.cli_args) {
      const s = String(arg ?? '');
      if (s.length > 200 || /[\0\r\n]/.test(s)) {
        throw new ApiValidationError('cli_args items must be <= 200 chars and contain no NUL/CR/LF.', 400);
      }
    }
  }

  if (agent.env && typeof agent.env === 'object' && !Array.isArray(agent.env)) {
    const keys = Object.keys(agent.env);
    if (keys.length > 30) {
      throw new ApiValidationError('env cannot exceed 30 keys.', 400);
    }
    for (const k of keys) {
      const upper = k.toUpperCase();
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(upper)) {
        throw new ApiValidationError(`Invalid env key '${k}'.`, 400);
      }
      if (DENIED_ENV_KEYS.includes(upper) || upper.startsWith('MAW_')) {
        throw new ApiValidationError(`Env key '${k}' is reserved/refused.`, 400);
      }
      const val = String(agent.env[k] ?? '');
      if (val.length > 1000) {
        throw new ApiValidationError(`Env value for '${k}' exceeds 1000 chars.`, 400);
      }
    }
  }
}

export const feature: MawFeature = {
  name: 'agents-ws',
  ui: {
    script: 'feat-workspace.js',
    style: 'feat-workspace.css',
  },
  status: async (ctx) => {
    const featDir = ctx.paths.featureDataDir('agents-ws');
    const agentsFile = path.win32.join(featDir, 'agents.json');
    const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
      version: 1,
      agents: [],
    });

    const chatDir = ctx.paths.featureDataDir('chat');
    const convsFile = path.win32.join(chatDir, 'conversations.json');
    const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
      version: 1,
      conversations: [],
    });

    const liveAgents = agentsData.agents.filter((a) => a.deleted_at === null);
    const busyAgentIds = new Set(
      convsData.conversations
        .filter((c) => c.active_job_id && c.deleted_at === null)
        .map((c) => c.agent_id)
    );

    return {
      agents: liveAgents.length,
      busy: liveAgents.filter((a) => busyAgentIds.has(a.id)).length,
    };
  },
  routes: {
    ws_state: {
      method: 'GET',
      handler: async (ctx) => {
        await tick(ctx);

        const featDir = ctx.paths.featureDataDir('agents-ws');
        const agentsFile = path.win32.join(featDir, 'agents.json');
        const groupsFile = path.win32.join(featDir, 'groups.json');
        const chatDir = ctx.paths.featureDataDir('chat');
        const convsFile = path.win32.join(chatDir, 'conversations.json');
        const handoffsDir = ctx.paths.featureDataDir('handoffs');
        const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');

        const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
          version: 1,
          agents: [],
        });
        const groupsData = await readJsonStore<{ version: number; groups: Group[] }>(groupsFile, {
          version: 1,
          groups: [],
        });
        const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
          version: 1,
          conversations: [],
        });
        const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
          version: 1,
          handoffs: [],
        });

        const platforms = await getPlatformsList(ctx);

        const projectPathFilter = String(ctx.query?.get('project_path') ?? '').trim();
        const normFilter = projectPathFilter.replace(/\//g, '\\').toLowerCase();

        const now = Date.now();
        const liveAgents: LiveAgent[] = [];
        const deletedAgents: Agent[] = [];

        for (const agent of agentsData.agents) {
          if (agent.deleted_at !== null) {
            const delTime = new Date(agent.deleted_at).getTime();
            if (now - delTime < 86400000) {
              deletedAgents.push(agent);
            }
            continue;
          }

          // Non-deleted conversations for this agent
          const agentConvs = convsData.conversations.filter(
            (c) => c.agent_id === agent.id && c.deleted_at === null
          );

          // Sort conversations by newest first
          agentConvs.sort(
            (a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime()
          );

          let activeJobId = '';
          let activeConvId = '';
          let totalQueue = 0;
          let lastActivity = agent.updated_at || agent.created_at;
          let isThinking = false;

          for (const c of agentConvs) {
            if (c.active_job_id && c.active_kind === 'turn') {
              isThinking = true;
              activeJobId = c.active_job_id;
              activeConvId = c.id;
            }
            totalQueue += c.queue ? c.queue.length : 0;
            if (c.updated_at && c.updated_at > lastActivity) {
              lastActivity = c.updated_at;
            }
          }

          // Item 24: error/needs-login only from agent's MOST RECENT conversation
          const mostRecentConv = agentConvs[0];
          const lastTurnFailed = mostRecentConv ? mostRecentConv.last_status === 'failed' : false;
          const lastError = mostRecentConv ? (mostRecentConv.last_error || '') : '';

          // Item 14: last_actual_model reported by CLI on agent's last finished turn
          let lastActualModel = '';
          for (const c of agentConvs) {
            const msgs = readConversationMessages(chatDir, c.id);
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i]!.role === 'assistant' && msgs[i]!.actual_model) {
                lastActualModel = msgs[i]!.actual_model;
                break;
              }
            }
            if (lastActualModel) break;
          }

          const hasWaitingHandoff = handoffsData.handoffs.some(
            (h) => h.to === agent.id && h.status === 'started'
          );

          let status: LiveAgent['status'] = 'idle';
          if (isThinking) {
            status = 'thinking';
          } else if (hasWaitingHandoff || totalQueue > 0) {
            status = 'waiting';
          } else if (lastTurnFailed) {
            const isAuth = AUTH_PATTERNS.some((p) => p.test(lastError));
            status = isAuth ? 'needs-login' : 'error';
          }

          const git = await getCachedGitInfo(agent.workdir);

          liveAgents.push({
            ...agent,
            reply_language: agent.reply_language ?? '',
            status,
            active_job_id: activeJobId,
            active_conversation_id: activeConvId,
            queue_len: totalQueue,
            last_activity: lastActivity,
            last_actual_model: lastActualModel,
            git,
          });
        }

        if (normFilter) {
          liveAgents.sort((a, b) => {
            const aMatch = a.workdir.replace(/\//g, '\\').toLowerCase() === normFilter ? 0 : 1;
            const bMatch = b.workdir.replace(/\//g, '\\').toLowerCase() === normFilter ? 0 : 1;
            if (aMatch !== bMatch) return aMatch - bMatch;
            return a.order - b.order;
          });
        } else {
          liveAgents.sort((a, b) => a.order - b.order);
        }

        deletedAgents.sort(
          (a, b) => new Date(b.deleted_at!).getTime() - new Date(a.deleted_at!).getTime()
        );

        return {
          ok: true,
          agents: liveAgents,
          groups: groupsData.groups.sort((a, b) => a.order - b.order),
          deleted: deletedAgents.slice(0, 20),
          platforms,
          features: {
            isolate: isWorktreeFeatureAvailable(ctx),
            resume: true,
          },
        };
      },
    },

    ws_platforms: {
      method: 'GET',
      handler: async (ctx) => {
        const refresh = ctx.query?.get('refresh') === '1';
        let isCached = false;
        let platforms: PlatformInfo[];

        if (refresh) {
          // Item 6 (Codex Pass 6): Bypass detection cache, clear S6-side in-memory cache and tempDir cache files
          cachedPlatformsData = null;
          const tempDir = ctx.paths.tempDir || getTempDir();
          let clearedAll = true;

          try {
            const toolCache = path.win32.join(tempDir, 'maw_tool_versions_cache_v4.json');
            if (fs.existsSync(toolCache)) {
              fs.unlinkSync(toolCache);
            }
          } catch {
            clearedAll = false;
          }

          try {
            const agentCache = path.win32.join(tempDir, 'maw_agents_detect_cache_v4.json');
            if (fs.existsSync(agentCache)) {
              fs.unlinkSync(agentCache);
            }
          } catch {
            clearedAll = false;
          }

          try {
            platforms = await getPlatformsList(ctx, true);
            cachedPlatformsData = { ts: Date.now(), platforms };
            isCached = !clearedAll;
          } catch (err) {
            if (cachedPlatformsData) {
              platforms = cachedPlatformsData.platforms;
              isCached = true;
            } else {
              throw err;
            }
          }
        } else {
          const now = Date.now();
          if (cachedPlatformsData && now - cachedPlatformsData.ts < 30000) {
            platforms = cachedPlatformsData.platforms;
            isCached = true;
          } else {
            platforms = await getPlatformsList(ctx, false);
            cachedPlatformsData = { ts: now, platforms };
            isCached = true;
          }
        }

        return {
          ok: true,
          platforms,
          cached: isCached,
        };
      },
    },

    ws_agent_save: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const rawAgent = (body.agent ?? {}) as Partial<Agent>;

          const featDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(featDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          const targetId = String(rawAgent.id ?? '').trim();
          const nowIso = new Date().toISOString();

          // Item 13: Partial update when id is provided
          if (targetId) {
            if (!AGENT_ID_REGEX.test(targetId)) {
              throw new ApiValidationError('Invalid agent id format.', 400);
            }
            const existing = agentsData.agents.find((a) => a.id === targetId && a.deleted_at === null);
            if (!existing) {
              throw new ApiValidationError(`Agent '${targetId}' not found.`, 404);
            }

            // Merge partial update
            const mergedReplyLang =
              rawAgent.reply_language !== undefined
                ? validateReplyLanguage(rawAgent.reply_language, {
                    allowEmpty: true,
                    fieldName: 'reply_language',
                  })
                : (existing.reply_language ?? '');
            const merged: Agent = {
              ...existing,
              ...rawAgent,
              id: existing.id,
              reply_language: mergedReplyLang,
              created_at: existing.created_at,
              updated_at: nowIso,
              deleted_at: null,
            };

            // Unique name among other live agents
            const duplicate = agentsData.agents.find(
              (a) => a.id !== targetId && a.deleted_at === null && a.name.toLowerCase() === merged.name.toLowerCase()
            );
            if (duplicate) {
              throw new ApiValidationError(`Another live agent with name '${merged.name}' already exists.`, 409);
            }

            validateAgentFields(merged, ctx);

            // Replace existing with merged
            const idx = agentsData.agents.findIndex((a) => a.id === targetId);
            agentsData.agents[idx] = merged;

            await writeJsonStore(agentsFile, agentsData);
            return { ok: true, agent: merged };
          } else {
            // Create new agent
            const name = String(rawAgent.name ?? '').trim();
            const duplicate = agentsData.agents.find(
              (a) => a.deleted_at === null && a.name.toLowerCase() === name.toLowerCase()
            );
            if (duplicate) {
              throw new ApiValidationError(`A live agent with name '${name}' already exists.`, 409);
            }

            const newReplyLang = validateReplyLanguage(rawAgent.reply_language, {
              allowEmpty: true,
              fieldName: 'reply_language',
            });

            const newAgent: Agent = {
              id: generateAgentId(),
              name,
              group_id: String(rawAgent.group_id ?? '').trim(),
              order: typeof rawAgent.order === 'number' ? rawAgent.order : agentsData.agents.length,
              platform: String(rawAgent.platform ?? '').trim().toLowerCase(),
              model: String(rawAgent.model ?? '').trim(),
              effort: String(rawAgent.effort ?? '').trim(),
              workdir: String(rawAgent.workdir ?? '').trim(),
              role: String(rawAgent.role ?? 'backend').trim().toLowerCase(),
              persona: String(rawAgent.persona ?? '').trim().slice(0, 4000),
              reply_language: newReplyLang,
              team_id: String(rawAgent.team_id ?? '').trim(),
              team_role: String(rawAgent.team_role ?? '').trim(),
              cli_args: Array.isArray(rawAgent.cli_args) ? rawAgent.cli_args.map(String) : [],
              env: rawAgent.env && typeof rawAgent.env === 'object' ? { ...(rawAgent.env as Record<string, string>) } : {},
              hooks: {
                before: String(rawAgent.hooks?.before ?? '').slice(0, 2000),
                after: String(rawAgent.hooks?.after ?? '').slice(0, 2000),
              },
              retry_policy: {
                max_attempts: Math.max(0, Math.min(5, Number(rawAgent.retry_policy?.max_attempts) || 0)),
                backoff_sec: Math.max(
                  0,
                  Math.min(1800, rawAgent.retry_policy?.backoff_sec !== undefined ? Number(rawAgent.retry_policy.backoff_sec) : 30)
                ),
              },
              bookmark: Boolean(rawAgent.bookmark),
              created_at: nowIso,
              updated_at: nowIso,
              deleted_at: null,
            };

            validateAgentFields(newAgent, ctx);

            agentsData.agents.push(newAgent);
            await writeJsonStore(agentsFile, agentsData);
            return { ok: true, agent: newAgent };
          }
        });
      },
    },

    ws_agent_delete: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!AGENT_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid agent id.', 400);
          }

          const featDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(featDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          const agent = agentsData.agents.find((a) => a.id === id && a.deleted_at === null);
          if (!agent) {
            throw new ApiValidationError(`Agent '${id}' not found.`, 404);
          }

          const chatDir = ctx.paths.featureDataDir('chat');
          const convsFile = path.win32.join(chatDir, 'conversations.json');
          const convsData = await readJsonStore<{ version: number; conversations: Conversation[] }>(convsFile, {
            version: 1,
            conversations: [],
          });

          const isBusy = convsData.conversations.some(
            (c) => c.agent_id === id && c.active_job_id && c.deleted_at === null
          );
          if (isBusy) {
            throw new ApiValidationError('Cannot delete agent while a turn is running.', 409);
          }

          // Item 4 (Codex Pass 6): Cannot delete agent while having a handoff in status 'started' or 'running' (as member or Lead)
          const handoffsDir = ctx.paths.featureDataDir('handoffs');
          const handoffsFile = path.win32.join(handoffsDir, 'handoffs.json');
          const handoffsData = await readJsonStore<{ version: number; handoffs: Handoff[] }>(handoffsFile, {
            version: 1,
            handoffs: [],
          });

          const hasActiveHandoff = handoffsData.handoffs.some((h) => {
            const isLead = h.lead_agent_id === id || h.from === id;
            const isMember =
              h.to === id ||
              Boolean(agent.team_role && (h.to === agent.team_role || h.to_role === agent.team_role));
            return (isLead || isMember) && (h.status === 'started' || h.status === 'running');
          });
          if (hasActiveHandoff) {
            throw new ApiValidationError('Cannot delete agent while a handoff is running or started.', 409);
          }

          const deleted_at = new Date().toISOString();
          agent.deleted_at = deleted_at;
          agent.updated_at = deleted_at;

          await writeJsonStore(agentsFile, agentsData);

          await appendAuditLog(featDir, {
            action: 'ws_agent_delete',
            target: id,
            detail: { name: agent.name },
          });

          return {
            ok: true,
            id,
            deleted_at,
          };
        });
      },
    },

    ws_agent_restore: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!AGENT_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid agent id.', 400);
          }

          const featDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(featDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          const agent = agentsData.agents.find((a) => a.id === id);
          if (!agent || agent.deleted_at === null) {
            throw new ApiValidationError(`Soft-deleted agent '${id}' not found.`, 404);
          }

          const collision = agentsData.agents.find(
            (a) => a.id !== id && a.deleted_at === null && a.name.toLowerCase() === agent.name.toLowerCase()
          );
          if (collision) {
            throw new ApiValidationError(`A live agent with name '${agent.name}' already exists.`, 409);
          }

          agent.deleted_at = null;
          agent.updated_at = new Date().toISOString();

          await writeJsonStore(agentsFile, agentsData);

          return {
            ok: true,
            agent,
          };
        });
      },
    },

    ws_agent_duplicate: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!AGENT_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid agent id.', 400);
          }

          const featDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(featDir, 'agents.json');
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          const original = agentsData.agents.find((a) => a.id === id && a.deleted_at === null);
          if (!original) {
            throw new ApiValidationError(`Agent '${id}' not found.`, 404);
          }

          let copyName = `${original.name} (copy)`;
          let counter = 2;
          while (
            agentsData.agents.some(
              (a) => a.deleted_at === null && a.name.toLowerCase() === copyName.toLowerCase()
            )
          ) {
            copyName = `${original.name} (copy ${counter})`;
            counter++;
          }

          const nowIso = new Date().toISOString();
          const copy: Agent = {
            ...original,
            id: generateAgentId(),
            name: copyName,
            team_id: '',
            team_role: '',
            created_at: nowIso,
            updated_at: nowIso,
            deleted_at: null,
          };

          agentsData.agents.push(copy);
          await writeJsonStore(agentsFile, agentsData);

          return {
            ok: true,
            agent: copy,
          };
        });
      },
    },

    ws_agent_move: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!AGENT_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid agent id.', 400);
          }

          const groupId = String(body.group_id ?? '').trim();
          const targetOrder = typeof body.order === 'number' ? body.order : undefined;

          const featDir = ctx.paths.featureDataDir('agents-ws');
          const agentsFile = path.win32.join(featDir, 'agents.json');
          const groupsFile = path.win32.join(featDir, 'groups.json');

          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });
          const groupsData = await readJsonStore<{ version: number; groups: Group[] }>(groupsFile, {
            version: 1,
            groups: [],
          });

          const agent = agentsData.agents.find((a) => a.id === id && a.deleted_at === null);
          if (!agent) {
            throw new ApiValidationError(`Agent '${id}' not found.`, 404);
          }

          if (groupId && !groupsData.groups.some((g) => g.id === groupId)) {
            throw new ApiValidationError(`Group '${groupId}' not found.`, 404);
          }

          agent.group_id = groupId;

          const groupMembers = agentsData.agents
            .filter((a) => a.id !== id && a.group_id === groupId && a.deleted_at === null)
            .sort((a, b) => a.order - b.order);

          if (targetOrder !== undefined && targetOrder >= 0) {
            groupMembers.splice(targetOrder, 0, agent);
          } else {
            groupMembers.push(agent);
          }

          for (let i = 0; i < groupMembers.length; i++) {
            groupMembers[i]!.order = i;
          }

          agent.updated_at = new Date().toISOString();
          await writeJsonStore(agentsFile, agentsData);

          return {
            ok: true,
            agent,
          };
        });
      },
    },

    ws_group_save: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const rawGroup = (body.group ?? {}) as Partial<Group>;

          const featDir = ctx.paths.featureDataDir('agents-ws');
          const groupsFile = path.win32.join(featDir, 'groups.json');
          const groupsData = await readJsonStore<{ version: number; groups: Group[] }>(groupsFile, {
            version: 1,
            groups: [],
          });

          const targetId = String(rawGroup.id ?? '').trim();

          // Item 13: Partial update when id provided
          if (targetId) {
            if (!GROUP_ID_REGEX.test(targetId)) {
              throw new ApiValidationError('Invalid group id format.', 400);
            }
            const existing = groupsData.groups.find((g) => g.id === targetId);
            if (!existing) {
              throw new ApiValidationError(`Group '${targetId}' not found.`, 404);
            }

            const merged: Group = {
              ...existing,
              ...rawGroup,
              id: existing.id,
            };

            const name = String(merged.name ?? '').trim();
            if (!name || name.length > 60) {
              throw new ApiValidationError('Group name must be 1-60 characters.', 400);
            }
            merged.name = name;

            const idx = groupsData.groups.findIndex((g) => g.id === targetId);
            groupsData.groups[idx] = merged;

            await writeJsonStore(groupsFile, groupsData);
            return { ok: true, group: merged };
          } else {
            const name = String(rawGroup.name ?? '').trim();
            if (!name || name.length > 60) {
              throw new ApiValidationError('Group name is required and must be 1-60 characters.', 400);
            }

            const newGroup: Group = {
              id: generateGroupId(),
              name,
              order: typeof rawGroup.order === 'number' ? rawGroup.order : groupsData.groups.length,
              collapsed: Boolean(rawGroup.collapsed),
              team_id: String(rawGroup.team_id ?? '').trim(),
            };

            groupsData.groups.push(newGroup);
            await writeJsonStore(groupsFile, groupsData);
            return { ok: true, group: newGroup };
          }
        });
      },
    },

    ws_group_delete: {
      method: 'POST',
      handler: async (ctx) => {
        return withS6State(async () => {
          const body = ctx.body ?? {};
          const id = String(body.id ?? '').trim();
          if (!GROUP_ID_REGEX.test(id)) {
            throw new ApiValidationError('Invalid group id.', 400);
          }

          const featDir = ctx.paths.featureDataDir('agents-ws');
          const groupsFile = path.win32.join(featDir, 'groups.json');
          const agentsFile = path.win32.join(featDir, 'agents.json');

          const groupsData = await readJsonStore<{ version: number; groups: Group[] }>(groupsFile, {
            version: 1,
            groups: [],
          });
          const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
            version: 1,
            agents: [],
          });

          const idx = groupsData.groups.findIndex((g) => g.id === id);
          if (idx === -1) {
            throw new ApiValidationError(`Group '${id}' not found.`, 404);
          }

          const removedGroup = groupsData.groups[idx]!;
          groupsData.groups.splice(idx, 1);
          await writeJsonStore(groupsFile, groupsData);

          let movedCount = 0;
          for (const agent of agentsData.agents) {
            if (agent.group_id === id) {
              agent.group_id = '';
              agent.updated_at = new Date().toISOString();
              movedCount++;
            }
          }
          if (movedCount > 0) {
            await writeJsonStore(agentsFile, agentsData);
          }

          await appendAuditLog(featDir, {
            action: 'ws_group_delete',
            target: id,
            detail: { name: removedGroup.name, moved: movedCount },
          });

          return {
            ok: true,
            moved: movedCount,
          };
        });
      },
    },
  },
};
