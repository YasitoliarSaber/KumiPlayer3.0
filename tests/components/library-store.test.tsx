import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { isScrollRecentlyActive, resetScrollGestureForTests } from '../../src/utils/scrollGesture';
import type { WorkIndex } from '../../src/api/types';

const { getLibrary, getWorkDetail, getHistory, getChanges, getCards } = vi.hoisted(() => ({
  getLibrary: vi.fn(),
  getWorkDetail: vi.fn(),
  getHistory: vi.fn(),
  getChanges: vi.fn(),
  getCards: vi.fn(),
}));

vi.mock('../../src/api/library', () => ({
  libraryApi: { getLibrary, getWorkDetail, getChanges, getCards },
}));

vi.mock('../../src/api/playback', () => ({
  playbackApi: { getHistory },
}));

import { useLibraryStore } from '../../src/stores/library';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function work(workId: string): WorkIndex {
  return {
    work_id: workId,
    title: workId,
    original_title: '',
    year: null,
    rating: 0,
    plot: '',
    genres: [],
    studios: [],
    show_type: '',
    media_type: '',
    source: 'pan115',
    card_type: 'standalone',
    poster_path: '',
    fanart_path: '',
    clearlogo_path: '',
    dir_path: '',
    seasons: [],
    episodes: [],
    related_works: [],
    tags: [],
    last_played: null,
  };
}

beforeEach(() => {
  resetScrollGestureForTests();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  getLibrary.mockReset();
  getWorkDetail.mockReset();
  getHistory.mockReset();
  getChanges.mockReset();
  getCards.mockReset();
  localStorage.clear();
  useLibraryStore.setState({
    works: [],
    history: [],
    loading: false,
    error: null,
    loaded: false,
    changeSequence: null,
    selectedWorkDetail: null,
    detailLoading: false,
    detailError: null,
  });
});
afterEach(() => resetScrollGestureForTests());

test('尚未发布与已发布空库有不同状态，普通同步只读发布摘要', async () => {
  getHistory.mockResolvedValue({ items: [] });
  getLibrary.mockResolvedValue({ works: [], change_sequence: 0, generation_id: '', updating: true });
  await useLibraryStore.getState().loadLibrary();
  expect(useLibraryStore.getState()).toMatchObject({ loaded: true, loading: false, updating: true, generationId: '' });
  getChanges.mockResolvedValue({ changes: [], next_sequence: 0, has_more: false, reset_required: false, generation_id: 'published-empty', updating: false });
  await useLibraryStore.getState().syncChanges();
  expect(useLibraryStore.getState()).toMatchObject({ updating: false, generationId: 'published-empty', works: [] });
  expect(getLibrary).toHaveBeenCalledTimes(1);
});

test('详情预热和点击导航只取数据，DOM 图片统一预算加载，不显式解码', async () => {
  const decode = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decode });
  const response = deferred<WorkIndex>();
  getWorkDetail.mockImplementationOnce(() => response.promise);
  const pending = useLibraryStore.getState().getWorkDetail('delayed');
  isScrollRecentlyActive();
  fireEvent.scroll(window);
  response.resolve({ ...work('delayed'), fanart_path: 'fixture-background.jpg' });
  await pending;
  expect(decode).not.toHaveBeenCalled();
  await useLibraryStore.getState().openWorkDetail('delayed');
  expect(decode).not.toHaveBeenCalled();
});

test('单张图片事件只取对应卡片，保留其他对象引用并废弃对应详情缓存', async () => {
  const first = work('art-1'); const second = work('art-2');
  useLibraryStore.setState({ works: [first, second], loaded: true, changeSequence: 10 });
  getWorkDetail.mockResolvedValue({ ...first, plot: 'detail retained' });
  await useLibraryStore.getState().getWorkDetail(first.work_id);
  getChanges.mockResolvedValue({ changes: [{ sequence: 11, kind: 'artwork', work_id: first.work_id }], next_sequence: 11, has_more: false, reset_required: false });
  const artwork = { poster: { resource_id: 'id', content_version: 'v2', state: 'ready', variants: { '384': '/api/assets/artwork/id/v2/384' } } };
  getCards.mockResolvedValue({ works: [{ ...first, artwork }] });
  expect(await useLibraryStore.getState().syncChanges()).toBe(true);
  expect(getLibrary).not.toHaveBeenCalled();
  expect(useLibraryStore.getState().works[1]).toBe(second);
  expect(useLibraryStore.getState().peekWorkDetail(first.work_id)?.plot).toBe('');
  expect(useLibraryStore.getState().peekWorkDetail(first.work_id)?.artwork).toEqual(artwork);
  await useLibraryStore.getState().getWorkDetail(first.work_id);
  expect(getWorkDetail).toHaveBeenCalledTimes(2);
  expect(useLibraryStore.getState().changeSequence).toBe(11);
});

