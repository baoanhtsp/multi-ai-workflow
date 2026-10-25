import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { handleDispatch } from './actions/dispatch.ts';
import { handleGitInfo } from './actions/git.ts';
import { handleInitSpec } from './actions/initSpec.ts';
import { handleCancelJob, handleJobStatus, handleRunJob } from './actions/jobs.ts';
import { handleJobStream } from './actions/jobStream.ts';
import { handleSaveNotify, handleTestNotify } from './actions/notify.ts';
import { handleSpecGuard } from './actions/specGuard.ts';
import { handleStatus } from './actions/status.ts';
import {
  BUILTIN_GET_ACTIONS,
  BUILTIN_POST_ACTIONS,
  createFeatureContext,
  loadServerFeatures,
  type LoadedServerFeatures,
  type MawFeature,
  type MawFeatureRequest,
} from './lib/feature.ts';
import { isFileSafe, resolveServerPaths, type ServerPaths } from './lib/paths.ts';
import { ApiValidationError } from './lib/validate.ts';

const MAX_BODY_BYTES = 256 * 1024; // 256 KB (SPEC §3.0)

export const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const BASE_SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

export function sendJson(
  res: ServerResponse,
  payload: Record<string, unknown>,
  statusCode = 200
): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...BASE_SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('Payload Too Large: Request body exceeds 256 KB limit.');
    this.name = 'PayloadTooLargeError';
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ApiValidationError('Malformed JSON request body.', 400));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new ApiValidationError('Malformed JSON request body.', 400));
      }
    });

    req.on('error', (err) => {
      if (!aborted) {
        aborted = true;
        reject(err);
      }
    });
  });
}

function isAllowedHostHeader(rawHost: string | undefined, boundPort: number): boolean {
  if (!rawHost) return false;
  const trimmed = rawHost.trim().toLowerCase();
  return trimmed === `127.0.0.1:${boundPort}` || trimmed === `localhost:${boundPort}`;
}

function isLoopbackRemote(remoteAddr: string | undefined): boolean {
  if (!remoteAddr) return true;
  return (
    remoteAddr === '127.0.0.1' ||
    remoteAddr === '::1' ||
    remoteAddr === '::ffff:127.0.0.1'
  );
}

function validatePostSecurity(
  req: IncomingMessage,
  rawHost: string
): { ok: true } | { ok: false; statusCode: number; error: string } {
  // (1) Custom header X-MAW-Request: 1 required on every POST
  const mawHeader = String(req.headers['x-maw-request'] ?? '').trim();
  if (mawHeader !== '1') {
    return {
      ok: false,
      statusCode: 403,
      error: 'Forbidden: Missing or invalid X-MAW-Request header.',
    };
  }

  // (2) Media type (part before ';', trimmed, lower-cased) must be exactly 'application/json'
  const rawContentType = String(req.headers['content-type'] ?? '');
  const mediaType = (rawContentType.split(';', 2)[0] ?? '').trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return {
      ok: false,
      statusCode: 415,
      error: 'Unsupported Media Type: Content-Type must be application/json.',
    };
  }

  // (3) Origin, if present, must equal http://<Host header>; Origin: null is rejected
  if ('origin' in req.headers) {
    const rawOrigin = String(req.headers.origin ?? '').trim();
    if (rawOrigin.toLowerCase() === 'null' || rawOrigin === '') {
      return {
        ok: false,
        statusCode: 403,
        error: 'Forbidden: Origin null is not allowed.',
      };
    }
    const expectedOrigin = `http://${rawHost.trim().toLowerCase()}`;
    if (rawOrigin.toLowerCase() !== expectedOrigin) {
      return {
        ok: false,
        statusCode: 403,
        error: 'Forbidden: Cross-origin POST requests are not allowed.',
      };
    }
  }

  // (4) Sec-Fetch-Site, if present, must be 'same-origin' or 'none'
  if ('sec-fetch-site' in req.headers) {
    const secFetchSite = String(req.headers['sec-fetch-site'] ?? '')
      .trim()
      .toLowerCase();
    if (secFetchSite !== '' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      return {
        ok: false,
        statusCode: 403,
        error: 'Forbidden: Cross-site request blocked by Sec-Fetch-Site policy.',
      };
    }
  }

  return { ok: true };
}

