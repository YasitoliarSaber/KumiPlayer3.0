/**
 * 浏览器唯一的后端传输实现。
 *
 * 约束（B §5.1 / §5.4）：
 * - 只能调用 `OPERATION_SPECS` 里登记的具名操作；路径、方法与查询参数都由
 *   白名单解析得出，调用方不能提供 URL、method 或 channel。
 * - 每个操作有显式期限；调用方不能自行放宽。
 * - 错误统一成 `GatewayError`，保留后端 `detail` 的真实语义（字符串或校验列表）。
 * - 不记录令牌、完整 URL 或私人路径；日志只允许出现在调用方并且必须是脱敏的。
 */

import type { GatewayError, GatewayValidationIssue, OperationOutcome } from '@shared/contracts/errors';
import {
  resolveHttpTarget,
  OPERATION_SPECS,
  type OperationId,
  type OperationSpec,
} from '@shared/contracts/operations';

import { resolveAppConfig, resolveRequestUrl, type AppRuntimeConfig } from './api-config';
import { apiSessionHeaders } from './session';

export interface CallOptions {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface BrowserTransport {
  call<T>(operation: OperationId, options?: CallOptions): Promise<OperationOutcome<T>>;
  /** 受限上传：只有登记了 `accepts: 'multipart'` 的操作允许走这条通道。 */
  upload<T>(operation: OperationId, form: FormData, options?: CallOptions): Promise<OperationOutcome<T>>;
  /** 受限下载：用于备份导出等明确的二进制响应。 */
  download(operation: OperationId, options?: CallOptions): Promise<
    { readonly ok: true; readonly blob: Blob; readonly filename: string } | { readonly ok: false; readonly error: GatewayError }
  >;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `b${requestCounter}-${Date.now().toString(36)}`;
}

function failure(kind: GatewayError['kind'], message: string, extra: Partial<GatewayError> = {}): GatewayError {
  return {
    kind,
    message,
    retryable: kind === 'network' || kind === 'timeout' || kind === 'unavailable' || kind === 'internal',
    ...extra,
  };
}

/** FastAPI 的 `detail` 既可能是字符串，也可能是校验问题列表。 */
function readDetail(payload: unknown): { message: string; details?: readonly GatewayValidationIssue[] } {
  if (typeof payload === 'string') {
    return { message: payload };
  }
  if (Array.isArray(payload)) {
    const details: GatewayValidationIssue[] = [];
    for (const entry of payload) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const location = Array.isArray(record.loc) ? record.loc.map((part) => String(part)).join('.') : '';
      details.push({
        location,
        message: typeof record.msg === 'string' ? record.msg : '校验失败',
        type: typeof record.type === 'string' ? record.type : 'unknown',
      });
    }
    const first = details[0];
    return {
      message: first ? `${first.location || '请求'}：${first.message}` : '请求参数校验失败',
      details,
    };
  }
  if (typeof payload === 'object' && payload !== null) {
    const detail = (payload as Record<string, unknown>).detail;
    if (detail !== undefined && detail !== payload) {
      return readDetail(detail);
    }
  }
  return { message: '请求失败' };
}

function errorForStatus(status: number, payload: unknown): GatewayError {
  const { message, details } = readDetail(payload);
  if (status === 401 || status === 403) {
    return failure('auth', message || '会话验证失败，请检查本机后端与开发代理配置', { status });
  }
  if (status === 400 || status === 422) {
    return failure('validation', message, { status, ...(details ? { details } : {}) });
  }
  if (status === 409) {
    return failure('conflict', message, { status });
  }
  if (status === 404) {
    return failure('unavailable', message || '后端没有这个资源', { status });
  }
  if (status === 503 || status === 502) {
    return failure('unavailable', message || '后端暂时不可用', { status });
  }
  if (status >= 500) {
    return failure('internal', message || `后端内部错误（${status}）`, { status });
  }
  return failure('protocol', message || `未预期的响应状态 ${status}`, { status });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { detail: text.slice(0, 200) };
  }
}

function contentTypeIsJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
}

