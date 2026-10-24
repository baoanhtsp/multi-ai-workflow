import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendAuditEntry } from '../../lib/audit.ts';
import { ApiValidationError } from '../../lib/validate.ts';

export { ApiValidationError };

export function stripAnsi(str: string): string {
  // Matches ANSI escape codes, OSC sequences, CSI sequences
  return str.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g,
    ''
  );
}

export function stripRunnerNoise(text: string): string {
  const cleanAnsi = stripAnsi(text);
  const lines = cleanAnsi.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (/^===\s*\[MISSION CONTROL JOB.*\]\s*===/i.test(trimmed)) return false;
    if (/^===\s*\[JOB_FINISHED.*\]\s*===/i.test(trimmed)) return false;
    if (/^===\s*\[JOB_CANCELLED.*\]\s*===/i.test(trimmed)) return false;
    if (/^-{5,}\s*$/.test(trimmed)) return false;
    if (
      /^(?:Mode|Agent|Role|Model|Effort|Project|Prompt|Command|Started|PID|WorkDir):\s/i.test(
        trimmed
      )
    ) {
      return false;
    }
    return true;
  });
  return filtered.join('\n').trim();
}

export function newId(prefix: string): string {
  const now = new Date();
  const yyyy = String(now.getFullYear()).padStart(4, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const hex = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${yyyy}${mm}${dd}${hh}${min}${ss}_${hex}`;
}

export function badRequest(msg: string): ApiValidationError {
  return new ApiValidationError(msg, 400);
}

export function notFound(msg: string): ApiValidationError {
  return new ApiValidationError(msg, 404);
}

export function conflict(msg: string): ApiValidationError {
  return new ApiValidationError(msg, 409);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw === '') {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    try {
      const baseName = path.basename(file).toLowerCase();
      const isCritical = [
        'tasks.json',
        'runs.json',
        'schedules.json',
        'pr_requests.json',
      ].includes(baseName);
      if (isCritical && fs.existsSync(file)) {
        const corruptName = `${file}.corrupt-${Date.now()}`;
        console.error(
          `[maw-board] JSON parse error in ${file}, backing up to ${corruptName}:`,
          err
        );
        fs.renameSync(file, corruptName);
      }
    } catch {
      // ignore backup error
    }
    return fallback;
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpFile, content, 'utf8');

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmpFile, file);
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if ((code === 'EPERM' || code === 'EBUSY') && attempt < 4) {
        const end = Date.now() + 15 * (attempt + 1);
        while (Date.now() < end) {
          // busy wait short backoff
        }
        continue;
      }
      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch {
        // ignore cleanup error
      }
      throw err;
    }
  }
}

class FileMutex {
  private locks = new Map<string, Promise<unknown>>();

  async runExclusive<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
    const key = path.resolve(file).toLowerCase();
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(
      () => next,
      () => next
    );
    this.locks.set(key, chained);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) {
        this.locks.delete(key);
      }
    }
  }
}

export const fileMutex = new FileMutex();

export function appendAudit(
  auditFile: string,
  action: string,
  details?: Record<string, unknown>
): void {
  appendAuditEntry(auditFile, {
    Timestamp: new Date().toISOString(),
    Tool: 'maw-board',
    Action: action,
    ...(details ?? {}),
  });
}
