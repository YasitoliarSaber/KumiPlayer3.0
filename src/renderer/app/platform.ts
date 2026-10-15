/**
 * 宿主能力适配入口。
 *
 * 业务组件只读取这里的结果，不散落 `window.kumiplayer` 判断：
 * 普通浏览器没有桌面桥接，因此窗口控件与拖拽区必须整体隐藏，
 * 而不是画一组点了没反应的按钮。
 */

export interface HostCapabilities {
  /** 运行在桌面壳内（有桥接）。 */
  readonly isDesktop: boolean;
  /** 可以控制窗口最小化/最大化/关闭。 */
  readonly hasWindowControls: boolean;
  /** 标题栏可作为窗口拖拽区域。 */
  readonly canDragWindow: boolean;
  /** 可以打开本机日志目录等桌面专属动作。 */
  readonly hasDesktopActions: boolean;
}

export function detectHost(): HostCapabilities {
  const bridge = typeof window === 'undefined' ? undefined : window.kumiplayer;
  const isDesktop = Boolean(bridge);
  return {
    isDesktop,
    hasWindowControls: Boolean(bridge?.windowControls),
    canDragWindow: isDesktop,
    hasDesktopActions: isDesktop,
  };
}
