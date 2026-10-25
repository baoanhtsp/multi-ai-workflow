import path from 'node:path';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import {
  appendAudit,
  badRequest,
  conflict,
  fileMutex,
  newId,
  notFound,
  readJson,
  writeJsonAtomic,
} from './lib.ts';
import { getTemplate, renderTemplate } from './templates.ts';

export type TaskMode = 'task' | 'team' | 'council' | 'auto-gate' | 'chat';
export type TaskRole =
  | 'architect'
  | 'leader'
  | 'backend'
  | 'frontend'
  | 'reviewer'
  | 'tester'
  | '';
export type TaskStatus =
  | 'backlog'
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'review'
  | 'done'
  | 'failed';
export type TaskCreatedBy = 'user' | 'lead' | 'github' | 'playbook' | 'schedule';

export interface TaskAttempt {
  n: number;
  job_id: string;
  agent: string;
  role: string;
  mode: string;
  kind: 'start' | 'retry' | 'resume' | 'auto-retry';
  started_at: string;
  finished_at?: string;
  status: 'DONE' | 'FAILED' | 'CANCELLED' | 'RUNNING' | 'ERROR' | string;
  exit_code: number | null;
  error?: string;
  score?: number | null;
  verdict?: string;
  findings?: string;
  prompt_chars?: number;
  branch?: string;
}

export interface TaskRetryConfig {
  auto: boolean;
  max_attempts: number;
  backoff_sec: number;
}

export interface TaskPendingRun {
  kind: 'start' | 'retry' | 'resume' | 'auto-retry';
  prompt: string;
  new_session?: boolean;
}

export interface TaskStartingInfo {
  at: string;
  prompt_sha: string;
}

export interface Card {
  id: string;
  title: string;
  prompt: string;
  project_path: string;
  mode: TaskMode;
  agent: string;
  account?: string;
  role: TaskRole;
  team?: Record<string, string>;
  reviewers?: string[];
  model?: string;
  effort?: string;
  preset_id?: string;
  isolate?: boolean;
  depends_on: string[];
  priority: number;
  require_review: boolean;
  status: TaskStatus;
  status_reason: string;
  job_id: string | null;
  attempts: TaskAttempt[];
  retry: TaskRetryConfig;
  next_retry_at: string | null;
  labels: string[];
  source: Record<string, unknown> | null;
  created_by: TaskCreatedBy;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  order: number;
  pr?: { number: number; url: string };
  pending_run?: TaskPendingRun | null;
  starting?: TaskStartingInfo | null;
}

export interface TasksFile {
  version: 1;
  tasks: Card[];
}

export interface TasksConfig {
  version: 1;
  max_parallel: number;
  per_agent: Record<string, number>;
  paused: boolean;
}

const ALLOWED_MODES = new Set(['task', 'team', 'council', 'auto-gate', 'chat']);
const ALLOWED_TASK_ROLES = new Set(['architect', 'backend', 'frontend', 'reviewer', 'tester']);
const ALLOWED_STATUSES = new Set([
  'backlog',
  'queued',
  'running',
  'needs_input',
  'review',
  'done',
  'failed',
]);
const ALLOWED_CREATED_BY = new Set(['user', 'lead', 'github', 'playbook', 'schedule']);

export function parseRetryConfig(
  raw: unknown,
  current?: TaskRetryConfig
): TaskRetryConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return current ?? { auto: false, max_attempts: 3, backoff_sec: 60 };
  }
  const r = raw as Record<string, unknown>;
  const auto = r.auto !== undefined ? Boolean(r.auto) : (current?.auto ?? false);

  let maxAttempts = current?.max_attempts ?? 3;
  if (r.max_attempts !== undefined) {
    const ma = Number(r.max_attempts);
    if (!Number.isInteger(ma) || Number.isNaN(ma) || ma < 1 || ma > 10) {
      throw badRequest('retry.max_attempts must be an integer between 1 and 10.');
    }
    maxAttempts = ma;
  }

  let backoffSec = current?.backoff_sec ?? 60;
  if (r.backoff_sec !== undefined) {
    const bs = Number(r.backoff_sec);
    if (!Number.isInteger(bs) || Number.isNaN(bs) || bs < 5 || bs > 3600) {
      throw badRequest('retry.backoff_sec must be an integer between 5 and 3600.');
    }
    backoffSec = bs;
  }

  return { auto, max_attempts: maxAttempts, backoff_sec: backoffSec };
}

