import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import OngoingUpdateSettingsPanel from '../../src/components/settings/OngoingUpdateSettingsPanel';

test('缺少设置字段时默认关闭且不主动写入配置', () => {
  const onSave = vi.fn();
  render(<OngoingUpdateSettingsPanel config={{}} onSave={onSave} />);
  expect(screen.getByRole('switch', { name: '启动时更新新番' })).not.toBeChecked();
  expect(screen.getByRole('combobox', { name: '新番更新间隔' })).toHaveTextContent('关闭');
  expect(onSave).not.toHaveBeenCalled();
});

test('保存期间锁住两个控件并等待服务端配置，不乐观显示已启用', async () => {
  let finish!: () => void;
  const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const { rerender } = render(<OngoingUpdateSettingsPanel config={{}} onSave={onSave} />);
  const startup = screen.getByRole('switch', { name: '启动时更新新番' });
  const interval = screen.getByRole('combobox', { name: '新番更新间隔' });
  fireEvent.click(startup);
  fireEvent.click(startup);
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ongoing_update_on_startup: true });
  expect(startup).toBeDisabled();
  expect(interval).toBeDisabled();
  expect(startup).not.toBeChecked();
  expect(screen.queryByText('新番更新设置已保存')).not.toBeInTheDocument();
  await act(async () => finish());
  rerender(<OngoingUpdateSettingsPanel config={{ ongoing_update_on_startup: true }} onSave={onSave} />);
  expect(startup).toBeChecked();
  expect(interval).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('新番更新设置已保存');
});

test('定时设置保存失败保留旧生效值，重试成功才显示已保存', async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error('离线夹具错误')).mockResolvedValue(undefined);
  const { rerender } = render(<OngoingUpdateSettingsPanel config={{ ongoing_update_interval_minutes: 30 }} onSave={onSave} />);
  const interval = screen.getByRole('combobox', { name: '新番更新间隔' });
  fireEvent.click(interval);
  fireEvent.click(screen.getByRole('option', { name: '每小时' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('离线夹具错误');
  expect(interval).toHaveTextContent('每 30 分钟');
  expect(screen.queryByText('新番更新设置已保存')).not.toBeInTheDocument();
  fireEvent.click(interval);
  fireEvent.click(screen.getByRole('option', { name: '每小时' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole('status')).toHaveTextContent('新番更新设置已保存');
  rerender(<OngoingUpdateSettingsPanel config={{ ongoing_update_interval_minutes: 60 }} onSave={onSave} />);
  expect(interval).toHaveTextContent('每小时');
});

test('保留服务端有效自定义间隔，关闭定时只保存零值', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<OngoingUpdateSettingsPanel config={{ ongoing_update_on_startup: true, ongoing_update_interval_minutes: 37 }} onSave={onSave} />);
  const interval = screen.getByRole('combobox', { name: '新番更新间隔' });
  expect(interval).toHaveTextContent('每 37 分钟');
  fireEvent.click(interval);
  expect(screen.getByRole('option', { name: '每 37 分钟' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('option', { name: '关闭' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith({ ongoing_update_interval_minutes: 0 }));
  expect(screen.getByRole('switch', { name: '启动时更新新番' })).toBeChecked();
});

test('外部保存进行时不允许并行写入', () => {
  const onSave = vi.fn();
  render(<OngoingUpdateSettingsPanel config={{}} onSave={onSave} externalBusy />);
  const startup = screen.getByRole('switch', { name: '启动时更新新番' });
  expect(startup).toBeDisabled();
  expect(screen.getByRole('combobox', { name: '新番更新间隔' })).toBeDisabled();
  fireEvent.click(startup);
  expect(onSave).not.toHaveBeenCalled();
});

test('每天与每周选择固定本机时间，星期和时间保存同一配置', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(<OngoingUpdateSettingsPanel config={{}} onSave={onSave} />);
  fireEvent.click(screen.getByRole('combobox', { name: '新番更新间隔' }));
  fireEvent.click(screen.getByRole('option', { name: '每天' }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ ongoing_update_schedule_mode: 'daily', ongoing_update_time: '09:00', ongoing_update_weekday: 0 }));
  rerender(<OngoingUpdateSettingsPanel config={{ ongoing_update_schedule_mode: 'weekly', ongoing_update_time: '20:00', ongoing_update_weekday: 2 }} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: '更新星期' })).toHaveTextContent('星期三');
  fireEvent.click(screen.getByRole('combobox', { name: '更新星期' }));
  fireEvent.click(screen.getByRole('option', { name: '星期六' }));
  fireEvent.change(screen.getByLabelText('更新时间'), { target: { value: '21:30' } });
  fireEvent.click(screen.getByRole('button', { name: '保存时间' }));
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ ongoing_update_time: '21:30', ongoing_update_weekday: 5 }));
});

test('旧的滚动24小时配置明确显示为分钟，不冒充固定每天时间', () => {
  render(<OngoingUpdateSettingsPanel config={{ ongoing_update_interval_minutes: 1440 }} onSave={vi.fn()} />);
  expect(screen.getByRole('combobox', { name: '新番更新间隔' })).toHaveTextContent('每 1440 分钟');
  expect(screen.queryByLabelText('更新时间')).not.toBeInTheDocument();
});
