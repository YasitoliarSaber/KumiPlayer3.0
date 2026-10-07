/**
 * 滚动瞬时冻结诊断采样器（默认关闭，脱离 React 状态）。
 *
 * 目的：为“画面停住 → 突然向下跳动”提供可对齐的时间线，而不是靠推测归因。
 *
 * 约束（与全局排查报告一致）：
 * - 默认关闭；只有显式开启后才注册监听并写入内存环形缓冲。
 * - 不逐次 console 输出，不每帧更新 DOM，不触发 React 渲染或 setState。
 * - 只记录归一化事件类型、计数与耗时；不保存完整 URL、查询参数、Token、
 *   真实媒体路径或响应正文。
 * - 采样器自身开销需要测量，因此 dump 同时给出记录调用次数与缓冲占用。
 *
 * 开启方式（二选一）：
 * - 控制台执行 `__kumiScrollDiagnostics.enable()`，或
 * - `localStorage.setItem('kumi:scroll-diagnostics', '1')` 后刷新。
 * 摘取结果：`__kumiScrollDiagnostics.dump()`。
 */

export interface ScrollDiagnosticEvent {
  /** 相对页面加载的时间戳（毫秒）。 */
  t: number;
  kind: string;
  /** 只允许数值或布尔量；禁止 URL、路径、令牌与响应正文。 */
  data?: Record<string, number | boolean>;
}

export interface ScrollDiagnosticsDump {
  enabled: boolean;
  bufferLimit: number;
  eventCount: number;
  recordCalls: number;
  overwritten: number;
  spanMs: number;
  counts: Record<string, number>;
  worstFrameGapMs: number;
  slowFrameCount: number;
  longTaskCount: number;
  worstLongTaskMs: number;
  events: ScrollDiagnosticEvent[];
}

const STORAGE_KEY = 'kumi:scroll-diagnostics';
const BUFFER_LIMIT = 4000;
/** 只记录明显丢帧的 rAF 间隔，避免把每帧都写进缓冲。 */
const FRAME_GAP_MS = 32;
const QUERY_PARAM = 'scrollDiagnostics';

const buffer: (ScrollDiagnosticEvent | undefined)[] = new Array(BUFFER_LIMIT);
let writeIndex = 0;
let buffered = 0;
let enabled = false;
let recordCalls = 0;
let overwritten = 0;
let startedAt = 0;
let frameHandle = 0;
let lastFrameAt = 0;
let longTaskObserver: PerformanceObserver | null = null;
let listenersAttached = false;
const sessionListeners = new Set<() => void>();

/** 开关与清空通知不经过 React；订阅者可立即挂载输入监听、补记当前窗口。 */
export function subscribeScrollDiagnostics(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}

function notifySessionListeners(): void {
  for (const listener of sessionListeners) listener();
}

function resetFrameBaseline(): void {
  lastFrameAt = timeOrigin();
}

function snapshotEvents(): ScrollDiagnosticEvent[] {
  if (buffered === 0) return [];
  const start = buffered === BUFFER_LIMIT ? writeIndex : 0;
  const events: ScrollDiagnosticEvent[] = [];
  for (let index = 0; index < buffered; index += 1) {
    const event = buffer[(start + index) % BUFFER_LIMIT];
    if (event) events.push(event);
  }
  return events;
}