test('选中作品的图片变化读取单作品详情，更新分集、演员和关联图片', async () => {
  const first = work('selected-art'); const stable = work('untouched-art');
  const oldDetail = { ...first, plot: 'metadata remains valid' };
  useLibraryStore.setState({ works: [first, stable], selectedWorkDetail: oldDetail, loaded: true, changeSequence: 11 });
  const refreshed = { ...oldDetail, episodes: [{ episode_id: 'ep', thumb_path: '/api/assets/artwork/ep/v2/384' }],
    cast: [{ name: 'actor', profile_path: '/api/assets/artwork/actor/v2/384' }],
    related_works: [{ title: 'related', poster_path: '/api/assets/artwork/related/v2/384' }] } as WorkIndex;
  getChanges.mockResolvedValue({ changes: [{ sequence: 12, kind: 'artwork', work_id: first.work_id }], next_sequence: 12, has_more: false });
  getCards.mockResolvedValue({ works: [first] });
  getWorkDetail.mockResolvedValue(refreshed);
  expect(await useLibraryStore.getState().syncChanges()).toBe(true);
  expect(getLibrary).not.toHaveBeenCalled();
  expect(getWorkDetail).toHaveBeenCalledExactlyOnceWith(first.work_id);
  expect(useLibraryStore.getState().selectedWorkDetail).toBe(refreshed);
  expect(useLibraryStore.getState().works[1]).toBe(stable);
  expect(useLibraryStore.getState().changeSequence).toBe(12);
  expect(await useLibraryStore.getState().getWorkDetail(first.work_id)).toBe(refreshed);
  expect(getWorkDetail).toHaveBeenCalledOnce();
});

test('图片详情刷新失败保留当前详情与游标，重试成功后仅更新该作品', async () => {
  const first = work('failed-art');
  useLibraryStore.setState({ works: [first], selectedWorkDetail: first, loaded: true, changeSequence: 15 });
  getChanges.mockResolvedValue({ changes: [{ sequence: 16, kind: 'artwork', work_id: first.work_id }], next_sequence: 16, has_more: false });
  getCards.mockResolvedValue({ works: [first] });
  getWorkDetail.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ...first, plot: 'valid' });
  expect(await useLibraryStore.getState().syncChanges()).toBe(false);
  expect(useLibraryStore.getState().selectedWorkDetail).toBe(first);
  expect(useLibraryStore.getState().changeSequence).toBe(15);
  expect(await useLibraryStore.getState().syncChanges()).toBe(true);
  expect(useLibraryStore.getState().selectedWorkDetail?.plot).toBe('valid');
  expect(getChanges).toHaveBeenLastCalledWith(15);
  expect(getLibrary).not.toHaveBeenCalled();
});

test('图片详情刷新途中切换作品不覆盖新的选择', async () => {
  const first = work('navigation-art'); const second = work('navigation-other');
  const response = deferred<WorkIndex>();
  useLibraryStore.setState({ works: [first, second], selectedWorkDetail: first, loaded: true, changeSequence: 17 });
  getChanges.mockResolvedValue({ changes: [{ sequence: 18, kind: 'artwork', work_id: first.work_id }], next_sequence: 18, has_more: false });
  getCards.mockResolvedValue({ works: [first] });
  getWorkDetail.mockImplementationOnce(() => response.promise);
  const pending = useLibraryStore.getState().syncChanges();
  await vi.waitFor(() => expect(getWorkDetail).toHaveBeenCalledWith(first.work_id));
  useLibraryStore.setState({ selectedWorkDetail: second });
  response.resolve({ ...first, plot: 'updated' });
  await pending;
  expect(useLibraryStore.getState().selectedWorkDetail).toBe(second);
});

