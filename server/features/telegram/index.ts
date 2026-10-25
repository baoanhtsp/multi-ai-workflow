import type { MawFeature } from '../../lib/feature.ts';
import {
  handleTelegramConfig,
  handleTelegramStatus,
  handleTelegramTest,
} from './actions.ts';
import { getGlobalTelegramPoller, readTelegramConfig } from './poller.ts';

export const feature: MawFeature = {
  name: 'telegram',
  start: (ctx) => {
    if (process.env.MAW_TELEGRAM_AUTOSTART === '0' || process.env.MAW_TEST === '1') {
      return;
    }
    const cfg = readTelegramConfig(ctx.paths);
    const poller = getGlobalTelegramPoller(ctx.paths);
    poller.setContext(ctx);
    if (cfg.inbound || cfg.push_inbox || cfg.digest.enabled) {
      void poller.start();
    }
  },
  stop: (ctx) => {
    if (ctx) {
      const poller = getGlobalTelegramPoller(ctx.paths);
      poller.stop();
    }
  },
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
    // Cheap status check without network calls or starting poller
    readTelegramConfig(ctx.paths);
    const poller = getGlobalTelegramPoller(ctx.paths);
    poller.setContext(ctx);
    return Promise.resolve(poller.getStatus());
  },
  // No ui field: UI lives in feat-inbox.js
};
