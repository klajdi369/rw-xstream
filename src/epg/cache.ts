export class BoundedTtlCache<T> {
  private readonly values = new Map<string, { storedAt: number; value: T }>();

  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}

  get(key: string, allowStale = false) {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (!allowStale && Date.now() - entry.storedAt >= this.ttlMs) return undefined;

    // Refresh insertion order so eviction follows actual recent use.
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T) {
    this.values.delete(key);
    this.values.set(key, { storedAt: Date.now(), value });
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next();
      if (oldest.done) break;
      this.values.delete(oldest.value);
    }
  }
}
