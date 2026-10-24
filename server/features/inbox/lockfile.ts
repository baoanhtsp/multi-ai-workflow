import fs from 'node:fs';
import path from 'node:path';
import { isProcessRunning } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';

export interface FileLockHandle {
  lockPath: string;
  pid: number;
  ts: number;
  keep: () => void;
  release: () => void;
}

export interface RecoverMutexHandle {
  recoverPath: string;
  pid: number;
  ts: number;
  release: () => void;
}

/**
 * Acquire the .recover mutex (Codex Review #7 Item 4).
 * Mutex writes { pid, ts } and may be taken over ONLY when that pid is dead
 * (or the file is corrupt and > 5 s old). Released only if content is still ours.
 */
export function acquireRecoverMutex(
  recoverPath: string,
  timeoutMs = 10_000
): RecoverMutexHandle | null {
  const myPid = process.pid;
  const myTs = Date.now();
  const start = Date.now();
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);

  while (true) {
    let recFd: number | null = null;
    try {
      recFd = fs.openSync(recoverPath, 'wx');
      const recData = JSON.stringify({ pid: myPid, ts: myTs }) + '\n';
      fs.writeFileSync(recFd, recData, 'utf8');
      fs.closeSync(recFd);
      recFd = null;
      return {
        recoverPath,
        pid: myPid,
        ts: myTs,
        release: () => {
          try {
            const curRaw = fs.readFileSync(recoverPath, 'utf8');
            const cur = JSON.parse(curRaw);
            if (Number(cur?.pid) === myPid && Number(cur?.ts) === myTs) {
              fs.unlinkSync(recoverPath);
            }
          } catch {}
        },
      };
    } catch (recErr: any) {
      if (recFd !== null) {
        try { fs.closeSync(recFd); } catch {}
        recFd = null;
      }
      if (recErr?.code === 'EEXIST') {
        let recStale = false;
        try {
          const recContent = fs.readFileSync(recoverPath, 'utf8');
          const recParsed = JSON.parse(recContent);
          const recOwnerPid = Number(recParsed?.pid);
          if (recOwnerPid > 0) {
            if (!isProcessRunning(recOwnerPid)) {
              recStale = true;
            }
          } else {
            const recStat = fs.statSync(recoverPath);
            if (Date.now() - recStat.mtimeMs > 5_000) {
              recStale = true;
            }
          }
        } catch {
          try {
            const recStat = fs.statSync(recoverPath);
            if (Date.now() - recStat.mtimeMs > 5_000) {
              recStale = true;
            }
          } catch {}
        }

        if (recStale) {
          try { fs.unlinkSync(recoverPath); } catch {}
          continue;
        }

        if (Date.now() - start >= timeoutMs) {
          return null;
        }
        Atomics.wait(int32, 0, 0, 25);
        continue;
      }
      throw recErr;
    }
  }
}

export interface AcquireLockOptions {
  timeoutMs?: number; // 0 for immediate/claims; >0 for items.lock (e.g. 2000ms)
  stepMs?: number; // default 25ms
  initialData?: Record<string, unknown>;
  onRecoverDeadOwner?: (deadContent: string, deadData: any) => void;
}

/**
 * Acquire a file lock with recovery mutex (Codex Review #6 Item 1).
 *
 * 1. Try fs.openSync(lockPath, 'wx') and write { pid, ts, ...initialData }.
 * 2. On EEXIST read it:
 *    - If owner pid is alive => busy (wait if timeoutMs > 0, else throw 409).
 *    - If owner is dead (or file corrupt and > 10 min) => recovery:
 *      a. Take recovery mutex: fs.openSync(lockPath + '.recover', 'wx').
 *         If mutex exists and is > 5s old, unlink it once and retry; else busy-wait.
 *      b. Holding the mutex, RE-READ lockPath: only if it is still the same dead-owner
 *         content, fs.unlinkSync(lockPath) and create the new lock with 'wx'.
 *      c. Release the mutex (unlink) in finally.
 * 3. Release of a normal lock: unlink only if the file content still has our pid + ts.
 *    No rename, no link. Never unlink a lock file whose content you did not just verify under the mutex.
 */
