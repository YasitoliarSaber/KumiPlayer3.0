/**
 * URL 状态与请求预算。字节缓存由浏览器管理；仅在请求期间持有 Image，
 * 完成后释放，不保存 Blob、ImageBitmap 或解码位图。
 */
export type ArtworkPriority = 'visible' | 'prefetch';
export type ArtworkState = 'idle' | 'queued' | 'loading' | 'ready' | 'failed';
interface Entry {
  state: ArtworkState;
  readonly consumers: Map<symbol, ArtworkPriority>;
  failures: number;
  retryAt: number;
  error?: 'load' | 'timeout';
  prefetch: boolean;
  release?: () => void;
}

export class ArtworkLifecycle {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private active = 0;
  private prefetch = 0;
  private pumping = false;
  private readonly counters = { started: 0, hits: 0, evicted: 0, failed: 0, loaded: 0, totalLoadMs: 0, peakActive: 0, peakPrefetch: 0 };

  constructor(private readonly options = { capacity: 512, concurrency: 6, prefetch: 2, cooldownMs: 30_000, timeoutMs: 15_000 }) {}

  state = (url: string): ArtworkState => this.entries.get(url)?.state ?? 'idle';
  retryAt = (url: string): number | null => {
    const entry = this.entries.get(url);
    return entry?.state === 'failed' && entry.failures < 3 ? entry.retryAt : null;
  };
  subscribe = (url: string, listener: () => void) => {
    const listeners = this.listeners.get(url) ?? new Set();
    listeners.add(listener);
    this.listeners.set(url, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(url);
    };
  };

  request(url: string, priority: ArtworkPriority): () => void {
    let entry = this.entries.get(url);
    if (!entry) {
      // 只淘汰未被使用的状态，绝不靠取消在途请求腾预算。
      while (this.entries.size >= this.options.capacity) {
        const victim = [...this.entries].find(([, value]) => !value.consumers.size && value.state !== 'loading');
        if (!victim) return () => undefined;
        this.entries.delete(victim[0]);
        this.counters.evicted += 1;
      }
      entry = { state: 'queued', consumers: new Map(), failures: 0, retryAt: 0, prefetch: false };
    } else if (entry.state === 'ready') {
      this.counters.hits += 1;
    } else if (entry.state === 'failed' && entry.failures < 3 && Date.now() >= entry.retryAt) {
      entry.state = 'queued';
    }
    this.entries.delete(url);
    this.entries.set(url, entry);
    const token = Symbol();
    entry.consumers.set(token, priority);
    this.pump();
    this.emit(url);
    return () => {
      entry.consumers.delete(token);
      if (!entry.consumers.size && entry.state === 'queued') this.entries.delete(url);
      this.pump();
    };
  }

  snapshot() {
    return { ...this.counters, entries: this.entries.size, active: this.active, prefetch: this.prefetch,
      queued: [...this.entries.values()].filter((entry) => entry.state === 'queued').length };
  }

  reportFailure(url: string) {
    const entry = this.entries.get(url);
    if (!entry || entry.state === 'failed') return;
    if (entry.release) { entry.release(); return; }
    entry.state = 'failed';
    entry.failures += 1;
    entry.retryAt = Date.now() + this.options.cooldownMs;
    entry.error = 'load';
    this.counters.failed += 1;
    this.emit(url);
  }

  private emit(url: string) { this.listeners.get(url)?.forEach((listener) => listener()); }
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active < this.options.concurrency) {
        const queued = [...this.entries].filter(([, entry]) => entry.state === 'queued' && entry.consumers.size);
        const visible = queued.find(([, entry]) => [...entry.consumers.values()].includes('visible'));
        const next = visible ?? (this.prefetch < this.options.prefetch ? queued[0] : undefined);
        if (!next) break;
        this.start(next[0], next[1], !visible);
      }
    } finally { this.pumping = false; }
  }

  private start(url: string, entry: Entry, prefetch: boolean) {
    entry.state = 'loading';
    entry.prefetch = prefetch;
    this.active += 1;
    if (prefetch) this.prefetch += 1;
    this.counters.peakActive = Math.max(this.counters.peakActive, this.active);
    this.counters.peakPrefetch = Math.max(this.counters.peakPrefetch, this.prefetch);
    this.counters.started += 1;
    const began = performance.now();
    const image = new Image();
    image.decoding = 'async';
    let settled = false;
    const finish = (ok: boolean, error: Entry['error'] = 'load') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      entry.release = undefined;
      this.active -= 1;
      if (prefetch) this.prefetch -= 1;
      entry.state = ok ? 'ready' : 'failed';
      if (ok) {
        this.counters.loaded += 1;
        this.counters.totalLoadMs += performance.now() - began;
      } else {
        entry.failures += 1;
        entry.retryAt = Date.now() + this.options.cooldownMs;
        entry.error = error;
        this.counters.failed += 1;
      }
      this.emit(url);
      this.pump();
    };
    const timer = setTimeout(() => {
      image.removeAttribute('src');
      finish(false, 'timeout');
    }, this.options.timeoutMs);
    // 先注册回调，再设置 src；complete 覆盖同步缓存命中的路径。
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    entry.release = () => { image.removeAttribute('src'); finish(false); };
    image.src = url;
    if (image.complete) finish(image.naturalWidth > 0);
    this.emit(url);
  }

  dispose() {
    // 仅用于模块卸载/测试，普通卡片卸载只解除消费者，保留有限在途请求。
    for (const entry of this.entries.values()) entry.consumers.clear();
    for (const entry of this.entries.values()) entry.release?.();
    this.entries.clear();
    this.listeners.clear();
    for (const key of Object.keys(this.counters) as (keyof typeof this.counters)[]) this.counters[key] = 0;
  }
}

export const artworkLifecycle = new ArtworkLifecycle();
if (import.meta.hot) import.meta.hot.dispose(() => artworkLifecycle.dispose());
