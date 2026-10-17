import { createContext } from 'react';
import { isScrollDiagnosticsEnabled, recordScrollDiagnostic, registerScrollDiagnosticSnapshot } from '../../utils/scrollDiagnostics';

type Priority = 0 | 1;
type State = 'idle' | 'loading' | 'ready' | 'error';
interface LoadJob {
  image: HTMLImageElement; url: string; priority: Priority;
  started: boolean; cancelled: boolean; finished: boolean; startedAt: number;
  abort?: () => void; done: (state: State) => void;
}

/** 所有页面共用实际 DOM 请求预算，先撤销浏览器请求，再释放预算。 */
export class ArtworkLoadBudget {
  private queued = new Set<LoadJob>();
  private running = new Set<LoadJob>();
  private failures = new Map<string, number>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private totals = { cancelled: 0, loaded: 0, failed: 0, timedOut: 0 };
  constructor(private limit = 6, private preloadLimit = 2, private cooldown = 30_000, private timeout = 30_000) {}

  snapshot() {
    return {
      queued: this.queued.size, running: this.running.size,
      preloading: [...this.running].filter((job) => job.priority === 1).length,
      cancelling: [...this.running].filter((job) => job.cancelled).length,
      oldestRunningMs: Math.max(0, ...[...this.running].map((job) => Date.now() - job.startedAt)),
      ...this.totals,
    };
  }

  private recordBudget() {
    if (isScrollDiagnosticsEnabled()) recordScrollDiagnostic('image-budget', this.snapshot());
  }

  enqueue(image: HTMLImageElement, url: string, priority: Priority, done: LoadJob['done']) {
    const job: LoadJob = { image, url, priority, done, started: false, cancelled: false, finished: false, startedAt: 0 };
    this.queued.add(job);
    this.recordBudget();
    this.pump();
    return {
      priority: (next: Priority) => {
        if (job.finished || job.cancelled || job.priority === next) return;
        job.priority = next;
        if (job.started) job.image.fetchPriority = next === 0 ? 'high' : 'low';
        this.recordBudget();
        this.pump();
      },
      cancel: () => {
        if (job.finished || job.cancelled) return;
        job.cancelled = true;
        if (this.queued.delete(job)) { job.finished = true; this.totals.cancelled += 1; }
        // 移除 src 会实际撤销 img 的 current/pending fetch；仅卸载节点不会。
        job.abort?.();
        this.recordBudget();
        this.pump();
      },
      pending: () => !job.finished,
      started: () => job.started,
    };
  }

  private pump() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    let retryIn = Infinity;
    for (const job of [...this.queued].sort((a, b) => a.priority - b.priority)) {
      if (!this.queued.has(job)) continue; // 缓存同步命中可能递归 pump，不能重复启动旧快照项。
      if (this.running.size >= this.limit) break;
      if ([...this.running].some((other) => other.image === job.image)) continue;
      if (job.priority === 1 && [...this.running].filter((other) => other.priority === 1).length >= this.preloadLimit) continue;
      const remaining = (this.failures.get(job.url) ?? -Infinity) + this.cooldown - Date.now();
      if (remaining > 0) { retryIn = Math.min(retryIn, remaining); continue; }
      this.queued.delete(job);
      this.running.add(job);
      job.started = true;
      job.startedAt = Date.now();
      let stopping = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const removeListeners = () => {
        job.image.removeEventListener('load', loaded);
        job.image.removeEventListener('error', failed);
        clearTimeout(deadline);
      };
      const terminal = (state: 'ready' | 'error' | 'cancelled') => {
        if (!this.running.delete(job)) return;
        job.finished = true;
        job.abort = undefined;
        removeListeners();
        this.totals[state === 'ready' ? 'loaded' : state === 'error' ? 'failed' : 'cancelled'] += 1;
        if (state === 'error') {
          this.failures.delete(job.url);
          this.failures.set(job.url, Date.now());
          if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!);
        } else if (state === 'ready') this.failures.delete(job.url);
        recordScrollDiagnostic(`image-${state}`, { ms: Date.now() - job.startedAt });
        this.recordBudget();
        if (!job.cancelled && state !== 'cancelled') job.done(state);
        this.pump();
      };
      const loaded = () => { if (!stopping) terminal('ready'); };
      const failed = () => { if (!stopping) terminal('error'); };
      const abort = (state: 'error' | 'cancelled') => {
        if (stopping || job.finished) return;
        stopping = true;
        removeListeners();
        clearImageSource(job.image);
        // WHATWG 的 stable state 会排入微任务。撤销后的微任务才放行同节点新请求，
        // 防止同步重设 src 合并掉撤销操作；取消不依赖缺失的 load/error 事件。
        queueMicrotask(() => terminal(state));
      };
      job.abort = () => abort('cancelled');
      job.image.addEventListener('load', loaded);
      job.image.addEventListener('error', failed);
      deadline = setTimeout(() => {
        // 缓存或脱离 DOM 的节点可能错过终态事件，先对账实际图片状态。
        if (job.image.complete) {
          if (job.image.naturalWidth > 0) loaded();
          else failed();
          return;
        }
        this.totals.timedOut += 1;
        recordScrollDiagnostic('image-timeout', { ms: Date.now() - job.startedAt });
        abort('error');
      }, this.timeout);
      job.done('loading');
      // 状态回调可能同步卸载/取消，不能在撤销之后重新启动 src。
      if (job.cancelled || job.finished || stopping) continue;
      // 可见性已由观察器控制；原生 lazy 会让已占预算的预取或卸载图片永远不开始。
      job.image.loading = 'eager';
      job.image.fetchPriority = job.priority === 0 ? 'high' : 'low';
      job.image.src = job.url;
      recordScrollDiagnostic('image-src-set');
      this.recordBudget();
      if (job.image.complete && job.image.naturalWidth > 0) loaded();
    }
    if (Number.isFinite(retryIn)) this.retryTimer = setTimeout(() => this.pump(), retryIn);
  }
}