export function getTasksFile(ctx: MawFeatureContext): string {
  return path.win32.join(ctx.paths.featureDataDir('tasks'), 'tasks.json');
}

export function getConfigFile(ctx: MawFeatureContext): string {
  return path.win32.join(ctx.paths.featureDataDir('tasks'), 'config.json');
}

function pruneOldDoneCards(tasks: Card[]): Card[] {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
  return tasks.filter((c) => {
    if (c.status !== 'done') return true;
    const finTime = c.finished_at ? Date.parse(c.finished_at) : Date.parse(c.updated_at);
    return !Number.isFinite(finTime) || finTime >= thirtyDaysAgo;
  });
}

function checkDependencyCycles(tasks: Card[], targetId: string, newDependsOn: string[]): void {
  const graph = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.id === targetId) {
      graph.set(t.id, [...newDependsOn]);
    } else {
      graph.set(t.id, [...(t.depends_on || [])]);
    }
  }
  if (!graph.has(targetId)) {
    graph.set(targetId, [...newDependsOn]);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(curr: string, pathNodes: string[]): void {
    visited.add(curr);
    inStack.add(curr);

    const deps = graph.get(curr) ?? [];
    for (const dep of deps) {
      if (inStack.has(dep)) {
        throw badRequest(
          `Dependency cycle detected: ${[...pathNodes, dep].join(' -> ')}`
        );
      }
      if (!visited.has(dep)) {
        dfs(dep, [...pathNodes, dep]);
      }
    }

    inStack.delete(curr);
  }

  for (const id of graph.keys()) {
    if (!visited.has(id)) {
      dfs(id, [id]);
    }
  }
}

export async function getConfig(ctx: MawFeatureContext): Promise<TasksConfig> {
  const file = getConfigFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const raw = readJson<TasksConfig>(file, {
      version: 1,
      max_parallel: 3,
      per_agent: {},
      paused: false,
    });
    return {
      version: 1,
      max_parallel: Math.max(1, Math.min(16, Number(raw.max_parallel ?? 3) || 3)),
      per_agent:
        raw.per_agent && typeof raw.per_agent === 'object' && !Array.isArray(raw.per_agent)
          ? raw.per_agent
          : {},
      paused: Boolean(raw.paused),
    };
  });
}

export async function saveConfig(
  ctx: MawFeatureContext,
  updates: Partial<TasksConfig>
): Promise<TasksConfig> {
  const file = getConfigFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const current = readJson<TasksConfig>(file, {
      version: 1,
      max_parallel: 3,
      per_agent: {},
      paused: false,
    });

    if (updates.max_parallel !== undefined) {
      const p = Math.trunc(Number(updates.max_parallel));
      if (!Number.isInteger(p) || p < 1 || p > 16) {
        throw badRequest('max_parallel must be an integer between 1 and 16.');
      }
      current.max_parallel = p;
    }

    if (updates.per_agent !== undefined) {
      if (
        !updates.per_agent ||
        typeof updates.per_agent !== 'object' ||
        Array.isArray(updates.per_agent)
      ) {
        throw badRequest('per_agent must be an object of { [agent]: limit }.');
      }
      const validated: Record<string, number> = {};
      for (const [k, v] of Object.entries(updates.per_agent)) {
        const lim = Math.trunc(Number(v));
        if (!Number.isInteger(lim) || lim < 0 || lim > 16) {
          throw badRequest(`Per-agent limit for '${k}' must be an integer between 0 and 16.`);
        }
        validated[k] = lim;
      }
      current.per_agent = validated;
    }

    if (updates.paused !== undefined) {
      current.paused = Boolean(updates.paused);
    }

    writeJsonAtomic(file, current);
    return current;
  });
}

export async function getCards(
  ctx: MawFeatureContext,
  filter?: { project_path?: string; agent?: string; status?: string }
): Promise<Card[]> {
  const file = getTasksFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const raw = readJson<TasksFile>(file, { version: 1, tasks: [] });
    let tasks = pruneOldDoneCards(Array.isArray(raw.tasks) ? raw.tasks : []);

    if (filter?.project_path) {
      const normFilter = path.resolve(filter.project_path).toLowerCase();
      tasks = tasks.filter((t) => {
        try {
          return path.resolve(t.project_path).toLowerCase() === normFilter;
        } catch {
          return false;
        }
      });
    }

    if (filter?.agent) {
      const a = filter.agent.trim().toLowerCase();
      tasks = tasks.filter((t) => t.agent.toLowerCase() === a);
    }

    if (filter?.status) {
      const s = filter.status.trim().toLowerCase();
      tasks = tasks.filter((t) => t.status.toLowerCase() === s);
    }

    return tasks;
  });
}

