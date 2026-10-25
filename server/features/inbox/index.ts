import type { MawFeature } from '../../lib/feature.ts';
import {
  buildInboxStatusContribution,
  handleInboxAct,
  handleInboxAdd,
  handleInboxClear,
  handleInboxGet,
  handleInboxList,
} from './actions.ts';
import { startBackgroundScanner, stopBackgroundScanner } from './scanner.ts';

export const feature: MawFeature = {
  name: 'inbox',
  start: (ctx) => {
    startBackgroundScanner(ctx.paths);
  },
  stop: () => {
    stopBackgroundScanner();
  },
  routes: {
    inbox_list: {
      method: 'GET',
      handler: (ctx, req) => handleInboxList(ctx, req),
    },
    inbox_get: {
      method: 'GET',
      handler: (ctx, req) => handleInboxGet(ctx, req),
    },
    inbox_add: {
      method: 'POST',
      handler: (ctx, req) => handleInboxAdd(ctx, req),
    },
    inbox_act: {
      method: 'POST',
      handler: (ctx, req) => handleInboxAct(ctx, req),
    },
    inbox_clear: {
      method: 'POST',
      handler: (ctx, req) => handleInboxClear(ctx, req),
    },
  },
  status: (ctx) => {
    return Promise.resolve(buildInboxStatusContribution(ctx.paths));
  },
  ui: {
    script: 'feat-inbox.js',
    style: 'feat-inbox.css',
  },
};

export { addInboxItem, getInboxItem, onInboxResolved } from './store.ts';
