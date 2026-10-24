import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const release = () => {
        const next = this.queue.shift();
        if (next) {
          next();
        } else {
          this.locked = false;
        }
      };

      if (!this.locked) {
        this.locked = true;
        resolve(release);
      } else {
        this.queue.push(() => resolve(release));
      }
    });
  }

  isLocked(): boolean {
    return this.locked;
  }
}

const mutexMap = new Map<string, AsyncMutex>();
const s6StateMutex = new AsyncMutex();
export const s6StateStorage = new AsyncLocalStorage<string>();
let activeOwnerToken: string | null = null;

export function getFileMutex(key: string): AsyncMutex {
  const norm = key.replace(/\//g, '\\').toLowerCase();
  let m = mutexMap.get(norm);
  if (!m) {
    m = new AsyncMutex();
    mutexMap.set(norm, m);
  }
  return m;
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const mutex = getFileMutex(filePath);
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export function isS6StateLocked(): boolean {
  return s6StateMutex.isLocked();
}

export async function withS6State<T>(fn: () => Promise<T>): Promise<T> {
  const callerToken = s6StateStorage.getStore();
  if (callerToken && callerToken === activeOwnerToken) {
    return await fn();
  }

  const newToken = crypto.randomUUID();
  const release = await s6StateMutex.acquire();
  activeOwnerToken = newToken;
  try {
    return await s6StateStorage.run(newToken, fn);
  } finally {
    activeOwnerToken = null;
    release();
  }
}