export async function getCard(
  ctx: MawFeatureContext,
  id: string
): Promise<Card | null> {
  const all = await getCards(ctx);
  return all.find((c) => c.id === id) ?? null;
}

export async function getTaskCounts(
  ctx: MawFeatureContext
): Promise<Record<string, number>> {
  const cards = await getCards(ctx);
  const counts: Record<string, number> = {
    backlog: 0,
    queued: 0,
    running: 0,
    needs_input: 0,
    review: 0,
    done: 0,
    failed: 0,
  };
  for (const c of cards) {
    counts[c.status] = (counts[c.status] ?? 0) + 1;
  }
  return counts;
}

export async function getRunningCardsCount(ctx: MawFeatureContext): Promise<number> {
  const cards = await getCards(ctx);
  return cards.filter((c) => c.status === 'running').length;
}

export async function getQueuedCardsCount(ctx: MawFeatureContext): Promise<number> {
  const cards = await getCards(ctx);
  return cards.filter((c) => c.status === 'queued').length;
}

export interface ValidatedCardInput {
  title: string;
  prompt: string;
  project_path: string;
  mode: TaskMode;
  agent: string;
  account?: string;
  role: TaskRole;
  team?: Record<string, string>;
  reviewers?: string[];
  model?: string;
  effort?: string;
  preset_id?: string;
  isolate?: boolean;
  depends_on: string[];
  priority: number;
  require_review: boolean;
  status: TaskStatus;
  retry: TaskRetryConfig;
  labels: string[];
  source: Record<string, unknown> | null;
  created_by: TaskCreatedBy;
}

