/**
 * 服务实现选择。
 *
 * 默认使用真实后端（浏览器 HTTP）。演示实现只在显式演示入口出现：
 * `?demo=1`（或 `?service=demo`）以及构建期 `VITE_RENDERER_SERVICE=demo`
 * 的独立演示产物。真实模式不会在失败后回退到演示数据，
 * 演示模式也不会悄悄访问真实库或启动后端。
 */

export type ServiceMode = 'real' | 'demo';

export interface ServiceModeInfo {
  readonly mode: ServiceMode;
  /** 供界面显示的一行说明；真实模式不展示任何"演示"字样。 */
  readonly label: string;
}

export function resolveServiceMode(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
  buildFlag: string | undefined = import.meta.env.VITE_RENDERER_SERVICE,
): ServiceModeInfo {
  const params = new URLSearchParams(search);
  const explicit = params.get('demo');
  const service = params.get('service');
  if (explicit === '1' || explicit === 'true' || service === 'demo') {
    return { mode: 'demo', label: '演示模式 · 数据来自本机演示素材' };
  }
  if (buildFlag === 'demo') {
    return { mode: 'demo', label: '演示模式 · 数据来自本机演示素材' };
  }
  return { mode: 'real', label: '真实模式 · 数据来自本机 KumiPlayer 后端' };
}
