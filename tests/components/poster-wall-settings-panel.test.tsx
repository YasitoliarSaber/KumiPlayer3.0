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

function choose(name: string, value: string) {
  fireEvent.click(screen.getByRole('combobox', { name }));
  const label = name === '封面大小' ? `${value} 列` : value === 'fanart' ? '横向海报' : '竖版封面';
  fireEvent.click(screen.getByRole('option', { name: label, exact: true }));
}

const base = { poster_size: 180, series_card_image_mode: 'poster' as const };

beforeEach(() => {
  ui.setPosterWallLayout.mockClear();
});

test('列数按 5 到 9 顺序提供，9 列只在应用后提交', async () => {
  const onSave = vi.fn().mockResolvedValue({ poster_size: 9, series_card_image_mode: 'poster' });
  render(<PosterWallSettingsPanel config={{ ...base, poster_size: 4 }} onSave={onSave} />);
  const size = screen.getByRole('combobox', { name: '封面大小' });
  expect(size).toHaveTextContent('5 列');
  fireEvent.click(size);
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['5 列', '6 列', '7 列', '8 列', '9 列']);
  fireEvent.click(screen.getByRole('option', { name: '9 列' }));
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '应用', exact: true }));
  await waitFor(() => expect(ui.setPosterWallLayout).toHaveBeenCalledExactlyOnceWith({ posterSize: 9, seriesCardImageMode: 'poster' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ poster_size: 9, series_card_image_mode: 'poster' });
});

test('读取旧像素偏好显示当前目标列数，反复选择不写配置', () => {
  const onSave = vi.fn();
  render(<PosterWallSettingsPanel config={base} onSave={onSave} />);
  const ratio = screen.getByRole('combobox', { name: '封面比例' });
  const size = screen.getByRole('combobox', { name: '封面大小' });

  expect(ratio).toHaveTextContent('竖版封面');
  expect(size).toHaveTextContent('5 列');
  expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '还原' })).toBeDisabled();

  choose('封面大小', '8');
  choose('封面比例', 'fanart');
  choose('封面大小', '6');

  expect(onSave).not.toHaveBeenCalled();
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '应用' })).toBeEnabled();
});

test('应用时一次提交两个布局字段，等待响应期间不改 Store', async () => {
  let finish!: (value: typeof base) => void;
  const onSave = vi.fn(() => new Promise<typeof base>((resolve) => { finish = resolve; }));
  render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  choose('封面大小', '8');
  choose('封面比例', 'fanart');
  fireEvent.click(screen.getByRole('button', { name: '应用' }));

  expect(onSave).toHaveBeenCalledExactlyOnceWith({ poster_size: 8, series_card_image_mode: 'fanart' });
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();

  await act(async () => finish({ poster_size: 8, series_card_image_mode: 'fanart' }));

  expect(ui.setPosterWallLayout).toHaveBeenCalledExactlyOnceWith({ posterSize: 8, seriesCardImageMode: 'fanart' });
  expect(screen.getByRole('status')).toHaveTextContent('作品墙设置已保存');
  expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
});

test('连点只发送一次请求，保存期间与外部忙碌时都不写入', async () => {
  let finish!: (value: typeof base) => void;
  const onSave = vi.fn(() => new Promise<typeof base>((resolve) => { finish = resolve; }));
  const { rerender } = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  choose('封面大小', '7');
  const apply = screen.getByRole('button', { name: '应用' });
  fireEvent.click(apply);
  fireEvent.click(apply);

  expect(onSave).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('combobox', { name: '封面比例' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: '封面大小' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '还原' })).toBeDisabled();

  await act(async () => finish({ poster_size: 7, series_card_image_mode: 'poster' }));

  const idle = vi.fn();
  rerender(<PosterWallSettingsPanel config={{ poster_size: 7, series_card_image_mode: 'poster' }} onSave={idle} externalBusy />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  expect(idle).not.toHaveBeenCalled();
});

