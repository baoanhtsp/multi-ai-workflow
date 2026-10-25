import type { MawFeature } from '../../lib/feature.ts';
import { badRequest } from '../tasks/lib.ts';
import { registerTicker, triggerImmediateTick } from '../tasks/scheduler.ts';
import {
  deleteSchedule,
  getSchedules,
  runScheduleNow,
  saveSchedule,
  scheduleTicker,
} from './runs.ts';

// Register schedules ticker in tasks scheduler
registerTicker('schedules', scheduleTicker);

export const feature: MawFeature = {
  name: 'schedules',
  routes: {
    schedule_list: {
      method: 'GET',
      handler: async (ctx) => {
        const schedules = await getSchedules(ctx);
        return {
          ok: true,
          schedules,
          now: new Date().toISOString(),
        };
      },
    },

    schedule_save: {
      method: 'POST',
      handler: async (ctx, req) => {
        const schedule = await saveSchedule(ctx, req.body);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          schedule,
        };
      },
    },

    schedule_delete: {
      method: 'POST',
      handler: async (ctx, req) => {
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }
        const deletedId = await deleteSchedule(ctx, id);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          id: deletedId,
        };
      },
    },

    schedule_run_now: {
      method: 'POST',
      handler: async (ctx, req) => {
        const id = String(req.body.id ?? '').trim();
        if (!id) {
          throw badRequest("Field 'id' is required.");
        }
        const { schedule, result } = await runScheduleNow(ctx, id);
        triggerImmediateTick(ctx);
        return {
          ok: true,
          schedule,
          result,
        };
      },
    },
  },
};

export default feature;
