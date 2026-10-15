import { createContext, useContext } from 'react';

/**
 * 主滚动容器引用：海报虚拟化需要与页面共享同一个原生滚动区。
 * 单独成文件，避免 AppShell 与页面组件互相 import 造成循环依赖。
 */
export const MainScrollContext = createContext<{ readonly current: HTMLElement | null }>({
  current: null,
});

export function useMainScroll(): { readonly current: HTMLElement | null } {
  return useContext(MainScrollContext);
}
