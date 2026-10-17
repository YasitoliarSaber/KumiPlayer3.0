/**
 * 浏览器传输层门禁：白名单、期限、取消与错误包络。
 * 只注入假的 fetch，不发起真实网络请求，也不接触真实后端或凭据。
 */

import { describe, expect, it, vi } from 'vitest';

import { createBrowserTransport } from '@/transport/http';
import { normalizeApiBase, resolveRequestUrl } from '@/transport/api-config';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('浏览器 HTTP 传输', () => {
  it('只请求白名单解析出的固定路径，并带上同源凭据', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const transport = createBrowserTransport({ apiBase: '' }, async (input, init) => {
      calls.push({ url: String(input), method: String(init?.method ?? 'GET') });
      return jsonResponse({ work_count: 0, episode_count: 0, works: [], collections: [], change_sequence: 0 });
    });

    const outcome = await transport.call('library.list', { query: { source: 'local' } });
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([{ url: '/api/library?source=local', method: 'GET' }]);
  });

  it('拒绝未登记的查询参数与路径参数', async () => {
    const transport = createBrowserTransport({ apiBase: '' }, async () => jsonResponse({}));
    const extra = await transport.call('library.list', { query: { source: 'local', evil: '1' } });
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.error.kind).toBe('protocol');
    }

    const traversal = await transport.call('work.detail', { params: { workId: '../../etc/passwd' } });
    expect(traversal.ok).toBe(false);
  });

  it('把 401 与 422 映射成可区分的真实语义', async () => {
    const unauthorized = createBrowserTransport({ apiBase: '' }, async () =>
      jsonResponse({ detail: 'KumiPlayer 桌面会话验证失败' }, 401),
    );
    const authFailure = await unauthorized.call('library.list', {});
    expect(authFailure.ok).toBe(false);
    if (!authFailure.ok) {
      expect(authFailure.error.kind).toBe('auth');
      expect(authFailure.error.retryable).toBe(false);
    }

    const invalid = createBrowserTransport({ apiBase: '' }, async () =>
      jsonResponse({ detail: [{ loc: ['body', 'title'], msg: '字段必填', type: 'value_error' }] }, 422),
    );
    const validationFailure = await invalid.call('work.title.set', {
      params: { workId: 'w1' },
      body: { title: '' },
    });
    expect(validationFailure.ok).toBe(false);
    if (!validationFailure.ok) {
      expect(validationFailure.error.kind).toBe('validation');
      expect(validationFailure.error.details?.[0]?.location).toBe('body.title');
    }
  });

  it('连接失败与超时分别映射为 network / timeout', async () => {
    const offline = createBrowserTransport({ apiBase: '' }, async () => {
      throw new TypeError('failed to fetch');
    });
    const networkFailure = await offline.call('library.list', {});
    expect(networkFailure.ok).toBe(false);
    if (!networkFailure.ok) {
      expect(networkFailure.error.kind).toBe('network');
    }

    const slow = createBrowserTransport({ apiBase: '' }, (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
    vi.useFakeTimers();
    const pending = slow.call('library.list', {});
    await vi.advanceTimersByTimeAsync(16_000);
    const timeoutFailure = await pending;
    vi.useRealTimers();
    expect(timeoutFailure.ok).toBe(false);
    if (!timeoutFailure.ok) {
      expect(timeoutFailure.error.kind).toBe('timeout');
    }
  });

  it('调用方取消请求时映射为 cancelled，不当作失败重试', async () => {
    const transport = createBrowserTransport({ apiBase: '' }, (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
    const controller = new AbortController();
    const pending = transport.call('library.list', { signal: controller.signal });
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.error.kind).toBe('cancelled');
      expect(cancelled.error.retryable).toBe(false);
    }
  });

  it('非 JSON 响应按协议错误处理，不把 HTML 当业务数据', async () => {
    const transport = createBrowserTransport({ apiBase: '' }, async () =>
      new Response('<html>未构建</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    const outcome = await transport.call('library.list', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('protocol');
    }
  });

  it('上传与下载只对登记了该能力的操作开放', async () => {
    const transport = createBrowserTransport({ apiBase: '' }, async () => jsonResponse({}));
    const deniedUpload = await transport.upload('library.list', new FormData());
    expect(deniedUpload.ok).toBe(false);

    const deniedDownload = await transport.download('library.list', {});
    expect(deniedDownload.ok).toBe(false);
  });

  it('基地址只做规范化拼接，不写入任何令牌', () => {
    expect(normalizeApiBase('http://127.0.0.1:37821/')).toBe('http://127.0.0.1:37821');
    expect(resolveRequestUrl({ apiBase: 'http://127.0.0.1:37821' }, '/api/library')).toBe(
      'http://127.0.0.1:37821/api/library',
    );
    expect(resolveRequestUrl({ apiBase: '' }, '/api/library')).toBe('/api/library');
  });
});
