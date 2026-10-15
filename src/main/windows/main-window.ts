/**
 * 主窗口：只负责窗口安全边界与导航策略，不承载业务。
 */

import { BrowserWindow, session, shell } from 'electron';
import path from 'node:path';

import { APP_PROTOCOL } from '@shared/contracts/desktop';
import { APP_ORIGIN, appDocumentUrl } from '../protocols/app-protocol';

export interface MainWindowOptions {
  readonly preloadPath: string;
  /** 开发模式下由 electron-vite 提供；生产模式使用受控应用协议。 */
  readonly devServerUrl?: string | undefined;
  /** 验证模式保持窗口不显示，避免干扰用户当前会话。 */
  readonly autoShow?: boolean;
  /**
   * 验证模式需要在离屏位置短暂显示窗口：Chromium 对完全隐藏的窗口
   * 不保证产出合成帧，capturePage 会失败。离屏显示不抢焦点。
   */
  readonly offscreenVerify?: boolean;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const autoShow = options.autoShow ?? true;
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    // 隐藏窗口时仍允许渲染与截图，验证模式因此不需要弹出可见窗口。
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.resolve(options.preloadPath),
    },
  });

  if (autoShow) {
    if (options.offscreenVerify) {
      window.once('ready-to-show', () => {
        window.setBounds({ x: -20000, y: -20000, width: 1280, height: 800 });
        window.showInactive();
      });
    } else {
      window.once('ready-to-show', () => {
        window.show();
      });
    }
  }

  // 导航策略：只允许受控应用源；其它一律交给系统浏览器，绝不在权限窗口内加载。
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      void openExternalSafely(url);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadURL(appDocumentUrl());
  }
  return window;
}

/** 显式权限策略：默认拒绝，只有明确的 https 外链才交给系统。 */
export function installPermissionPolicy(target: Electron.Session = session.defaultSession): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  target.setPermissionCheckHandler(() => false);
}

async function openExternalSafely(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== 'https:') {
    return;
  }
  await shell.openExternal(url.href);
}

export const APP_SCHEME = APP_PROTOCOL;
