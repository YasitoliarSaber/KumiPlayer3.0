/**
 * Renderer 侧唯一业务 facade（B 5.1）。
 *
 * 只负责生成请求标识、调用具名操作与呈现错误；不提供任意 URL/channel，
 * 也不实现第二套 HTTP 客户端。
 */

import type { OperationOutcome } from '@shared/contracts/errors';
import type { OperationId } from '@shared/contracts/operations';
import type { DesktopBridge, BridgeRequest } from '@shared/contracts/desktop';

export interface CallOptions {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface BridgeFacade {
  call<T>(operation: OperationId, options?: CallOptions): Promise<OperationOutcome<T>>;
}

let counter = 0;

export function nextRequestId(): string {
  counter += 1;
  return `r${counter}-${Date.now().toString(36)}`;
}

export function createBridgeFacade(
  resolveBridge: () => DesktopBridge | undefined = () =>
    typeof window === 'undefined' ? undefined : window.kumiplayer,
): BridgeFacade {
  return {
    async call<T>(operation: OperationId, options: CallOptions = {}): Promise<OperationOutcome<T>> {
      const bridge = resolveBridge();
      if (!bridge) {
        return {
          ok: false,
          epoch: 0,
          error: {
            kind: 'protocol',
            message: '当前环境没有桌面桥接（请在桌面客户端内运行）',
            retryable: false,
          },
        };
      }
      const requestId = nextRequestId();
      const request: BridgeRequest = {
        operation,
        requestId,
        ...(options.params === undefined ? {} : { params: options.params }),
        ...(options.query === undefined ? {} : { query: options.query }),
        ...(options.body === undefined ? {} : { body: options.body }),
      };
      const signal = options.signal;
      const onAbort = () => {
        void bridge.cancel(requestId);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const outcome = (await bridge.invoke(request)) as OperationOutcome<T>;
        return outcome;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
