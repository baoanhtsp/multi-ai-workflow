import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { handleGitInfo } from '../actions/git.ts';
import { getRecentJobs, handleCancelJob, handleJobStatus, handleRunJob } from '../actions/jobs.ts';
import { handleSpecGuard } from '../actions/specGuard.ts';
import { isDirectorySafe, isFileSafe, type ServerPaths } from './paths.ts';
import { loadAgentRegistry, type LoadedRegistry } from './registry.ts';
import { ApiValidationError } from './validate.ts';

export interface MawFeatureUi {
  script: string;
  style?: string;
}

export interface CallActionOptions {
  query?: Record<string, unknown> | URLSearchParams;
  body?: Record<string, unknown>;
}

export interface MawFeatureContext {
  paths: ServerPaths;
  registry: LoadedRegistry;
  serverUrl?: string;
  readJobs: (options?: { limit?: number }) => Promise<Array<Record<string, unknown>>>;
  startJob: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cancelJob?: (jobId: string) => Promise<Record<string, unknown>>;
  callAction?: (
    action: string,
    options?: CallActionOptions
  ) => Promise<Record<string, unknown>>;
  appendActionAudit?: (entry: Record<string, unknown>) => Promise<void> | void;
  url?: URL;
  query?: URLSearchParams;
  body?: Record<string, unknown>;
  req?: IncomingMessage;
  res?: ServerResponse;
}

export interface MawFeatureRequest extends MawFeatureContext {
  url: URL;
  query: URLSearchParams;
  body: Record<string, unknown>;
  req: IncomingMessage;
  res: ServerResponse;
  ctx: MawFeatureContext;
}

export type MawFeatureRouteHandler = (
  ctx: MawFeatureContext & MawFeatureRequest,
  req: MawFeatureRequest
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface MawFeatureRoute {
  method?: 'GET' | 'POST';
  methods?: Array<'GET' | 'POST'>;
  handler: MawFeatureRouteHandler;
}

export interface MawFeature {
  name: string;
  routes: Record<string, MawFeatureRoute>;
  status?: (
    ctx: MawFeatureContext
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  start?: (ctx: MawFeatureContext) => Promise<void> | void;
  stop?: (ctx?: MawFeatureContext) => Promise<void> | void;
  ui?: MawFeatureUi;
}

export interface RegisteredFeatureRoute {
  featureName: string;
  action: string;
  method: 'GET' | 'POST';
  methods: Array<'GET' | 'POST'>;
  handler: MawFeatureRouteHandler;
}

export interface LoadedServerFeatures {
  features: MawFeature[];
  routes: Map<string, RegisteredFeatureRoute>;
}

export const BUILTIN_GET_ACTIONS = new Set<string>([
  'status',
  'git_info',
  'job_status',
  'job_stream',
]);

export const BUILTIN_POST_ACTIONS = new Set<string>([
  'spec_guard',
  'init_spec',
  'dispatch',
  'run_job',
  'cancel_job',
  'save_notify',
  'test_notify',
]);

const FEATURE_NAME_REGEX = /^[a-z][a-z0-9-]{1,31}$/;
const ACTION_NAME_REGEX = /^[a-z][a-z0-9_-]{1,63}$/;
const UI_SCRIPT_REGEX = /^feat-[a-z0-9-]+\.js$/;
const UI_STYLE_REGEX = /^feat-[a-z0-9-]+\.css$/;

const requireModule = createRequire(import.meta.url);

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function appendJsonLineSafe(filePath: string, payload: Record<string, unknown>): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    // Best-effort audit write
  }
}

