import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import PosterWallSettingsPanel from '../../src/components/settings/PosterWallSettingsPanel';

const ui = vi.hoisted(() => ({ setPosterWallLayout: vi.fn() }));
vi.mock('../../src/stores/ui', () => ({
  useUiStore: (selector?: (state: unknown) => unknown) => {
    const state = { setPosterWallLayout: ui.setPosterWallLayout };
    return selector ? selector(state) : state;
  },
}));

const base = { poster_size: 180, series_card_image_mode: 'poster' as const };

beforeEach(() => {
  ui.setPosterWallLayout.mockClear();
});

test('读取旧像素偏好显示当前目标列数，反复选择不写配置', () => {
  const onSave = vi.fn();
  render(<PosterWallSettingsPanel config={base} onSave={onSave} />);
  const ratio = screen.getByRole('combobox', { name: '封面比例' });
  const size = screen.getByRole('combobox', { name: '封面大小' });

  expect(ratio).toHaveValue('poster');
  expect(size).toHaveValue('5');
  expect(screen.getByRole('option', { name: '当前设置（目标 5 列）' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '应用作品墙设置' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '还原选择' })).toBeDisabled();

  fireEvent.change(size, { target: { value: '8' } });
  fireEvent.change(ratio, { target: { value: 'fanart' } });
  fireEvent.change(size, { target: { value: '6' } });

  expect(onSave).not.toHaveBeenCalled();
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '应用作品墙设置' })).toBeEnabled();
});

test('应用时一次提交两个布局字段，等待响应期间不改 Store', async () => {
  let finish!: (value: typeof base) => void;
  const onSave = vi.fn(() => new Promise<typeof base>((resolve) => { finish = resolve; }));
  render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  fireEvent.change(screen.getByRole('combobox', { name: '封面大小' }), { target: { value: '8' } });
  fireEvent.change(screen.getByRole('combobox', { name: '封面比例' }), { target: { value: 'fanart' } });
  fireEvent.click(screen.getByRole('button', { name: '应用作品墙设置' }));

  expect(onSave).toHaveBeenCalledExactlyOnceWith({ poster_size: 8, series_card_image_mode: 'fanart' });
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();

  await act(async () => finish({ poster_size: 8, series_card_image_mode: 'fanart' }));

  expect(ui.setPosterWallLayout).toHaveBeenCalledExactlyOnceWith({ posterSize: 8, seriesCardImageMode: 'fanart' });
  expect(screen.getByRole('status')).toHaveTextContent('作品墙设置已保存');
  expect(screen.getByRole('button', { name: '应用作品墙设置' })).toBeDisabled();
});

test('连点只发送一次请求，保存期间与外部忙碌时都不写入', async () => {
  let finish!: (value: typeof base) => void;
  const onSave = vi.fn(() => new Promise<typeof base>((resolve) => { finish = resolve; }));
  const { rerender } = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  fireEvent.change(screen.getByRole('combobox', { name: '封面大小' }), { target: { value: '4' } });
  const apply = screen.getByRole('button', { name: '应用作品墙设置' });
  fireEvent.click(apply);
  fireEvent.click(apply);

  expect(onSave).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('combobox', { name: '封面比例' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: '封面大小' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '还原选择' })).toBeDisabled();

  await act(async () => finish({ poster_size: 4, series_card_image_mode: 'poster' }));

  const idle = vi.fn();
  rerender(<PosterWallSettingsPanel config={{ poster_size: 4, series_card_image_mode: 'poster' }} onSave={idle} externalBusy />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '应用作品墙设置' }));
  expect(idle).not.toHaveBeenCalled();
});