export async function validateCardInput(
  ctx: MawFeatureContext,
  input: Record<string, unknown>,
  validDependencyIds?: Set<string>,
  itemPrefix = ''
): Promise<ValidatedCardInput> {
  // 1. Template resolution if template_id given
  let rawTitle = String(input.title ?? '').trim();
  let rawPrompt = String(input.prompt ?? '').trim();
  const templateId = String(input.template_id ?? '').trim();

  if (templateId) {
    const tpl = await getTemplate(ctx, templateId);
    if (!tpl) {
      throw notFound(`${itemPrefix}Template not found: ${templateId}`);
    }
    const vars =
      input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars)
        ? (input.vars as Record<string, string>)
        : {};
    const rendered = renderTemplate(
      tpl,
      vars,
      String(input.project_path ?? ctx.paths.projectsRoot)
    );
    if (!rawTitle) rawTitle = rendered.title;
    if (!rawPrompt) rawPrompt = rendered.prompt;
    if (!input.mode && tpl.mode) input.mode = tpl.mode;
    if (!input.agent && tpl.agent) input.agent = tpl.agent;
    if (!input.role && tpl.role) input.role = tpl.role;
    if (!input.preset_id && tpl.preset_id) input.preset_id = tpl.preset_id;
  }

  // Title validation
  if (!rawTitle || rawTitle.length > 200) {
    throw badRequest(`${itemPrefix}Card title must be between 1 and 200 characters.`);
  }

  // Prompt validation
  if (!rawPrompt || rawPrompt.length > 20000) {
    throw badRequest(`${itemPrefix}Card prompt must be between 1 and 20000 characters.`);
  }

  // Project path validation
  const rawProjectPath = String(input.project_path ?? '').trim();
  if (!rawProjectPath) {
    throw badRequest(`${itemPrefix}project_path is required.`);
  }
  const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
  if (!projectPath) {
    throw badRequest(
      `${itemPrefix}Invalid project_path '${rawProjectPath}': must be inside projects root.`
    );
  }

  // Mode validation
  const mode = String(input.mode ?? 'task').trim() as TaskMode;
  if (!ALLOWED_MODES.has(mode)) {
    throw badRequest(
      `${itemPrefix}Invalid mode '${mode}'. Allowed: ${Array.from(ALLOWED_MODES).join(', ')}`
    );
  }

  // Enabled agents check
  const enabledAgents = new Map(
    (ctx.registry?.agents ?? []).filter((a) => a.enabled).map((a) => [a.id, a])
  );

  const presetId = input.preset_id ? String(input.preset_id).trim() : undefined;
  let agent = String(input.agent ?? '').trim();
  let role = String(input.role ?? '').trim() as TaskRole;

  if (mode === 'task') {
    if (!agent) {
      throw badRequest(`${itemPrefix}Agent is required for 'task' mode.`);
    }
    if (enabledAgents.size > 0 && !enabledAgents.has(agent)) {
      throw badRequest(`${itemPrefix}Agent '${agent}' is not installed or enabled.`);
    }
    if (!ALLOWED_TASK_ROLES.has(role)) {
      throw badRequest(
        `${itemPrefix}Invalid task role '${role}'. Allowed: ${Array.from(ALLOWED_TASK_ROLES).join(', ')}`
      );
    }
  } else if (mode === 'team') {
    if (!agent && !presetId) {
      throw badRequest(`${itemPrefix}Leader agent is required for 'team' mode.`);
    }
    if (agent && enabledAgents.size > 0 && !enabledAgents.has(agent)) {
      throw badRequest(`${itemPrefix}Leader agent '${agent}' is not installed or enabled.`);
    }
    role = 'leader';
  } else if (mode === 'auto-gate') {
    if (!agent && !presetId) {
      throw badRequest(`${itemPrefix}Implementer agent is required for 'auto-gate' mode.`);
    }
    if (agent && enabledAgents.size > 0 && !enabledAgents.has(agent)) {
      throw badRequest(`${itemPrefix}Implementer agent '${agent}' is not installed or enabled.`);
    }
  } else if (mode === 'council') {
    agent = '';
  } else if (mode === 'chat') {
    if (!agent) {
      throw badRequest(`${itemPrefix}Agent is required for 'chat' mode.`);
    }
    if (enabledAgents.size > 0 && !enabledAgents.has(agent)) {
      throw badRequest(`${itemPrefix}Agent '${agent}' is not installed or enabled.`);
    }
  }

  // Team validation
  let team: Record<string, string> | undefined;
  if (input.team && typeof input.team === 'object' && !Array.isArray(input.team)) {
    team = {};
    for (const [k, v] of Object.entries(input.team as Record<string, unknown>)) {
      const val = String(v ?? '').trim();
      if (val) {
        if (enabledAgents.size > 0 && !enabledAgents.has(val)) {
          throw badRequest(`${itemPrefix}Team member agent '${val}' is not installed or enabled.`);
        }
        team[k] = val;
      }
    }
  }

  // Reviewers validation
  let reviewers: string[] | undefined;
  if (Array.isArray(input.reviewers)) {
    reviewers = [];
    for (const r of input.reviewers) {
      const rev = String(r ?? '').trim();
      if (rev) {
        if (enabledAgents.size > 0) {
          const ag = enabledAgents.get(rev);
          if (!ag) {
            throw badRequest(`${itemPrefix}Reviewer agent '${rev}' is not installed or enabled.`);
          }
          if (!ag.capabilities.review) {
            throw badRequest(`${itemPrefix}Agent '${rev}' does not have review capability.`);
          }
        }
        reviewers.push(rev);
      }
    }
  }

  // Depends_on validation
  let dependsOn: string[] = [];
  if (Array.isArray(input.depends_on)) {
    dependsOn = Array.from(
      new Set(input.depends_on.map((x) => String(x ?? '').trim()).filter(Boolean))
    );
    if (dependsOn.length > 20) {
      throw badRequest(`${itemPrefix}depends_on cannot contain more than 20 dependencies.`);
    }
    if (validDependencyIds) {
      for (const dep of dependsOn) {
        if (!validDependencyIds.has(dep)) {
          throw badRequest(`${itemPrefix}Dependency card not found: ${dep}`);
        }
      }
    }
  }

  // Status validation
  const rawStatus = String(input.status ?? 'backlog').trim() as TaskStatus;
  if (rawStatus !== 'backlog' && rawStatus !== 'queued') {
    throw badRequest(`${itemPrefix}Card initial status must be 'backlog' or 'queued'.`);
  }

  // Priority validation
  let priority = 0;
  if (input.priority !== undefined) {
    priority = Math.trunc(Number(input.priority));
    if (!Number.isInteger(priority) || priority < -2 || priority > 3) {
      throw badRequest(`${itemPrefix}Card priority must be an integer between -2 and 3.`);
    }
  }

  // Retry validation
  const retryCfg = parseRetryConfig(input.retry);

  // Labels
  const labels = Array.isArray(input.labels)
    ? input.labels.map((x) => String(x ?? '').trim()).filter(Boolean)
    : [];

  // Created by
  let createdBy: TaskCreatedBy = 'user';
  if (input.created_by) {
    const cb = String(input.created_by).trim() as TaskCreatedBy;
    if (ALLOWED_CREATED_BY.has(cb)) {
      createdBy = cb;
    }
  }

  return {
    title: rawTitle,
    prompt: rawPrompt,
    project_path: projectPath,
    mode,
    agent: agent || '',
    account: input.account ? String(input.account).trim().toLowerCase() : undefined,
    role: role || '',
    team,
    reviewers,
    model: input.model ? String(input.model).trim() : undefined,
    effort: input.effort ? String(input.effort).trim() : undefined,
    preset_id: input.preset_id ? String(input.preset_id).trim() : undefined,
    isolate: input.isolate !== undefined ? Boolean(input.isolate) : undefined,
    depends_on: dependsOn,
    priority,
    require_review: Boolean(input.require_review),
    status: rawStatus,
    retry: retryCfg,
    labels,
    source:
      input.source && typeof input.source === 'object' && !Array.isArray(input.source)
        ? (input.source as Record<string, unknown>)
        : null,
    created_by: createdBy,
  };
}

