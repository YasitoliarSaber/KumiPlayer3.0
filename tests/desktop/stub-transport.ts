/**
 * 真实服务测试用的桩传输层。
 *
 * 只按具名操作返回调用方给定的载荷或失败原因，不发起任何网络请求，
 * 也不接触真实后端、真实数据与真实凭据。
 */

import type { OperationId } from '@shared/contracts/operations';
import type { GatewayError, OperationOutcome } from '@shared/contracts/errors';
import type { BrowserTransport, CallOptions } from '@/transport/http';

export interface RecordedCall {
  readonly operation: OperationId;
  readonly options: CallOptions;
}

export function createStubTransport(
  responses: Partial<Record<OperationId, unknown>> = {},
  recorded: RecordedCall[] = [],
  failures: Partial<Record<OperationId, string>> = {},
): BrowserTransport {
  return {
    async call<T>(operation: OperationId, options: CallOptions = {}): Promise<OperationOutcome<T>> {
      recorded.push({ operation, options });
      const failure = failures[operation];
      if (failure !== undefined) {
        const error: GatewayError = { kind: 'validation', message: failure, retryable: false };
        return { ok: false, error, epoch: 0 };
      }
      if (!(operation in responses)) {
        const error: GatewayError = { kind: 'unavailable', message: '桩未定义该操作', retryable: false };
        return { ok: false, error, epoch: 0 };
      }
      return { ok: true, data: responses[operation] as T, epoch: 0 };
    },
    async upload<T>(operation: OperationId, form: FormData, options: CallOptions = {}): Promise<OperationOutcome<T>> {
      recorded.push({ operation, options });
      void form;
      return { ok: true, data: (responses[operation] ?? {}) as T, epoch: 0 };
    },
    async download(operation: OperationId) {
      recorded.push({ operation, options: {} });
      return { ok: true, blob: new Blob(['zip']), filename: 'kumiplayer-backup.kumibak' };
    },
  };
}
