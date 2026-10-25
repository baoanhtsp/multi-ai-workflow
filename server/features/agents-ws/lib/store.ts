import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from './mutex.ts';

export async function readJsonStore<T>(filePath: string, defaultValue: T): Promise<T> {
  return withFileLock(filePath, async () => {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch {
      return defaultValue;
    }
    if (!raw) {
      return defaultValue;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err: unknown) {
      // Item 3: Corrupt store must not be silently replaced:
      // move to <file>.corrupt-<timestamp>, append audit line, start from default
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptPath = `${filePath}.corrupt-${ts}`;
      try {
        fs.renameSync(filePath, corruptPath);
      } catch {
        try {
          fs.copyFileSync(filePath, corruptPath);
          fs.unlinkSync(filePath);
        } catch {}
      }

      const featureDir = path.dirname(filePath);
      try {
        await appendAuditLog(featureDir, {
          action: 'store_corrupt',
          target: path.basename(filePath),
          detail: {
            error: err instanceof Error ? err.message : String(err),
            backup: corruptPath,
          },
        });
      } catch {}

      return defaultValue;
    }
  });
}

export async function writeJsonStore<T>(filePath: string, data: T): Promise<void> {
  return withFileLock(filePath, async () => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempFile = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(tempFile, content, 'utf8');

    let renamed = false;
    let attempts = 0;
    // Item 5: Never copy onto live file. Retry rename with backoff up to ~1s, then throw.
    const maxAttempts = 10;
    let lastError: unknown = null;

    while (!renamed && attempts < maxAttempts) {
      try {
        fs.renameSync(tempFile, filePath);
        renamed = true;
      } catch (err: unknown) {
        lastError = err;
        attempts++;
        if (attempts < maxAttempts) {
          const delayMs = Math.min(20 * attempts, 150);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    if (!renamed) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch {}
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
  });
}

export interface AuditLogEntry {
  ts?: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export async function appendAuditLog(
  featureDir: string,
  entry: AuditLogEntry
): Promise<void> {
  const auditFile = path.win32.join(featureDir, 'audit.jsonl');
  return withFileLock(auditFile, async () => {
    if (!fs.existsSync(featureDir)) {
      fs.mkdirSync(featureDir, { recursive: true });
    }
    const record = {
      ts: entry.ts ?? new Date().toISOString(),
      feature: path.basename(featureDir),
      action: entry.action,
      target: entry.target,
      detail: entry.detail ?? {},
    };
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(auditFile, line, 'utf8');
    try {
      const parentDir = path.dirname(featureDir);
      const parentName = path.basename(parentDir).toLowerCase();
      if (parentName === 'features' || parentName === 'data') {
        const sharedAudit = path.win32.join(path.dirname(parentDir), 'audit.jsonl');
        fs.appendFileSync(sharedAudit, line, 'utf8');
      }
    } catch {
      // Ignore shared audit write error
    }
  });
}
