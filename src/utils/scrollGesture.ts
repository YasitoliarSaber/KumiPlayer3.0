// 共享的滚动静默状态（单例）。
// 整个应用只注册一个 window scroll 监听器，避免每张海报卡各自监听滚动，
// 把滚动事件放大为 O(卡片数) 的 JS 与计时器操作。

const SCROLL_QUIET_MS = 300;

let scrollRecentlyActive = false;
let resetTimer: number | null = null;
let listenerInstalled = false;
let lastScrollAt = 0;
const activeRoots = new Set<HTMLElement>();

function finishWhenQuiet(): void {
  const remaining = SCROLL_QUIET_MS - (Date.now() - lastScrollAt);
  if (remaining > 0) {
    resetTimer = window.setTimeout(finishWhenQuiet, remaining);
    return;
  }
  scrollRecentlyActive = false;
  resetTimer = null;
  for (const root of activeRoots) delete root.dataset.scrollActive;
  activeRoots.clear();
}

function markScrolling(event: Event): void {
  scrollRecentlyActive = true;
  lastScrollAt = Date.now();
  const target = event.target;
  const root = target instanceof Element ? target.closest<HTMLElement>('.app-main') : null;
  // 每个滚动容器只在开始/结束时改一次 DOM，不在逐帧热路径更新样式或 React。
  if (root && !activeRoots.has(root)) {
    root.dataset.scrollActive = 'true';
    activeRoots.add(root);
  }
  // 连续滚动只更新时刻；同一个计时器到期后检查静默窗口，避免每个事件撤销重建。
  if (resetTimer === null) resetTimer = window.setTimeout(finishWhenQuiet, SCROLL_QUIET_MS);
}

function installScrollListener(): void {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('scroll', markScrolling, { capture: true, passive: true });
}

/** 最近 300ms 内是否发生过滚动；首次调用会安装唯一的共享监听器。 */
export function isScrollRecentlyActive(): boolean {
  installScrollListener();
  return scrollRecentlyActive;
}

/** 仅供测试重置单例状态，避免用例间污染。 */
export function resetScrollGestureForTests(): void {
  if (typeof window !== 'undefined' && listenerInstalled) {
    window.removeEventListener('scroll', markScrolling, { capture: true });
  }
  listenerInstalled = false;
  if (resetTimer !== null) {
    window.clearTimeout(resetTimer);
    resetTimer = null;
  }
  scrollRecentlyActive = false;
  lastScrollAt = 0;
  for (const root of activeRoots) delete root.dataset.scrollActive;
  activeRoots.clear();
}