function timeOrigin(): number {
  const perf = typeof performance !== 'undefined' ? performance : undefined;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readStoredFlag(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStoredFlag(value: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 隐私模式或存储被禁用时，本次会话的开关仍然生效。
  }
}

function readQueryFlag(): boolean {
  if (!hasWindow()) return false;
  try {
    return new URLSearchParams(window.location.search).get(QUERY_PARAM) === '1';
  } catch {
    return false;
  }
}

export function isScrollDiagnosticsEnabled(): boolean {
  return enabled;
}

/** 记录一条归一化诊断事件；未开启时是空操作。 */
export function recordScrollDiagnostic(kind: string, data?: Record<string, number | boolean>): void {
  if (!enabled) return;
  recordCalls += 1;
  if (buffered === BUFFER_LIMIT) overwritten += 1;
  else buffered += 1;
  buffer[writeIndex] = { t: Math.round(timeOrigin() - startedAt), kind, data };
  writeIndex = (writeIndex + 1) % BUFFER_LIMIT;
}

export function clearScrollDiagnostics(): void {
  for (let index = 0; index < BUFFER_LIMIT; index += 1) buffer[index] = undefined;
  writeIndex = 0;
  buffered = 0;
  overwritten = 0;
  recordCalls = 0;
  startedAt = timeOrigin();
  resetFrameBaseline();
  longTaskObserver?.takeRecords();
  notifySessionListeners();
}

function attachListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  const observerCtor = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : undefined;
  if (observerCtor) {
    try {
      longTaskObserver = new observerCtor((list) => {
        for (const entry of list.getEntries()) {
          // 不将上一次录制的延迟回调或后台任务混入当前前台时间线。
          if (entry.startTime < startedAt || (hasWindow() && document.visibilityState !== 'visible')) continue;
          recordScrollDiagnostic('long-task', {
            ms: Math.round(entry.duration),
            startMs: Math.round(entry.startTime - startedAt),
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch {
      longTaskObserver = null;
    }
  }
  if (!hasWindow() || typeof window.requestAnimationFrame !== 'function') return;
  lastFrameAt = timeOrigin();
  document.addEventListener('visibilitychange', resetFrameBaseline);
  const frame = () => {
    if (!enabled) return;
    const now = timeOrigin();
    const delta = now - lastFrameAt;
    lastFrameAt = now;
    if (document.visibilityState === 'visible' && delta >= FRAME_GAP_MS) {
      recordScrollDiagnostic('frame-gap', { ms: Math.round(delta) });
    }
    frameHandle = window.requestAnimationFrame(frame);
  };
  frameHandle = window.requestAnimationFrame(frame);
}

function detachListeners(): void {
  if (frameHandle && hasWindow()) window.cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  if (hasWindow()) document.removeEventListener('visibilitychange', resetFrameBaseline);
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  listenersAttached = false;
}

/** 显式开启采样；persist=false 时只在本次会话生效。 */
export function enableScrollDiagnostics(options?: { persist?: boolean }): void {
  if (options?.persist !== false) writeStoredFlag(true);
  if (enabled) return;
  enabled = true;
  clearScrollDiagnostics();
  attachListeners();
}

export function disableScrollDiagnostics(options?: { persist?: boolean }): void {
  if (options?.persist !== false) writeStoredFlag(false);
  enabled = false;
  detachListeners();
  notifySessionListeners();
}

export function dumpScrollDiagnostics(options?: { includeEvents?: boolean }): ScrollDiagnosticsDump {
  const events = snapshotEvents();
  const counts: Record<string, number> = {};
  let worstFrameGapMs = 0;
  let slowFrameCount = 0;
  let longTaskCount = 0;
  let worstLongTaskMs = 0;
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    const ms = typeof event.data?.ms === 'number' ? event.data.ms : 0;
    if (event.kind === 'frame-gap') {
      slowFrameCount += 1;
      worstFrameGapMs = Math.max(worstFrameGapMs, ms);
    } else if (event.kind === 'long-task') {
      longTaskCount += 1;
      worstLongTaskMs = Math.max(worstLongTaskMs, ms);
    }
  }
  return {
    enabled,
    bufferLimit: BUFFER_LIMIT,
    eventCount: events.length,
    recordCalls,
    overwritten,
    spanMs: events.length ? events[events.length - 1].t - events[0].t : 0,
    counts,
    worstFrameGapMs,
    slowFrameCount,
    longTaskCount,
    worstLongTaskMs,
    events: options?.includeEvents === false ? [] : events,
  };
}

declare global {
  interface Window {
    __kumiScrollDiagnostics?: {
      enable: typeof enableScrollDiagnostics;
      disable: typeof disableScrollDiagnostics;
      clear: typeof clearScrollDiagnostics;
      dump: typeof dumpScrollDiagnostics;
      record: typeof recordScrollDiagnostic;
      enabled: typeof isScrollDiagnosticsEnabled;
    };
  }
}

if (hasWindow()) {
  window.__kumiScrollDiagnostics = {
    enable: enableScrollDiagnostics,
    disable: disableScrollDiagnostics,
    clear: clearScrollDiagnostics,
    dump: dumpScrollDiagnostics,
    record: recordScrollDiagnostic,
    enabled: isScrollDiagnosticsEnabled,
  };
  // 存储标志或 URL 参数要求开启时，页面加载即开始录制。
  if (readStoredFlag() || readQueryFlag()) enableScrollDiagnostics({ persist: false });
}
