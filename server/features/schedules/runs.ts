import path from 'node:path';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { getPlaybookRuns, startPlaybookRun } from '../playbooks/runs.ts';
import {
  appendAudit,
  badRequest,
  fileMutex,
  newId,
  notFound,
  readJson,
  writeJsonAtomic,
} from '../tasks/lib.ts';
import { createCard, getCards } from '../tasks/store.ts';
import { computeNextRunAt, validateWhenFormat } from './parser.ts';

export interface ScheduleActionCard {
  type: 'card';
  card: Record<string, unknown>;
}

export interface ScheduleActionPlaybook {
  type: 'playbook';
  project_path: string;
  file: string;
  mode?: string;
  agent?: string;
  role?: string;
  on_failure?: 'stop' | 'continue';
  [key: string]: unknown;
}

export type ScheduleAction = ScheduleActionCard | ScheduleActionPlaybook;

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  when: string;
  action: ScheduleAction;
  skip_if_running: boolean;
  last_run_at: string | null;
  next_run_at: string;
  last_result: string;
}

export function getSchedulesFile(ctx: MawFeatureContext): string {
  return path.win32.join(ctx.paths.featureDataDir('schedules'), 'schedules.json');
}

export async function getSchedules(ctx: MawFeatureContext): Promise<Schedule[]> {
  const file = getSchedulesFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const raw = readJson<{ version: 1; schedules: Schedule[] }>(file, {
      version: 1,
      schedules: [],
    });
    return Array.isArray(raw.schedules) ? raw.schedules : [];
  });
}

export async function saveSchedule(
  ctx: MawFeatureContext,
  raw: Record<string, unknown>
): Promise<Schedule> {
  const name = String(raw.name ?? '').trim();
  if (!name) {
    throw badRequest("Field 'name' is required for schedule.");
  }

  const whenStr = String(raw.when ?? '').trim();
  if (!whenStr) {
    throw badRequest("Field 'when' is required for schedule.");
  }

  validateWhenFormat(whenStr);
  const nextRunAt = computeNextRunAt(whenStr, new Date());

  if (!raw.action || typeof raw.action !== 'object' || Array.isArray(raw.action)) {
    throw badRequest("Field 'action' must be an object with { type: 'card' | 'playbook', ... }.");
  }
  const actionRaw = raw.action as Record<string, unknown>;
  const actionType = String(actionRaw.type ?? '').trim().toLowerCase();
  if (actionType !== 'card' && actionType !== 'playbook') {
    throw badRequest("action.type must be either 'card' or 'playbook'.");
  }

  let validatedAction: ScheduleAction;
  if (actionType === 'card') {
    if (!actionRaw.card || typeof actionRaw.card !== 'object' || Array.isArray(actionRaw.card)) {
      throw badRequest("action.card must be an object for action type 'card'.");
    }
    const cardObj = { ...(actionRaw.card as Record<string, unknown>) };
    const rawProj = String(cardObj.project_path ?? '').trim();
    if (!rawProj) {
      throw badRequest("action.card.project_path is required.");
    }
    const validProj = resolveProjectPath(rawProj, ctx.paths.projectsRoot);
    if (!validProj) {
      throw badRequest(`action.card.project_path "${rawProj}" is not valid or outside projectsRoot.`);
    }
    cardObj.project_path = validProj;

    validatedAction = {
      type: 'card',
      card: cardObj,
    };
  } else {
    const proj = String(actionRaw.project_path ?? '').trim();
    const fl = String(actionRaw.file ?? '').trim();
    if (!proj || !fl) {
      throw badRequest("action.project_path and action.file are required for action type 'playbook'.");
    }
    const validProj = resolveProjectPath(proj, ctx.paths.projectsRoot);
    if (!validProj) {
      throw badRequest(`action.project_path "${proj}" is not valid or outside projectsRoot.`);
    }
    validatedAction = {
      type: 'playbook',
      project_path: validProj,
      file: fl,
      mode: actionRaw.mode ? String(actionRaw.mode).trim() : undefined,
      agent: actionRaw.agent ? String(actionRaw.agent).trim() : undefined,
      role: actionRaw.role ? String(actionRaw.role).trim() : undefined,
      on_failure:
        String(actionRaw.on_failure ?? 'stop').trim().toLowerCase() === 'continue'
          ? 'continue'
          : 'stop',
    };
  }

  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : true;
  const skipIfRunning = raw.skip_if_running !== undefined ? Boolean(raw.skip_if_running) : true;

  const file = getSchedulesFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<{ version: 1; schedules: Schedule[] }>(file, {
      version: 1,
      schedules: [],
    });
    if (!Array.isArray(data.schedules)) data.schedules = [];

    const rawId = String(raw.id ?? '').trim();
    const id = rawId || newId('sch');
    const existingIdx = data.schedules.findIndex((s) => s.id === id);

    if (existingIdx < 0 && data.schedules.length >= 50) {
      throw badRequest('Maximum schedule limit (50) reached.');
    }

    const schedule: Schedule = {
      id,
      name,
      enabled,
      when: whenStr,
      action: validatedAction,
      skip_if_running: skipIfRunning,
      last_run_at: existingIdx >= 0 ? data.schedules[existingIdx]!.last_run_at : null,
      next_run_at: nextRunAt,
      last_result: existingIdx >= 0 ? data.schedules[existingIdx]!.last_result : '',
    };

    if (existingIdx >= 0) {
      data.schedules[existingIdx] = schedule;
    } else {
      data.schedules.push(schedule);
    }

    writeJsonAtomic(file, data);
    return schedule;
  });
}

