/**
 * 桌面壳与 Renderer 之间的 IPC 契约（B §5.3 的“桌面IPC契约”）。
 *
 * 只包含可序列化数据：不传 Electron 事件对象、DOM File、类实例。
 */

import type { GatewayError, OperationOutcome } from './errors';
import type { OperationId, OperationRequest } from './operations';

export const BRIDGE_CHANNEL = 'kumiplayer:bridge';
export const DESKTOP_STATUS_CHANNEL = 'kumiplayer:desktop-status';
/** 一元取消消息：只取消本次传输，不取消持久任务。 */
export const CANCEL_CHANNEL = 'kumiplayer:cancel';
/** 窗口控制：只有最小化/最大化/关闭三个具名动作，不接受任意命令。 */
export const WINDOW_CHANNEL = 'kumiplayer:window';

export type BackendPhase =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'recovering'
  | 'stopping'
  | 'failed';

/** 进程保护的真实模式；`heartbeat-only` 不是 Job Object 等价物，不能冒充。 */
export type BackendProtection = 'job-object-helper' | 'heartbeat-only';

export interface DesktopStatus {
  /** 后端运行代次；重启后递增，用于隔离旧请求与旧缓存。 */
  readonly epoch: number;
  readonly phase: BackendPhase;
  readonly protection: BackendProtection;
  readonly runtimeKind: string;
  /** 后端是否已通过鉴权就绪（health 通过且 config 成功）。 */
  readonly authenticated: boolean;
  readonly port: number;
  readonly dataDir: string;
  /** 可公开、可展示的失败原因；不含 Token、凭据与完整路径列表。 */
  readonly lastError?: GatewayError;
}

export interface BridgeRequest extends OperationRequest {}

export type BridgeResponse = OperationOutcome<unknown>;

export interface DesktopBridge {
  /**
   * 运行模式：`live` 走真实后端，`mock` 是完全离线的演示模式。
   * 由桌面壳在启动时确定，Renderer 只读取、不切换、不自动降级。
   */
  readonly mode: DesktopMode;
  /** 唯一业务入口：具名操作白名单。 */
  invoke(request: BridgeRequest): Promise<BridgeResponse>;
  /** 取消指定请求；只取消本次传输，不等于取消持久任务。 */
  cancel(requestId: string): Promise<void>;
  /** 订阅桌面状态；返回退订函数。 */
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  /** 窗口控制。演示模式与正式模式共用同一组具名动作。 */
  readonly windowControls: WindowControls;
}

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
}

export type DesktopMode = 'live' | 'mock';

/** 图片资源 URL：固定应用协议 → 固定回环后端 GET。 */
export interface ArtworkUrlRequest {
  readonly resourceId: string;
  readonly contentVersion: string;
  readonly width: 256 | 384 | 512 | 768 | 1280;
}

export const ARTWORK_WIDTHS: readonly ArtworkUrlRequest['width'][] = [256, 384, 512, 768, 1280];
export const ARTWORK_PROTOCOL = 'kumiplayer-artwork';
export const APP_PROTOCOL = 'kumiplayer-app';

export function isOperationId(value: unknown): value is OperationId {
  return typeof value === 'string';
}