test('手工修改后的刷新废弃旧详情请求，迟到响应不能覆盖当前版本', async () => {
  const first = work('manual-art'); const stale = deferred<WorkIndex>();
  const updated = { ...first, local_poster_path: '/api/assets/artwork/manual/v2/384' };
  useLibraryStore.setState({ works: [first], selectedWorkDetail: first });
  getWorkDetail.mockImplementationOnce(() => stale.promise).mockResolvedValueOnce(updated);
  const oldRequest = useLibraryStore.getState().getWorkDetail(first.work_id);
  await useLibraryStore.getState().refreshWork(first.work_id);
  stale.resolve({ ...first, local_poster_path: '/api/assets/artwork/manual/v1/384' });
  expect(await oldRequest).toBe(updated);
  expect(await useLibraryStore.getState().getWorkDetail(first.work_id)).toBe(updated);
  expect(useLibraryStore.getState().selectedWorkDetail).toBe(updated);
  expect(getWorkDetail).toHaveBeenCalledTimes(2);
});

test('分页卡片失败不应用部分变化，不推进游标，下次从原游标重试', async () => {
  const old = work('page-1');
  useLibraryStore.setState({ works: [old], loaded: true, changeSequence: 20 });
  getChanges.mockResolvedValueOnce({ changes: [{ sequence: 21, kind: 'work_upsert', work_id: old.work_id }], next_sequence: 21, has_more: true })
    .mockResolvedValueOnce({ changes: [{ sequence: 22, kind: 'artwork', work_id: 'page-2' }], next_sequence: 22, has_more: false });
  getCards.mockResolvedValueOnce({ works: [{ ...old, title: 'updated' }] }).mockRejectedValueOnce(new Error('offline'));
  expect(await useLibraryStore.getState().syncChanges()).toBe(false);
  expect(useLibraryStore.getState().works[0]).toBe(old);
  expect(useLibraryStore.getState().changeSequence).toBe(20);
  getChanges.mockResolvedValue({ changes: [], next_sequence: 20, has_more: false });
  await useLibraryStore.getState().syncChanges();
  expect(getChanges).toHaveBeenLastCalledWith(20);
});

test('分页合并新增与移除，只影响指定作品，空变化保留列表引用', async () => {
  const removed = work('gone'); const stable = work('stable'); const added = work('added');
  useLibraryStore.setState({ works: [removed, stable], loaded: true, changeSequence: 30 });
  getChanges.mockResolvedValueOnce({ changes: [{ sequence: 31, kind: 'work_remove', work_id: removed.work_id }], next_sequence: 31, has_more: true })
    .mockResolvedValueOnce({ changes: [{ sequence: 32, kind: 'work_upsert', work_id: added.work_id }], next_sequence: 32, has_more: false });
  getCards.mockResolvedValueOnce({ works: [] }).mockResolvedValueOnce({ works: [added] });
  expect(await useLibraryStore.getState().syncChanges()).toBe(true);
  expect(useLibraryStore.getState().works).toEqual([stable, added]);
  expect(useLibraryStore.getState().works[0]).toBe(stable);
  const list = useLibraryStore.getState().works;
  getChanges.mockResolvedValue({ changes: [], next_sequence: 32, has_more: false });
  await useLibraryStore.getState().syncChanges();
  expect(useLibraryStore.getState().works).toBe(list);
});

test('只有过期/reset 才全同步，并从新库快照取得游标', async () => {
  useLibraryStore.setState({ works: [work('reset-old')], loaded: true, changeSequence: 1 });
  getChanges.mockResolvedValue({ changes: [], next_sequence: 99, has_more: false, reset_required: true });
  getLibrary.mockResolvedValue({ works: [work('reset-new')], change_sequence: 99 });
  getHistory.mockResolvedValue({ items: [] });
  expect(await useLibraryStore.getState().syncChanges()).toBe(true);
  expect(getLibrary).toHaveBeenCalledOnce();
  expect(useLibraryStore.getState().changeSequence).toBe(99);
});

