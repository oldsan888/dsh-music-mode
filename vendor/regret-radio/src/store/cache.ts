// 内存缓存，替代 Redis

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class MemoryCache {
  private store = new Map<string, CacheEntry<any>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // 每分钟清理过期条目
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlSec: number): void {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlSec * 1000,
    });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    this.store.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
}

// 单例实例
export const cache = new MemoryCache();

// 便捷方法（兼容 Redis 接口风格）
export async function cacheGet<T>(key: string): Promise<T | null> {
  return cache.get<T>(key);
}

export async function cacheSet<T>(key: string, data: T, ttlSec: number): Promise<void> {
  cache.set(key, data, ttlSec);
}

export async function cacheDel(key: string): Promise<void> {
  cache.del(key);
}

export function closeCache(): void {
  cache.destroy();
}
