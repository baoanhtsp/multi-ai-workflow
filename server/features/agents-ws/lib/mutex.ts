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
}

const mutexMap = new Map<string, AsyncMutex>();

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
