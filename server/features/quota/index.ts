import {
  appendActionAudit,
  type MawFeature,
  type MawFeatureContext,
} from '../../lib/feature.ts';
import { isTestContext } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { loadFallbackConfig } from '../policy/lib/s4-core.ts';
import {
  buildQuotaStatusSummary,
  decideQuotaRoute,
  loadQuotaSnapshots,
  refreshAllQuotaSnapshots,
} from './store.ts';

let quotaRefreshTimer: NodeJS.Timeout | null = null;

export const feature: MawFeature = {
  name: 'quota',
  ui: {
    script: 'feat-quota.js',
    style: 'feat-quota.css',
  },
  start: (ctx: MawFeatureContext) => {
    if (isTestContext()) {
      return;
    }
    if (quotaRefreshTimer) {
      clearInterval(quotaRefreshTimer);
    }
    quotaRefreshTimer = setInterval(() => {
      try {
        refreshAllQuotaSnapshots(ctx.paths, ctx.registry);
      } catch {
        // Ignore background refresh error
      }
    }, 5 * 60 * 1000);
    quotaRefreshTimer.unref();
  },
  stop: () => {
    if (quotaRefreshTimer) {
      clearInterval(quotaRefreshTimer);
      quotaRefreshTimer = null;
    }
  },
  status: (ctx: MawFeatureContext) => {
    return buildQuotaStatusSummary(ctx.paths, ctx.registry);
  },
  routes: {
    quota_get: {
      method: 'GET',
      handler: (ctx, req) => {
        const agentFilter = String(req.query.get('agent') ?? '')
          .trim()
          .toLowerCase();
        const accountFilter = String(req.query.get('account') ?? '')
          .trim()
          .toLowerCase();

        let snapshots = loadQuotaSnapshots(ctx.paths);
        if (snapshots.length === 0) {
          snapshots = refreshAllQuotaSnapshots(ctx.paths, ctx.registry);
        }

        if (agentFilter) {
          snapshots = snapshots.filter((s) => s.agent === agentFilter);
        }
        if (accountFilter) {
          snapshots = snapshots.filter((s) => s.account === accountFilter);
        }

        const fallbackDir = ctx.paths.featureDataDir('fallback');
        const routing = loadFallbackConfig(
          fallbackDir,
          ctx.registry.agents.map((a) => a.id)
        ).config.quota_routing;

        return {
          ok: true,
          snapshots,
          routing,
        };
      },
    },
    quota_refresh: {
      method: 'POST',
      handler: (ctx, req) => {
        const body = req.body ?? {};
        const agent = body.agent !== undefined ? String(body.agent).trim().toLowerCase() : '';
        const account = body.account !== undefined ? String(body.account).trim().toLowerCase() : '';

        let snapshots = refreshAllQuotaSnapshots(ctx.paths, ctx.registry, {
          agent: agent || undefined,
          account: account || undefined,
        });

        if (agent) {
          snapshots = snapshots.filter((s) => s.agent === agent);
        }
        if (account) {
          snapshots = snapshots.filter((s) => s.account === account);
        }

        appendActionAudit(ctx.paths, {
          feature: 'quota',
          action: 'quota_refresh',
          agent: agent || null,
          account: account || null,
        });

        return {
          ok: true,
          snapshots,
        };
      },
    },
    quota_route_preview: {
      method: 'GET',
      handler: (ctx, req) => {
        const agent = String(req.query.get('agent') ?? '')
          .trim()
          .toLowerCase();
        const role =
          String(req.query.get('role') ?? 'backend')
            .trim()
            .toLowerCase() || 'backend';
        const account = String(req.query.get('account') ?? '')
          .trim()
          .toLowerCase();

        if (!agent) {
          throw new ApiValidationError("Missing 'agent' query parameter.", 400);
        }
        const known = ctx.registry.allAgents.some((a) => a.id === agent);
        if (!known) {
          throw new ApiValidationError(`Unknown agent '${agent}'.`, 400);
        }

        const { decision } = decideQuotaRoute(ctx.paths, ctx.registry, {
          agent,
          role,
          account: account || undefined,
        });

        return {
          ok: true,
          decision,
        };
      },
    },
  },
};
