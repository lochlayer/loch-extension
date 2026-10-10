// A key-value store. Two of them exist: `local` (chrome.storage.local, on disk) and `session`
// (chrome.storage.session, in memory, gone when the browser closes, readable only by this
// extension's own trusted contexts). Tests pass in-memory ones.

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  /** Every key that starts with `prefix`. */
  keys(prefix: string): Promise<string[]>;
  clear(): Promise<void>;
}

export function chromeKV(area: chrome.storage.StorageArea): KV {
  return {
    async get<T>(key: string) {
      const found = await area.get(key);
      return found[key] as T | undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(keys) {
      await area.remove(keys);
    },
    async keys(prefix) {
      const all = await area.get(null);
      return Object.keys(all).filter((key) => key.startsWith(prefix));
    },
    async clear() {
      await area.clear();
    },
  };
}

/** An in-memory store with the same contract: values are structured-cloned in and out. */
export function memoryKV(initial: Record<string, unknown> = {}): KV & { dump(): Record<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
  return {
    async get<T>(key: string) {
      return clone(data.get(key)) as T | undefined;
    },
    async set(key, value) {
      data.set(key, clone(value));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
    async keys(prefix) {
      return [...data.keys()].filter((key) => key.startsWith(prefix));
    },
    async clear() {
      data.clear();
    },
    dump() {
      return Object.fromEntries(data);
    },
  };
}