export function acquireFileLock(
  lockPath: string,
  options?: AcquireLockOptions
): FileLockHandle {
  const timeoutMs = options?.timeoutMs ?? 0;
  const stepMs = options?.stepMs ?? 25;
  const myPid = process.pid;
  const myTs = Date.now();
  const start = Date.now();
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);

  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  while (true) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      const lockData = JSON.stringify({
        pid: myPid,
        ts: myTs,
        ...options?.initialData,
      }) + '\n';
      fs.writeFileSync(fd, lockData, 'utf8');
      fs.closeSync(fd);
      fd = null;
      return createHandle(lockPath, myPid, myTs);
    } catch (err: any) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
        fd = null;
      }

      if (err?.code === 'EEXIST') {
        let isStale = false;
        let deadContent = '';
        let deadParsed: any = null;

        try {
          deadContent = fs.readFileSync(lockPath, 'utf8');
          deadParsed = JSON.parse(deadContent);
          const ownerPid = Number(deadParsed?.pid);
          if (ownerPid > 0) {
            if (!isProcessRunning(ownerPid)) {
              isStale = true;
            }
          } else {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > 600_000) {
              isStale = true;
            }
          }
        } catch {
          // Corrupt or unreadable file: stale only if older than 10m
          try {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > 600_000) {
              isStale = true;
            }
          } catch {
            // ignore
          }
        }

        if (isStale) {
          const recoverPath = lockPath + '.recover';
          const mutex = acquireRecoverMutex(recoverPath, 10_000);
          if (mutex) {
            try {
              // Holding mutex: RE-READ lockPath and re-decide
              let isSameDeadContent = false;
              let currentDeadData: any = null;
              try {
                const currentContent = fs.readFileSync(lockPath, 'utf8');
                if (deadContent) {
                  isSameDeadContent = currentContent === deadContent;
                  if (isSameDeadContent) {
                    try { currentDeadData = JSON.parse(currentContent); } catch {}
                    const curDeadPid = Number(currentDeadData?.pid);
                    if (curDeadPid > 0 && isProcessRunning(curDeadPid)) {
                      isSameDeadContent = false;
                    }
                  }
                } else {
                  // Lock was corrupt
                  try {
                    JSON.parse(currentContent);
                    isSameDeadContent = false;
                  } catch {
                    isSameDeadContent = true;
                  }
                }
              } catch {
                isSameDeadContent = false;
              }

              if (isSameDeadContent) {
                if (options?.onRecoverDeadOwner) {
                  options.onRecoverDeadOwner(deadContent, currentDeadData ?? deadParsed);
                }

                try {
                  fs.unlinkSync(lockPath);
                } catch {
                  // ignore
                }

                const newFd = fs.openSync(lockPath, 'wx');
                const lockData = JSON.stringify({
                  pid: myPid,
                  ts: myTs,
                  ...options?.initialData,
                }) + '\n';
                fs.writeFileSync(newFd, lockData, 'utf8');
                fs.closeSync(newFd);
                return createHandle(lockPath, myPid, myTs);
              }
            } finally {
              mutex.release();
            }
          }
          // If not same dead content or mutex timed out, loop back and re-evaluate
          continue;
        }

        // Live owner: busy
        if (timeoutMs > 0) {
          if (Date.now() - start >= timeoutMs) {
            throw new ApiValidationError("Inbox is busy, try again.", 503);
          }
          Atomics.wait(int32, 0, 0, stepMs);
          continue;
        }

        throw new ApiValidationError(
          `Inbox item '${path.basename(lockPath, '.lock')}' is already being processed.`,
          409
        );
      }
      throw err;
    }
  }
}

function createHandle(lockPath: string, myPid: number, myTs: number): FileLockHandle {
  let keepLock = false;
  return {
    lockPath,
    pid: myPid,
    ts: myTs,
    keep: () => {
      keepLock = true;
    },
    release: () => {
      if (keepLock) return;
      try {
        const currentRaw = fs.readFileSync(lockPath, 'utf8');
        const current = JSON.parse(currentRaw);
        if (Number(current?.pid) === myPid && Number(current?.ts) === myTs) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // ignore
      }
    },
  };
}
