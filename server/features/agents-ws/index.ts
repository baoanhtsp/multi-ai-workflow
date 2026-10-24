import path from 'node:path';
import { getProjectGitInfo } from '../../actions/git.ts';
import type { MawFeature, MawFeatureContext } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { detectRegistryAgents, getCodexModels, getDetectedToolVersions } from '../../lib/versions.ts';
import { tick } from '../chat/tick.ts';
import type { Conversation } from '../chat/types.ts';
import type { Handoff } from '../handoffs/types.ts';
import { AGENT_ID_REGEX, generateAgentId, generateGroupId, GROUP_ID_REGEX } from './lib/ids.ts';
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

async function getPlatformsList(ctx: MawFeatureContext, forceRefresh = false): Promise<PlatformInfo[]> {
  const registry = ctx.registry;
  const versions = await getDetectedToolVersions(ctx.paths.userProfile);
  const codexModels = getCodexModels(ctx.paths.userProfile);
  const detectedMap = await detectRegistryAgents(ctx.paths, registry.allAgents, versions);

  return registry.allAgents.map((entry) => {
    const det = detectedMap.get(entry.id) ?? { installed: false, version: null };
    const models = [...entry.models];
    if (entry.id === 'codex') {
      for (const cm of codexModels) {
        if (!models.includes(cm)) models.push(cm);
      }
    }
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

          // Compute live status
          const agentConvs = convsData.conversations.filter(
            (c) => c.agent_id === agent.id && c.deleted_at === null
          );

          let activeJobId = '';
          let activeConvId = '';
          let totalQueue = 0;
          let lastActivity = agent.updated_at || agent.created_at;
          let isThinking = false;
          let lastTurnFailed = false;
          let lastError = '';

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
            if (c.last_status === 'failed') {
              lastTurnFailed = true;
              lastError = c.last_error || '';
            }
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
            status,
            active_job_id: activeJobId,
            active_conversation_id: activeConvId,
            queue_len: totalQueue,
            last_activity: lastActivity,
            git,
          });
        }

        // Project path given => agents whose workdir equals it come first
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
            isolate: false,
            resume: false,
          },
        };
      },
    },

    ws_platforms: {
      method: 'GET',
      handler: async (ctx) => {
        const refresh = ctx.query?.get('refresh') === '1';
        const platforms = await getPlatformsList(ctx, refresh);
        return {
          ok: true,
          platforms,
        };
      },
    },

    ws_agent_save: {
      method: 'POST',
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const rawAgent = (body.agent ?? {}) as Partial<Agent>;

        const name = String(rawAgent.name ?? '').trim();
        if (!name || name.length > 60) {
          throw new ApiValidationError('Agent name is required and must be 1-60 characters.', 400);
        }

        const rawWorkdir = String(rawAgent.workdir ?? '').trim();
        const workdir = resolveProjectPath(rawWorkdir, ctx.paths.projectsRoot);
        if (!workdir) {
          throw new ApiValidationError('Invalid or missing workdir (must be strictly inside projectsRoot).', 400);
        }

        const platform = String(rawAgent.platform ?? '').trim().toLowerCase();
        const registryAgent = ctx.registry.agents.find((a) => a.id === platform);
        if (!registryAgent) {
          throw new ApiValidationError(`Invalid platform '${platform}'. Must be an enabled registry agent.`, 400);
        }

        const model = String(rawAgent.model ?? '').trim();
        if (model && !registryAgent.models.includes(model)) {
          throw new ApiValidationError(
            `Invalid model '${model}' for platform '${platform}'. Allowed: ${registryAgent.models.join(', ')}.`,
            400
          );
        }

        const effort = String(rawAgent.effort ?? '').trim();
        if (effort && !registryAgent.efforts.includes(effort)) {
          throw new ApiValidationError(
            `Invalid effort '${effort}' for platform '${platform}'. Allowed: ${registryAgent.efforts.join(', ')}.`,
            400
          );
        }

        const role = String(rawAgent.role ?? 'backend').trim().toLowerCase();
        if (!ALLOWED_TASK_ROLES.includes(role)) {
          throw new ApiValidationError(
            `Invalid role '${role}'. Must be one of: ${ALLOWED_TASK_ROLES.join(', ')}.`,
            400
          );
        }

        const persona = String(rawAgent.persona ?? '').trim().slice(0, 4000);

        let cli_args: string[] = [];
        if (Array.isArray(rawAgent.cli_args)) {
          if (rawAgent.cli_args.length > 20) {
            throw new ApiValidationError('cli_args cannot exceed 20 items.', 400);
          }
          for (const arg of rawAgent.cli_args) {
            const s = String(arg ?? '');
            if (s.length > 200 || /[\0\r\n]/.test(s)) {
              throw new ApiValidationError('cli_args items must be <= 200 chars and contain no NUL/CR/LF.', 400);
            }
            cli_args.push(s);
          }
        }

        let env: Record<string, string> = {};
        if (rawAgent.env && typeof rawAgent.env === 'object' && !Array.isArray(rawAgent.env)) {
          const keys = Object.keys(rawAgent.env);
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
            const val = String(rawAgent.env[k] ?? '');
            if (val.length > 1000) {
              throw new ApiValidationError(`Env value for '${k}' exceeds 1000 chars.`, 400);
            }
            env[upper] = val;
          }
        }

        const hooks = {
          before: String(rawAgent.hooks?.before ?? '').slice(0, 2000),
          after: String(rawAgent.hooks?.after ?? '').slice(0, 2000),
        };

        const rawRetry = rawAgent.retry_policy ?? ({} as Partial<Agent['retry_policy']>);
        const retry_policy = {
          max_attempts: Math.max(0, Math.min(5, Number(rawRetry.max_attempts) || 0)),
          backoff_sec: Math.max(5, Math.min(1800, Number(rawRetry.backoff_sec) || 30)),
        };

        const bookmark = Boolean(rawAgent.bookmark);
        const groupId = String(rawAgent.group_id ?? '').trim();
        const order = typeof rawAgent.order === 'number' ? rawAgent.order : 0;
        const teamId = String(rawAgent.team_id ?? '').trim();
        const teamRole = String(rawAgent.team_role ?? '').trim();

        const featDir = ctx.paths.featureDataDir('agents-ws');
        const agentsFile = path.win32.join(featDir, 'agents.json');
        const agentsData = await readJsonStore<{ version: number; agents: Agent[] }>(agentsFile, {
          version: 1,
          agents: [],
        });

        const targetId = String(rawAgent.id ?? '').trim();
        const nowIso = new Date().toISOString();

        if (targetId) {
          if (!AGENT_ID_REGEX.test(targetId)) {
            throw new ApiValidationError('Invalid agent id format.', 400);
          }
          const existing = agentsData.agents.find((a) => a.id === targetId && a.deleted_at === null);
          if (!existing) {
            throw new ApiValidationError(`Agent '${targetId}' not found.`, 404);
          }

          // Unique name among other live agents
          const duplicate = agentsData.agents.find(
            (a) => a.id !== targetId && a.deleted_at === null && a.name.toLowerCase() === name.toLowerCase()
          );
          if (duplicate) {
            throw new ApiValidationError(`Another live agent with name '${name}' already exists.`, 409);
          }

          existing.name = name;
          existing.group_id = groupId;
          existing.order = order;
          existing.platform = platform;
          existing.model = model;
          existing.effort = effort;
          existing.workdir = workdir;
          existing.role = role;
          existing.persona = persona;
          existing.team_id = teamId;
          existing.team_role = teamRole;
          existing.cli_args = cli_args;
          existing.env = env;
          existing.hooks = hooks;
          existing.retry_policy = retry_policy;
          existing.bookmark = bookmark;
          existing.updated_at = nowIso;

          await writeJsonStore(agentsFile, agentsData);
          return { ok: true, agent: existing };
        } else {
          // New agent
          const duplicate = agentsData.agents.find(
            (a) => a.deleted_at === null && a.name.toLowerCase() === name.toLowerCase()
          );
          if (duplicate) {
            throw new ApiValidationError(`A live agent with name '${name}' already exists.`, 409);
          }

          const newAgent: Agent = {
            id: generateAgentId(),
            name,
            group_id: groupId,
            order,
            platform,
            model,
            effort,
            workdir,
            role,
            persona,
            team_id: teamId,
            team_role: teamRole,
            cli_args,
            env,
            hooks,
            retry_policy,
            bookmark,
            created_at: nowIso,
            updated_at: nowIso,
            deleted_at: null,
          };

          agentsData.agents.push(newAgent);
          await writeJsonStore(agentsFile, agentsData);
          return { ok: true, agent: newAgent };
        }
      },
    },

    ws_agent_delete: {
      method: 'POST',
      handler: async (ctx) => {
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

        // 409 while a turn is running
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
      },
    },

    ws_agent_restore: {
      method: 'POST',
      handler: async (ctx) => {
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

        // Check name conflict with live agents
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
      },
    },

    ws_agent_duplicate: {
      method: 'POST',
      handler: async (ctx) => {
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
      },
    },

    ws_agent_move: {
      method: 'POST',
      handler: async (ctx) => {
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

        // Renumber order in target group
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
      },
    },

    ws_group_save: {
      method: 'POST',
      handler: async (ctx) => {
        const body = ctx.body ?? {};
        const rawGroup = (body.group ?? {}) as Partial<Group>;

        const name = String(rawGroup.name ?? '').trim();
        if (!name || name.length > 60) {
          throw new ApiValidationError('Group name is required and must be 1-60 characters.', 400);
        }

        const featDir = ctx.paths.featureDataDir('agents-ws');
        const groupsFile = path.win32.join(featDir, 'groups.json');
        const groupsData = await readJsonStore<{ version: number; groups: Group[] }>(groupsFile, {
          version: 1,
          groups: [],
        });

        const targetId = String(rawGroup.id ?? '').trim();
        if (targetId) {
          if (!GROUP_ID_REGEX.test(targetId)) {
            throw new ApiValidationError('Invalid group id format.', 400);
          }
          const existing = groupsData.groups.find((g) => g.id === targetId);
          if (!existing) {
            throw new ApiValidationError(`Group '${targetId}' not found.`, 404);
          }

          existing.name = name;
          if (typeof rawGroup.order === 'number') existing.order = rawGroup.order;
          if (rawGroup.collapsed !== undefined) existing.collapsed = Boolean(rawGroup.collapsed);
          if (typeof rawGroup.team_id === 'string') existing.team_id = rawGroup.team_id.trim();

          await writeJsonStore(groupsFile, groupsData);
          return { ok: true, group: existing };
        } else {
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
      },
    },

    ws_group_delete: {
      method: 'POST',
      handler: async (ctx) => {
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
      },
    },
  },
};
