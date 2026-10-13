import { afterEach, expect, test, vi } from 'vitest';
import { bangumiApi } from '../../src/api/bangumi';
import { systemApi } from '../../src/api/system';
import { api, ApiError } from '../../src/api/client';
import { waitForDesktopBackend } from '../../src/api/backendReadiness';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([true, false])('普通请求超时覆盖响应正文，成功状态=%s', async (ok) => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    signal = options.signal;
    return {
      ok, status: ok ? 200 : 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('fixture', 'AbortError')));
      }),
    };
  }));
  const result = api.get('/api/config').catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30001);
  expect(signal.aborted).toBe(true);
  expect(await result).toMatchObject({ status: 408 });
  expect(await result).toBeInstanceOf(ApiError);
  expect(vi.getTimerCount()).toBe(0);
});

test('带调用方取消信号的请求仍有超时，提前取消可立即结束', async () => {
  vi.useFakeTimers();
  const external = new AbortController();
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('fixture', 'AbortError')));
  })));
  const timedOut = api.post('/fixture', {}, { signal: external.signal }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30001);
  expect(await timedOut).toMatchObject({ status: 408 });
  const cancelled = api.post('/fixture', {}, { signal: external.signal }).catch(error => error);
  external.abort();
  expect(await cancelled).toMatchObject({ status: 408 });
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['headers', 'body'])('启动就绪检测不会因 %s 永久等待', async (stage) => {
  vi.useFakeTimers();
  let completed = false;
  const signals: AbortSignal[] = [];
  const pending = waitForDesktopBackend({
    fetchHealth: (signal) => {
      signals.push(signal);
      return stage === 'headers'
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
    },
  }).catch((error: unknown) => { completed = true; return error; });
  await vi.advanceTimersByTimeAsync(30001);
  expect(completed).toBe(true);
  expect(await pending).toBeInstanceOf(Error);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('正常响应读完后清理超时计时器', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ fixture: true }) })));
  expect(await api.get('/fixture')).toEqual({ fixture: true });
  expect(vi.getTimerCount()).toBe(0);
});


test.each(['bangumi', 'system'])('%s 请求也能在响应正文挂起时结束等待', async (client) => {
  vi.useFakeTimers();
  let completed = false;
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => ({
    ok: true, headers: new Headers({ 'content-type': 'application/json' }),
    json: () => new Promise((_done, fail) => {
      options.signal?.addEventListener('abort', () => fail(new DOMException('fixture', 'AbortError')));
    }),
  })));
  const pending = (client === 'bangumi' ? bangumiApi.verifySession() : systemApi.openFolder('fixture-work'))
    .catch(error => { completed = true; return error; });
  await vi.advanceTimersByTimeAsync(30001);
  expect(completed).toBe(true);
  expect(await pending).toBeInstanceOf(Error);
});
