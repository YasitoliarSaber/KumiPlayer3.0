import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import OpenListSettingsPanel, { type OpenListDraft } from '../../src/components/settings/OpenListSettingsPanel';
import type { PublicConfig } from '../../src/api/config';
import type { OpenListTestResult } from '../../src/api/openlist';

const telemetry = vi.hoisted(() => vi.fn(async () => ({ fs_list: 0, login: 0, total: 0, disclaimer: '' })));
vi.mock('../../src/api/openlist', () => ({ openlistApi: { getTelemetryToday: telemetry } }));

const config = {
  openlist_configured: true,
  openlist_connection_id: 'connection-a',
  openlist_server_url: 'https://openlist.example.test',
  openlist_remote_root: '/media',
  openlist_mount_root: 'K:\\',
  openlist_cache_ttl_minutes: 1440,
  openlist_prefetch_limit: 12,
} as PublicConfig;
const draft: OpenListDraft = {
  server_url: config.openlist_server_url, remote_root: config.openlist_remote_root,
  mount_root: config.openlist_mount_root, username: '', password: '', cache_ttl: '1440', prefetch_limit: '12',
};
const connected: OpenListTestResult = { ok: true, code: 'connected', phase: 'list', message: '' };
const callbacks = () => ({
  onChangeDraft: vi.fn(), onSaveConnection: vi.fn(), onTestConnection: vi.fn(async () => connected),
  onNotice: vi.fn(), notice: '', noticeKind: 'info' as const,
});
beforeEach(() => vi.clearAllMocks());

test('进入已保存连接分类自动验证一次，发送当前身份与远端根且不写配置', async () => {
  const handlers = callbacks();
  const view = render(<OpenListSettingsPanel config={config} draft={draft} active={false} {...handlers} />);
  expect(handlers.onTestConnection).not.toHaveBeenCalled();
  view.rerender(<OpenListSettingsPanel config={config} draft={draft} active {...handlers} />);
  expect(await screen.findByText('OpenList 连接正常')).toBeVisible();
  expect(handlers.onTestConnection).toHaveBeenCalledExactlyOnceWith({
    connection_id: 'connection-a', server_url: config.openlist_server_url, remote_root: '/media',
    username: '', password: '', allow_insecure_http: true,
  });
  expect(handlers.onSaveConnection).not.toHaveBeenCalled();
  view.rerender(<OpenListSettingsPanel config={config} draft={{ ...draft }} active {...handlers} />);
  expect(handlers.onTestConnection).toHaveBeenCalledOnce();
});

test('离开再进入分类才重新验证，失败结果可见且不自动重试', async () => {
  const handlers = callbacks();
  handlers.onTestConnection.mockResolvedValue({ ok: false, code: 'root_not_found', phase: 'list', message: '远端目录已经不存在' });
  const view = render(<OpenListSettingsPanel config={config} draft={draft} active {...handlers} />);
  expect(await screen.findByText('远端根目录不存在或已被移动')).toBeVisible();
  expect(handlers.onNotice).toHaveBeenCalledWith('远端目录已经不存在', 'error');
  expect(handlers.onTestConnection).toHaveBeenCalledOnce();
  view.rerender(<OpenListSettingsPanel config={config} draft={draft} active={false} {...handlers} />);
  view.rerender(<OpenListSettingsPanel config={config} draft={draft} active {...handlers} />);
  await waitFor(() => expect(handlers.onTestConnection).toHaveBeenCalledTimes(2));
  await screen.findByText('远端根目录不存在或已被移动');
  expect(handlers.onTestConnection).toHaveBeenCalledTimes(2);
});

test.each(['未保存', '正在编辑', '操作进行中'])('%s时不自动发起连接验证', async state => {
  const handlers = callbacks();
  render(<OpenListSettingsPanel
    config={state === '未保存' ? { ...config, openlist_configured: false } : config}
    draft={state === '正在编辑' ? { ...draft, server_url: 'https://candidate.example.test' } : draft}
    active externalBusy={state === '操作进行中' ? 'saving' : null} {...handlers}
  />);
  await act(async () => {});
  expect(handlers.onTestConnection).not.toHaveBeenCalled();
  expect(handlers.onSaveConnection).not.toHaveBeenCalled();
});

test('分类中的当前验证尚未结束时不会重复发起，也不能并发手动验证', async () => {
  const handlers = callbacks();
  let finish!: (result: OpenListTestResult) => void;
  handlers.onTestConnection.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<OpenListSettingsPanel config={config} draft={draft} active {...handlers} />);
  expect(screen.getByText('正在检查连接…')).toBeVisible();
  expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '处理中…' }));
  view.rerender(<OpenListSettingsPanel config={config} draft={draft} active {...handlers} />);
  expect(handlers.onTestConnection).toHaveBeenCalledOnce();
  await act(async () => finish(connected));
  expect(screen.getByText('OpenList 连接正常')).toBeVisible();
  expect(handlers.onTestConnection).toHaveBeenCalledOnce();
});

test('开发模式重复执行effect仍只验证一次，结果不会被误当成已卸载响应', async () => {
  const handlers = callbacks();
  render(<StrictMode><OpenListSettingsPanel config={config} draft={draft} active {...handlers} /></StrictMode>);
  expect(await screen.findByText('OpenList 连接正常')).toBeVisible();
  expect(handlers.onTestConnection).toHaveBeenCalledOnce();
});

test('切换连接身份重建面板后，迟到的旧连接结果不覆盖当前连接', async () => {
  const handlers = callbacks();
  let finishFirst!: (result: OpenListTestResult) => void;
  handlers.onTestConnection.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
  const view = render(<OpenListSettingsPanel key="a" config={config} draft={draft} active {...handlers} />);
  const next = { ...config, openlist_connection_id: 'connection-b', openlist_server_url: 'https://second.example.test' };
  view.rerender(<OpenListSettingsPanel key="b" config={next} draft={{ ...draft, server_url: next.openlist_server_url }} active {...handlers} />);
  expect(await screen.findByText('OpenList 连接正常')).toBeVisible();
  expect(handlers.onTestConnection).toHaveBeenLastCalledWith(expect.objectContaining({ connection_id: 'connection-b' }));
  handlers.onNotice.mockClear();
  await act(async () => finishFirst({ ok: false, code: 'root_not_found', phase: 'list', message: '旧连接不存在' }));
  expect(screen.getByText('OpenList 连接正常')).toBeVisible();
  expect(screen.queryByText('远端根目录不存在或已被移动')).not.toBeInTheDocument();
  expect(handlers.onNotice).not.toHaveBeenCalledWith('旧连接不存在', 'error');
});
