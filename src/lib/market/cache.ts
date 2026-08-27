interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Small in-process TTL cache.
 *
 * On a serverless deployment this lives for the lifetime of a warm instance,
 * which is exactly the right scope for market data: it collapses a burst of
 * dashboard requests into one upstream call without ever serving genuinely
 * stale prices. Cold starts simply miss, which is correct rather than clever.
 */
export class TtlCache {
  private store = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Cache-aside with request coalescing: concurrent misses for the same key
   * share a single upstream call rather than stampeding a rate-limited API.
   */
  async fetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Last known good value, ignoring expiry. Used when upstream is down. */
  stale<T>(key: string): T | undefined {
    return this.store.get(key)?.value as T | undefined;
  }

  setStaleFallback<T>(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() });
  }
}

export const marketCache = new TtlCache();