export async function createCard(
  ctx: MawFeatureContext,
  input: Record<string, unknown>
): Promise<Card> {
  const file = getTasksFile(ctx);
  return fileMutex.runExclusive(file, async () => {
    const data = readJson<TasksFile>(file, { version: 1, tasks: [] });
    data.tasks = pruneOldDoneCards(Array.isArray(data.tasks) ? data.tasks : []);

    if (data.tasks.length >= 2000) {
      throw badRequest('Maximum card limit (2000) reached.');
    }

    const existingIds = new Set(data.tasks.map((t) => t.id));
    const validated = await validateCardInput(ctx, input, existingIds);

    const newCardId = newId('task');
    if (validated.depends_on.includes(newCardId)) {
      throw badRequest('Card cannot depend on itself.');
    }
    checkDependencyCycles(data.tasks, newCardId, validated.depends_on);

    // Order calculation
    let order = 1000;
    if (input.order !== undefined) {
      order = Math.max(0, Math.trunc(Number(input.order) || 1000));
    } else {
      const colTasks = data.tasks.filter((t) => t.status === validated.status);
      if (colTasks.length > 0) {
        order = Math.max(...colTasks.map((t) => t.order)) + 1000;
      }
    }

    const card: Card = {
      ...validated,
      id: newCardId,
      status_reason: '',
      job_id: null,
      attempts: [],
      next_retry_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      order,
    };

    data.tasks.push(card);
    writeJsonAtomic(file, data);
    return card;
  });
}

