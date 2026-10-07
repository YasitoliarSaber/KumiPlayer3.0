// 仅分类切换时短暂等待实际视口；不等待 overscan、整库图片或阻塞后续导航。
export function startPosterPresentation(grid: HTMLElement): () => void {
  const main = grid.closest<HTMLElement>('.app-main');
  let stopped = false;
  let frame = 0;
  let observer: MutationObserver | undefined;
  grid.dataset.presentation = 'preparing';
  grid.setAttribute('inert', '');
  grid.setAttribute('aria-busy', 'true');

  const stop = () => {
    stopped = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timeout);
    observer?.disconnect();
  };
  const reveal = () => {
    if (stopped) return;
    stop();
    grid.dataset.presentation = 'ready';
    grid.removeAttribute('inert');
    grid.removeAttribute('aria-busy');
  };
  const check = () => {
    frame = 0;
    if (stopped || !grid.querySelector('.poster-card')) return;
    const top = main?.getBoundingClientRect().top ?? 0;
    const bottom = top + (main?.clientHeight ?? window.innerHeight);
    const images = [...grid.querySelectorAll<HTMLImageElement>('.poster-managed-image')]
      .filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > top && rect.top < bottom;
      });
    if (images.every(image => ['ready', 'error'].includes(image.dataset.state ?? ''))) reveal();
  };
  const schedule = () => {
    if (!stopped && !frame) frame = window.requestAnimationFrame(check);
  };
  // 慢图、未生成缩略图和隐藏窗口不能无限锁住页面；超时后仍按单图解码渐显。
  const timeout = window.setTimeout(reveal, 500);
  // 分类页在第一帧恢复 scrollTop，下一帧才按最终视口选择等待对象。
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    if (stopped) return;
    observer = new MutationObserver(schedule);
    observer.observe(grid, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
    schedule();
  });
  return () => {
    stop();
    delete grid.dataset.presentation;
    grid.removeAttribute('inert');
    grid.removeAttribute('aria-busy');
  };
}
