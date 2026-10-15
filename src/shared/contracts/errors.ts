/**
 * 跨进程错误包络（B §5.4）。
 *
 * 这里是纯契约：不得引用 React、Electron、Node 或后端模型。
 * 后端 FastAPI 的 `detail` 可能是字符串，也可能是校验错误列表，
 * 适配器保留真实语义，不强行拼成字符串。
 */

export type GatewayErrorKind =
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'auth'
  | 'validation'
  | 'conflict'
  | 'unavailable'
  | 'internal'
  | 'protocol';

export interface GatewayError {
  readonly kind: GatewayErrorKind;
  /** 可公开、可展示的说明；不得包含 Token、凭据或私人媒体路径。 */
  readonly message: string;
  /** HTTP 状态码；本地失败没有该字段。 */
  readonly status?: number;
  /** 稳定的业务错误码；后端未提供时缺席。 */
  readonly code?: string;
  /** 字段级校验明细；FastAPI 422 的列表在此保留结构。 */
  readonly details?: readonly GatewayValidationIssue[];
  readonly retryable: boolean;
}

export interface GatewayValidationIssue {
  readonly location: string;
  readonly message: string;
  readonly type: string;
}

export interface OperationSuccess<T> {
  readonly ok: true;
  readonly data: T;
  /** 后端运行代次；后端重启后递增，用于隔离旧请求结果。 */
  readonly epoch: number;
}

export interface OperationFailure {
  readonly ok: false;
  readonly error: GatewayError;
  readonly epoch: number;
}

export type OperationOutcome<T> = OperationSuccess<T> | OperationFailure;

export const RETRYABLE_ERROR_KINDS: readonly GatewayErrorKind[] = [
  'network',
  'timeout',
  'unavailable',
  'internal',
];

export function isRetryableKind(kind: GatewayErrorKind): boolean {
  return RETRYABLE_ERROR_KINDS.includes(kind);
}
