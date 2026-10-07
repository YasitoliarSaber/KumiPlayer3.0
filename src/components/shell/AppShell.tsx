import { type CSSProperties, type ReactNode, useEffect } from 'react';
import Sidebar from './Sidebar';
import DesktopTitleBar from './DesktopTitleBar';
import { SIDEBAR_WIDTHS, useUiStore } from '../../stores/ui';
import { isScrollDiagnosticsEnabled, recordScrollDiagnostic, subscribeScrollDiagnostics } from '../../utils/scrollDiagnostics';

interface AppShellProps {
  children: ReactNode;
}

/** 诊断采样的最小间隔：采样本身不能变成滚动热路径。 */
const DIAGNOSTIC_SAMPLE_INTERVAL_MS = 100;

export default function AppShell({ children }: AppShellProps) {
  const sidebarMode = useUiStore((state) => state.sidebarMode);

  // 诊断采样（默认关闭）：只在显式开启后挂载被动监听，直接写内存环形缓冲，
  // 不进入 React 状态、不逐次输出日志，也不改变原生滚动行为。
  useEffect(() => {
    let detach: (() => void) | undefined;
    const sync = () => {
      detach?.();
      detach = undefined;
      if (!isScrollDiagnosticsEnabled()) return undefined;
      const container = document.querySelector<HTMLElement>('main.app-main');
      if (!container) return undefined;
      let scrollEvents = 0;
      let wheelEvents = 0;
      const lastSampleAt: Record<string, number> = {};
      const sample = (kind: string, extra?: Record<string, number | boolean>) => {
        const now = performance.now();
        if (now - (lastSampleAt[kind] ?? -Infinity) < DIAGNOSTIC_SAMPLE_INTERVAL_MS) return;
        lastSampleAt[kind] = now;
        recordScrollDiagnostic(kind, {
          scrollTop: Math.round(container.scrollTop),
          scrollEvents,
          wheelEvents,
          ...extra,
        });
      };
      const onScroll = () => {
        scrollEvents += 1;
        sample('scroll');
      };
      const onWheel = (event: WheelEvent) => {
        wheelEvents += 1;
        sample('wheel', { deltaY: Math.round(event.deltaY) });
      };
      container.addEventListener('scroll', onScroll, { passive: true });
      container.addEventListener('wheel', onWheel, { passive: true });
      detach = () => {
        container.removeEventListener('scroll', onScroll);
        container.removeEventListener('wheel', onWheel);
      };
    };
    sync();
    const unsubscribe = subscribeScrollDiagnostics(sync);
    return () => { unsubscribe(); detach?.(); };
  }, []);

  return (
    <div
      className={`app-shell sidebar-${sidebarMode} flex min-h-screen`}
      style={{
        background: 'var(--app-bg)',
        '--sidebar-width': `${SIDEBAR_WIDTHS[sidebarMode]}px`,
      } as CSSProperties}
    >
      <DesktopTitleBar />
      <Sidebar />
      <main className="app-main flex-1">
        <div className="app-content px-4 pb-5 2xl:px-6">{children}</div>
      </main>
    </div>
  );
}