export async function updateCard(
  ctx: MawFeatureContext,
  id: string,
  updates: Record<string, unknown>
): Promise<Card> {
  const file = getTasksFile(ctx);
  return fileMutex.runExclusive(file, async () => {
    const data = readJson<TasksFile>(file, { version: 1, tasks: [] });
    const card = data.tasks?.find((t) => t.id === id);
    if (!card) {
      throw notFound(`Task card not found: ${id}`);
    }

    const isRunning = card.status === 'running';

    // If running, only title, labels, priority, retry can be updated
    if (isRunning) {
      const allowedRunningKeys = new Set(['id', 'title', 'labels', 'priority', 'retry']);
      for (const k of Object.keys(updates)) {
        if (!allowedRunningKeys.has(k)) {
          throw conflict('Cannot edit running task except title, labels, priority, retry.');
        }
      }
    }

    if (updates.title !== undefined) {
      const t = String(updates.title).trim();
      if (!t || t.length > 200) {
        throw badRequest('Card title must be between 1 and 200 characters.');
      }
      card.title = t;
    }

    if (!isRunning && updates.prompt !== undefined) {
      const p = String(updates.prompt).trim();
      if (!p || p.length > 20000) {
        throw badRequest('Card prompt must be between 1 and 20000 characters.');
      }
      card.prompt = p;
    }

    if (updates.priority !== undefined) {
      const pri = Math.trunc(Number(updates.priority));
      if (!Number.isInteger(pri) || pri < -2 || pri > 3) {
        throw badRequest('Card priority must be an integer between -2 and 3.');
      }
      card.priority = pri;
    }

    if (updates.labels !== undefined && Array.isArray(updates.labels)) {
      card.labels = updates.labels.map((x) => String(x ?? '').trim()).filter(Boolean);
    }

    if (updates.retry !== undefined) {
      card.retry = parseRetryConfig(updates.retry, card.retry);
    }

    if (!isRunning) {
      const enabledAgents = new Map(
        (ctx.registry?.agents ?? []).filter((a) => a.enabled).map((a) => [a.id, a])
      );

      if (updates.project_path !== undefined) {
        const rawProjectPath = String(updates.project_path ?? '').trim();
        if (!rawProjectPath) {
          throw badRequest('project_path cannot be empty.');
        }
        const resolvedPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!resolvedPath) {
          throw badRequest(
            `Invalid project_path '${rawProjectPath}': must be inside projects root.`
          );
        }
        const pathChanged = card.project_path.toLowerCase() !== resolvedPath.toLowerCase();
        card.project_path = resolvedPath;
        if (pathChanged) {
          const cardMap = new Map((data.tasks ?? []).map((t) => [t.id, t]));
          card.depends_on = (card.depends_on || []).filter((depId) => {
            const depCard = cardMap.get(depId);
            return (
              depCard && depCard.project_path.toLowerCase() === resolvedPath.toLowerCase()
            );
          });
        }
      }

      if (updates.mode !== undefined) {
        const m = String(updates.mode).trim() as TaskMode;
        if (!ALLOWED_MODES.has(m)) {
          throw badRequest(
            `Invalid mode '${m}'. Allowed: ${Array.from(ALLOWED_MODES).join(', ')}`
          );
        }
        card.mode = m;
      }

      if (updates.account !== undefined) {
        const acc = String(updates.account ?? '').trim().toLowerCase();
        card.account = acc || undefined;
      }

      if (updates.agent !== undefined) {
        const a = String(updates.agent).trim();
        if (
          card.mode === 'task' ||
          card.mode === 'team' ||
          card.mode === 'auto-gate' ||
          card.mode === 'chat'
        ) {
          if (!a) {
            throw badRequest(`Agent is required for '${card.mode}' mode.`);
          }
          if (enabledAgents.size > 0 && !enabledAgents.has(a)) {
            throw badRequest(`Agent '${a}' is not installed or enabled.`);
          }
        }
        card.agent = a;
      }

      if (updates.role !== undefined) {
        const r = String(updates.role).trim() as TaskRole;
        if (card.mode === 'task' && !ALLOWED_TASK_ROLES.has(r)) {
          throw badRequest(
            `Invalid task role '${r}'. Allowed: ${Array.from(ALLOWED_TASK_ROLES).join(', ')}`
          );
        }
        card.role = card.mode === 'team' ? 'leader' : r;
      }

      if (updates.team !== undefined) {
        if (updates.team && typeof updates.team === 'object' && !Array.isArray(updates.team)) {
          const teamObj: Record<string, string> = {};
          for (const [k, v] of Object.entries(updates.team as Record<string, unknown>)) {
            const val = String(v ?? '').trim();
            if (val) {
              if (enabledAgents.size > 0 && !enabledAgents.has(val)) {
                throw badRequest(`Team member agent '${val}' is not installed or enabled.`);
              }
              teamObj[k] = val;
            }
          }
          card.team = teamObj;
        } else {
          card.team = undefined;
        }
      }

      if (updates.reviewers !== undefined) {
        if (Array.isArray(updates.reviewers)) {
          const revs: string[] = [];
          for (const r of updates.reviewers) {
            const rev = String(r ?? '').trim();
            if (rev) {
              if (enabledAgents.size > 0) {
                const ag = enabledAgents.get(rev);
                if (!ag) {
                  throw badRequest(`Reviewer agent '${rev}' is not installed or enabled.`);
                }
                if (!ag.capabilities.review) {
                  throw badRequest(`Agent '${rev}' does not have review capability.`);
                }
              }
              revs.push(rev);
            }
          }
          card.reviewers = revs;
        } else {
          card.reviewers = undefined;
        }
      }
      if (updates.depends_on !== undefined && Array.isArray(updates.depends_on)) {
        const deps = Array.from(
          new Set(updates.depends_on.map((x) => String(x ?? '').trim()).filter(Boolean))
        );
        if (deps.length > 20) {
          throw badRequest('depends_on cannot contain more than 20 dependencies.');
        }
        if (deps.includes(card.id)) {
          throw badRequest('Card cannot depend on itself.');
        }
        const existingIds = new Set(data.tasks.map((t) => t.id));
        for (const dep of deps) {
          if (!existingIds.has(dep)) {
            throw badRequest(`Dependency card not found: ${dep}`);
          }
        }
        checkDependencyCycles(data.tasks, card.id, deps);
        card.depends_on = deps;
      }

      if (updates.require_review !== undefined) {
        card.require_review = Boolean(updates.require_review);
      }

      if (updates.model !== undefined) {
        card.model = String(updates.model).trim() || undefined;
      }
      if (updates.effort !== undefined) {
        card.effort = String(updates.effort).trim() || undefined;
      }
      if (updates.preset_id !== undefined) {
        card.preset_id = String(updates.preset_id).trim() || undefined;
      }
      if (updates.isolate !== undefined) {
        card.isolate = Boolean(updates.isolate);
      }
    }

    card.updated_at = new Date().toISOString();
    writeJsonAtomic(file, data);
    return card;
  });
}

