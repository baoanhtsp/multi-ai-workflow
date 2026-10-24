import fs from 'node:fs';
import path from 'node:path';
import { handleCancelJob } from '../../actions/jobs.ts';
import { createFeatureContext, type MawFeature } from '../../lib/feature.ts';
import { resolveServerPaths } from '../../lib/paths.ts';
import { appendAudit, badRequest, conflict, notFound, stripAnsi } from './lib.ts';
import { exportLibrary, importLibrary } from './library.ts';
import { deletePreset, getPresets, savePreset } from './presets.ts';
import {
  ensureScheduler,
  getSchedulerStatus,
  handleTaskRetry,
  startCardJob,
  triggerImmediateTick,
} from './scheduler.ts';
import {
  bulkCreateCards,
  createCard,
  deleteCard,
  getCard,
  getCards,
  getConfig,
  getQueuedCardsCount,
  getRunningCardsCount,
  getTaskCounts,
  moveCard,
  patchCard,
  saveConfig,
  updateCard,
  type TaskStatus,
} from './store.ts';
import { deleteTemplate, getTemplates, saveTemplate } from './templates.ts';

function readLogTail4Kb(logFile: string): string {
  try {
    if (!fs.existsSync(logFile)) return '';
    const st = fs.statSync(logFile);
    if (st.size <= 0) return '';
    const readLen = Math.min(st.size, 4096);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, st.size - readLen);
      return stripAnsi(buf.subarray(0, bytesRead).toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export const feature: MawFeature = {
  name: 'tasks',
  ui: {
    script: 'feat-tasks.js',
    style: 'feat-tasks.css',
  },
  status: async (ctx) => {
    ensureScheduler(ctx);
    const [counts, running, queued, config] = await Promise.all([
      getTaskCounts(ctx),
      getRunningCardsCount(ctx),
      getQueuedCardsCount(ctx),
      getConfig(ctx),
    ]);
    const scheduler = getSchedulerStatus(ctx);
    return {
      counts,
      running,
      queued,
      scheduler,
      config,
    };
  },
  routes: {
    task_list: {
      method: 'GET',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const projectPath = req.url.searchParams.get('project_path') ?? undefined;
        const agent = req.url.searchParams.get('agent') ?? undefined;
        const status = req.url.searchParams.get('status') ?? undefined;

        const [tasks, config, counts] = await Promise.all([
          getCards(ctx, { project_path: projectPath, agent, status }),
          getConfig(ctx),
          getTaskCounts(ctx),
        ]);
        const scheduler = getSchedulerStatus(ctx);

        return {
          ok: true,
          tasks,
          config,
          scheduler,
          counts,
        };
      },
    },

    task_get: {
      method: 'GET',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const id = String(req.url.searchParams.get('id') ?? '').trim();
        if (!id) {
          throw badRequest("Parameter 'id' is required.");
        }
        const task = await getCard(ctx, id);
        if (!task) {
          throw notFound(`Task not found: ${id}`);
        }

        let logTail = '';
        if (task.job_id) {
          const logFile = path.win32.join(ctx.paths.jobsDir, `${task.job_id}.log`);
          logTail = readLogTail4Kb(logFile);
        }

        return {
          ok: true,
          task,
          log_tail: logTail,
        };
      },
    },

    task_create: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const task = await createCard(ctx, req.body);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          task,
        };
      },
    },

    task_update: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }
        const task = await updateCard(ctx, id, req.body);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          task,
        };
      },
    },

    task_delete: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }
        const deletedId = await deleteCard(ctx, id);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          id: deletedId,
        };
      },
    },

    task_move: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }
        const targetStatus = String(req.body.status ?? '').trim() as TaskStatus;
        const beforeId = req.body.before_id ? String(req.body.before_id).trim() : undefined;
        const reason = req.body.reason !== undefined ? String(req.body.reason) : undefined;

        const task = await moveCard(ctx, id, targetStatus, beforeId, reason);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          task,
        };
      },
    },

    task_start: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }
        const task = await getCard(ctx, id);
        if (!task) {
          throw notFound(`Task not found: ${id}`);
        }
        if (task.status === 'running') {
          throw conflict('Card is already running.');
        }

        const jobId = await startCardJob(ctx, task, {
          ignoreLimits: Boolean(req.body.ignore_limits),
        });
        triggerImmediateTick(ctx);
        return {
          ok: true,
          task,
          job_id: jobId,
        };
      },
    },

    task_cancel: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }

        let cancelJobId: string | null = null;
        let cardTitle = '';
        const patched = await patchCard(ctx, id, (task) => {
          if (task.status !== 'running') {
            throw conflict('Cannot cancel card: not in running state.');
          }
          cancelJobId = task.job_id;
          cardTitle = task.title;
          task.status = 'failed';
          task.status_reason = 'cancelled';
          task.finished_at = new Date().toISOString();
          task.updated_at = new Date().toISOString();

          const lastAtt = task.attempts[task.attempts.length - 1];
          if (lastAtt && lastAtt.status === 'RUNNING') {
            lastAtt.status = 'CANCELLED';
            lastAtt.finished_at = new Date().toISOString();
          }
        });

        if (!patched) {
          throw notFound(`Task not found: ${id}`);
        }

        if (cancelJobId) {
          try {
            await handleCancelJob({ job_id: cancelJobId }, ctx.paths);
          } catch {
            // Ignore if already dead
          }
        }

        appendAudit(ctx.paths.auditFile, 'task_cancel', { id: patched.id, title: cardTitle, job_id: cancelJobId });
        triggerImmediateTick(ctx);

        return {
          ok: true,
          task: patched,
        };
      },
    },

    task_retry: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const task = await handleTaskRetry(ctx, req.body);
        return {
          ok: true,
          task,
        };
      },
    },

    task_config_save: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const config = await saveConfig(ctx, req.body);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          config,
        };
      },
    },

    task_bulk_create: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const tasks = await bulkCreateCards(ctx, {
          tasks: Array.isArray(req.body.tasks) ? req.body.tasks : [],
          created_by: req.body.created_by as any,
        });
        triggerImmediateTick(ctx);
        return {
          ok: true,
          tasks,
        };
      },
    },

    template_list: {
      method: 'GET',
      handler: async (ctx) => {
        ensureScheduler(ctx);
        const templates = await getTemplates(ctx);
        return {
          ok: true,
          templates,
        };
      },
    },

    template_save: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const template = await saveTemplate(ctx, req.body);
        return {
          ok: true,
          template,
        };
      },
    },

    template_delete: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }
        const deletedId = await deleteTemplate(ctx, id);
        return {
          ok: true,
          id: deletedId,
        };
      },
    },

    preset_list: {
      method: 'GET',
      handler: async (ctx) => {
        ensureScheduler(ctx);
        const presets = await getPresets(ctx);
        return {
          ok: true,
          presets,
        };
      },
    },

    preset_save: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const preset = await savePreset(ctx, req.body);
        return {
          ok: true,
          preset,
        };
      },
    },

    preset_delete: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }
        const deletedId = await deletePreset(ctx, id);
        return {
          ok: true,
          id: deletedId,
        };
      },
    },

    library_export: {
      method: 'GET',
      handler: async (ctx) => {
        ensureScheduler(ctx);
        const library = await exportLibrary(ctx);
        return {
          ok: true,
          library,
        };
      },
    },

    library_import: {
      method: 'POST',
      handler: async (ctx, req) => {
        ensureScheduler(ctx);
        const overwrite = Boolean(req.body.overwrite);
        const result = await importLibrary(ctx, req.body.library, overwrite);
        return result;
      },
    },
  },
};

export default feature;

// Auto-start rule from design §1.3:
// auto-start at module load ONLY when process.argv[1] ends with server\main.ts or server/main.ts and MAW_BOARD_AUTOSTART !== '0';
// otherwise lazily via ensureScheduler(ctx) from status() and from every S2 route.
if (
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('server\\main.ts') || process.argv[1].endsWith('server/main.ts')) &&
  process.env.MAW_BOARD_AUTOSTART !== '0'
) {
  let projectsRoot: string | undefined;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === '--projects-root' && i + 1 < process.argv.length) {
      projectsRoot = process.argv[++i]!;
    } else if (arg.startsWith('--projects-root=')) {
      projectsRoot = arg.slice(16);
    }
  }
  const defaultPaths = resolveServerPaths({ projectsRoot });
  const defaultCtx = createFeatureContext(defaultPaths);
  ensureScheduler(defaultCtx);
}