test('媒体库缓存的序列化在空闲回调里进行，不占用响应应用的同步路径', async () => {
  let idle!: IdleRequestCallback;
  Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: (callback: IdleRequestCallback) => { idle = callback; return 1; } });
  const toJSON = vi.fn(() => ({ ...work('cached') }));
  getLibrary.mockResolvedValue({ works: [{ ...work('cached'), toJSON }] });
  getHistory.mockResolvedValue({ items: [] });
  await useLibraryStore.getState().loadLibrary();
  expect(toJSON).not.toHaveBeenCalled();
  idle({ didTimeout: false, timeRemaining: () => 50 });
  expect(toJSON).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem('kumiplayer-library-cache-v4')!).works[0].work_id).toBe('cached');
});

test('空闲缓存写入触发存储配额异常时，不产生异步未捕获异常', async () => {
  let idle!: IdleRequestCallback;
  Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: (callback: IdleRequestCallback) => { idle = callback; return 1; } });
  getLibrary.mockResolvedValue({ works: [work('cached')] });
  getHistory.mockResolvedValue({ items: [] });
  await useLibraryStore.getState().loadLibrary();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  expect(() => idle({ didTimeout: true, timeRemaining: () => 0 })).not.toThrow();
  expect(useLibraryStore.getState().loaded).toBe(true);
});

test('idle 超时期间仍在滚动时推迟缓存，停止后才序列化最新内容', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const callbacks: IdleRequestCallback[] = [];
    Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: (callback: IdleRequestCallback) => { callbacks.push(callback); return callbacks.length; } });
    const toJSON = vi.fn(() => ({ ...work('quiet-cache') }));
    getLibrary.mockResolvedValue({ works: [{ ...work('quiet-cache'), toJSON }] });
    getHistory.mockResolvedValue({ items: [] });
    await useLibraryStore.getState().loadLibrary();
    isScrollRecentlyActive();
    fireEvent.scroll(window);
    callbacks[0]({ didTimeout: true, timeRemaining: () => 0 });
    expect(toJSON).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    callbacks[1]({ didTimeout: false, timeRemaining: () => 50 });
    expect(toJSON).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

test('删除后的强制刷新不会被进行中的加载拦截，旧响应也不能恢复已删除卡片', async () => {
  const staleLibrary = deferred<{ works: WorkIndex[] }>();
  const staleHistory = deferred<{ items: [] }>();
  getLibrary
    .mockImplementationOnce(() => staleLibrary.promise)
    .mockResolvedValueOnce({ works: [] });
  getHistory
    .mockImplementationOnce(() => staleHistory.promise)
    .mockResolvedValueOnce({ items: [] });

  const staleRequest = useLibraryStore.getState().loadLibrary();
  expect(useLibraryStore.getState().loading).toBe(true);

  await useLibraryStore.getState().loadLibrary({ force: true });
  expect(getLibrary).toHaveBeenCalledTimes(2);
  expect(useLibraryStore.getState().works).toEqual([]);

  staleLibrary.resolve({ works: [work('deleted-work')] });
  staleHistory.resolve({ items: [] });
  await staleRequest;

  expect(useLibraryStore.getState().works).toEqual([]);
});

test('删除后的空库刷新会使先前排队的缓存写入失效', async () => {
  const idleCallbacks: IdleRequestCallback[] = [];
  const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
    idleCallbacks.push(callback);
    return idleCallbacks.length;
  });
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    value: requestIdleCallback,
  });
  getLibrary
    .mockResolvedValueOnce({ works: [work('deleted-work')] })
    .mockResolvedValueOnce({ works: [] });
  getHistory.mockResolvedValue({ items: [] });

  await useLibraryStore.getState().loadLibrary();
  expect(idleCallbacks).toHaveLength(1);

  await useLibraryStore.getState().loadLibrary({ force: true });
  idleCallbacks[0]({ didTimeout: false, timeRemaining: () => 50 });

  expect(localStorage.getItem('kumiplayer-library-cache-v4')).toBeNull();
});

