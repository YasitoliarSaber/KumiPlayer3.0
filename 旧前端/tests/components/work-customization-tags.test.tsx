import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import WorkCustomizationTags from '../../src/components/detail/WorkCustomizationTags';
import { useUiStore } from '../../src/stores/ui';

const { getCustomization, saveTags, getExtraVideos } = vi.hoisted(() => ({
  getCustomization: vi.fn(),
  saveTags: vi.fn(),
  getExtraVideos: vi.fn(),
}));

vi.mock('../../src/api/workCustomization', () => ({
  workCustomizationApi: {
    get: getCustomization,
    saveTags,
    getExtraVideos,
  },
}));

beforeEach(() => {
  getCustomization.mockReset().mockResolvedValue({ work_id: 'work-1', tags: [] });
  saveTags.mockReset().mockImplementation(async (_workId, tags) => ({ work_id: 'work-1', tags }));
  getExtraVideos.mockReset().mockResolvedValue({
    work_id: 'work-1',
    substantive_special_count: 0,
    auxiliary_count: 2,
    unmatched_count: 0,
    uncertain_count: 0,
    reasons: [],
    categories: [{ category: 'auxiliary', count: 2, reasons: ['PV/CM'] }],
  });
  useUiStore.setState({
    detailTagPresets: [],
    extraVideoRemindersEnabled: true,
    includeAuxiliaryVideoReminders: false,
  });
});

test('自定义标签可保存并成为快捷项，动画类型不会重复显示且默认隐藏辅助视频提醒', async () => {
  render(<WorkCustomizationTags workId="work-1" sources={['本地']} metadataStatus={<span>TMDB 已同步</span>} typeTags={['动画', '科幻']} />);

  expect(await screen.findByText('科幻')).toBeInTheDocument();
  expect(screen.queryByText('动画')).not.toBeInTheDocument();
  expect(screen.queryByText(/辅助视频/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '管理自定义标签' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox', { name: '标签名称' }), { target: { value: '收藏待看' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '添加到作品' }));

  await waitFor(() => expect(saveTags).toHaveBeenCalledWith('work-1', [expect.objectContaining({ label: '收藏待看', color: '#7c9cff' })]));
  expect(await screen.findByText('收藏待看')).toBeInTheDocument();
  expect(useUiStore.getState().detailTagPresets).toEqual([expect.objectContaining({ label: '收藏待看' })]);

  fireEvent.click(screen.getByRole('button', { name: '管理自定义标签' }));
  const reopenedDialog = await screen.findByRole('dialog');
  await waitFor(() => expect(reopenedDialog).toBeVisible());
  fireEvent.click(within(reopenedDialog).getByText('收藏待看').closest('button')!);
  await waitFor(() => expect(saveTags).toHaveBeenLastCalledWith('work-1', [expect.objectContaining({ label: '收藏待看' })]));
});

test('编辑已有标签会保留 id 并更新快捷标签名称和颜色', async () => {
  getCustomization.mockResolvedValue({
    work_id: 'work-1',
    tags: [{ id: 'stable-id', label: '稍后看', color: '#123456' }],
  });

  render(<WorkCustomizationTags workId="work-1" sources={[]} metadataStatus={null} typeTags={[]} />);

  fireEvent.click(await screen.findByRole('button', { name: '编辑标签 稍后看' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox', { name: '标签名称' }), { target: { value: '已收藏' } });
  fireEvent.change(within(dialog).getByLabelText('选择标签颜色'), { target: { value: '#abcdef' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存修改' }));

  await waitFor(() => expect(saveTags).toHaveBeenCalledWith('work-1', [
    { id: 'stable-id', label: '已收藏', color: '#abcdef' },
  ]));
  expect(useUiStore.getState().detailTagPresets).toEqual([
    expect.objectContaining({ id: 'stable-id', label: '已收藏', color: '#abcdef' }),
  ]);
});

test('切换作品先清空旧标签，读取失败会提示重试并阻止覆盖保存', async () => {
  getCustomization.mockResolvedValueOnce({
    work_id: 'work-1',
    tags: [{ id: 'old-id', label: '旧作品标签', color: '#123456' }],
  }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
    work_id: 'work-2',
    tags: [{ id: 'new-id', label: '新作品标签', color: '#654321' }],
  });
  const view = render(<WorkCustomizationTags workId="work-1" sources={[]} metadataStatus={null} typeTags={[]} />);
  expect(await screen.findByText('旧作品标签')).toBeInTheDocument();

  view.rerender(<WorkCustomizationTags workId="work-2" sources={[]} metadataStatus={null} typeTags={[]} />);

  expect(screen.queryByText('旧作品标签')).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('作品标签读取失败');
  expect(screen.getByRole('button', { name: '管理自定义标签' })).toBeDisabled();
  expect(saveTags).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('新作品标签')).toBeInTheDocument();
  expect(screen.queryByText('旧作品标签')).not.toBeInTheDocument();
});

test('旧作品的未完成保存响应不会覆盖切换后作品的标签状态', async () => {
  getCustomization.mockResolvedValueOnce({
    work_id: 'work-1',
    tags: [{ id: 'old-id', label: '旧标签', color: '#123456' }],
  }).mockResolvedValueOnce({
    work_id: 'work-2',
    tags: [{ id: 'new-id', label: '新标签', color: '#654321' }],
  });
  let resolveOldSave: ((value: { work_id: string; tags: never[] }) => void) | undefined;
  saveTags.mockImplementationOnce(() => new Promise((resolve) => { resolveOldSave = resolve; }));
  const view = render(<WorkCustomizationTags workId="work-1" sources={[]} metadataStatus={null} typeTags={[]} />);

  fireEvent.click(await screen.findByRole('button', { name: '移除标签 旧标签' }));
  await waitFor(() => expect(saveTags).toHaveBeenCalledWith('work-1', []));
  view.rerender(<WorkCustomizationTags workId="work-2" sources={[]} metadataStatus={null} typeTags={[]} />);
  expect(await screen.findByText('新标签')).toBeInTheDocument();

  resolveOldSave?.({ work_id: 'work-1', tags: [] });
  await waitFor(() => expect(screen.getByText('新标签')).toBeInTheDocument());
  expect(screen.queryByText('旧标签')).not.toBeInTheDocument();
});
