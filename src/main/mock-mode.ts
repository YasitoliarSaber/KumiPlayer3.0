/**
 * 演示（mock）模式。
 *
 * 该模式必须被显式选择：只有 `KUMIPLAYER_DESKTOP_MOCK=1` 才生效。
 * 生效时桌面主进程**不创建 BackendManager**、不启动 Python/helper、
 * 不做健康检查、鉴权、心跳、WebSocket 或任何业务 HTTP 请求，
 * 也不注册具名业务网关；Renderer 只消费本地演示数据与本地素材。
 */

import type { App } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export function isMockMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KUMIPLAYER_DESKTOP_MOCK === '1';
}

/**
 * 演示模式使用独立 Electron profile，放在 `.build` 下，
 * 避免读取或覆盖用户真实应用的窗口/偏好数据。
 */
export function installMockProfile(app: App, projectRoot: string): string {
  const profileDir = path.join(projectRoot, '.build', 'desktop', 'mock-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  app.setPath('userData', profileDir);
  return profileDir;
}

/**
 * 演示素材根目录（由 scripts/desktop/prepare-mock-assets.cjs 生成）。
 * 目录名与 URL 前缀一致（`__mock/`），浏览器与 Electron 共用同一份素材，
 * 无需为宿主改动 Renderer 代码。
 */
export function mockAssetRoot(projectRoot: string): string | null {
  const root = path.join(projectRoot, '.build', 'mock-assets', '__mock');
  return fs.existsSync(root) ? root : null;
}
