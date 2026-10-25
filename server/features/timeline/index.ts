import type { MawFeature } from '../../lib/feature.ts';
import {
  handleTimeline,
  handleTimelineAdd,
  handleTimelineReport,
} from './actions.ts';

export const feature: MawFeature = {
  name: 'timeline',
  routes: {
    timeline: {
      method: 'GET',
      handler: (ctx, req) => handleTimeline(ctx, req),
    },
    timeline_add: {
      method: 'POST',
      handler: (ctx, req) => handleTimelineAdd(ctx, req),
    },
    timeline_report: {
      method: 'GET',
      handler: (ctx, req) => handleTimelineReport(ctx, req),
    },
  },
  ui: {
    script: 'feat-timeline.js',
    style: 'feat-timeline.css',
  },
};
