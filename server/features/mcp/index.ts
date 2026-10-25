import type { MawFeature } from '../../lib/feature.ts';
import {
  handleMcpApply,
  handleMcpBackups,
  handleMcpConfig,
  handleMcpPreview,
  handleMcpRestore,
} from './actions.ts';

export const feature: MawFeature = {
  name: 'mcp',
  routes: {
    mcp_config: {
      method: 'GET',
      handler: (ctx, req) => handleMcpConfig(ctx, req),
    },
    mcp_preview: {
      method: 'POST',
      handler: (ctx, req) => handleMcpPreview(ctx, req),
    },
    mcp_apply: {
      method: 'POST',
      handler: (ctx, req) => handleMcpApply(ctx, req),
    },
    mcp_backups: {
      method: 'GET',
      handler: (ctx, req) => handleMcpBackups(ctx, req),
    },
    mcp_restore: {
      method: 'POST',
      handler: (ctx, req) => handleMcpRestore(ctx, req),
    },
  },
  ui: {
    script: 'feat-mcp.js',
    style: 'feat-mcp.css',
  },
};