export function createBrowserTransport(
  config: AppRuntimeConfig = resolveAppConfig(),
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): BrowserTransport {
  async function send(
    operation: OperationId,
    options: CallOptions,
    body: BodyInit | undefined,
    isForm: boolean,
  ): Promise<
    { readonly ok: true; readonly response: Response; readonly payload: unknown } | { readonly ok: false; readonly error: GatewayError }
  > {
    const spec: OperationSpec | undefined = OPERATION_SPECS[operation];
    if (!spec || spec.transport !== 'http') {
      return { ok: false, error: failure('protocol', `未登记的 HTTP 操作：${String(operation)}`) };
    }
    const resolved = resolveHttpTarget({
      operation,
      requestId: nextRequestId(),
      ...(options.params ? { params: options.params } : {}),
      ...(options.query ? { query: options.query } : {}),
      ...(options.body ? { body: options.body } : {}),
    });
    if (!resolved.ok) {
      return { ok: false, error: failure('protocol', resolved.reason) };
    }

    const search = new URLSearchParams();
    for (const [name, value] of resolved.target.query) {
      search.append(name, value);
    }
    const query = search.toString();
    const url = resolveRequestUrl(config, `${resolved.target.path}${query ? `?${query}` : ''}`);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, spec.timeoutMs);
    const callerSignal = options.signal;
    let callerAborted = false;
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort();
    };
    if (callerSignal) {
      if (callerSignal.aborted) {
        onCallerAbort();
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    try {
      const response = await fetchImpl(url, {
        method: resolved.target.method,
        headers: {
          ...apiSessionHeaders(),
          ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const payload = contentTypeIsJson(response) ? await readJson(response) : null;
      if (!response.ok) {
        return {
          ok: false,
          error: contentTypeIsJson(response)
            ? errorForStatus(response.status, payload)
            : failure('protocol', `后端返回了非 JSON 响应（${response.status}）`, { status: response.status }),
        };
      }
      if (!contentTypeIsJson(response)) {
        return { ok: false, error: failure('protocol', '后端返回了非 JSON 响应，无法解析业务数据') };
      }
      return { ok: true, response, payload };
    } catch (error) {
      if (callerAborted) {
        return { ok: false, error: failure('cancelled', '请求已取消') };
      }
      if (timedOut) {
        return { ok: false, error: failure('timeout', '请求超时，请重试') };
      }
      if (error instanceof TypeError) {
        return {
          ok: false,
          error: failure('network', '无法连接本机 KumiPlayer 后端，请确认后端已启动'),
        };
      }
      return { ok: false, error: failure('internal', '请求未能完成') };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  return {
    async call<T>(operation: OperationId, options: CallOptions = {}): Promise<OperationOutcome<T>> {
      const result = await send(
        operation,
        options,
        options.body === undefined ? undefined : JSON.stringify(options.body),
        false,
      );
      if (!result.ok) {
        return { ok: false, error: result.error, epoch: 0 };
      }
      return { ok: true, data: result.payload as T, epoch: 0 };
    },

    async upload<T>(operation: OperationId, form: FormData, options: CallOptions = {}): Promise<OperationOutcome<T>> {
      const spec: OperationSpec | undefined = OPERATION_SPECS[operation];
      if (!spec || spec.transport !== 'http' || spec.upload !== true) {
        return {
          ok: false,
          error: failure('protocol', `${String(operation)} 不接受上传`),
          epoch: 0,
        };
      }
      const result = await send(operation, options, form, true);
      if (!result.ok) {
        return { ok: false, error: result.error, epoch: 0 };
      }
      return { ok: true, data: result.payload as T, epoch: 0 };
    },

    async download(operation: OperationId, options: CallOptions = {}) {
      const spec: OperationSpec | undefined = OPERATION_SPECS[operation];
      if (!spec || spec.transport !== 'http' || spec.download !== true) {
        return { ok: false, error: failure('protocol', `${String(operation)} 不提供下载`) };
      }
      const resolved = resolveHttpTarget({ operation, requestId: nextRequestId(), ...(options.query ? { query: options.query } : {}) });
      if (!resolved.ok) {
        return { ok: false, error: failure('protocol', resolved.reason) };
      }
      const url = resolveRequestUrl(config, resolved.target.path);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: resolved.target.method,
          headers: apiSessionHeaders(),
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) {
          return { ok: false, error: errorForStatus(response.status, await readJson(response)) };
        }
        const disposition = response.headers.get('content-disposition') ?? '';
        const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
        const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, '')) : 'kumiplayer-backup.kumibak';
        return { ok: true, blob: await response.blob(), filename };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, error: failure('timeout', '下载超时，请重试') };
        }
        return { ok: false, error: failure('network', '无法连接本机 KumiPlayer 后端') };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 供测试与调用方复用：把非 JSON 载荷解释成可公开的错误描述。 */
export { readDetail as readBackendDetail };
