import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getRecentJobs, handleRunJob } from '../actions/jobs.ts';
import { isDirectorySafe, isFileSafe, type ServerPaths } from './paths.ts';
import { loadAgentRegistry, type LoadedRegistry } from './registry.ts';

export interface MawFeatureUi {
  script: string;
  style?: string;
}

export interface MawFeatureContext {
  paths: ServerPaths;
  registry: LoadedRegistry;
  readJobs: () => Promise<Array<Record<string, unknown>>>;
  startJob: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
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
  method: 'GET' | 'POST';
  handler: MawFeatureRouteHandler;
}

export interface MawFeature {
  name: string;
  routes: Record<string, MawFeatureRoute>;
  status?: (
    ctx: MawFeatureContext
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  ui?: MawFeatureUi;
}

export interface RegisteredFeatureRoute {
  featureName: string;
  action: string;
  method: 'GET' | 'POST';
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

export function createFeatureContext(
  paths: ServerPaths,
  registry?: LoadedRegistry
): MawFeatureContext {
  const loadedReg = registry ?? loadAgentRegistry(paths);
  return {
    paths,
    registry: loadedReg,
    readJobs: () => getRecentJobs(paths.jobsDir),
    startJob: (body: Record<string, unknown>) => handleRunJob(body, paths),
  };
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
    const method = String(rawRoute.method ?? '').trim().toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(
        `Invalid HTTP method '${String(rawRoute.method)}' for action '${actionName}' in feature '${name}' (expected 'GET' or 'POST').`
      );
    }
    if (typeof rawRoute.handler !== 'function') {
      throw new Error(
        `Invalid handler for action '${actionName}' in feature '${name}' (expected function).`
      );
    }
    validatedRoutes[actionName] = {
      method: method as 'GET' | 'POST',
      handler: rawRoute.handler as MawFeatureRouteHandler,
    };
  }

  if (raw.status !== undefined && typeof raw.status !== 'function') {
    throw new Error(
      `Invalid 'status' property in feature '${name}' (${sourceLabel}): expected function.`
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
      routes.set(action, {
        featureName: feat.name,
        action,
        method: route.method,
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