export function appendActionAudit(
  paths: ServerPaths,
  entry: Record<string, unknown>
): void {
  const nowIso = new Date().toISOString();
  const normalized: Record<string, unknown> = {
    ts: entry.ts ?? entry.timestamp ?? entry.Timestamp ?? nowIso,
    timestamp: entry.timestamp ?? entry.ts ?? entry.Timestamp ?? nowIso,
    ...entry,
  };

  // 1. Shared action audit file in $MAW_HOME/audit.jsonl
  const sharedActionAuditFile = path.win32.join(paths.mawHome, 'audit.jsonl');
  appendJsonLineSafe(sharedActionAuditFile, normalized);

  // 2. If entry specifies a feature name, also mirror to featureDataDir(feature)/audit.jsonl
  const featName = typeof entry.feature === 'string' ? entry.feature.trim() : '';
  if (featName && FEATURE_NAME_REGEX.test(featName)) {
    const featAuditFile = path.win32.join(paths.featureDataDir(featName), 'audit.jsonl');
    appendJsonLineSafe(featAuditFile, normalized);
  }
}

const cachedRoutesByRepo = new Map<string, Map<string, RegisteredFeatureRoute>>();

function getDefaultRoutesForRepo(repoRoot: string): Map<string, RegisteredFeatureRoute> {
  const key = repoRoot.toLowerCase();
  let cached = cachedRoutesByRepo.get(key);
  if (!cached) {
    cached = loadServerFeatures({ repoRoot }).routes;
    cachedRoutesByRepo.set(key, cached);
  }
  return cached;
}

export function createFeatureContext(
  paths: ServerPaths,
  registry?: LoadedRegistry,
  options?: {
    routes?: Map<string, RegisteredFeatureRoute>;
    serverUrl?: string;
  }
): MawFeatureContext {
  const loadedReg = registry ?? loadAgentRegistry(paths);
  const serverUrl = options?.serverUrl ?? `http://127.0.0.1:${process.env.MAW_PORT || '4317'}`;

  const ctx: MawFeatureContext = {
    paths,
    registry: loadedReg,
    serverUrl,
    readJobs: (opts?: { limit?: number }) => getRecentJobs(paths.jobsDir, opts?.limit ?? 15),
    startJob: (body: Record<string, unknown>) => handleRunJob(body, paths),
    cancelJob: (jobId: string) => handleCancelJob({ job_id: jobId }, paths),
    appendActionAudit: (entry: Record<string, unknown>) => appendActionAudit(paths, entry),
    callAction: async (action: string, callOpts?: CallActionOptions) => {
      const trimmedAction = String(action ?? '').trim();
      const routes = options?.routes ?? getDefaultRoutesForRepo(paths.repoRoot);
      const url = new URL(`${serverUrl}/api`);
      url.searchParams.set('action', trimmedAction);

      if (callOpts?.query) {
        if (callOpts.query instanceof URLSearchParams) {
          for (const [k, v] of callOpts.query.entries()) {
            url.searchParams.set(k, v);
          }
        } else if (typeof callOpts.query === 'object') {
          for (const [k, v] of Object.entries(callOpts.query)) {
            if (v !== undefined && v !== null) {
              url.searchParams.set(k, String(v));
            }
          }
        }
      }

      const bodyObj: Record<string, unknown> =
        callOpts?.body && isPlainObject(callOpts.body) ? callOpts.body : {};

      const featRoute = routes.get(trimmedAction);
      if (featRoute) {
        const subReq: MawFeatureRequest = {
          ...ctx,
          url,
          query: url.searchParams,
          body: bodyObj,
          req: {} as IncomingMessage,
          res: {} as ServerResponse,
          ctx,
        };
        const res = await featRoute.handler(subReq, subReq);
        return (res ?? { ok: true }) as Record<string, unknown>;
      }

      if (trimmedAction === 'spec_guard') {
        return await handleSpecGuard(bodyObj, paths);
      }
      if (trimmedAction === 'git_info') {
        return await handleGitInfo(url, paths);
      }
      if (trimmedAction === 'job_status') {
        return await handleJobStatus(url, paths);
      }
      if (trimmedAction === 'run_job') {
        return await handleRunJob(bodyObj, paths);
      }
      if (trimmedAction === 'cancel_job') {
        return await handleCancelJob(bodyObj, paths);
      }

      throw new ApiValidationError(`Unsupported action: ${trimmedAction}`, 400);
    },
  };

  return ctx;
}

