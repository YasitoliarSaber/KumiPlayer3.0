/**
 * 窗口控制 IPC。
 *
 * 只接受三个具名动作，且只作用于发起调用的那个受信窗口；
 * 不提供任意命令、不暴露 BrowserWindow 实例。
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { WINDOW_CHANNEL, type WindowAction } from '@shared/contracts/desktop';

import { APP_ORIGIN } from '../protocols/app-protocol';

export function registerWindowControls(listWindows: () => WebContents[]): void {
  ipcMain.handle(WINDOW_CHANNEL, (event: IpcMainInvokeEvent, raw: unknown) => {
    if (!trusted(event, listWindows())) {
      return null;
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return null;
    }
    const action = raw as WindowAction | 'isMaximized';
    switch (action) {
      case 'minimize':
        window.minimize();
        return true;
      case 'toggleMaximize':
        if (window.isMaximized()) {
          window.unmaximize();
        } else {
          window.maximize();
        }
        return window.isMaximized();
      case 'close':
        window.close();
        return true;
      case 'isMaximized':
        return window.isMaximized();
      default:
        return null;
    }
  });
}

function trusted(event: IpcMainInvokeEvent, windows: WebContents[]): boolean {
  const sender = event.sender;
  if (!windows.includes(sender)) {
    return false;
  }
  const frame = event.senderFrame;
  if (!frame || frame !== sender.mainFrame) {
    return false;
  }
  return frame.url.startsWith(APP_ORIGIN) || frame.url.startsWith('http://127.0.0.1:');
}