test('保存失败保留旧 Store 与草稿，重试成功才生效', async () => {
  const onSave = vi.fn()
    .mockRejectedValueOnce(new Error('网络错误'))
    .mockResolvedValueOnce({ poster_size: 8, series_card_image_mode: 'fanart' });
  render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  fireEvent.change(screen.getByRole('combobox', { name: '封面大小' }), { target: { value: '8' } });
  fireEvent.change(screen.getByRole('combobox', { name: '封面比例' }), { target: { value: 'fanart' } });
  fireEvent.click(screen.getByRole('button', { name: '应用作品墙设置' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('作品墙设置未能保存，请重试');
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveValue('8');
  expect(screen.getByRole('combobox', { name: '封面比例' })).toHaveValue('fanart');

  fireEvent.click(screen.getByRole('button', { name: '应用作品墙设置' }));
  await waitFor(() => expect(ui.setPosterWallLayout)
    .toHaveBeenCalledExactlyOnceWith({ posterSize: 8, seriesCardImageMode: 'fanart' }));
  expect(screen.getByRole('status')).toHaveTextContent('作品墙设置已保存');
});

test('还原选择只丢弃草稿，不发送请求也不改 Store', () => {
  const onSave = vi.fn();
  render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  fireEvent.change(screen.getByRole('combobox', { name: '封面大小' }), { target: { value: '8' } });
  expect(screen.getByRole('button', { name: '还原选择' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '还原选择' }));

  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveValue('5');
  expect(screen.getByRole('button', { name: '应用作品墙设置' })).toBeDisabled();
  expect(onSave).not.toHaveBeenCalled();
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
});

test('保存其他配置不吞掉未保存草稿，服务端布局变化时同步基准', () => {
  const onSave = vi.fn();
  const { rerender } = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  fireEvent.change(screen.getByRole('combobox', { name: '封面大小' }), { target: { value: '8' } });
  // 保存其他设置会换掉整个 config 对象，但两个布局字段未变：草稿必须保留。
  rerender(<PosterWallSettingsPanel config={{ ...base }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveValue('8');

  // 服务端布局确实变化且本地没有草稿时才同步；旧 5/7 不自动映射到预设。
  fireEvent.click(screen.getByRole('button', { name: '还原选择' }));
  rerender(<PosterWallSettingsPanel config={{ poster_size: 210, series_card_image_mode: 'fanart' }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveValue('4');
  expect(screen.getByRole('combobox', { name: '封面比例' })).toHaveValue('fanart');
  rerender(<PosterWallSettingsPanel config={{ poster_size: 170, series_card_image_mode: 'poster' }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveValue('5');
  expect(screen.getByRole('option', { name: '当前设置（目标 5 列）' })).toBeInTheDocument();
});

test('使用服务端返回的合法布局更新 Store，响应非法时不宣称成功', async () => {
  const onSave = vi.fn().mockResolvedValueOnce({ poster_size: 6, series_card_image_mode: 'poster' });
  const first = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  fireEvent.change(screen.getByRole('combobox', { name: '封面大小' }), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('button', { name: '应用作品墙设置' }));
  await waitFor(() => expect(ui.setPosterWallLayout)
    .toHaveBeenCalledExactlyOnceWith({ posterSize: 6, seriesCardImageMode: 'poster' }));
  first.unmount();
  ui.setPosterWallLayout.mockClear();

  const invalid = vi.fn().mockResolvedValue({ poster_size: 0, series_card_image_mode: 'poster' });
  render(<PosterWallSettingsPanel config={base} onSave={invalid} />);
  fireEvent.change(screen.getByRole('combobox', { name: '封面大小' }), { target: { value: '8' } });
  fireEvent.click(screen.getByRole('button', { name: '应用作品墙设置' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('保存结果无法确认，请重新进入设置核对');
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
});

test('未应用就离开不会持久化布局', () => {
  const onSave = vi.fn();
  const { unmount } = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  fireEvent.change(screen.getByRole('combobox', { name: '封面大小' }), { target: { value: '8' } });
  unmount();

  expect(onSave).not.toHaveBeenCalled();
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
});

test('服务端布局变化时仍显示旧列数草稿，还原后采用新的已保存值', () => {
  const onSave = vi.fn();
  const { rerender } = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);
  fireEvent.change(screen.getByRole('combobox', { name: '封面比例' }), { target: { value: 'fanart' } });
  rerender(<PosterWallSettingsPanel config={{ poster_size: 6, series_card_image_mode: 'poster' }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveValue('5');
  expect(screen.getByRole('combobox', { name: '封面比例' })).toHaveValue('fanart');
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '还原选择' }));
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveValue('6');
});
