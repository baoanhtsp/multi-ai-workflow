import child_process from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MawFeature, MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import { resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import {
  appendJsonl,
  isPathInsideProject,
  readJsonSafe,
  writeJsonAtomic,
} from '../policy/lib/s4-core.ts';
import {
  computeDirtySignature,
  computeGate,
  createDefaultChecksConfig,
  detectChecks,
  getGitInfo,
  getProjectChecksSha256,
  isProjectChecksTrusted,
  runCheckProcess,
  trustProjectChecks,
  validateChecksConfig,
  type CheckRunResult,
  type ChecksConfig,
  type ChecksOverride,
  type GateResult,
} from './lib/checks-core.ts';

// Track active runs in memory
interface RunningProject {
  runId: string;
  projectPath: string;
  startedAt: string;
  childProcess?: child_process.ChildProcess;
  cancelled: boolean;
}

const activeRuns = new Map<string, RunningProject>();

function normProjectKey(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function appendChecksAudit(
  ctx: MawFeatureContext,
  action: string,
  details: Record<string, unknown>
): void {
  const auditFile = path.win32.join(ctx.paths.featureDataDir('checks'), 'audit.jsonl');
  appendJsonl(auditFile, {
    ts: new Date().toISOString(),
    action,
    by: 'dashboard',
    details,
  });
}

function getOverrides(ctx: MawFeatureContext): ChecksOverride[] {
  const file = path.win32.join(ctx.paths.featureDataDir('checks'), 'overrides.json');
  return readJsonSafe<ChecksOverride[]>(file, []).data;
}

function saveOverrides(ctx: MawFeatureContext, overrides: ChecksOverride[]): void {
  const file = path.win32.join(ctx.paths.featureDataDir('checks'), 'overrides.json');
  writeJsonAtomic(file, overrides);
}

function getStoredResults(ctx: MawFeatureContext, projectPath: string): CheckRunResult[] {
  const hash = crypto.createHash('sha1').update(normProjectKey(projectPath)).digest('hex');
  const file = path.win32.join(ctx.paths.featureDataDir('checks'), 'results', `${hash}.json`);
  return readJsonSafe<CheckRunResult[]>(file, []).data;
}

function saveStoredResults(
  ctx: MawFeatureContext,
  projectPath: string,
  results: CheckRunResult[]
): void {
  const hash = crypto.createHash('sha1').update(normProjectKey(projectPath)).digest('hex');
  const dir = path.win32.join(ctx.paths.featureDataDir('checks'), 'results');
  const file = path.win32.join(dir, `${hash}.json`);
  writeJsonAtomic(file, results);
}

function getLastSummary(ctx: MawFeatureContext): Record<string, { green: boolean; at: string }> {
  const file = path.win32.join(ctx.paths.featureDataDir('checks'), 'summary.json');
  return readJsonSafe<Record<string, { green: boolean; at: string }>>(file, {}).data;
}

function saveLastSummary(
  ctx: MawFeatureContext,
  projectPath: string,
  green: boolean,
  at: string
): void {
  const file = path.win32.join(ctx.paths.featureDataDir('checks'), 'summary.json');
  const summary = getLastSummary(ctx);
  const key = normProjectKey(projectPath);
  summary[key] = { green, at };

  // Limit to 20 most recent
  const keys = Object.keys(summary);
  if (keys.length > 20) {
    const sorted = keys.sort((a, b) => (summary[b]?.at || '').localeCompare(summary[a]?.at || ''));
    const trimmed: Record<string, { green: boolean; at: string }> = {};
    for (const k of sorted.slice(0, 20)) {
      trimmed[k] = summary[k]!;
    }
    writeJsonAtomic(file, trimmed);
    return;
  }
  writeJsonAtomic(file, summary);
}

// ============================================================================
// Feature Export
// ============================================================================

export const feature: MawFeature = {
  name: 'checks',
  ui: {
    script: 'feat-checks.js',
    style: 'feat-checks.css',
  },
  routes: {
    checks_config: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const rawPath = String(req.query.get('project_path') || '').trim();
        if (!rawPath) {
          throw new ApiValidationError('project_path is required.', 400);
        }
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const detected = detectChecks(projectPath);
        const shaInfo = getProjectChecksSha256(projectPath);

        if (!shaInfo) {
          return {
            ok: true,
            exists: false,
            config: detected,
            trusted: false,
            sha256: '',
            detected,
            warnings: [],
          };
        }

        let rawConfig: unknown = null;
        try {
          rawConfig = JSON.parse(shaInfo.content);
        } catch {
          // Unparseable JSON
        }

        const { config, warnings } = validateChecksConfig(rawConfig, projectPath);
        const trusted = isProjectChecksTrusted(ctx.paths, projectPath, shaInfo.sha256);

        return {
          ok: true,
          exists: true,
          config,
          trusted,
          sha256: shaInfo.sha256,
          detected,
          warnings,
        };
      },
    },

    checks_save: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const rawPath = String(body.project_path || '').trim();
        if (!rawPath) {
          throw new ApiValidationError('project_path is required.', 400);
        }
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const { config, errorField, errorMessage } = validateChecksConfig(body.config, projectPath);
        if (errorField) {
          throw new ApiValidationError(`${errorField}: ${errorMessage}`, 400);
        }

        const mawDir = path.win32.join(projectPath, '.maw');
        if (!fs.existsSync(mawDir)) {
          fs.mkdirSync(mawDir, { recursive: true });
        }

        const configFile = path.win32.join(mawDir, 'checks.json');
        writeJsonAtomic(configFile, config);

        const shaInfo = getProjectChecksSha256(projectPath);
        const sha256 = shaInfo ? shaInfo.sha256 : '';

        trustProjectChecks(ctx.paths, projectPath, sha256);
        appendChecksAudit(ctx, 'checks_save', { project_path: projectPath, sha256 });

        return {
          ok: true,
          config,
          sha256,
        };
      },
    },

    checks_trust: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const rawPath = String(body.project_path || '').trim();
        const sha256 = String(body.sha256 || '').trim().toLowerCase();
        if (!rawPath) {
          throw new ApiValidationError('project_path is required.', 400);
        }
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const currentInfo = getProjectChecksSha256(projectPath);
        if (!currentInfo) {
          throw new ApiValidationError('No .maw/checks.json found in project.', 404);
        }

        if (currentInfo.sha256.toLowerCase() !== sha256) {
          throw new ApiValidationError('sha256 does not match current .maw/checks.json.', 400);
        }

        trustProjectChecks(ctx.paths, projectPath, sha256);
        appendChecksAudit(ctx, 'checks_trust', { project_path: projectPath, sha256 });

        return { ok: true };
      },
    },

    checks_run: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const rawPath = String(body.project_path || '').trim();
        if (!rawPath) {
          throw new ApiValidationError('project_path is required.', 400);
        }
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const normKey = normProjectKey(projectPath);
        if (activeRuns.has(normKey)) {
          throw new ApiValidationError('Checks are already running for this project.', 409);
        }

        const shaInfo = getProjectChecksSha256(projectPath);
        if (!shaInfo) {
          throw new ApiValidationError('No .maw/checks.json configured for project.', 400);
        }

        const trusted = isProjectChecksTrusted(ctx.paths, projectPath, shaInfo.sha256);
        if (!trusted) {
          throw new ApiValidationError('Checks configuration is untrusted. Please trust it first.', 400);
        }

        let rawConfig: unknown = null;
        try {
          rawConfig = JSON.parse(shaInfo.content);
        } catch {
          throw new ApiValidationError('Malformed .maw/checks.json', 400);
        }

        const { config, errorField, errorMessage } = validateChecksConfig(rawConfig, projectPath);
        if (errorField) {
          throw new ApiValidationError(`${errorField}: ${errorMessage}`, 400);
        }

        const filterIds = Array.isArray(body.ids) ? body.ids.map(String) : undefined;
        const checksToRun = filterIds
          ? config.checks.filter((c) => filterIds.includes(c.id))
          : config.checks;

        const runId = 'run_' + crypto.randomBytes(6).toString('hex');
        const startedAt = new Date().toISOString();

        const runInfo: RunningProject = {
          runId,
          projectPath,
          startedAt,
          cancelled: false,
        };
        activeRuns.set(normKey, runInfo);

        // Background execution
        (async () => {
          const gitInfo = getGitInfo(projectPath);
          const dirtySig = computeDirtySignature(gitInfo.porcelainLines);
          const results: CheckRunResult[] = getStoredResults(ctx, projectPath);

          for (const check of checksToRun) {
            if (runInfo.cancelled) break;

            const runIdx = results.findIndex((r) => r.id === check.id);
            const runningEntry: CheckRunResult = {
              id: check.id,
              label: check.label || check.id,
              state: 'running',
              exit_code: 0,
              duration_ms: 0,
              output_tail: '',
              at: new Date().toISOString(),
              head: gitInfo.head,
              dirty_signature: dirtySig,
            };
            if (runIdx >= 0) results[runIdx] = runningEntry;
            else results.push(runningEntry);
            saveStoredResults(ctx, projectPath, results);

            const res = await runCheckProcess(check, projectPath, (child) => {
              runInfo.childProcess = child;
            });

            const finishedEntry: CheckRunResult = {
              id: check.id,
              label: check.label || check.id,
              state: res.state,
              exit_code: res.exit_code,
              duration_ms: res.duration_ms,
              output_tail: res.output_tail,
              at: new Date().toISOString(),
              head: gitInfo.head,
              dirty_signature: dirtySig,
            };

            const finalIdx = results.findIndex((r) => r.id === check.id);
            if (finalIdx >= 0) results[finalIdx] = finishedEntry;
            else results.push(finishedEntry);
            saveStoredResults(ctx, projectPath, results);
          }

          activeRuns.delete(normKey);

          // Recompute gate and update summary
          try {
            const gate = await computeGate(ctx.paths, projectPath, config, results);
            saveLastSummary(ctx, projectPath, gate.green, new Date().toISOString());
          } catch {
            // Ignore
          }
        })().catch(() => {
          activeRuns.delete(normKey);
        });

        return {
          ok: true,
          run_id: runId,
          started_at: startedAt,
        };
      },
    },

    checks_status: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const rawPath = String(req.query.get('project_path') || '').trim();
        if (!rawPath) {
          throw new ApiValidationError('project_path is required.', 400);
        }
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const normKey = normProjectKey(projectPath);
        const active = activeRuns.get(normKey);
        const running = Boolean(active);
        const runId = active ? active.runId : null;

        const gitInfo = getGitInfo(projectPath);
        const results = getStoredResults(ctx, projectPath);

        const shaInfo = getProjectChecksSha256(projectPath);
        let config = createDefaultChecksConfig();
        let isUntrusted = false;

        if (shaInfo) {
          const trusted = isProjectChecksTrusted(ctx.paths, projectPath, shaInfo.sha256);
          if (!trusted) {
            isUntrusted = true;
          }
          try {
            const parsed = JSON.parse(shaInfo.content);
            config = validateChecksConfig(parsed, projectPath).config;
          } catch {
            // Ignore
          }
        }

        const gate = await computeGate(ctx.paths, projectPath, config, results);
        if (isUntrusted) {
          gate.green = false;
          gate.items.unshift({
            id: 'trust',
            label: 'Config trust',
            state: 'untrusted',
            detail: `Configuration changed (sha ${shaInfo?.sha256.slice(0, 8)}). Review and trust before running.`,
            at: new Date().toISOString(),
          });
        }

        return {
          ok: true,
          project_path: projectPath,
          branch: gitInfo.branch,
          head: gitInfo.head,
          running,
          run_id: runId,
          gate,
          results,
        };
      },
    },

    checks_gate: {
      method: 'GET',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const rawPath = String(req.query.get('project_path') || '').trim();
        const overrideToken = String(req.query.get('override_token') || '').trim();
        if (!rawPath) {
          throw new ApiValidationError('project_path is required.', 400);
        }
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const results = getStoredResults(ctx, projectPath);
        const shaInfo = getProjectChecksSha256(projectPath);
        let config = createDefaultChecksConfig();
        let isUntrusted = false;

        if (shaInfo) {
          const trusted = isProjectChecksTrusted(ctx.paths, projectPath, shaInfo.sha256);
          if (!trusted) isUntrusted = true;
          try {
            const parsed = JSON.parse(shaInfo.content);
            config = validateChecksConfig(parsed, projectPath).config;
          } catch {
            // Ignore
          }
        }

        const gate = await computeGate(ctx.paths, projectPath, config, results);
        if (isUntrusted) {
          gate.green = false;
        }

        // Check override token
        if (overrideToken) {
          const overrides = getOverrides(ctx);
          const now = Date.now();
          const idx = overrides.findIndex(
            (o) =>
              o.token === overrideToken &&
              isPathInsideProject(projectPath, o.project_path) &&
              new Date(o.expires_at).getTime() > now
          );

          if (idx >= 0) {
            overrides.splice(idx, 1);
            saveOverrides(ctx, overrides);
            gate.green = true;
            gate.overridden = true;
          }
        }

        return {
          ok: true,
          green: gate.green,
          overridden: gate.overridden || false,
          items: gate.items,
        };
      },
    },

    checks_override: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const rawPath = String(body.project_path || '').trim();
        const reason = String(body.reason || '').trim();
        const scope = (String(body.scope || 'merge').trim().toLowerCase() as 'merge' | 'review');

        if (!rawPath) {
          throw new ApiValidationError('project_path is required.', 400);
        }
        if (!reason) {
          throw new ApiValidationError('reason is required.', 400);
        }
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const token = 'ovr_' + crypto.randomBytes(12).toString('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

        const overrides = getOverrides(ctx).filter((o) => new Date(o.expires_at).getTime() > Date.now());
        overrides.push({
          token,
          project_path: projectPath,
          reason,
          scope,
          expires_at: expiresAt,
        });
        saveOverrides(ctx, overrides);

        appendChecksAudit(ctx, 'checks_override', { project_path: projectPath, reason, scope, token });

        return {
          ok: true,
          token,
          expires_at: expiresAt,
        };
      },
    },

    checks_cancel: {
      method: 'POST',
      handler: async (ctx: MawFeatureContext, req: MawFeatureRequest) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const rawPath = String(body.project_path || '').trim();
        if (!rawPath) {
          throw new ApiValidationError('project_path is required.', 400);
        }
        const projectPath = resolveProjectPath(rawPath, ctx.paths.projectsRoot);
        if (!projectPath) {
          throw new ApiValidationError('Invalid project_path.', 400);
        }

        const normKey = normProjectKey(projectPath);
        const active = activeRuns.get(normKey);
        if (!active) {
          return { ok: true, message: 'No checks running.' };
        }

        active.cancelled = true;
        if (active.childProcess && active.childProcess.pid) {
          try {
            child_process.spawn('taskkill.exe', ['/PID', String(active.childProcess.pid), '/T', '/F'], {
              shell: false,
              windowsHide: true,
            });
          } catch {
            // Ignore
          }
        }

        activeRuns.delete(normKey);
        appendChecksAudit(ctx, 'checks_cancel', { project_path: projectPath, run_id: active.runId });

        return { ok: true };
      },
    },
  },
  status: async (ctx: MawFeatureContext) => {
    const running = Array.from(activeRuns.values()).map((r) => r.projectPath);
    const last = getLastSummary(ctx);
    return {
      running,
      last,
    };
  },
};
