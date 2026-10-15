/// <reference types="vite/client" />

import type { DesktopBridge } from '@shared/contracts/desktop';

declare global {
  interface Window {
    /** 桌面壳注入的桥接；普通浏览器中不存在，页面不得假定它一定存在。 */
    readonly kumiplayer?: DesktopBridge;
  }
}

export {};