export async function deleteCard(
  ctx: MawFeatureContext,
  id: string
): Promise<string> {
  const file = getTasksFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<TasksFile>(file, { version: 1, tasks: [] });
    const idx = data.tasks.findIndex((t) => t.id === id);
    if (idx < 0) {
      throw notFound(`Task card not found: ${id}`);
    }

    const card = data.tasks[idx]!;
    if (card.status === 'running') {
      throw conflict('Cannot delete a running card. Cancel it first.');
    }

    data.tasks.splice(idx, 1);

    // Remove deleted id from other cards' depends_on
    for (const t of data.tasks) {
      if (Array.isArray(t.depends_on) && t.depends_on.includes(id)) {
        t.depends_on = t.depends_on.filter((d) => d !== id);
      }
    }

    writeJsonAtomic(file, data);
    appendAudit(ctx.paths, 'task_delete', { id, title: card.title }, 'tasks');
    return id;
  });
}

export async function moveCard(
  ctx: MawFeatureContext,
  id: string,
  targetStatus: TaskStatus,
  beforeId?: string,
  reason?: string
): Promise<Card> {
  if (targetStatus === 'running') {
    throw badRequest("Cannot move card directly to 'running' status (use scheduler or task_start).");
  }
  if (!ALLOWED_STATUSES.has(targetStatus)) {
    throw badRequest(`Invalid target status: ${targetStatus}`);
  }

  const file = getTasksFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<TasksFile>(file, { version: 1, tasks: [] });
    const card = data.tasks?.find((t) => t.id === id);
    if (!card) {
      throw notFound(`Task card not found: ${id}`);
    }

    if (card.status === 'running') {
      throw conflict('Cannot move a running card. Cancel it first.');
    }

    card.status = targetStatus;
    if (targetStatus === 'done' && !card.finished_at) {
      card.finished_at = new Date().toISOString();
    }
    if (reason !== undefined) {
      card.status_reason = String(reason).trim().slice(0, 200);
    } else if (targetStatus === 'queued') {
      card.status_reason = '';
    }

    // Reorder inside target column
    const colCards = (data.tasks ?? [])
      .filter((t) => t.status === targetStatus && t.id !== id)
      .sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));

    if (beforeId) {
      const idx = colCards.findIndex((c) => c.id === beforeId);
      if (idx >= 0) {
        colCards.splice(idx, 0, card);
      } else {
        colCards.push(card);
      }
    } else {
      colCards.push(card);
    }

    // Reassign order 1000, 2000, 3000...
    for (let i = 0; i < colCards.length; i++) {
      colCards[i]!.order = (i + 1) * 1000;
    }

    card.updated_at = new Date().toISOString();
    writeJsonAtomic(file, data);
    return card;
  });
}

export function isJobIdAttachedToAnyCard(tasks: Card[], jobId: string): boolean {
  for (const t of tasks) {
    if (t.job_id === jobId) return true;
    if (Array.isArray(t.attempts)) {
      for (const a of t.attempts) {
        if (a.job_id === jobId) return true;
      }
    }
  }
  return false;
}