export async function startServerFeatures(
  features: readonly MawFeature[],
  ctx: MawFeatureContext
): Promise<void> {
  for (const feat of features) {
    if (typeof feat.start === 'function') {
      await feat.start(ctx);
    }
  }
}

export async function stopServerFeatures(features: readonly MawFeature[]): Promise<void> {
  for (const feat of features) {
    if (typeof feat.stop === 'function') {
      try {
        await feat.stop();
      } catch {
        // Ignore stop errors during shutdown
      }
    }
  }
}

export function validateFeatureDefinition(
  raw: unknown,
  sourceLabel: string
): MawFeature {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid feature in ${sourceLabel}: export must be an object.`);
  }

  const name = String(raw.name ?? '').trim();
  if (!FEATURE_NAME_REGEX.test(name)) {
    throw new Error(
      `Invalid feature name '${name}' in ${sourceLabel} (must match ^[a-z][a-z0-9-]{1,31}$).`
    );
  }

  if (!isPlainObject(raw.routes)) {
    throw new Error(
      `Invalid feature '${name}' in ${sourceLabel}: 'routes' must be an object.`
    );
  }

  const validatedRoutes: Record<string, MawFeatureRoute> = {};
  for (const [actionName, rawRoute] of Object.entries(raw.routes)) {
    if (!ACTION_NAME_REGEX.test(actionName)) {
      throw new Error(
        `Invalid route action name '${actionName}' in feature '${name}' (${sourceLabel}).`
      );
    }
    if (!isPlainObject(rawRoute)) {
      throw new Error(
        `Invalid route definition for action '${actionName}' in feature '${name}' (${sourceLabel}).`
      );
    }
    let methods: Array<'GET' | 'POST'> = [];
    if (Array.isArray(rawRoute.methods) && rawRoute.methods.length > 0) {
      for (const m of rawRoute.methods) {
        const up = String(m ?? '').trim().toUpperCase();
        if (up !== 'GET' && up !== 'POST') {
          throw new Error(
            `Invalid HTTP method '${String(m)}' in methods[] for action '${actionName}' in feature '${name}' (expected 'GET' or 'POST').`
          );
        }
        if (!methods.includes(up as 'GET' | 'POST')) {
          methods.push(up as 'GET' | 'POST');
        }
      }
    } else {
      const method = String(rawRoute.method ?? '').trim().toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        throw new Error(
          `Invalid HTTP method '${String(rawRoute.method)}' for action '${actionName}' in feature '${name}' (expected 'GET' or 'POST').`
        );
      }
      methods = [method as 'GET' | 'POST'];
    }
    if (typeof rawRoute.handler !== 'function') {
      throw new Error(
        `Invalid handler for action '${actionName}' in feature '${name}' (expected function).`
      );
    }
    validatedRoutes[actionName] = {
      method: methods[0]!,
      methods,
      handler: rawRoute.handler as MawFeatureRouteHandler,
    };
  }

  if (raw.status !== undefined && typeof raw.status !== 'function') {
    throw new Error(
      `Invalid 'status' property in feature '${name}' (${sourceLabel}): expected function.`
    );
  }
  if (raw.start !== undefined && typeof raw.start !== 'function') {
    throw new Error(
      `Invalid 'start' property in feature '${name}' (${sourceLabel}): expected function.`
    );
  }
  if (raw.stop !== undefined && typeof raw.stop !== 'function') {
    throw new Error(
      `Invalid 'stop' property in feature '${name}' (${sourceLabel}): expected function.`
    );
  }

  let validatedUi: MawFeatureUi | undefined;
  if (raw.ui !== undefined && raw.ui !== null) {
    if (!isPlainObject(raw.ui)) {
      throw new Error(
        `Invalid 'ui' property in feature '${name}' (${sourceLabel}): expected object.`
      );
    }
    const script = String(raw.ui.script ?? '').trim();
    if (!UI_SCRIPT_REGEX.test(script)) {
      throw new Error(
        `Invalid ui.script '${script}' in feature '${name}' (must match ^feat-[a-z0-9-]+\\.js$).`
      );
    }
    let style: string | undefined;
    if (raw.ui.style !== undefined && raw.ui.style !== null && String(raw.ui.style).trim() !== '') {
      style = String(raw.ui.style).trim();
      if (!UI_STYLE_REGEX.test(style)) {
        throw new Error(
          `Invalid ui.style '${style}' in feature '${name}' (must match ^feat-[a-z0-9-]+\\.css$).`
        );
      }
    }
    validatedUi = style ? { script, style } : { script };
  }

  return {
    name,
    routes: validatedRoutes,
    status: raw.status as MawFeature['status'],
    start: raw.start as MawFeature['start'],
    stop: raw.stop as MawFeature['stop'],
    ui: validatedUi,
  };
}

export function loadServerFeatures(options: {
  repoRoot: string;
  featuresDir?: string;
  extraFeatures?: MawFeature[];
}): LoadedServerFeatures {
  const dirsToScan: string[] = [];
  const defaultDir = path.win32.join(options.repoRoot, 'server', 'features');
  if (options.featuresDir) {
    dirsToScan.push(options.featuresDir);
  } else {
    dirsToScan.push(defaultDir);
    const envDir = (process.env.MAW_FEATURES_DIR ?? '').trim();
    if (envDir && envDir.toLowerCase() !== defaultDir.toLowerCase()) {
      dirsToScan.push(envDir);
    }
  }

  const rawFeatures: Array<{ def: unknown; source: string }> = [];

  for (const baseDir of dirsToScan) {
    if (!isDirectorySafe(baseDir)) {
      continue;
    }
    const entries = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const subDir = path.win32.join(baseDir, entry.name);
      const indexTs = path.win32.join(subDir, 'index.ts');
      const indexJs = path.win32.join(subDir, 'index.js');
      const targetFile = isFileSafe(indexTs)
        ? indexTs
        : isFileSafe(indexJs)
          ? indexJs
          : '';
      if (!targetFile) {
        continue;
      }
      const mod = requireModule(targetFile) as Record<string, unknown>;
      const exportedFeature = mod?.feature ?? mod?.default;
      rawFeatures.push({
        def: exportedFeature,
        source: targetFile,
      });
    }
  }

  if (options.extraFeatures) {
    for (let i = 0; i < options.extraFeatures.length; i++) {
      rawFeatures.push({
        def: options.extraFeatures[i],
        source: `extraFeatures[${i}]`,
      });
    }
  }

  const features: MawFeature[] = [];
  const seenFeatureNames = new Set<string>();
  const routes = new Map<string, RegisteredFeatureRoute>();

  for (const item of rawFeatures) {
    const feat = validateFeatureDefinition(item.def, item.source);
    if (seenFeatureNames.has(feat.name)) {
      throw new Error(
        `Duplicate feature name '${feat.name}' loaded from ${item.source}.`
      );
    }
    seenFeatureNames.add(feat.name);

    for (const [action, route] of Object.entries(feat.routes)) {
      if (BUILTIN_GET_ACTIONS.has(action) || BUILTIN_POST_ACTIONS.has(action)) {
        throw new Error(
          `Duplicate action '${action}' in feature '${feat.name}': collides with built-in server action.`
        );
      }
      const existing = routes.get(action);
      if (existing) {
        throw new Error(
          `Duplicate action '${action}' in feature '${feat.name}': already registered by feature '${existing.featureName}'.`
        );
      }
      const routeMethod = route.method ?? (route.methods && route.methods[0]) ?? 'GET';
      const routeMethods = route.methods ?? [routeMethod];
      routes.set(action, {
        featureName: feat.name,
        action,
        method: routeMethod,
        methods: routeMethods,
        handler: route.handler,
      });
    }

    features.push(feat);
  }

  features.sort((a, b) => a.name.localeCompare(b.name));

  return {
    features,
    routes,
  };
}
