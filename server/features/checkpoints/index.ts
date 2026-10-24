import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature } from '../../lib/feature.ts';
import { isFileSafe, resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  createCheckpoint,
  diffTrees,
  listCheckpoints,
  restoreTree,
  validateCheckpointId,
  validateJobKey,
  JOB_ID_REGEX,
} from './snapshot.ts';

export interface CheckpointsConfig {
  enabled: boolean;
  retention: number;
}

export function loadCheckpointsConfig(dataDir: string): CheckpointsConfig {
  const configFile = path.win32.join(dataDir, 'config.json');
  if (isFileSafe(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
      const enabled = raw.enabled !== false;
      const rawRetention = Number(raw.retention);
      const retention =
        Number.isFinite(rawRetention) && rawRetention >= 5 && rawRetention <= 500
          ? Math.trunc(rawRetention)
          : 50;
      return { enabled, retention };
    } catch {
      // Return defaults on parse error
    }
  }
  return { enabled: true, retention: 50 };
}

export function saveCheckpointsConfig(dataDir: string, cfg: CheckpointsConfig): void {
  const configFile = path.win32.join(dataDir, 'config.json');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
}

export const feature: MawFeature = {
  name: 'checkpoints',
  ui: {
    script: 'feat-checkpoints.js',
    style: 'feat-checkpoints.css',
  },
  status: async (ctx) => {
    const dataDir = ctx.paths.featureDataDir('checkpoints');
    const cfg = loadCheckpointsConfig(dataDir);
    return {
      enabled: cfg.enabled,
      retention: cfg.retention,
    };
  },
  routes: {
    checkpoint_list: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawPath = String(req.url.searchParams.get('project_path') ?? '').trim();
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project path.', 400);
        }

        const rawJobId = req.url.searchParams.get('job_id');
        let jobId: string | undefined = undefined;
        if (rawJobId !== null && rawJobId !== '') {
          if (!validateJobKey(rawJobId)) {
            throw new ApiValidationError('Invalid job key.', 400);
          }
          jobId = rawJobId;
        }
        const rawLimit = Number(req.url.searchParams.get('limit') ?? 200);
        const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 200;

        const dataDir = ctx.paths.featureDataDir('checkpoints');
        const cfg = loadCheckpointsConfig(dataDir);

        const res = await listCheckpoints(projectPath, {
          jobId: jobId || undefined,
          limit,
          retention: cfg.retention,
        });

        return {
          ok: true,
          project_path: projectPath,
          head: res.head,
          retention: cfg.retention,
          checkpoints: res.checkpoints,
        };
      },
    },

    checkpoint_diff: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawPath = String(req.url.searchParams.get('project_path') ?? '').trim();
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project path.', 400);
        }

        const from = String(req.url.searchParams.get('from') ?? '').trim();
        if (!from) {
          throw new ApiValidationError('Missing from parameter.', 400);
        }

        const to = String(req.url.searchParams.get('to') ?? 'WORKTREE').trim() || 'WORKTREE';
        const subPath = req.url.searchParams.get('path') ?? undefined;

        const diffRes = await diffTrees(projectPath, from, to, subPath);
        return diffRes;
      },
    },

    checkpoint_create: {
      method: 'POST',
      handler: async (ctx, req) => {
        const rawPath = String(req.body.project_path ?? '').trim();
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project path.', 400);
        }

        const label = String(req.body.label ?? 'manual checkpoint').trim() || 'manual checkpoint';
        const dataDir = ctx.paths.featureDataDir('checkpoints');
        const cfg = loadCheckpointsConfig(dataDir);

        const res = await createCheckpoint(projectPath, {
          jobKey: 'manual',
          event: 'manual',
          label,
          configRetention: cfg.retention,
        });

        return {
          ok: true,
          checkpoint: res.checkpoint,
          created: res.created,
        };
      },
    },

    checkpoint_restore: {
      method: 'POST',
      handler: async (ctx, req) => {
        const rawPath = String(req.body.project_path ?? '').trim();
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project path.', 400);
        }

        const checkpointId = String(req.body.checkpoint ?? '').trim();
        validateCheckpointId(checkpointId);

        if (req.body.confirm !== true) {
          throw new ApiValidationError('Confirmation required.', 400);
        }

        const dataDir = ctx.paths.featureDataDir('checkpoints');
        const checkpointsAuditFile = path.win32.join(dataDir, 'audit.jsonl');

        const restoreRes = await restoreTree(projectPath, checkpointId, {
          confirm: true,
          auditFile: ctx.paths.auditFile,
          checkpointsAuditFile,
        });

        return restoreRes;
      },
    },

    checkpoint_config: {
      method: 'POST',
      handler: async (ctx, req) => {
        const dataDir = ctx.paths.featureDataDir('checkpoints');
        const cfg = loadCheckpointsConfig(dataDir);

        if (req.body.retention !== undefined) {
          const r = Number(req.body.retention);
          if (!Number.isFinite(r) || r < 5 || r > 500) {
            throw new ApiValidationError('Retention must be an integer between 5 and 500.', 400);
          }
          cfg.retention = Math.trunc(r);
        }

        if (req.body.enabled !== undefined) {
          if (typeof req.body.enabled !== 'boolean') {
            throw new ApiValidationError('Enabled must be a boolean.', 400);
          }
          cfg.enabled = req.body.enabled;
        }

        saveCheckpointsConfig(dataDir, cfg);

        return {
          ok: true,
          retention: cfg.retention,
          enabled: cfg.enabled,
        };
      },
    },

    checkpoint_rollback_target: {
      method: 'GET',
      handler: async (ctx, req) => {
        const rawJobId = String(req.url.searchParams.get('job_id') ?? '').trim();
        if (!rawJobId || !JOB_ID_REGEX.test(rawJobId)) {
          throw new ApiValidationError('Invalid job_id.', 400);
        }

        const metaFile = path.win32.join(ctx.paths.jobsDir, `${rawJobId}.json`);
        if (!isFileSafe(metaFile)) {
          throw new ApiValidationError(`Job not found: ${rawJobId}`, 404);
        }

        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
        } catch {
          throw new ApiValidationError(`Job not found: ${rawJobId}`, 404);
        }

        const rawProjectPath = String(meta.project_path ?? '').trim();
        const projectPath = resolveProjectPath(rawProjectPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project path in job metadata.', 404);
        }

        const listRes = await listCheckpoints(projectPath, {
          jobId: rawJobId,
          limit: 500,
        });

        // The first checkpoint of that job is the earliest one (event == 'job-start' or earliest by n/time)
        const jobCheckpoints = listRes.checkpoints.filter((cp) => cp.job_key === rawJobId);
        if (jobCheckpoints.length === 0) {
          throw new ApiValidationError(`No checkpoint found for job ${rawJobId}`, 404);
        }

        // listCheckpoints returns newest first, so oldest is the last one
        const earliest =
          jobCheckpoints.find((cp) => cp.event === 'job-start') ??
          jobCheckpoints[jobCheckpoints.length - 1]!;

        return {
          ok: true,
          project_path: projectPath,
          checkpoint: earliest,
        };
      },
    },
  },
};
