/**
 * In-memory TTL cache with in-flight dedup.
 *
 * On Vercel the cache is per-instance and ephemeral; on Render it lives for
 * the process lifetime. Either way it shields mangafire.to from duplicate
 * scrapes: concurrent misses for the same key fire ONE fetch, not N.
 */

interface Entry {
  value: any;
  expiresAt: number;
}

export const TTL = {
  HOME: 5 * 60, // 300s
  LATEST: 2 * 60, // 120s
  SEARCH: 10 * 60, // 600s
  CATEGORY: 10 * 60, // 600s
  GENRE: 10 * 60, // 600s
  MANGA_INFO: 30 * 60, // 1800s
  CHAPTERS: 15 * 60, // 900s
  CHAPTER_IMGS: 60 * 60, // 3600s
  VOLUMES: 30 * 60, // 1800s
} as const;

class MemoryCache {
  private store = new Map<string, Entry>();
  private inflight = new Map<string, Promise<any>>();

  get(key: string): any | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: any, ttlSeconds: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  /**
   * Return cached value, or run `fetcher` exactly once for concurrent callers
   * and cache the result.
   */
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== null) return cached as T;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const task = (async () => {
      try {
        const value = await fetcher();
        this.set(key, value, ttlSeconds);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  stats() {
    const now = Date.now();
    const entries: { key: string; expiresIn: number }[] = [];
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        continue;
      }
      entries.push({ key, expiresIn: Math.round((entry.expiresAt - now) / 1000) });
    }
    entries.sort((a, b) => a.key.localeCompare(b.key));
    return { totalEntries: entries.length, entries };
  }
}

export const cache = new MemoryCache();