export async function deleteSchedule(
  ctx: MawFeatureContext,
  id: string
): Promise<string> {
  const file = getSchedulesFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<{ version: 1; schedules: Schedule[] }>(file, {
      version: 1,
      schedules: [],
    });
    const beforeLen = data.schedules?.length ?? 0;
    data.schedules = (data.schedules ?? []).filter((s) => s.id !== id);
    if (data.schedules.length === beforeLen) {
      throw notFound(`Schedule not found: ${id}`);
    }
    writeJsonAtomic(file, data);
    appendAudit(ctx.paths.auditFile, 'schedule_delete', { id });
    return id;
  });
}

export async function executeScheduleAction(
  ctx: MawFeatureContext,
  schedule: Schedule
): Promise<string> {
  if (schedule.action.type === 'card') {
    const cardInput = {
      ...schedule.action.card,
      created_by: 'schedule',
      source: {
        kind: 'schedule',
        schedule_id: schedule.id,
      },
      status: 'queued',
    };
    const card = await createCard(ctx, cardInput);
    return `created ${card.id}`;
  } else if (schedule.action.type === 'playbook') {
    const pb = await startPlaybookRun(ctx, schedule.action, { schedule_id: schedule.id });
    return `started playbook run ${pb.run.id}`;
  }
  return 'unknown action type';
}

export async function runScheduleNow(
  ctx: MawFeatureContext,
  id: string
): Promise<{ schedule: Schedule; result: string }> {
  const file = getSchedulesFile(ctx);
  return fileMutex.runExclusive(file, async () => {
    const data = readJson<{ version: 1; schedules: Schedule[] }>(file, {
      version: 1,
      schedules: [],
    });
    const schedule = (data.schedules ?? []).find((s) => s.id === id);
    if (!schedule) {
      throw notFound(`Schedule not found: ${id}`);
    }

    const result = await executeScheduleAction(ctx, schedule);
    schedule.last_run_at = new Date().toISOString();
    schedule.last_result = result;
    schedule.next_run_at = computeNextRunAt(schedule.when, new Date());

    writeJsonAtomic(file, data);
    return { schedule, result };
  });
}

export async function scheduleTicker(ctx: MawFeatureContext): Promise<void> {
  const file = getSchedulesFile(ctx);
  await fileMutex.runExclusive(file, async () => {
    const data = readJson<{ version: 1; schedules: Schedule[] }>(file, {
      version: 1,
      schedules: [],
    });
    if (!Array.isArray(data.schedules)) return;

    const now = new Date();
    const nowIso = now.toISOString();
    let modified = false;

    for (const schedule of data.schedules) {
      if (!schedule.enabled) {
        continue;
      }
      if (schedule.next_run_at && schedule.next_run_at <= nowIso) {
        // Check skip_if_running
        if (schedule.skip_if_running) {
          if (schedule.action.type === 'card') {
            const cards = await getCards(ctx);
            const hasRunning = cards.some(
              (c) =>
                c.source?.kind === 'schedule' &&
                c.source?.schedule_id === schedule.id &&
                (c.status === 'queued' || c.status === 'running')
            );
            if (hasRunning) {
              schedule.last_result = 'skipped (previous still running)';
              schedule.last_run_at = nowIso;
              schedule.next_run_at = computeNextRunAt(schedule.when, now);
              modified = true;
              continue;
            }
          } else if (schedule.action.type === 'playbook') {
            const runs = await getPlaybookRuns(ctx);
            const hasRunning = runs.some(
              (r) => r.schedule_id === schedule.id && r.status === 'running'
            );
            if (hasRunning) {
              schedule.last_result = 'skipped (previous still running)';
              schedule.last_run_at = nowIso;
              schedule.next_run_at = computeNextRunAt(schedule.when, now);
              modified = true;
              continue;
            }
          }
        }

        try {
          const result = await executeScheduleAction(ctx, schedule);
          schedule.last_result = result;
        } catch (err: unknown) {
          schedule.last_result = `error: ${err instanceof Error ? err.message : String(err)}`;
        }

        schedule.last_run_at = nowIso;
        schedule.next_run_at = computeNextRunAt(schedule.when, now);
        modified = true;
      }
    }

    if (modified) {
      writeJsonAtomic(file, data);
    }
  });
}
