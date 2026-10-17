/** 开发期采样：回调间隔不等于屏幕呈现帧率；不进入生产包。 */
import { artworkLifecycle } from '@/shared/ui/artwork-lifecycle';

export function installScrollProfile() {
  const host = document.createElement('aside');
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:1000;padding:10px;background:#fff;color:#111;border:1px solid #aaa;border-radius:8px;font:12px monospace;max-width:480px';
  const start = document.createElement('button');
  start.textContent = '采样 8 秒';
  start.style.cssText = 'padding:6px;border:1px solid #aaa;border-radius:4px';
  const output = document.createElement('pre');
  output.dataset.profileResult = '';
  output.style.cssText = 'white-space:pre-wrap;max-height:160px;overflow:auto;margin:4px 0 0';
  host.append(start, output);
  document.body.append(host);
  let running = false;
  let cancelled = false;
  const cancel = () => { if (document.hidden) cancelled = true; };
  document.addEventListener('visibilitychange', cancel);
  start.onclick = () => {
    if (running) return;
    running = true;
    cancelled = document.hidden;
    start.disabled = true;
    output.textContent = '采样中：在海报墙连续滚动';
    const intervals: number[] = [];
    const longTasks: number[] = [];
    const longFrames: number[] = [];
    let scrollEvents = 0;
    const onScroll = () => { scrollEvents += 1; };
    document.addEventListener('scroll', onScroll, true);
    const observers = ['longtask', 'long-animation-frame'].flatMap((type) => {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) return [];
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) (type === 'longtask' ? longTasks : longFrames).push(entry.duration);
      });
      observer.observe({ type });
      return [observer];
    });
    const began = performance.now();
    const artworkBefore = artworkLifecycle.snapshot();
    let previous = 0;
    const tick = (now: number) => {
      if (previous) intervals.push(now - previous);
      previous = now;
      if (!cancelled && now - began < 8000) { requestAnimationFrame(tick); return; }
      observers.forEach((observer) => observer.disconnect());
      document.removeEventListener('scroll', onScroll, true);
      intervals.sort((a, b) => a - b);
      const percentile = (p: number) => Number((intervals[Math.floor((intervals.length - 1) * p)] ?? 0).toFixed(2));
      const filters = [...document.querySelectorAll<HTMLElement>('[data-testid="main-scroll"] *')].filter((element) => {
        const css = getComputedStyle(element);
        return css.backdropFilter !== 'none' || css.filter !== 'none';
      });
      output.textContent = JSON.stringify({
        material: document.documentElement.dataset.material,
        viewport: [innerWidth, innerHeight, devicePixelRatio],
        duration: Math.round(now - began), cancelled, scrollEvents,
        callbacks: intervals.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99),
        over33: intervals.filter((n) => n > 33.4).length,
        longTasks: longTasks.length, maxLongTask: Math.round(Math.max(0, ...longTasks)),
        longFrames: longFrames.length, maxLongFrame: Math.round(Math.max(0, ...longFrames)),
        mainFilters: filters.length,
        artwork: artworkLifecycle.snapshot(),
        artworkDelta: Object.fromEntries(Object.entries(artworkLifecycle.snapshot()).map(([key, value]) =>
          [key, value - artworkBefore[key as keyof typeof artworkBefore]])),
        grids: [...document.querySelectorAll<HTMLElement>('[data-virtual-rows]')].map((grid) => ({
          rows: Number(grid.dataset.virtualRows), columns: Number(grid.dataset.posterColumns),
          rendered: grid.querySelectorAll('[data-work-id]').length, total: Number(grid.dataset.posterTotal),
        })),
        imageResources: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/assets/artwork/'))
          .filter((entry) => entry.startTime >= began).map((entry) => {
            const resource = entry as PerformanceResourceTiming;
            // transferSize=0 只能说明无可见传输字节，不能单独证明命中缓存。
            return { duration: Math.round(resource.duration), transferSize: resource.transferSize, encodedBodySize: resource.encodedBodySize };
          }),
      });
      running = false;
      start.disabled = false;
    };
    requestAnimationFrame(tick);
  };
  return () => { cancelled = true; host.remove(); document.removeEventListener('visibilitychange', cancel); };
}
