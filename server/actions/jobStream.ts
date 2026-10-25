import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { isFileSafe, type ServerPaths } from '../lib/paths.ts';
import { ApiValidationError } from '../lib/validate.ts';
import {
  readSafeLogSlice,
  redactJobLogChunk,
  refreshJobMetaStatus,
  type JobMeta,
} from './jobs.ts';

const TERMINAL_STATUSES = new Set(['DONE', 'FAILED', 'CANCELLED']);
const LOG_POLL_INTERVAL_MS = 500; // SPEC §3.11 & M3: read log every 500 ms
const PID_CHECK_EVERY_TICKS = 4; // M3: check PID liveness every 4 * 500 ms = 2 s

function writeSseEvent(res: ServerResponse, event: string, data: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function handleJobStream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  paths: ServerPaths
): Promise<void> {
  const rawJobId = String(url.searchParams.get('job_id') ?? '');
  const jobId = rawJobId.replace(/[^a-zA-Z0-9_]/g, '');
  let currentOffset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset') ?? 0) || 0));

  if (jobId === '' || !jobId.startsWith('job_')) {
    throw new ApiValidationError('Invalid job_id.', 400);
  }

  const metaFile = path.win32.join(paths.jobsDir, `${jobId}.json`);
  const logFile = path.win32.join(paths.jobsDir, `${jobId}.log`);
  if (!isFileSafe(metaFile)) {
    throw new ApiValidationError(`Job not found: ${jobId}`, 404);
  }

  let initialMeta: JobMeta;
  try {
    initialMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
  } catch {
    throw new ApiValidationError(`Job not found: ${jobId}`, 404);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    Connection: 'keep-alive',
  });

  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let tickBusy = false;
  let tickCount = 0;
  let lastStatus = '';

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  const flushLogChunks = (): void => {
    while (!closed) {
      const { chunk, nextOffset } = readSafeLogSlice(logFile, currentOffset, 131072);
      if (nextOffset <= currentOffset) {
        break;
      }
      currentOffset = nextOffset;
      if (chunk.length > 0) {
        writeSseEvent(res, 'log', {
          chunk: redactJobLogChunk(chunk, paths),
          next_offset: currentOffset,
        });
      }
    }
  };

  const computeElapsed = (meta: JobMeta): number => {
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.max(0, nowSec - Math.trunc(Number(meta.started_ts ?? nowSec) || nowSec));
  };

  // Initial flush on connect (checks both marker and PID)
  initialMeta = await refreshJobMetaStatus(initialMeta, paths.jobsDir, { checkPid: true });
  if (closed) return;

  flushLogChunks();
  lastStatus = String(initialMeta.status ?? 'RUNNING');
  writeSseEvent(res, 'status', {
    status: lastStatus,
    exit_code: initialMeta.exit_code ?? null,
    elapsed_sec: computeElapsed(initialMeta),
  });

  if (TERMINAL_STATUSES.has(lastStatus)) {
    cleanup();
    res.end();
    return;
  }

  pollTimer = setInterval(() => {
    if (closed || tickBusy) return;
    tickBusy = true;
    tickCount++;
    const shouldCheckPid = tickCount % PID_CHECK_EVERY_TICKS === 0;
    void (async () => {
      try {
        flushLogChunks();
        if (!isFileSafe(metaFile)) {
          cleanup();
          res.end();
          return;
        }
        let meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as JobMeta;
        meta = await refreshJobMetaStatus(meta, paths.jobsDir, { checkPid: shouldCheckPid });
        if (closed) return;

        const curStatus = String(meta.status ?? 'RUNNING');
        if (TERMINAL_STATUSES.has(curStatus)) {
          flushLogChunks();
          writeSseEvent(res, 'status', {
            status: curStatus,
            exit_code: meta.exit_code ?? null,
            elapsed_sec: computeElapsed(meta),
          });
          cleanup();
          res.end();
          return;
        }

        if (curStatus !== lastStatus) {
          lastStatus = curStatus;
          writeSseEvent(res, 'status', {
            status: curStatus,
            exit_code: meta.exit_code ?? null,
            elapsed_sec: computeElapsed(meta),
          });
        }
      } catch {
        // Ignore transient read errors while job is running
      } finally {
        tickBusy = false;
      }
    })();
  }, LOG_POLL_INTERVAL_MS);

  pingTimer = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) return;
    res.write(': ping\n\n');
  }, 15000);
}