export const artworkLoadBudget = new ArtworkLoadBudget();
registerScrollDiagnosticSnapshot('imageBudget', () => artworkLoadBudget.snapshot());
function clearImageSource(image: HTMLImageElement) {
  if (!image.hasAttribute('src')) return;
  image.removeAttribute('src');
  recordScrollDiagnostic('image-src-cleared');
}
interface ImageEntry {
  url: string; visible: boolean; preload: boolean; resident: boolean;
  ready: boolean; job?: ReturnType<ArtworkLoadBudget['enqueue']>;
  onState?: (state: State) => void;
  retries: number; retryTimer?: ReturnType<typeof setTimeout>;
}

// 三个观察器各有明确职责：可见优先，少量预取，较宽驻留区避免往返抖动。
export class PosterImageLifecycle {
  private entries = new Map<HTMLImageElement, ImageEntry>();
  private observers: IntersectionObserver[] = [];
  private root: HTMLElement | null = null;
  private height = -1;
  constructor(private budget = artworkLoadBudget) {}

  configure(root: HTMLElement | null, height: number) {
    if (this.observers.length && this.root === root && this.height === height) return;
    this.root = root; this.height = height;
    this.observers.forEach((observer) => observer.disconnect());
    this.observers = [];
    if (typeof IntersectionObserver === 'undefined') return;
    const margins = ['0px', `${Math.round(height * 0.5)}px 0px ${Math.round(height)}px 0px`, `${Math.round(height * 2)}px 0px`];
    (['visible', 'preload', 'resident'] as const).forEach((kind, index) => {
      const observer = new IntersectionObserver((changes) => {
        for (const change of changes) {
          const image = change.target as HTMLImageElement;
          const entry = this.entries.get(image);
          if (!entry) continue;
          entry[kind] = change.isIntersecting;
          this.update(image, entry);
        }
      }, { root, rootMargin: margins[index] });
      this.observers.push(observer);
      for (const image of this.entries.keys()) observer.observe(image);
    });
  }

  register(image: HTMLImageElement, value: { url: string; path?: string; width?: number; local?: boolean; onState?: ImageEntry['onState'] }) {
    const entry: ImageEntry = { url: value.url, onState: value.onState, visible: false, preload: false, resident: true, ready: false, retries: 0 };
    this.entries.set(image, entry);
    image.dataset.state = 'idle';
    this.observers.forEach((observer) => observer.observe(image));
    if (!this.observers.length) { entry.visible = true; this.update(image, entry); }
    return () => {
      this.observers.forEach((observer) => observer.unobserve(image));
      this.entries.delete(image);
      clearTimeout(entry.retryTimer);
      entry.job?.cancel();
      // 运行任务自行撤销 src 并等浏览器处理；已结束图片直接释放驻留。
      if (!entry.job?.pending()) clearImageSource(image);
    };
  }

  private update(image: HTMLImageElement, entry: ImageEntry) {
    if (!entry.visible) { clearTimeout(entry.retryTimer); entry.retryTimer = undefined; }
    if (!entry.visible && !entry.preload) {
      if (entry.job?.started()) entry.job.priority(1);
      if (!entry.job?.pending()) {
        if (!entry.resident) { clearImageSource(image); entry.ready = false; image.dataset.state = 'idle'; }
      } else if (!entry.job?.started() || !entry.resident) {
        entry.job?.cancel(); entry.job = undefined;
        entry.ready = false; image.dataset.state = 'idle'; entry.onState?.('idle');
      }
      return;
    }
    if (entry.job?.pending()) { entry.job.priority(entry.visible ? 0 : 1); return; }
    if (entry.ready || !entry.url) return;
    if (entry.retryTimer) return;
    entry.job = this.budget.enqueue(image, entry.url, entry.visible ? 0 : 1, (state) => {
      if (this.entries.get(image) !== entry) return;
      entry.ready = state === 'ready';
      image.dataset.state = state;
      entry.onState?.(state);
      if (state === 'error' && entry.visible && entry.retries < 2) {
        entry.retries += 1;
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = undefined;
          if (this.entries.get(image) === entry && entry.visible) this.update(image, entry);
        }, 30_000);
      }
      if ((state === 'ready' || state === 'error') && !entry.resident && !entry.visible && !entry.preload) {
        clearImageSource(image); entry.ready = false;
      }
    });
  }

  dispose() {
    this.observers.forEach((observer) => observer.disconnect());
    this.observers = [];
    for (const [image, entry] of this.entries) {
      clearTimeout(entry.retryTimer);
      entry.job?.cancel();
      if (!entry.job?.pending()) clearImageSource(image);
    }
    this.entries.clear();
  }
}

export const PosterImageContext = createContext<PosterImageLifecycle | null>(null);
export const defaultImageLifecycle = new PosterImageLifecycle();
const scrollRootLifecycles = new WeakMap<HTMLElement, PosterImageLifecycle>();

/** 可见性按滚动根隔离，实际图片请求仍共用全局预算。 */
export function getSharedImageLifecycle(root: HTMLElement | null, height: number) {
  let lifecycle = root ? scrollRootLifecycles.get(root) : defaultImageLifecycle;
  if (!lifecycle) {
    lifecycle = new PosterImageLifecycle();
    scrollRootLifecycles.set(root!, lifecycle);
  }
  lifecycle.configure(root, height);
  return lifecycle;
}
