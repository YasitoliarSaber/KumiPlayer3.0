/**
 * 窄桥接：只公开具名方法，不公开 `invoke(channel, ...)`、任意文件读写或通用 HTTP。
 *
 * 沙箱内 preload 只能是 CJS，且不使用 Node 独占能力；
 * 订阅回调剥离 Electron 事件对象，窗口销毁时由调用方退订。
 */

import { contextBridge, ipcRenderer } from 'electron';

import {
  BRIDGE_CHANNEL,
  CANCEL_CHANNEL,
  DESKTOP_STATUS_CHANNEL,
  WINDOW_CHANNEL,
  type BridgeRequest,
  type BridgeResponse,
  type DesktopBridge,
  type DesktopMode,
  type DesktopStatus,
  type WindowAction,
} from '@shared/contracts/desktop';

const MAX_DEPTH = 4;
const MAX_KEYS = 64;

/** 只复制可结构化克隆的原始值，避免把函数、原型或类实例送进 IPC。 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    throw new Error('桥接参数嵌套过深');
  }
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value;
  }
  if (type === 'undefined') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1));
  }
  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_KEYS) {
      throw new Error('桥接参数字段过多');
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      output[key] = sanitize(entry, depth + 1);
    }
    return output;
  }
  throw new Error('桥接参数包含不可序列化的值');
}

/**
 * 运行模式由桌面壳的环境显式决定：演示模式必须被明确选择，
 * 不会因为真实后端失败而自动切换成假数据。
 */
const MODE: DesktopMode = process.env.KUMIPLAYER_DESKTOP_MOCK === '1' ? 'mock' : 'live';

const bridge: DesktopBridge = {
  mode: MODE,
  async invoke(request: BridgeRequest): Promise<BridgeResponse> {
    const payload = sanitize(request) as BridgeRequest;
    return (await ipcRenderer.invoke(BRIDGE_CHANNEL, payload)) as BridgeResponse;
  },
  async cancel(requestId: string): Promise<void> {
    ipcRenderer.send(CANCEL_CHANNEL, requestId);
  },
  onStatus(listener: (status: DesktopStatus) => void): () => void {
    const handler = (_event: unknown, status: DesktopStatus) => {
      listener(status);
    };
    ipcRenderer.on(DESKTOP_STATUS_CHANNEL, handler);
    return () => {
      ipcRenderer.off(DESKTOP_STATUS_CHANNEL, handler);
    };
  },
  windowControls: {
    async minimize(): Promise<void> {
      await ipcRenderer.invoke(WINDOW_CHANNEL, 'minimize' satisfies WindowAction);
    },
    async toggleMaximize(): Promise<boolean> {
      return Boolean(await ipcRenderer.invoke(WINDOW_CHANNEL, 'toggleMaximize' satisfies WindowAction));
    },
    async close(): Promise<void> {
      await ipcRenderer.invoke(WINDOW_CHANNEL, 'close' satisfies WindowAction);
    },
    async isMaximized(): Promise<boolean> {
      return Boolean(await ipcRenderer.invoke(WINDOW_CHANNEL, 'isMaximized'));
    },
  },
};

contextBridge.exposeInMainWorld('kumiplayer', bridge);
