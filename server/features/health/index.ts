import type { MawFeature } from '../../lib/feature.ts';
import {
  handleDoctorReport,
  handleHealthCheck,
  handleLoginOpen,
  handleLoginPoll,
} from './actions.ts';
import { readHealthCacheOnly } from './probes.ts';

export const feature: MawFeature = {
  name: 'health',
  routes: {
    health_check: {
      method: 'GET',
      handler: (ctx, req) => handleHealthCheck(ctx, req),
    },
    login_open: {
      method: 'POST',
      handler: (ctx, req) => handleLoginOpen(ctx, req),
    },
    login_poll: {
      method: 'GET',
      handler: (ctx, req) => handleLoginPoll(ctx, req),
    },
    doctor_report: {
      method: 'GET',
      handler: (ctx, req) => handleDoctorReport(ctx, req),
    },
  },
  status: (ctx) => {
    // Cache only: NEVER spawn a probe or network call in status()
    const cached = readHealthCacheOnly(ctx.paths);
    return Promise.resolve(cached);
  },
  ui: {
    script: 'feat-health.js',
    style: 'feat-health.css',
  },
};
