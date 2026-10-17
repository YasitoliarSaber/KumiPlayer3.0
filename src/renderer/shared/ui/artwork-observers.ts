/** 全部图片共享观察器，避免逐卡创建滚动监听与观察器。 */
type Watch = { visible: boolean; near: boolean; notify: (priority: 'visible' | 'prefetch' | null) => void };
const watches = new Map<Element, Watch>();
let visibleObserver: IntersectionObserver | undefined;
let nearObserver: IntersectionObserver | undefined;

export function watchArtwork(element: Element, notify: Watch['notify']) {
  if (typeof IntersectionObserver === 'undefined') { notify('visible'); return () => undefined; }
  const update = (entries: IntersectionObserverEntry[], visible: boolean) => {
    for (const entry of entries) {
      const watch = watches.get(entry.target);
      if (!watch) continue;
      if (visible) watch.visible = entry.isIntersecting;
      else watch.near = entry.isIntersecting;
      watch.notify(watch.visible ? 'visible' : watch.near ? 'prefetch' : null);
    }
  };
  visibleObserver ??= new IntersectionObserver((entries) => update(entries, true));
  nearObserver ??= new IntersectionObserver((entries) => update(entries, false), { rootMargin: '300px' });
  watches.set(element, { visible: false, near: false, notify });
  visibleObserver.observe(element);
  nearObserver.observe(element);
  return () => {
    watches.delete(element);
    visibleObserver?.unobserve(element);
    nearObserver?.unobserve(element);
    if (!watches.size) {
      visibleObserver?.disconnect(); nearObserver?.disconnect();
      visibleObserver = undefined; nearObserver = undefined;
    }
  };
}

const sizes = new Map<Element, (width: number) => void>();
let resizeObserver: ResizeObserver | undefined;
export function watchArtworkSize(element: Element, notify: (width: number) => void) {
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) sizes.get(entry.target)?.(entry.contentRect.width);
  });
  sizes.set(element, notify);
  resizeObserver.observe(element);
  notify(element.getBoundingClientRect().width);
  return () => {
    sizes.delete(element); resizeObserver?.unobserve(element);
    if (!sizes.size) { resizeObserver?.disconnect(); resizeObserver = undefined; }
  };
}

const dprListeners = new Set<() => void>();
let dprQuery: MediaQueryList | undefined;
const notifyDpr = () => {
  dprQuery?.removeEventListener('change', notifyDpr);
  dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprQuery?.addEventListener('change', notifyDpr);
  dprListeners.forEach((listener) => listener());
};
export const devicePixelRatio = () => window.devicePixelRatio || 1;
export function watchDevicePixelRatio(listener: () => void) {
  dprListeners.add(listener);
  if (dprListeners.size === 1) { notifyDpr(); window.addEventListener('resize', notifyDpr); }
  return () => {
    dprListeners.delete(listener);
    if (!dprListeners.size) {
      dprQuery?.removeEventListener('change', notifyDpr);
      window.removeEventListener('resize', notifyDpr);
    }
  };
}
