// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { BackendGateway } from '../../src/main/backend/gateway';
import { loadFixture } from './fixtures';

interface Recorded {
  url: string;
  method: string;
  token: string | undefined;
  signal: AbortSignal | undefined;
}

function gatewayWith(
  responder: (request: Request) => Promise<Response> | Response,
  options: { readonly timeoutMsOverride?: number; readonly token?: string } = {},
) {
  const recorded: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    recorded.push({
      url: request.url,
      method: request.method,
      token: request.headers.get('x-kumiplayer-token') ?? undefined,
      signal: init?.signal ?? undefined,
    });
    return responder(request);
  };
  const gateway = new BackendGateway({
    context: () => ({
      port: 37899,
      token: options.token ?? 'test-token',
      epoch: 7,
    }),
    fetchImpl,
    ...(options.timeoutMsOverride === undefined
      ? {}
      : { timeoutMsOverride: options.timeoutMsOverride }),
  });
  return { gateway, recorded };
}

const request = (operation: Parameters<BackendGateway['call']>[0]['operation']) => ({
  operation,
  requestId: 'req-1',
});

describe('唯一 HTTP 网关', () => {
  it('通过具名操作读取真实夹具响应，并带上运行代次', async () => {
    const fixture = loadFixture('library');
    const { gateway, recorded } = gatewayWith(
      () => Response.json(fixture.body, { status: fixture.status }),
    );
    const outcome = await gateway.call(request('library.list'), new AbortController().signal);
    expect(outcome.ok).toBe(true);
    expect(outcome.epoch).toBe(7);
    expect(recorded[0]?.url).toBe('http://127.0.0.1:37899/api/library');
    expect(recorded[0]?.token).toBe('test-token');
  });

  it('公开健康检查不携带会话令牌', async () => {
    const fixture = loadFixture('health');
    const { gateway, recorded } = gatewayWith(() => Response.json(fixture.body));
    await gateway.call(request('health.get'), new AbortController().signal);
    expect(recorded[0]?.token).toBeUndefined();
  });

  it('401 映射为 auth，且不盲目重试', async () => {
    const fixture = loadFixture('error-unauthorized');
    const { gateway } = gatewayWith(
      () => Response.json(fixture.body, { status: fixture.status }),
    );
    const outcome = await gateway.call(request('config.get'), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('auth');
      expect(outcome.error.retryable).toBe(false);
    }
  });

  it('响应形状不符时判为协议错误，不把坏数据交给界面', async () => {
    const { gateway } = gatewayWith(() => Response.json({ works: 'not-an-array' }));
    const outcome = await gateway.call(request('library.list'), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('protocol');
      expect(outcome.error.message).toContain('后端响应与契约不符');
    }
  });

  it('取消只结束本次传输', async () => {
    const controller = new AbortController();
    const { gateway } = gatewayWith(
      (received) =>
        new Promise<Response>((_resolve, reject) => {
          received.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const pending = gateway.call(request('library.list'), controller.signal);
    controller.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('cancelled');
    }
  });

  it('超过期限映射为可重试的 timeout', async () => {
    const { gateway } = gatewayWith(
      (received) =>
        new Promise<Response>((_resolve, reject) => {
          received.signal?.addEventListener('abort', () => {
            reject(new DOMException('timeout', 'AbortError'));
          });
        }),
      { timeoutMsOverride: 30 },
    );
    const outcome = await gateway.call(request('library.list'), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('timeout');
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('后端未启动时映射为可重试的 unavailable', async () => {
    const { gateway } = gatewayWith(() => {
      const error = new Error('connect ECONNREFUSED') as Error & { cause?: unknown };
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    });
    const outcome = await gateway.call(request('library.list'), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('unavailable');
    }
  });
});
