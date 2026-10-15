/**
 * 唯一后端 HTTP 网关（ADR-04）。
 *
 * Renderer 不能提供 URL、method 或 channel；这里只按具名操作白名单
 * 映射到固定回环端点，附会话 Token，统一处理取消、期限、错误与响应校验。
 * 图片不走这里（见 protocols/artwork.ts），也不存在第二个通用 HTTP 客户端。
 */

import { BACKEND_HOST } from '../config';
import {
  OPERATION_SPECS,
  resolveHttpTarget,
  type OperationId,
  type OperationRequest,
} from '@shared/contracts/operations';
import type { GatewayError, OperationOutcome } from '@shared/contracts/errors';
import {
  OPERATION_RESPONSE_PARSERS,
  hasResponseParser,
  interpretFailurePayload,
  protocolFailure,
} from '@shared/contracts/responses';

export interface GatewayContext {
  readonly port: number;
  readonly token: string;
  readonly epoch: number;
}

export interface GatewayDependencies {
  readonly context: () => GatewayContext;
  readonly fetchImpl?: typeof fetch;
  /**
   * 测试接缝：覆盖操作期限，用于在毫秒级验证超时语义。
   * 生产路径不设置该值，始终使用白名单里的 timeoutMs。
   */
  readonly timeoutMsOverride?: number;
}

const PUBLIC_PATHS = new Set(['/api/health']);

export class BackendGateway {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: GatewayDependencies) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async call<T = unknown>(
    request: OperationRequest,
    signal: AbortSignal,
  ): Promise<OperationOutcome<T>> {
    const context = this.deps.context();
    const epoch = context.epoch;
    const spec = OPERATION_SPECS[request.operation];
    if (!spec) {
      return { ok: false, epoch, error: protocolFailure(`未登记的操作：${request.operation}`) };
    }
    if (spec.transport !== 'http') {
      return {
        ok: false,
        epoch,
        error: protocolFailure(`${request.operation} 不是 HTTP 操作`),
      };
    }
    const resolved = resolveHttpTarget(request);
    if (!resolved.ok) {
      return { ok: false, epoch, error: protocolFailure(resolved.reason) };
    }

    const url = new URL(`http://${BACKEND_HOST}:${context.port}${resolved.target.path}`);
    for (const [name, value] of resolved.target.query) {
      url.searchParams.append(name, value);
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!PUBLIC_PATHS.has(resolved.target.path)) {
      headers['X-KumiPlayer-Token'] = context.token;
    }
    let body: string | undefined;
    if (spec.method !== 'GET' && request.body && Object.keys(request.body).length > 0) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }

    const deadline = AbortSignal.timeout(this.deps.timeoutMsOverride ?? spec.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: combined,
        redirect: 'error',
      });
    } catch (error) {
      return { ok: false, epoch, error: classifyTransportError(error, deadline) };
    }

    const payload = await readJson(response);
    if (!response.ok) {
      return { ok: false, epoch, error: interpretFailurePayload(response.status, payload) };
    }
    if (!hasResponseParser(request.operation)) {
      return {
        ok: false,
        epoch,
        error: protocolFailure(`操作 ${request.operation} 缺少响应契约`),
      };
    }
    const parser = OPERATION_RESPONSE_PARSERS[request.operation];
    const parsed = parser(payload);
    if (!parsed.ok) {
      return {
        ok: false,
        epoch,
        error: {
          kind: 'protocol',
          message: `后端响应与契约不符：${parsed.issues.slice(0, 5).join('; ')}`,
          status: response.status,
          retryable: false,
        },
      };
    }
    return { ok: true, epoch, data: parsed.value as T };
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function classifyTransportError(error: unknown, deadline: AbortSignal): GatewayError {
  if (deadline.aborted) {
    return { kind: 'timeout', message: '请求超过期限', retryable: true };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'cancelled', message: '请求已取消', retryable: false };
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code?: unknown }).code ?? '')
    : '';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return { kind: 'unavailable', message: '本地后端未就绪或连接被拒绝', retryable: true };
  }
  return { kind: 'network', message: '无法连接本地后端', retryable: true };
}

/** 供 IPC 层判断一个未知值是否是合法操作 id。 */
export function isKnownOperation(value: unknown): value is OperationId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OPERATION_SPECS, value);
}