test('保存失败保留旧 Store 与草稿，重试成功才生效', async () => {
  const onSave = vi.fn()
    .mockRejectedValueOnce(new Error('网络错误'))
    .mockResolvedValueOnce({ poster_size: 8, series_card_image_mode: 'fanart' });
  render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  choose('封面大小', '8');
  choose('封面比例', 'fanart');
  fireEvent.click(screen.getByRole('button', { name: '应用' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('作品墙设置未能保存，请重试');
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveTextContent('8 列');
  expect(screen.getByRole('combobox', { name: '封面比例' })).toHaveTextContent('横向海报');

  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  await waitFor(() => expect(ui.setPosterWallLayout)
    .toHaveBeenCalledExactlyOnceWith({ posterSize: 8, seriesCardImageMode: 'fanart' }));
  expect(screen.getByRole('status')).toHaveTextContent('作品墙设置已保存');
});

test('还原选择只丢弃草稿，不发送请求也不改 Store', () => {
  const onSave = vi.fn();
  render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  choose('封面大小', '8');
  expect(screen.getByRole('button', { name: '还原' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '还原' }));

  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveTextContent('5 列');
  expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
  expect(onSave).not.toHaveBeenCalled();
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
});

test('保存其他配置不吞掉未保存草稿，服务端布局变化时同步基准', () => {
  const onSave = vi.fn();
  const { rerender } = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  choose('封面大小', '8');
  // 保存其他设置会换掉整个 config 对象，但两个布局字段未变：草稿必须保留。
  rerender(<PosterWallSettingsPanel config={{ ...base }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveTextContent('8 列');

  // 没有草稿时同步服务端布局；旧大封面偏好归入 5 列。
  fireEvent.click(screen.getByRole('button', { name: '还原' }));
  rerender(<PosterWallSettingsPanel config={{ poster_size: 210, series_card_image_mode: 'fanart' }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveTextContent('5 列');
  expect(screen.getByRole('combobox', { name: '封面比例' })).toHaveTextContent('横向海报');
  rerender(<PosterWallSettingsPanel config={{ poster_size: 170, series_card_image_mode: 'poster' }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveTextContent('5 列');
});

test('使用服务端返回的合法布局更新 Store，响应非法时不宣称成功', async () => {
  const onSave = vi.fn().mockResolvedValueOnce({ poster_size: 6, series_card_image_mode: 'poster' });
  const first = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  choose('封面大小', '8');
  fireEvent.click(screen.getByRole('button', { name: '应用' }));
  await waitFor(() => expect(ui.setPosterWallLayout)
    .toHaveBeenCalledExactlyOnceWith({ posterSize: 6, seriesCardImageMode: 'poster' }));
  first.unmount();
  ui.setPosterWallLayout.mockClear();

  const invalid = vi.fn().mockResolvedValue({ poster_size: 0, series_card_image_mode: 'poster' });
  render(<PosterWallSettingsPanel config={base} onSave={invalid} />);
  choose('封面大小', '8');
  fireEvent.click(screen.getByRole('button', { name: '应用' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('保存结果无法确认，请重新进入设置核对');
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
});

test('未应用就离开不会持久化布局', () => {
  const onSave = vi.fn();
  const { unmount } = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);

  choose('封面大小', '8');
  unmount();

  expect(onSave).not.toHaveBeenCalled();
  expect(ui.setPosterWallLayout).not.toHaveBeenCalled();
});

test('服务端布局变化时仍显示旧列数草稿，还原后采用新的已保存值', () => {
  const onSave = vi.fn();
  const { rerender } = render(<PosterWallSettingsPanel config={base} onSave={onSave} />);
  choose('封面比例', 'fanart');
  rerender(<PosterWallSettingsPanel config={{ poster_size: 6, series_card_image_mode: 'poster' }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveTextContent('5 列');
  expect(screen.getByRole('combobox', { name: '封面比例' })).toHaveTextContent('横向海报');
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '还原' }));
  expect(screen.getByRole('combobox', { name: '封面大小' })).toHaveTextContent('6 列');
});
