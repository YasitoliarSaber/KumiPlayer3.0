import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackRefresh } from '../../src/renderer/features/playback/PlaybackRefresh';
import { ServiceProvider, useWorkDetail } from '../../src/renderer/shared/api/service-context';
import { createMockMediaService } from '../../src/renderer/mock/service';
import { buildMockCatalog, buildMockDetail } from '../../src/renderer/mock/catalog';
import { createHttpMediaService } from '../../src/renderer/services/real/service';
import { createStubTransport, type RecordedCall } from './stub-transport';

const catalog = buildMockCatalog();
const work = buildMockDetail(catalog.works[0]!, catalog);

describe('返回网页后按事件刷新播放进度', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('空闲不轮询，重复前台事件合并，隐藏与卸载后不请求', async () => {
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let position = 10;
    const getWorkDetail = vi.fn(async () => ({ ...work, progress: {
      episodeId: 'episode', episodeCode: '01', episodeTitle: '第一集', position, duration: 1000, completed: false, updatedAt: '',
    } }));
    const service = { ...createMockMediaService({ catalog, latencyMs: 0 }), serviceMode: 'real' as const, getWorkDetail };
    function Probe() {
      const detail = useWorkDetail(work.id);
      return <span>位置 {detail.data?.progress?.position}</span>;
    }
    const view = render(<QueryClientProvider client={client}><ServiceProvider service={service}>
      <PlaybackRefresh /><Probe />
    </ServiceProvider></QueryClientProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getWorkDetail).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(getWorkDetail).toHaveBeenCalledTimes(1);
    position = 420;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(getWorkDetail).toHaveBeenCalledTimes(2);
    expect(screen.getByText('位置 420')).toBeTruthy();
    visible.mockReturnValue('hidden');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(getWorkDetail).toHaveBeenCalledTimes(2);
    visible.mockReturnValue('visible');
    act(() => { window.dispatchEvent(new Event('focus')); });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(getWorkDetail).toHaveBeenCalledTimes(2);
    client.clear();
  });
});

describe('详情用后端内存进度覆盖较旧的保存记录', () => {
  const detail = { work_id: 'work', title: '作品', seasons: [], episodes: [
    { episode_id: 'ep', episode_number: 10, title: '我们没有明天', runtime: 24 },
  ] };
  const saved = { items: [{ work_id: 'work', episode_id: 'ep', position: 100, duration: 1500, completed: false }] };

  it('当前 MPV 位置优先，保留真实时长与剧集目标，全部为只读请求', async () => {
    const calls: RecordedCall[] = [];
    const service = createHttpMediaService({ transport: createStubTransport({
      'work.detail': detail, 'playback.history': saved,
      'playback.status': { status: 'playing', session: { work_id: 'work', episode_id: 'ep', position: 360, duration: 1500 } },
    }, calls) });
    const result = await service.getWorkDetail('work');
    expect(result.progress).toMatchObject({ position: 360, duration: 1500, episodeCode: '10', episodeTitle: '我们没有明天' });
    expect(calls.map((call) => call.operation)).toEqual(['work.detail', 'playback.history', 'playback.status']);
  });

  it('另一作品或已退出的会话不覆盖保存记录，未知时长保留已知值', async () => {
    for (const status of [
      { status: 'playing', session: { work_id: 'other', episode_id: 'ep', position: 999 } },
      { status: 'exited', session: { work_id: 'work', episode_id: 'ep', position: 999 } },
    ]) {
      const service = createHttpMediaService({ transport: createStubTransport({
        'work.detail': detail, 'playback.history': saved, 'playback.status': status,
      }) });
      expect((await service.getWorkDetail('work')).progress?.position).toBe(100);
    }
    const service = createHttpMediaService({ transport: createStubTransport({
      'work.detail': detail, 'playback.history': saved,
      'playback.status': { status: 'playing', session: { work_id: 'work', episode_id: 'ep', position: 360, duration: 0 } },
    }) });
    expect((await service.getWorkDetail('work')).progress?.duration).toBe(1500);
  });
});
