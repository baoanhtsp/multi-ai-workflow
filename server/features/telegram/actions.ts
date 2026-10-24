import type { MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  getGlobalTelegramPoller,
  readTelegramConfig,
  readTelegramState,
  setCapturedHost,
  writeTelegramConfig,
  writeTelegramState,
} from './poller.ts';
import type { TelegramConfigData } from './types.ts';

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function handleTelegramStatus(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const host = req.req?.headers.host;
  if (host) {
    setCapturedHost(host);
  }

  const poller = getGlobalTelegramPoller(ctx.paths);
  poller.setContext(ctx);
  const status = poller.getStatus();
  return {
    ok: true,
    ...status,
  };
}

export async function handleTelegramConfig(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const host = req.req?.headers.host;
  if (host) {
    setCapturedHost(host);
  }

  const body = req.body;
  const currentCfg = readTelegramConfig(ctx.paths);

  let inbound = currentCfg.inbound;
  if ('inbound' in body && body.inbound !== undefined && body.inbound !== null) {
    inbound = Boolean(body.inbound);
  }

  let pushInbox = currentCfg.push_inbox;
  if ('push_inbox' in body && body.push_inbox !== undefined && body.push_inbox !== null) {
    pushInbox = Boolean(body.push_inbox);
  }

  const digest = { ...currentCfg.digest };
  if (body.digest && typeof body.digest === 'object' && !Array.isArray(body.digest)) {
    const rawDigest = body.digest as Record<string, unknown>;
    if ('enabled' in rawDigest && rawDigest.enabled !== undefined) {
      digest.enabled = Boolean(rawDigest.enabled);
    }
    if ('morning' in rawDigest && typeof rawDigest.morning === 'string') {
      const m = rawDigest.morning.trim();
      if (!TIME_REGEX.test(m)) {
        throw new ApiValidationError("Invalid digest.morning time format (expected 'HH:MM').", 400);
      }
      digest.morning = m;
    }
    if ('evening' in rawDigest && typeof rawDigest.evening === 'string') {
      const e = rawDigest.evening.trim();
      if (!TIME_REGEX.test(e)) {
        throw new ApiValidationError("Invalid digest.evening time format (expected 'HH:MM').", 400);
      }
      digest.evening = e;
    }
  }

  const newConfig: TelegramConfigData = {
    inbound,
    push_inbox: pushInbox,
    digest,
  };

  writeTelegramConfig(ctx.paths, newConfig);

  const poller = getGlobalTelegramPoller(ctx.paths);
  poller.setContext(ctx);

  // If inbound or push_inbox was enabled, store push_since in state.json (Item 8)
  if (inbound || pushInbox) {
    const state = readTelegramState(ctx.paths);
    if (!state.push_since) {
      state.push_since = new Date().toISOString();
      writeTelegramState(ctx.paths, state);
    }
  }

  if (inbound) {
    await poller.start();
  } else {
    poller.stop();
  }

  return {
    ok: true,
    ...poller.getStatus(),
  };
}

export async function handleTelegramTest(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const host = req.req?.headers.host;
  if (host) {
    setCapturedHost(host);
  }

  const poller = getGlobalTelegramPoller(ctx.paths);
  poller.setContext(ctx);
  const result = await poller.sendTestMessage();
  if (!result.ok) {
    throw new ApiValidationError(result.error ?? 'Failed to send test Telegram message.', 400);
  }

  return {
    ok: true,
    sent: true,
  };
}
