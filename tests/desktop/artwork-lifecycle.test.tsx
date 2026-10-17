import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Artwork } from '@/shared/ui/Artwork';
import { ArtworkLifecycle, artworkLifecycle } from '@/shared/ui/artwork-lifecycle';
import { artworkAtWidth } from '@/shared/ui/artwork-size';

class ImageStub {
  static images: ImageStub[] = [];
  static cached = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  decoding = '';
  complete = ImageStub.cached;
  naturalWidth = ImageStub.cached ? 256 : 0;
  constructor() { ImageStub.images.push(this); }
  removeAttribute() { this.src = ''; }
  load() { this.complete = true; this.naturalWidth = 256; this.onload?.(); }
  fail() { this.onerror?.(); }
}

const variants = [256, 384, 512].map((width) => ({ url: `/poster/${width}`, width }));
const poster = { url: '/poster/384', width: 384, height: 0, variants };
const managers: ArtworkLifecycle[] = [];
const manager = () => { const value = new ArtworkLifecycle(); managers.push(value); return value; };

beforeEach(() => {
  vi.useFakeTimers();
  ImageStub.images = []; ImageStub.cached = false;
  vi.stubGlobal('Image', ImageStub);
});
afterEach(() => {
  managers.splice(0).forEach((value) => value.dispose());
  artworkLifecycle.dispose();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('按实际尺寸选择已发布图片', () => {
  it('宽度与 DPR 共同决定最小足够变体，超大目标只退到已发布最大档', () => {
    expect(artworkAtWidth(poster, 203, 1.25)?.width).toBe(256);
    expect(artworkAtWidth(poster, 203, 2)?.width).toBe(512);
    expect(artworkAtWidth(poster, 4000, 2)?.width).toBe(512);
    expect(artworkAtWidth(null, 200)).toBeNull();
    expect(artworkAtWidth({ url: '/fixed', width: 384, height: 0 }, 100)?.url).toBe('/fixed');
    const fanart = { ...poster, variants: [512, 768, 1280].map((width) => ({ width, url: `/fanart/${width}` })) };
    expect(artworkAtWidth(fanart, 300, 2)?.width).toBe(768);
  });
});

describe('共享图片生命周期', () => {
  it('最多 6 个活动请求、2 个预取，可见请求先于等待中的预取', () => {
    const value = manager();
    for (let i = 0; i < 8; i++) value.request(`/prefetch/${i}`, 'prefetch');
    expect(value.snapshot()).toMatchObject({ active: 2, prefetch: 2, queued: 6 });
    for (let i = 0; i < 8; i++) value.request(`/visible/${i}`, 'visible');
    expect(value.snapshot()).toMatchObject({ active: 6, prefetch: 2, queued: 10 });
    ImageStub.images[0]!.load();
    expect(ImageStub.images.at(-1)?.src).toBe('/visible/4');
    expect(value.snapshot().active).toBe(6);
  });

  it('同 URL 只创建一个调度任务，卸载不取消在途图片，命中复用状态', () => {
    const value = manager();
    const release = value.request('/same', 'visible');
    value.request('/same', 'prefetch');
    expect(ImageStub.images).toHaveLength(1);
    release();
    expect(value.snapshot().active).toBe(1);
    ImageStub.images[0]!.load();
    value.request('/same', 'visible')();
    expect(ImageStub.images).toHaveLength(1);
    expect(value.snapshot().hits).toBe(1);
  });

  it('离开窗口取消尚未开始的预取，512 条状态上限与 LRU 淘汰有效', () => {
    const value = manager();
    value.request('/p1', 'prefetch'); value.request('/p2', 'prefetch');
    value.request('/queued', 'prefetch')();
    expect(value.state('/queued')).toBe('idle');
    ImageStub.images.forEach((image) => image.load());
    ImageStub.cached = true;
    for (let i = 0; i < 600; i++) value.request(`/cache/${i}`, 'visible')();
    expect(value.snapshot().entries).toBe(512);
    expect(value.snapshot().evicted).toBeGreaterThan(0);
    expect(value.state('/cache/0')).toBe('idle');
    expect(value.state('/cache/599')).toBe('ready');
  });

  it('同步缓存命中、超时与失败冷却均释放预算，失败最多重试两次', () => {
    const value = manager();
    ImageStub.cached = true;
    value.request('/cached', 'visible')();
    expect(value.state('/cached')).toBe('ready');
    expect(value.snapshot().active).toBe(0);
    ImageStub.cached = false;
    value.request('/bad', 'visible')();
    ImageStub.images.at(-1)!.fail();
    value.request('/bad', 'visible')();
    expect(value.snapshot().started).toBe(2);
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(30_000);
      value.request('/bad', 'visible')();
      ImageStub.images.at(-1)!.fail();
    }
    vi.advanceTimersByTime(30_000);
    value.request('/bad', 'visible')();
    expect(value.snapshot().started).toBe(4);
    expect(value.retryAt('/bad')).toBeNull();
    value.request('/timeout', 'visible')();
    vi.advanceTimersByTime(15_000);
    expect(value.state('/timeout')).toBe('failed');
    expect(value.snapshot().active).toBe(0);
  });
});

describe('图片组件', () => {
  it('尺寸变化和 URL 变化同步切换图片，失败与缺图保留透明布局', () => {
    const view = render(<Artwork artwork={poster} alt="作品" displayWidth={200} priority="visible" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/poster/256');
    fireEvent.error(screen.getByRole('img'));
    const fallback = view.container.querySelector('[data-artwork-fallback]')!;
    expect(fallback.textContent).toBe('');
    expect(fallback.className).not.toContain('bg-');
    view.rerender(<Artwork artwork={poster} alt="作品" displayWidth={400} priority="visible" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/poster/512');
    view.rerender(<Artwork artwork={null} alt="作品" className="aspect-video" />);
    expect(view.container.querySelector('[data-artwork-fallback]')).toHaveClass('aspect-video');
  });

  it('驻留图片不调度，转为可见后请求；失败定时重试有界且卸载清理', () => {
    const view = render(<Artwork artwork={poster} alt="作品" displayWidth={200} priority={null} />);
    expect(artworkLifecycle.snapshot().started).toBe(0);
    view.rerender(<Artwork artwork={poster} alt="作品" displayWidth={200} priority="visible" />);
    act(() => ImageStub.images.at(-1)!.fail());
    act(() => vi.advanceTimersByTime(30_000));
    expect(artworkLifecycle.snapshot().started).toBe(2);
    act(() => ImageStub.images.at(-1)!.fail());
    view.unmount();
    act(() => vi.advanceTimersByTime(60_000));
    expect(artworkLifecycle.snapshot().started).toBe(2);
  });
});
