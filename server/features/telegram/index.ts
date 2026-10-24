import type { MawFeature } from '../../lib/feature.ts';
import {
  handleTelegramConfig,
  handleTelegramStatus,
  handleTelegramTest,
} from './actions.ts';
import { getGlobalTelegramPoller, readTelegramConfig } from './poller.ts';

export const feature: MawFeature = {
  name: 'telegram',
  routes: {
    telegram_status: {
      method: 'GET',
      handler: (ctx, req) => handleTelegramStatus(ctx, req),
    },
    telegram_config: {
      method: 'POST',
      handler: (ctx, req) => handleTelegramConfig(ctx, req),
    },
    telegram_test: {
      method: 'POST',
      handler: (ctx, req) => handleTelegramTest(ctx, req),
    },
  },
  status: (ctx) => {
    // Cheap status check without network calls
    const cfg = readTelegramConfig(ctx.paths);
    const poller = getGlobalTelegramPoller(ctx.paths);
    poller.setContext(ctx);
    // Lazily start only if inbound is explicitly true and not yet running
    if (cfg.inbound) {
      void poller.start();
    }
    return Promise.resolve(poller.getStatus());
  },
  // No ui field: UI lives in feat-inbox.js
};