export async function patchCard(
  ctx: MawFeatureContext,
  id: string,
  updater: (fresh: Card, allTasks: Card[]) => void | boolean | Promise<void | boolean>
): Promise<Card | null> {
  const file = getTasksFile(ctx);
  return fileMutex.runExclusive(file, async () => {
    const data = readJson<TasksFile>(file, { version: 1, tasks: [] });
    if (!Array.isArray(data.tasks)) data.tasks = [];
    const card = data.tasks.find((t) => t.id === id);
    if (!card) {
      return null;
    }
    const res = await updater(card, data.tasks);
    if (res === false) {
      return card;
    }
    card.updated_at = new Date().toISOString();
    writeJsonAtomic(file, data);
    return card;
  });
}

export async function saveCard(
  ctx: MawFeatureContext,
  card: Card
): Promise<Card> {
  const file = getTasksFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<TasksFile>(file, { version: 1, tasks: [] });
    if (!Array.isArray(data.tasks)) {
      data.tasks = [];
    }
    const idx = data.tasks.findIndex((t) => t.id === card.id);
    if (idx < 0) {
      throw notFound(`Task card not found: ${card.id}`);
    }
    card.updated_at = new Date().toISOString();
    data.tasks[idx] = card;
    writeJsonAtomic(file, data);
    return card;
  });
}

export async function bulkCreateCards(
  ctx: MawFeatureContext,
  input: { tasks: Array<Record<string, unknown>>; created_by?: TaskCreatedBy }
): Promise<Card[]> {
  const items = Array.isArray(input.tasks) ? input.tasks : [];
  if (items.length === 0) {
    return [];
  }
  if (items.length > 50) {
    throw badRequest('task_bulk_create supports at most 50 tasks per request.');
  }

  // Pre-generate IDs and map refs
  const refMap = new Map<string, string>();
  const idList: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const id = newId('task');
    idList.push(id);
    const ref = String(items[i]!.ref ?? '').trim();
    if (ref) {
      refMap.set(ref, id);
    }
  }

  // Pre-validate depends_on_refs before acquiring mutex
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (Array.isArray(item.depends_on_refs)) {
      for (const ref of item.depends_on_refs) {
        const r = String(ref ?? '').trim();
        if (!r || !refMap.has(r)) {
          throw badRequest(`Item #${i + 1}: unknown depends_on_ref '${r}'.`);
        }
      }
    }
  }

  const file = getTasksFile(ctx);
  return fileMutex.runExclusive(file, async () => {
    const data = readJson<TasksFile>(file, { version: 1, tasks: [] });
    data.tasks = pruneOldDoneCards(Array.isArray(data.tasks) ? data.tasks : []);

    if (data.tasks.length + items.length > 2000) {
      throw badRequest('Maximum card limit (2000) reached.');
    }

    const existingIds = new Set(data.tasks.map((t) => t.id));
    const allValidIds = new Set([...existingIds, ...idList]);

    const createdCards: Card[] = [];

    // First pass: validate every card completely without saving anything
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const assignedId = idList[i]!;

      // Resolve depends_on_refs
      const resolvedDeps: string[] = Array.isArray(item.depends_on)
        ? item.depends_on.map((x) => String(x ?? '').trim()).filter(Boolean)
        : [];

      if (Array.isArray(item.depends_on_refs)) {
        for (const ref of item.depends_on_refs) {
          const r = String(ref ?? '').trim();
          if (refMap.has(r)) {
            resolvedDeps.push(refMap.get(r)!);
          }
        }
      }

      const cardInput: Record<string, unknown> = {
        ...item,
        id: assignedId,
        depends_on: Array.from(new Set(resolvedDeps)),
        created_by: input.created_by || item.created_by || 'lead',
      };

      const validated = await validateCardInput(
        ctx,
        cardInput,
        allValidIds,
        `Item #${i + 1}: `
      );

      if (validated.depends_on.includes(assignedId)) {
        throw badRequest(`Item #${i + 1}: Card cannot depend on itself.`);
      }

      const card: Card = {
        ...validated,
        id: assignedId,
        status_reason: '',
        job_id: null,
        attempts: [],
        next_retry_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        order: (i + 1) * 1000,
      };

      createdCards.push(card);
    }

    // Check cycles across all existing + newly created cards
    const combinedTasks = [...data.tasks, ...createdCards];
    for (let i = 0; i < createdCards.length; i++) {
      const c = createdCards[i]!;
      try {
        checkDependencyCycles(combinedTasks, c.id, c.depends_on);
      } catch (err: unknown) {
        throw badRequest(`Item #${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // If all pass, append all cards and save
    data.tasks.push(...createdCards);
    writeJsonAtomic(file, data);
    return createdCards;
  });
}
