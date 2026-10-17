/**
 * 浏览器传输的运行期配置。
 *
 * 只描述"连到哪里"，不携带任何秘密：
 * - 默认同源（`''`）：开发期由 Vite 开发服务器把 `/api` 代理到本机后端，
 *   生产期由后端自身托管构建产物，两种情况下会话令牌都由服务端侧注入，
 *   浏览器进程里不存在 Token。
 * - 允许通过 `VITE_API_BASE`（非秘密）或运行时注入的
 *   `window.__KUMIPLAYER_APP_CONFIG__.apiBase` 指向另一个本机地址。
 *
 * 绝不读取 `VITE_*` 形式的令牌，也不把令牌写进 URL、localStorage 或日志。
 */

export interface AppRuntimeConfig {
  /** 后端 API 基地址；空字符串表示与页面同源。 */
  readonly apiBase: string;
  /**
   * 仅开发期由本机开发服务器注入的会话令牌（服务端侧读取进程环境变量后写入页面）。
   * 不来自 `VITE_*`、不落 localStorage、不进 URL 与日志；生产桌面版由 preload 注入。
   */
  readonly apiToken?: string;
}

declare global {
  interface Window {
    readonly __KUMIPLAYER_APP_CONFIG__?: Partial<AppRuntimeConfig>;
  }
}

const DEFAULT_CONFIG: AppRuntimeConfig = { apiBase: '' };

/** 去掉末尾斜杠，避免与已登记路径拼接出 `//api`。 */
export function normalizeApiBase(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function resolveAppConfig(): AppRuntimeConfig {
  const injected = typeof window === 'undefined' ? undefined : window.__KUMIPLAYER_APP_CONFIG__;
  if (injected && typeof injected.apiBase === 'string') {
    return {
      apiBase: normalizeApiBase(injected.apiBase),
      ...(typeof injected.apiToken === 'string' ? { apiToken: injected.apiToken } : {}),
    };
  }
  const fromEnv = import.meta.env.VITE_API_BASE;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { apiBase: normalizeApiBase(fromEnv) };
  }
  return DEFAULT_CONFIG;
}

/** 拼接基地址与已登记路径；查询串由调用方在路径上给出。 */
export function resolveRequestUrl(config: AppRuntimeConfig, path: string): string {
  return `${config.apiBase}${path}`;
}
