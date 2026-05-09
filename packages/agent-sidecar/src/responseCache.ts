import type { ResponseCacheMetadata } from '@minicode/shared';

interface CacheEntry<T> {
  value: T;
  metadata: ResponseCacheMetadata;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createCacheKey(scope: ResponseCacheMetadata['scope'], payload: unknown): string {
  return `${scope}:${stableStringify(payload)}`;
}

export class ResponseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly enabled: boolean;
  private readonly maxEntries: number;
  private readonly scope: ResponseCacheMetadata['scope'];

  constructor(scope: ResponseCacheMetadata['scope'], options?: { enabled?: boolean; maxEntries?: number }) {
    this.scope = scope;
    this.enabled = options?.enabled !== false;
    this.maxEntries = Math.max(1, options?.maxEntries || 100);
  }

  get(key: string): CacheEntry<T> | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, value: T): CacheEntry<T> {
    const entry: CacheEntry<T> = {
      value,
      metadata: {
        scope: this.scope,
        key,
        hit: false
      }
    };

    if (!this.enabled) {
      return entry;
    }

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) {
        break;
      }
      this.entries.delete(oldest);
    }
    return entry;
  }
}
