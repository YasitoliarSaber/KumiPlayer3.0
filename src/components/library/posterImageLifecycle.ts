import { createContext } from 'react';
import { recordScrollDiagnostic } from '../../utils/scrollDiagnostics';

type Priority = 0 | 1;
type State = 'idle' | 'loading' | 'ready' | 'error';
interface LoadJob {
  image: HTMLImageElement; url: string; priority: Priority;
  started: boolean; cancelled: boolean; done: (state: State) => void;
}

/** 所有页面共用实际 DOM 请求预算，取消挂载不等于浏览器已取消传输。 */
export class ArtworkLoadBudget {
  private queued = new Set<LoadJob>();
  private running = new Set<LoadJob>();
  private failures = new Map<string, number>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private limit = 6, private preloadLimit = 2, private cooldown = 30_000) {}

  enqueue(image: HTMLImageElement, url: string, priority: Priority, done: LoadJob['done']) {
    const job: LoadJob = { image, url, priority, done, started: false, cancelled: false };
    this.queued.add(job);
    this.pump();
    return {
      priority: (next: Priority) => { job.priority = next; this.pump(); },
      cancel: () => {
        job.cancelled = true;
        this.queued.delete(job);
        // 已开始的请求保留监听器和预算，直到 load/error；不能虚报取消成功。
        this.pump();
      },
      pending: () => !job.started || this.running.has(job),
      started: () => job.started,
    };
  }

  private pump() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    let retryIn = Infinity;
    for (const job of [...this.queued].sort((a, b) => a.priority - b.priority)) {
      if (this.running.size >= this.limit) break;
      if ([...this.running].some((other) => other.image === job.image)) continue;
      if (job.priority === 1 && [...this.running].filter((other) => other.priority === 1).length >= this.preloadLimit) continue;
      const remaining = (this.failures.get(job.url) ?? -Infinity) + this.cooldown - Date.now();
      if (remaining > 0) { retryIn = Math.min(retryIn, remaining); continue; }
      this.queued.delete(job);
      this.running.add(job);
      job.started = true;
      const terminal = (state: State) => {
        if (!this.running.delete(job)) return;
        job.image.removeEventListener('load', loaded);
        job.image.removeEventListener('error', failed);
        if (state === 'error') {
          this.failures.delete(job.url);
          this.failures.set(job.url, Date.now());
          if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!);
        } else this.failures.delete(job.url);
        if (!job.cancelled) job.done(state);
        this.pump();
      };
      const loaded = () => terminal('ready');
      const failed = () => terminal('error');
      job.image.addEventListener('load', loaded);
      job.image.addEventListener('error', failed);
      job.done('loading');
      // 可见性已由观察器控制；原生 lazy 会让已占预算的预取或卸载图片永远不开始。
      job.image.loading = 'eager';
      job.image.fetchPriority = job.priority === 0 ? 'high' : 'low';
      job.image.src = job.url;
      recordScrollDiagnostic('image-src-set');
      if (job.image.complete && job.image.naturalWidth > 0) loaded();
    }
    if (Number.isFinite(retryIn)) this.retryTimer = setTimeout(() => this.pump(), retryIn);
  }
}

export const artworkLoadBudget = new ArtworkLoadBudget();
function clearImageSource(image: HTMLImageElement) {
  if (!image.hasAttribute('src')) return;
  image.removeAttribute('src');
  recordScrollDiagnostic('image-src-cleared');
}
interface ImageEntry {
  url: string; visible: boolean; preload: boolean; resident: boolean;
  ready: boolean; job?: ReturnType<ArtworkLoadBudget['enqueue']>;
  onState?: (state: State) => void;
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
    const entry: ImageEntry = { url: value.url, onState: value.onState, visible: false, preload: false, resident: true, ready: false };
    this.entries.set(image, entry);
    image.dataset.state = 'idle';
    this.observers.forEach((observer) => observer.observe(image));
    if (!this.observers.length) { entry.visible = true; this.update(image, entry); }
    return () => {
      this.observers.forEach((observer) => observer.unobserve(image));
      this.entries.delete(image);
      entry.job?.cancel();
      // 未完成的 src 不主动清除；浏览器终态仍负责释放全局预算。
      if (!entry.job?.pending()) clearImageSource(image);
    };
  }

  private update(image: HTMLImageElement, entry: ImageEntry) {
    if (!entry.visible && !entry.preload) {
      if (!entry.job?.pending()) {
        if (!entry.resident) { clearImageSource(image); entry.ready = false; image.dataset.state = 'idle'; }
      } else if (!entry.job?.started()) { entry.job?.cancel(); entry.job = undefined; }
      return;
    }
    if (entry.job?.pending()) { entry.job.priority(entry.visible ? 0 : 1); return; }
    if (entry.ready || !entry.url) return;
    entry.job = this.budget.enqueue(image, entry.url, entry.visible ? 0 : 1, (state) => {
      if (this.entries.get(image) !== entry) return;
      entry.ready = state === 'ready';
      image.dataset.state = state;
      entry.onState?.(state);
      if ((state === 'ready' || state === 'error') && !entry.resident && !entry.visible && !entry.preload) {
        clearImageSource(image); entry.ready = false;
      }
    });
  }

  dispose() {
    this.observers.forEach((observer) => observer.disconnect());
    this.observers = [];
    for (const [image, entry] of this.entries) {
      entry.job?.cancel();
      if (!entry.job?.pending()) clearImageSource(image);
    }
    this.entries.clear();
  }
}

export const PosterImageContext = createContext<PosterImageLifecycle | null>(null);
export const defaultImageLifecycle = new PosterImageLifecycle();
