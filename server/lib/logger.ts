import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestContext } from './paths.ts';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_KEEP_FILES = 3;

export function rotateLogFile(
  filePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP_FILES
): void {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const st = fs.statSync(filePath);
    if (st.size < maxBytes) {
      return;
    }

    const oldest = `${filePath}.${keep}`;
    if (fs.existsSync(oldest)) {
      try {
        fs.unlinkSync(oldest);
      } catch {
        // Ignore unlink errors
      }
    }

    for (let i = keep - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        try {
          if (fs.existsSync(dst)) {
            fs.unlinkSync(dst);
          }
          fs.renameSync(src, dst);
        } catch {
          // Ignore rotation rename error
        }
      }
    }

    try {
      const firstRotated = `${filePath}.1`;
      if (fs.existsSync(firstRotated)) {
        fs.unlinkSync(firstRotated);
      }
      fs.renameSync(filePath, firstRotated);
    } catch {
      // Ignore rename error
    }
  } catch {
    // Never throw from log rotation
  }
}

export function formatErrorWithStack(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function resolveSafeLogDir(mawHomeOverride?: string): string | null {
  const realHome = path.win32.resolve(os.homedir()).toLowerCase().replace(/\\+$/, '');
  const realMawHome = path.win32.join(realHome, '.maw').toLowerCase();

  const rawMawHome =
    mawHomeOverride?.trim() ||
    process.env.MAW_HOME?.trim() ||
    path.win32.join(process.env.USERPROFILE?.trim() || os.homedir(), '.maw');
  const resolvedMawHome = path.win32.resolve(rawMawHome);

  if (isTestContext() && resolvedMawHome.toLowerCase().replace(/\\+$/, '') === realMawHome) {
    return null;
  }

  return path.win32.join(resolvedMawHome, 'logs');
}

export function appendServerLog(
  level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL',
  message: string,
  err?: unknown,
  mawHomeOverride?: string
): void {
  const ts = new Date().toISOString();
  const errDetail = err !== undefined ? `\n${formatErrorWithStack(err)}` : '';
  const line = `[${ts}] [${level}] (pid=${process.pid}) ${message}${errDetail}\n`;

  if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
    try {
      process.stderr.write(line);
    } catch {
      // Ignore stderr write errors
    }
  }

  const logDir = resolveSafeLogDir(mawHomeOverride);
  if (!logDir) {
    return;
  }

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.win32.join(logDir, 'server.log');
    rotateLogFile(logFile, DEFAULT_MAX_BYTES, DEFAULT_KEEP_FILES);
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    // Ignore file logging errors
  }
}

export function logServerError(
  source: string,
  err: unknown,
  mawHomeOverride?: string
): void {
  appendServerLog('ERROR', `[${source}] Unhandled error`, err, mawHomeOverride);
}
