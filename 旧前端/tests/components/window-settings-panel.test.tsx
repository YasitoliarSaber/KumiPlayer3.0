import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import WindowSettingsPanel from '../../src/components/settings/WindowSettingsPanel';

const desktop = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), hide: vi.fn() }));
vi.mock('../../src/platform/windowPreferences', () => ({
  getWindowPreferences: desktop.get,
  saveWindowPreferences: desktop.save,
  hideToTray: desktop.hide,
}));
const defaults = { minimize_to_tray: false, close_to_tray: false };

beforeEach(() => {
  desktop.get.mockReset().mockResolvedValue(defaults);
  desktop.save.mockReset().mockImplementation(async (value) => value);
  desktop.hide.mockReset().mockResolvedValue(undefined);
});

test('loads the native preferences and offers independent close and minimize switches', async () => {
  render(<WindowSettingsPanel />);
  const minimize = await screen.findByRole('switch', { name: '点击窗口最小化按钮时收到托盘' });
  const close = screen.getByRole('switch', { name: '关闭窗口时收到托盘' });
  expect(minimize).not.toBeChecked();
  expect(close).not.toBeChecked();
  fireEvent.click(minimize);
  await waitFor(() => expect(minimize).toBeChecked());
  expect(desktop.save).toHaveBeenCalledWith({ minimize_to_tray: true, close_to_tray: false });
  expect(close).not.toBeChecked();
});

test('a failed save preserves the old behavior and allows retry', async () => {
  desktop.save.mockRejectedValueOnce(new Error('disk full'));
  render(<WindowSettingsPanel />);
  const close = await screen.findByRole('switch', { name: '关闭窗口时收到托盘' });
  fireEvent.click(close);
  expect(await screen.findByRole('alert')).toHaveTextContent('窗口设置未能保存');
  expect(close).not.toBeChecked();
  fireEvent.click(close);
  await waitFor(() => expect(close).toBeChecked());
});

test('switches remain disabled until the native save completes', async () => {
  let finish!: (value: typeof defaults) => void;
  desktop.save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<WindowSettingsPanel />);
  const close = await screen.findByRole('switch', { name: '关闭窗口时收到托盘' });
  fireEvent.click(close);
  expect(close).toBeDisabled();
  expect(screen.getByRole('switch', { name: '点击窗口最小化按钮时收到托盘' })).toBeDisabled();
  await act(async () => finish({ ...defaults, close_to_tray: true }));
  expect(close).toBeEnabled();
  expect(close).toBeChecked();
});

test('read errors are visible and can be retried without resetting saved preferences', async () => {
  desktop.get.mockRejectedValueOnce(new Error('read failed'));
  render(<WindowSettingsPanel />);
  expect(await screen.findByRole('alert')).toHaveTextContent('无法读取窗口设置');
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  expect(await screen.findByRole('switch', { name: '点击窗口最小化按钮时收到托盘' })).not.toBeChecked();
});

test('the immediate tray button uses the native command and reports hide failures', async () => {
  desktop.hide.mockRejectedValueOnce(new Error('tray unavailable'));
  render(<WindowSettingsPanel />);
  await screen.findByRole('switch', { name: '点击窗口最小化按钮时收到托盘' });
  fireEvent.click(screen.getByRole('button', { name: '立即收到托盘' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无法收到托盘');
  expect(desktop.hide).toHaveBeenCalledOnce();
});