test('详情返回值缺少本地图片字段时保留 compact 卡片的本地路径', async () => {
  const compactWork = work('w1');
  compactWork.local_poster_path = 'D:/mirror/作品1/poster.jpg';
  compactWork.local_fanart_path = 'D:/mirror/作品1/fanart.jpg';
  (compactWork as any).local_clearlogo_path = 'D:/mirror/作品1/clearlogo.png';
  getLibrary.mockResolvedValue({ works: [compactWork] });
  getHistory.mockResolvedValue({ items: [] });
  getWorkDetail.mockResolvedValue({ ...work('w1') });

  await useLibraryStore.getState().loadLibrary();
  await useLibraryStore.getState().openWorkDetail('w1');

  const updated = useLibraryStore.getState().works[0];
  expect(updated.local_poster_path).toBe('D:/mirror/作品1/poster.jpg');
  expect(updated.local_fanart_path).toBe('D:/mirror/作品1/fanart.jpg');
  expect((updated as any).local_clearlogo_path).toBe('D:/mirror/作品1/clearlogo.png');
});

test('详情返回值带新本地路径时更新 compact 卡片', async () => {
  const compactWork = work('w2');
  compactWork.local_poster_path = 'D:/mirror/作品2/poster-old.jpg';
  getLibrary.mockResolvedValue({ works: [compactWork] });
  getHistory.mockResolvedValue({ items: [] });
  getWorkDetail.mockResolvedValue({
    ...work('w2'),
    local_poster_path: 'D:/mirror/作品2/poster-new.jpg',
  });

  await useLibraryStore.getState().loadLibrary();
  await useLibraryStore.getState().openWorkDetail('w2');

  const updated = useLibraryStore.getState().works[0];
  expect(updated.local_poster_path).toBe('D:/mirror/作品2/poster-new.jpg');
});

test('详情返回值本地路径为空时保留 compact 卡片的有效本地路径', async () => {
  const compactWork = work('w3');
  compactWork.local_fanart_path = 'D:/mirror/作品3/fanart.jpg';
  getLibrary.mockResolvedValue({ works: [compactWork] });
  getHistory.mockResolvedValue({ items: [] });
  getWorkDetail.mockResolvedValue({
    ...work('w3'),
    local_poster_path: '',
    local_fanart_path: '',
  });

  await useLibraryStore.getState().loadLibrary();
  await useLibraryStore.getState().openWorkDetail('w3');

  const updated = useLibraryStore.getState().works[0];
  expect(updated.local_fanart_path).toBe('D:/mirror/作品3/fanart.jpg');
});

test('来源筛选支持 OpenList：主来源与跨来源合并作品均可见', async () => {
  const { useUiStore } = await import('../../src/stores/ui');
  const openlistOnly = { ...work('openlist-1'), source: 'openlist' as const };
  const merged = {
    ...work('merged-1'),
    source: 'local' as const,
    sources: ['local', 'openlist'] as Array<'local' | 'openlist'>,
  };
  const pan115Only = work('pan115-1');
  getLibrary.mockResolvedValue({ works: [openlistOnly, merged, pan115Only] });
  getHistory.mockResolvedValue({ items: [] });

  await useLibraryStore.getState().loadLibrary();
  useUiStore.setState({ source: 'openlist' });

  const filtered = useLibraryStore.getState().filteredWorks();
  const ids = filtered.map((item) => item.work_id).sort();
  expect(ids).toEqual(['merged-1', 'openlist-1']);

  // 纯 115 作品不在 OpenList 筛选下出现
  expect(filtered.some((item) => item.work_id === 'pan115-1')).toBe(false);

  useUiStore.setState({ source: 'all' });
});

test('来源筛选不因 OpenList 新增改变本地来源语义', async () => {
  const { useUiStore } = await import('../../src/stores/ui');
  const localWork = { ...work('local-1'), source: 'local' as const };
  const openlistWork = { ...work('openlist-2'), source: 'openlist' as const };
  getLibrary.mockResolvedValue({ works: [localWork, openlistWork] });
  getHistory.mockResolvedValue({ items: [] });

  await useLibraryStore.getState().loadLibrary();
  useUiStore.setState({ source: 'local' });

  const filtered = useLibraryStore.getState().filteredWorks();
  expect(filtered.map((item) => item.work_id)).toEqual(['local-1']);

  useUiStore.setState({ source: 'all' });
});
