import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import PosterCard from '../../src/components/library/PosterCard';
import { useLibraryStore } from '../../src/stores/library';
import { resetScrollGestureForTests } from '../../src/utils/scrollGesture';

const getWorkDetail = vi.fn();
let addListenerSpy: ReturnType<typeof vi.spyOn>;
let requestedImages: Set<HTMLImageElement>;
let imageSetterSpy: ReturnType<typeof vi.spyOn>;
let imageVersion = 0;

function work(workId: string) {
  return {
    work_id: workId,
    title: `作品${workId}`,
    original_title: `Work ${workId}`,
    year: 2024,
    rating: 8.5,
    show_type: 'anime_series',
    source: 'local',
    poster_path: `/api/assets/artwork/${workId}/v${imageVersion}/384`,
    fanart_path: '',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  imageVersion += 1;
  requestedImages = new Set();
  const setter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!.set!;
  imageSetterSpy = vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, value: string) {
    requestedImages.add(this);
    setter.call(this, value);
  });
  resetScrollGestureForTests();
  addListenerSpy = vi.spyOn(window, 'addEventListener');
  addListenerSpy.mockClear();
  getWorkDetail.mockReset();
  getWorkDetail.mockResolvedValue({ work_id: 'w1' });
  useLibraryStore.setState({ getWorkDetail });
});

afterEach(() => {
  // 卸载不代表传输结束，必须模拟已卸载节点的浏览器终态。
  requestedImages.forEach((node) => fireEvent.load(node));
  imageSetterSpy.mockRestore();
  vi.useRealTimers();
});

test('滚动过程中悬停卡片不会触发详情预取', () => {
  render(<PosterCard work={work('w1')} />);
  const card = screen.getByRole('button', { name: /作品w1/ });

  fireEvent.scroll(window);
  fireEvent.pointerEnter(card);
  vi.advanceTimersByTime(200);

  expect(getWorkDetail).not.toHaveBeenCalled();
});

test('滚动开始会取消已排队的详情预取', () => {
  render(<PosterCard work={work('w1')} />);
  const card = screen.getByRole('button', { name: /作品w1/ });

  fireEvent.pointerEnter(card);
  vi.advanceTimersByTime(50);
  fireEvent.scroll(window);
  vi.advanceTimersByTime(150);

  expect(getWorkDetail).not.toHaveBeenCalled();
});

test('滚动停止超过静默窗口后悬停恢复详情预取', () => {
  render(<PosterCard work={work('w1')} />);
  const card = screen.getByRole('button', { name: /作品w1/ });

  fireEvent.scroll(window);
  vi.advanceTimersByTime(350);
  fireEvent.pointerEnter(card);
  vi.advanceTimersByTime(200);

  expect(getWorkDetail).toHaveBeenCalledTimes(1);
});

test('多张海报卡共享同一个全局滚动监听器与计时器', async () => {
  const { unmount } = render(
    <div>
      {['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((workId) => (
        <PosterCard key={workId} work={work(workId)} />
      ))}
    </div>,
  );

  await act(async () => {});
  const scrollListenerRegistrations = addListenerSpy.mock.calls.filter((call) => call[0] === 'scroll');
  expect(scrollListenerRegistrations).toHaveLength(1);

  fireEvent.scroll(window);
  expect(vi.getTimerCount()).toBe(1);

  unmount();
  await act(async () => {});
  expect(addListenerSpy.mock.calls.filter((call) => call[0] === 'scroll')).toHaveLength(1);
});

test('卸载海报卡不残留每卡滚动监听与计时器', async () => {
  const { unmount } = render(<PosterCard work={work('w1')} />);
  const card = screen.getByRole('button', { name: /作品w1/ });

  fireEvent.pointerEnter(card);
  unmount();
  await act(async () => {});
  fireEvent.scroll(window);

  expect(addListenerSpy.mock.calls.filter((call) => call[0] === 'scroll')).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);
});

