import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { PublicConfig } from '../../src/api/config';
import LocalRootsPanel from '../../src/components/settings/LocalRootsPanel';
vi.mock('../../src/platform/folderPicker', () => ({ pickFolder: vi.fn() }));
const config = { local_root: 'D:/Media', local_roots: [{ root_id: 'root-1', name: '动画库', path: 'D:/Media' }] } as PublicConfig;

test('登记两个目录后按列表保存，不覆盖为一个兼容值', async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<LocalRootsPanel config={config} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: '添加本地目录' }));
  fireEvent.change(screen.getByRole('textbox', { name: '目录 2 名称' }), { target: { value: '影视库' } });
  fireEvent.change(screen.getByRole('textbox', { name: '目录 2 路径' }), { target: { value: 'E:/Movies' } });
  fireEvent.click(screen.getByRole('button', { name: '保存本地目录' }));
  await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith({ local_roots: [
    { root_id: '', name: '动画库', path: 'D:/Media' }, { root_id: '', name: '影视库', path: 'E:/Movies' },
  ] }));
  expect(screen.getByRole('button', { name: '保存本地目录' })).toBeDisabled();
});

test('移除登记需要再次确认，确认前可以取消', () => {
  render(<LocalRootsPanel config={config} onSave={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '移除动画库' }));
  expect(screen.getByRole('textbox', { name: '目录 1 路径' })).toHaveValue('D:/Media');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '移除动画库' }));
  fireEvent.click(screen.getByRole('button', { name: '确认移除' }));
  expect(screen.queryByRole('textbox', { name: '目录 1 路径' })).not.toBeInTheDocument();
});

test.each(['relative/Media', 'd:\\MEDIA\\.'])('拒绝非法或重复路径 %s，保留草稿', async path => {
  const save = vi.fn();
  render(<LocalRootsPanel config={config} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: '添加本地目录' }));
  fireEvent.change(screen.getByRole('textbox', { name: '目录 2 路径' }), { target: { value: path } });
  fireEvent.click(screen.getByRole('button', { name: '保存本地目录' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: '目录 2 路径' })).toHaveValue(path);
});

test('其他配置刷新与保存失败不会清掉目录草稿', async () => {
  const save = vi.fn().mockRejectedValue(new Error('offline'));
  const view = render(<LocalRootsPanel config={config} onSave={save} />);
  fireEvent.change(screen.getByRole('textbox', { name: '目录 1 名称' }), { target: { value: '待保存' } });
  view.rerender(<LocalRootsPanel config={{ ...config, poster_size: 8 }} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: '保存本地目录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能保存');
  expect(screen.getByRole('textbox', { name: '目录 1 名称' })).toHaveValue('待保存');
});

test('旧单目录仍显示为第一条登记', () => {
  render(<LocalRootsPanel config={{ local_root: 'D:/Old' } as PublicConfig} onSave={vi.fn()} />);
  expect(screen.getByRole('textbox', { name: '目录 1 路径' })).toHaveValue('D:/Old');
});
