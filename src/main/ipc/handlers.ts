/**
 * 具名 IPC handler（B 9.1）。
 *
 * 只接受已登记操作；校验发起者 webContents、主 frame 与来源 URL；
 * 不接受 Renderer 提供的 URL、method、channel，也不暴露任何通用代理。
 */

import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  BRIDGE_CHANNEL,
  CANCEL_CHANNEL,
  DESKTOP_STATUS_CHANNEL,
  APP_PROTOCOL,
  type BridgeRequest,
  type BridgeResponse,
  type DesktopStatus,
} from '@shared/contracts/desktop';
import { OPERATION_SPECS, type OperationId } from '@shared/contracts/operations';
import { protocolFailure } from '@shared/contracts/responses';

import type { BackendManager } from '../backend/manager';
import type { BackendGateway } from '../backend/gateway';

export interface BridgeIpcOptions {
  readonly gateway: BackendGateway;
  readonly manager: BackendManager;
  readonly listWindows: () => WebContents[];
}

const MAX_REQUEST_ID_LENGTH = 128;

export function registerBridgeIpc(options: BridgeIpcOptions): void {
  const inflight = new Map<string, AbortController>();

  ipcMain.handle(BRIDGE_CHANNEL, async (event, raw: unknown): Promise<BridgeResponse> => {
    const trusted = trustedSender(event, options.listWindows());
    if (!trusted) {
      return {
        ok: false,
        epoch: options.manager.status().epoch,
        error: protocolFailure('拒绝来自非受信来源的桥接调用'),
      };
    }
    const request = parseRequest(raw);
    if (!request) {
      return {
        ok: false,
        epoch: options.manager.status().epoch,
        error: protocolFailure('桥接请求形状非法'),
      };
    }

    const spec = OPERATION_SPECS[request.operation];
    if (spec.transport === 'local') {
      return handleLocal(request.operation, options);
    }

    const controller = new AbortController();
    inflight.set(request.requestId, controller);
    try {
      return await options.gateway.call(request, controller.signal);
    } finally {
      inflight.delete(request.requestId);
    }
  });

  // 取消是一元消息：只取消本次传输，不取消已受理的持久任务。
  ipcMain.on(CANCEL_CHANNEL, (event, raw: unknown) => {
    if (!trustedSender(event, options.listWindows())) {
      return;
    }
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_REQUEST_ID_LENGTH) {
      return;
    }
    inflight.get(raw)?.abort();
  });
}

export function broadcastStatus(windows: WebContents[], status: DesktopStatus): void {
  for (const contents of windows) {
    if (!contents.isDestroyed()) {
      contents.send(DESKTOP_STATUS_CHANNEL, status);
    }
  }
}

/** 只接受受信主框架；子框架、未知窗口与其它来源一律拒绝。 */
function trustedSender(event: IpcMainInvokeEvent, windows: WebContents[]): boolean {
  const sender = event.sender;
  if (!windows.includes(sender)) {
    return false;
  }
  const frame = event.senderFrame;
  if (!frame || frame !== sender.mainFrame) {
    return false;
  }
  try {
    const url = new URL(frame.url);
    return url.protocol === `${APP_PROTOCOL}:`;
  } catch {
    return false;
  }
}

function parseRequest(raw: unknown): BridgeRequest | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const operation = record.operation;
  if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(OPERATION_SPECS, operation)) {
    return null;
  }
  const requestId = record.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }
  if (record.params !== undefined && typeof record.params !== 'object') {
    return null;
  }
  if (record.query !== undefined && typeof record.query !== 'object') {
    return null;
  }
  if (record.body !== undefined && typeof record.body !== 'object') {
    return null;
  }
  return {
    operation: operation as OperationId,
    requestId,
    ...(record.params === undefined ? {} : { params: record.params as Record<string, string> }),
    ...(record.query === undefined ? {} : { query: record.query as Record<string, string> }),
    ...(record.body === undefined ? {} : { body: record.body as Record<string, unknown> }),
  };
}

function handleLocal(operation: OperationId, options: BridgeIpcOptions): BridgeResponse {
  const epoch = options.manager.status().epoch;
  switch (operation) {
    case 'desktop.status':
      return { ok: true, epoch, data: options.manager.status() };
    case 'desktop.restartBackend':
      void options.manager.restart();
      return { ok: true, epoch, data: { accepted: true } };
    case 'desktop.openLogs': {
      const logsDir = path.join(options.manager.status().dataDir, 'logs');
      if (!fs.existsSync(logsDir)) {
        return {
          ok: false,
          epoch,
          error: { kind: 'unavailable', message: '日志目录尚未创建', retryable: false },
        };
      }
      void shell.openPath(logsDir);
      return { ok: true, epoch, data: { opened: true } };
    }
    case 'desktop.diagnostics': {
      // 只收集脱敏状态：不含 Token、凭据、媒体路径与请求日志。
      const status = options.manager.status();
      return {
        ok: true,
        epoch,
        data: {
          epoch: status.epoch,
          phase: status.phase,
          protection: status.protection,
          runtimeKind: status.runtimeKind,
          port: status.port,
          authenticated: status.authenticated,
          lastErrorKind: status.lastError?.kind ?? '',
          lastErrorMessage: status.lastError?.message ?? '',
          hasLogDirectory: fs.existsSync(path.join(status.dataDir, 'logs')),
        },
      };
    }
    default:
      return { ok: false, epoch, error: protocolFailure(`未登记的本地操作：${operation}`) };
  }
}