test('本地缩略图请求失败时不再重复请求原图，改为常驻标题占位', async () => {
  render(<PosterCard work={work('w1')} thumbnailWidth={384} />);
  const image = screen.getByRole('img', { name: '作品w1' });

  expect(image.getAttribute('src')).toContain('/api/assets/artwork/');
  fireEvent.error(image);

  await act(async () => {});
  expect(image.getAttribute('src')).toContain('/api/assets/artwork/');
  expect(document.querySelector('.poster-placeholder-title')).toBeTruthy();
});

test('分类页在索引保留远程引用时只用已发布的本地版本图', () => {
  const remoteWork = {
    ...work('w1'),
    poster_path: 'https://image.tmdb.org/t/p/w342/remote.jpg',
    local_poster_path: '/api/assets/artwork/local/v1/384',
  };

  render(<PosterCard work={remoteWork} thumbnailWidth={384} localArtworkOnly />);
  const image = screen.getByRole('img', { name: '作品w1' });

  expect(image.getAttribute('src')).toContain('/api/assets/artwork/local/v1/384');
  expect(image.getAttribute('src')).not.toContain('/api/assets/remote');
});

test('本地海报缺失时本地模式分类卡片保留标题且不请求远程图', () => {
  const remoteOnlyWork = {
    ...work('w1'),
    poster_path: 'https://image.tmdb.org/t/p/w342/remote-only.jpg',
    local_poster_path: '',
  };

  render(<PosterCard work={remoteOnlyWork} thumbnailWidth={384} localArtworkOnly />);
  expect(screen.queryByRole('img', { name: '作品w1' })).toBeNull();
  expect(screen.getAllByText('作品w1').length).toBeGreaterThan(0);
});

test('本地与远程图都缺失时分类卡片显示文字占位', () => {
  const emptyWork = {
    ...work('w1'),
    poster_path: '',
    local_poster_path: '',
    fanart_path: '',
  };

  render(<PosterCard work={emptyWork} thumbnailWidth={384} localArtworkOnly />);

  expect(screen.queryByRole('img', { name: '作品w1' })).toBeNull();
  expect(screen.getAllByText('作品w1').length).toBeGreaterThan(0);
});

test('recent 卡片尚无已发布背景时保持占位，不回退远程 fanart', () => {
  const recentWork = {
    ...work('w1'),
    fanart_path: 'https://image.tmdb.org/t/p/w1280/remote-fanart.jpg',
    local_fanart_path: '',
    poster_path: '',
  };

  render(<PosterCard work={recentWork} showType="recent" />);
  expect(screen.queryByRole('img', { name: '作品w1' })).toBeNull();
});

test('海报占位区分加载与失败，图片地址改变后清除旧错误', async () => {
  const { rerender } = render(<PosterCard work={work('w1')} thumbnailWidth={384} />);
  expect(screen.getByText('图片加载中')).toBeVisible();
  const image = screen.getByRole('img');
  expect(image).toHaveAttribute('loading', 'eager');
  expect(image).toHaveAttribute('src', expect.stringContaining('/api/assets/artwork/'));
  fireEvent.error(image);
  expect(screen.getByText('图片暂不可用')).toBeVisible();
  expect(screen.queryByText('图片加载中')).toBeNull();

  rerender(<PosterCard work={{ ...work('w1'), poster_path: '/api/assets/artwork/w1/v2/384' }} thumbnailWidth={384} />);
  expect(screen.queryByText('图片暂不可用')).toBeNull();
  expect(screen.getByText('图片加载中')).toBeVisible();

  Object.defineProperty(image, 'decode', { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  await act(async () => { fireEvent.load(image); });
  expect(screen.queryByText('图片加载中')).toBeNull();
});

test('尚未测量的海报只展示标题，不声称图片正在加载', () => {
  render(<PosterCard work={work('w1')} deferImage />);
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByText('图片加载中')).toBeNull();
  expect(screen.queryByText('图片暂不可用')).toBeNull();
  expect(screen.getAllByText('作品w1').length).toBeGreaterThan(0);
});