const STATIC_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStaticFile(
  res: ServerResponse,
  filePath: string,
  contentType: string,
  extraHeaders?: Record<string, string>
): void {
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    ...BASE_SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': contentType,
    'Content-Length': buf.length,
  });
  res.end(buf);
}

export interface MawServerOptions {
  repoRoot?: string;
  projectsRoot?: string;
  userProfile?: string;
  mawHome?: string;
  tempDir?: string;
  jobsDir?: string;
  scriptsDir?: string;
  featuresDir?: string;
  extraFeatures?: MawFeature[];
}

export function createMawHttpServer(options?: MawServerOptions): {
  server: http.Server;
  getPaths: () => ServerPaths;
  loadedFeatures: LoadedServerFeatures;
} {
  const getPaths = (): ServerPaths => resolveServerPaths(options);
  const initialPaths = getPaths();
  const loadedFeatures = loadServerFeatures({
    repoRoot: initialPaths.repoRoot,
    featuresDir: options?.featuresDir,
    extraFeatures: options?.extraFeatures,
  });

  const server = http.createServer(async (req, res) => {
    try {
      // 1. Loopback client guard
      if (!isLoopbackRemote(req.socket?.remoteAddress)) {
        sendJson(res, { ok: false, error: 'Forbidden: Localhost access only.' }, 403);
        return;
      }

      // 2. Strict Host header guard: must be 127.0.0.1:<port> or localhost:<port> (SPEC §3.0)
      const addr = server.address() as AddressInfo | null;
      const boundPort = addr && typeof addr.port === 'number' ? addr.port : 4317;
      const rawHost = req.headers.host;
      if (!isAllowedHostHeader(rawHost, boundPort)) {
        sendJson(res, { ok: false, error: 'Forbidden: Untrusted Host header.' }, 403);
        return;
      }

      const method = (req.method ?? 'GET').toUpperCase();

      // 3. OPTIONS preflight -> 204 with no Access-Control-Allow-* headers
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          ...BASE_SECURITY_HEADERS,
          Allow: 'GET, POST, OPTIONS',
        });
        res.end();
        return;
      }

      // 4. POST security checks (X-MAW-Request, Content-Type, Origin, Sec-Fetch-Site)
      if (method === 'POST') {
        const postCheck = validatePostSecurity(req, rawHost!);
        if (!postCheck.ok) {
          sendJson(res, { ok: false, error: postCheck.error }, postCheck.statusCode);
          return;
        }
      }

      // 5. Inspect raw request path BEFORE URL normalization to block any '..' or backslash traversal
      const rawUrl = req.url ?? '/';
      const qIdx = rawUrl.indexOf('?');
      const rawPathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
      let decodedPathname = '';
      try {
        decodedPathname = decodeURIComponent(rawPathname);
      } catch {
        sendJson(res, { ok: false, error: 'Not Found' }, 404);
        return;
      }

      if (
        rawPathname.includes('..') ||
        decodedPathname.includes('..') ||
        decodedPathname.includes('\\') ||
        decodedPathname.includes('\0')
      ) {
        sendJson(res, { ok: false, error: 'Not Found' }, 404);
        return;
      }

      const url = new URL(rawUrl, `http://${rawHost}`);
      const paths = getPaths();
      const serverUrl = `http://127.0.0.1:${boundPort}`;

      // 6. API Endpoint: /api (or /dashboard/api)
      if (decodedPathname === '/api' || decodedPathname === '/dashboard/api') {
        const action = (url.searchParams.get('action') ?? 'status').trim();
        const featRoute = loadedFeatures.routes.get(action);

        if (
          !BUILTIN_GET_ACTIONS.has(action) &&
          !BUILTIN_POST_ACTIONS.has(action) &&
          !featRoute
        ) {
          sendJson(res, { ok: false, error: `Unsupported action: ${action}` }, 400);
          return;
        }

        if (featRoute) {
          const allowedMethods = featRoute.methods ?? [featRoute.method];
          if (!allowedMethods.includes(method as 'GET' | 'POST')) {
            sendJson(
              res,
              {
                ok: false,
                error: `Method Not Allowed: Use ${allowedMethods.join(' or ')} for ${action}.`,
              },
              405
            );
            return;
          }

          const body = method === 'POST' ? await readJsonBody(req) : {};
          const baseCtx = createFeatureContext(paths, undefined, {
            routes: loadedFeatures.routes,
            serverUrl,
          });
          const reqCtx: MawFeatureRequest = {
            ...baseCtx,
            url,
            query: url.searchParams,
            body,
            req,
            res,
            ctx: baseCtx,
          };
          const payload = await featRoute.handler(reqCtx, reqCtx);
          if (payload !== undefined && !res.headersSent && !res.writableEnded) {
            sendJson(res, payload, 200);
          }
          return;
        }

        if (BUILTIN_GET_ACTIONS.has(action) && method !== 'GET') {
          sendJson(
            res,
            { ok: false, error: `Method Not Allowed: Use GET for ${action}.` },
            405
          );
          return;
        }

        if (BUILTIN_POST_ACTIONS.has(action) && method !== 'POST') {
          sendJson(
            res,
            { ok: false, error: `Method Not Allowed: Use POST for ${action}.` },
            405
          );
          return;
        }

        if (action === 'status') {
          const payload = await handleStatus(paths, loadedFeatures.features, {
            routes: loadedFeatures.routes,
            serverUrl,
          });
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'git_info') {
          const payload = await handleGitInfo(url, paths);
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'job_status') {
          const payload = await handleJobStatus(url, paths);
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'job_stream') {
          await handleJobStream(req, res, url, paths);
          return;
        }

        // POST actions: read and validate JSON body (<= 256 KB)
        const body = await readJsonBody(req);

        if (action === 'spec_guard') {
          const payload = await handleSpecGuard(body, paths);
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'init_spec') {
          const payload = await handleInitSpec(body, paths);
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'dispatch') {
          const payload = await handleDispatch(body, paths);
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'run_job') {
          const payload = await handleRunJob(body, paths);
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'cancel_job') {
          const payload = await handleCancelJob(body, paths);
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'save_notify') {
          const payload = handleSaveNotify(body, paths);
          sendJson(res, payload, 200);
          return;
        }

        if (action === 'test_notify') {
          const payload = await handleTestNotify(paths);
          sendJson(res, payload, 200);
          return;
        }
      }

      // 7. Static routes (GET only)
      if (method !== 'GET') {
        sendJson(res, { ok: false, error: 'Not Found' }, 404);
        return;
      }

      if (
        decodedPathname === '/' ||
        decodedPathname === '/index.html' ||
        decodedPathname === '/dashboard' ||
        decodedPathname === '/dashboard/' ||
        decodedPathname === '/dashboard/index.html'
      ) {
        const indexHtml = path.win32.join(paths.dashboardDir, 'index.html');
        if (!isFileSafe(indexHtml)) {
          sendJson(res, { ok: false, error: 'dashboard/index.html not found.' }, 404);
          return;
        }
        serveStaticFile(res, indexHtml, 'text/html; charset=utf-8', {
          'Content-Security-Policy': DASHBOARD_CSP,
        });
        return;
      }

      const staticMatch = /^\/(?:dashboard\/)?([a-zA-Z0-9._-]+\.(css|js|svg|png|ico))$/.exec(
        decodedPathname
      );
      if (staticMatch) {
        const fileName = staticMatch[1]!;
        const ext = `.${staticMatch[2]!.toLowerCase()}`;
        const mimeType = STATIC_MIME_TYPES[ext];
        const candidatePath = path.win32.join(paths.dashboardDir, fileName);
        if (mimeType && isFileSafe(candidatePath)) {
          try {
            const realFile = fs.realpathSync(candidatePath);
            const realDash = fs.realpathSync(paths.dashboardDir);
            const normFile = realFile.replace(/\//g, '\\').toLowerCase();
            const normDash = realDash.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
            if (normFile.startsWith(normDash + '\\')) {
              serveStaticFile(res, realFile, mimeType);
              return;
            }
          } catch {
            // Fall through to 404
          }
        }
      }

      sendJson(res, { ok: false, error: 'Not Found' }, 404);
    } catch (err: unknown) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, { ok: false, error: err.message }, 413);
        return;
      }
      if (err instanceof ApiValidationError) {
        const payload: Record<string, unknown> = {
          ok: false,
          error: err.message,
        };
        const extra = err as unknown as Record<string, unknown>;
        for (const k of ['status', 'command', 'dispatched', 'output', 'raw']) {
          if (k in extra) {
            payload[k] = extra[k];
          }
        }
        sendJson(res, payload, err.statusCode);
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      sendJson(res, { ok: false, error: message }, 500);
    }
  });

  return { server, getPaths, loadedFeatures };
}
