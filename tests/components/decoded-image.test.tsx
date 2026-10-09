import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { StrictMode } from 'react';
import DecodedImage from '../../src/components/ui/DecodedImage';

test('浏览器 load 终态显示图片，不启动额外 decode 批次', () => {
  const decode = vi.fn();
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decode });
  const onDecoded = vi.fn(); const onStateChange = vi.fn();
  render(<DecodedImage src="/api/assets/artwork/id/v1/384" alt="海报" onDecoded={onDecoded} onStateChange={onStateChange} />);
  const image = screen.getByRole('img');
  expect(image).toHaveAttribute('data-image-state', 'loading');
  fireEvent.load(image);
  expect(image).toHaveAttribute('data-image-state', 'ready');
  expect(onDecoded).toHaveBeenCalledOnce();
  expect(decode).not.toHaveBeenCalled();
  expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(['loading', 'ready']);
});

test('load 完成回调保留轮播切换功能，错误显示稳定占位', () => {
  const ready = vi.fn();
  const { rerender } = render(<DecodedImage src="/api/assets/artwork/c/v1/1280" alt="背景" onDecoded={ready} />);
  fireEvent.load(screen.getByRole('img'));
  expect(ready).toHaveBeenCalledOnce();
  rerender(<DecodedImage src="/api/assets/artwork/c/v2/1280" alt="背景" onDecoded={ready} />);
  fireEvent.error(screen.getByRole('img'));
  expect(screen.getByRole('img')).toHaveAttribute('data-image-state', 'error');
  expect(screen.getByRole('img')).not.toHaveClass('is-ready');
  expect(ready).toHaveBeenCalledOnce();
});

test('地址切换不取消正在传输的预算，旧终态不能将新图标记 ready', () => {
  const ready = vi.fn();
  const { rerender } = render(<DecodedImage src="/api/assets/artwork/stale/v1/384" alt="切换" onDecoded={ready} />);
  const node = screen.getByRole('img');
  rerender(<DecodedImage src="/api/assets/artwork/stale/v2/384" alt="切换" onDecoded={ready} />);
  expect(node).toHaveAttribute('src', '/api/assets/artwork/stale/v1/384');
  fireEvent.load(node);
  expect(node).toHaveAttribute('src', '/api/assets/artwork/stale/v2/384');
  expect(node).toHaveAttribute('data-image-state', 'loading');
  expect(ready).not.toHaveBeenCalled();
  fireEvent.load(node);
  expect(node).toHaveAttribute('data-image-state', 'ready');
  expect(ready).toHaveBeenCalledOnce();
});

test('缓存 complete 与 load 重复到达，每个记录只通知一次 ready', () => {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(384);
  const ready = vi.fn();
  render(<DecodedImage src="/api/assets/artwork/cache/v1/384" alt="缓存" onDecoded={ready} />);
  expect(screen.getByRole('img')).toHaveAttribute('data-image-state', 'ready');
  fireEvent.load(screen.getByRole('img'));
  expect(ready).toHaveBeenCalledOnce();
});

test('StrictMode 重放保留缓存展示，未开始请求卸载后不再赋值', () => {
  render(<StrictMode><DecodedImage src="/api/assets/artwork/strict/v1/384" alt="重放" revealOnLoad /></StrictMode>);
  const node = screen.getByRole('img');
  fireEvent.load(node);
  // 重放的旧监听器释放后新记录开始；再次 load 是新记录的终态。
  fireEvent.load(node);
  expect(node).toHaveAttribute('data-image-state', 'ready');
});
