import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import FolderPathInput from '../../src/components/settings/FolderPathInput';
import { pickFolder } from '../../src/platform/folderPicker';
import { useState } from 'react';

vi.mock('../../src/platform/folderPicker', () => ({ pickFolder: vi.fn() }));

test('取消与失败不改路径，并显示可重试错误', async () => {
  const onChange = vi.fn();
  vi.mocked(pickFolder).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('dialog unavailable'));
  render(<FolderPathInput label="本地目录" value="J:/Media" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: '选择本地目录' }));
  await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '选择本地目录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无法打开文件夹选择器');
  expect(onChange).not.toHaveBeenCalled();
});

test('切换连接后迟到的文件夹选择不能更新新连接', async () => {
  let finish!: (value: string) => void;
  vi.mocked(pickFolder).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const onChange = vi.fn();
  const view = render(<FolderPathInput label="挂载位置" value="K:/" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: '选择挂载位置' }));
  view.unmount();
  await act(async () => finish('J:/'));
  expect(onChange).not.toHaveBeenCalled();
});

test('摘要显示完整路径，展开与收起手动编辑保留草稿且不调用选择器', () => {
  const path = 'K:/动画/非常长的文件夹名称/完整路径不会被摘要截断';
  const before = vi.mocked(pickFolder).mock.calls.length;
  function Harness() {
    const [value, setValue] = useState(path);
    return <FolderPathInput compact label="挂载位置" value={value} onChange={setValue} />;
  }
  render(<Harness />);
  expect(screen.getByText(path)).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '手动输入挂载位置' }));
  expect(screen.getByRole('textbox', { name: '挂载位置' }).tagName).toBe('TEXTAREA');
  fireEvent.change(screen.getByRole('textbox', { name: '挂载位置' }), { target: { value: 'J:/新的/\n路径' } });
  fireEvent.click(screen.getByRole('button', { name: '收起编辑' }));
  expect(screen.getByText('J:/新的/路径')).toBeVisible();
  expect(vi.mocked(pickFolder).mock.calls.length).toBe(before);
});
