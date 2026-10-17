/**
 * 会话令牌持有者（Renderer 侧）。
 *
 * 浏览器直连路径下令牌由服务端侧注入（开发代理或后端自身托管），
 * 因此这里的默认值是空串。未来 Electron 版本由 preload 在初始化时
 * 通过 `setApiSessionToken` 注入同一次运行期的短期令牌。
 *
 * 令牌只保存在模块内存：不写 localStorage、不写 URL、不写日志。
 */

let apiSessionToken = '';

export function setApiSessionToken(token: string): void {
  apiSessionToken = token.trim();
}

export function hasApiSessionToken(): boolean {
  return apiSessionToken.length > 0;
}

export function apiSessionHeaders(): Readonly<Record<string, string>> {
  return apiSessionToken ? { 'X-KumiPlayer-Token': apiSessionToken } : {};
}
