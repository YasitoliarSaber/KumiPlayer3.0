/** 仅作品墙的短缓动；普通滚动容器、触控板与快速滚动保留原生行为。 */
export function attachPosterWheelSmoothing(main: HTMLElement, wall: HTMLElement): () => void {
  // 参考 Lenis 的按时间阻尼思路，保留原生 scrollTop 与虚拟化坐标；不变换整页。
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let target = main.scrollTop;
  let written = target;
  let previousTime = 0;
  let lastInput = 0;
  let direction = 0;
  let nativeUntil = 0;

  const prefersReducedMotion = () => reducedMotion?.matches || document.documentElement.dataset.motion === 'reduced';
  const stop = () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    direction = 0;
  };
  const finish = () => {
    main.scrollTop = target;
    written = main.scrollTop;
    stop();
  };
  const advance = (time: number) => {
    const elapsed = time - previousTime;
    previousTime = time;
    // 主线程忙或使用减少动态效果时立即结束，不以长惯性掩盖卡顿。
    if (elapsed > 34 || prefersReducedMotion()) {
      nativeUntil = time + 400;
      finish();
      return;
    }
    const current = main.scrollTop;
    if (Math.abs(current - written) > 1) { stop(); return; }
    if (Math.abs(target - current) <= 0.75 || time - lastInput >= 180) { finish(); return; }
    main.scrollTop = current + (target - current) * (1 - Math.exp(-elapsed / 45));
    written = main.scrollTop;
    frame = window.requestAnimationFrame(advance);
  };
  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || !(event.target instanceof Node) || !wall.contains(event.target)) return;
    if (!event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey
      || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || prefersReducedMotion()) {
      stop();
      return;
    }
    const now = performance.now();
    const delta = event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? main.clientHeight : 1);
    const current = main.scrollTop;
    // 细小像素输入通常来自触控板；大幅/快速累计输入直接交还浏览器合成滚动。
    const pending = frame ? Math.abs(target - current) : 0;
    if (Math.abs(delta) < 40 || Math.abs(delta) > 320 || pending + Math.abs(delta) > Math.min(400, main.clientHeight * 0.6)) {
      if (frame) finish();
      nativeUntil = now + 400;
      return;
    }
    if (now < nativeUntil) return;
    const nextDirection = Math.sign(delta);
    if (!frame || nextDirection !== direction) target = current;
    target = Math.max(0, Math.min(main.scrollHeight - main.clientHeight, target + delta));
    if (target === current) { stop(); return; }
    event.preventDefault();
    direction = nextDirection;
    lastInput = now;
    if (!frame) {
      written = current;
      previousTime = now;
      frame = window.requestAnimationFrame(advance);
    }
  };
  const onScroll = () => {
    // 分类恢复位置、键盘焦点或外部程序跳转优先，不能被旧缓动拉回去。
    if (frame && Math.abs(main.scrollTop - written) > 1) stop();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab'].includes(event.key)) stop();
  };
  main.addEventListener('wheel', onWheel, { passive: false });
  main.addEventListener('scroll', onScroll, { passive: true });
  main.addEventListener('pointerdown', stop, { passive: true });
  main.addEventListener('keydown', onKeyDown);
  return () => {
    stop();
    main.removeEventListener('wheel', onWheel);
    main.removeEventListener('scroll', onScroll);
    main.removeEventListener('pointerdown', stop);
    main.removeEventListener('keydown', onKeyDown);
  };
}
