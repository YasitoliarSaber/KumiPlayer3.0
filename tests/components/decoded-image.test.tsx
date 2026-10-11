import { act, fireEvent, render, screen } from '@testing-library/react';
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

test('地址切换实际撤销旧请求，旧终态不能将新图标记 ready', async () => {
  const ready = vi.fn();
  const { rerender } = render(<DecodedImage src="/api/assets/artwork/stale/v1/384" alt="切换" onDecoded={ready} />);
  const node = screen.getByRole('img');
  rerender(<DecodedImage src="/api/assets/artwork/stale/v2/384" alt="切换" onDecoded={ready} />);
  expect(node).not.toHaveAttribute('src');
  fireEvent.load(node);
  expect(ready).not.toHaveBeenCalled();
  await act(async () => {});
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

test('StrictMode 重放保留缓存展示，未开始请求卸载后不再赋值', async () => {
  render(<StrictMode><DecodedImage src="/api/assets/artwork/strict/v1/384" alt="重放" revealOnLoad /></StrictMode>);
  const node = screen.getByRole('img');
  fireEvent.load(node);
  // 浏览器处理撤销后新记录开始；旧 load 不能提前标为完成。
  await act(async () => {});
  fireEvent.load(node);
  expect(node).toHaveAttribute('data-image-state', 'ready');
});
