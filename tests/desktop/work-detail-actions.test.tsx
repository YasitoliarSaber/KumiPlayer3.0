/**
 * 作品详情「更多操作」的真实链路：重新刮削 / 编辑标题 / 打开所在位置 / 从媒体库移除。
 * 全部使用桩 MediaService：不连接后端、不读写真实数据，也不访问在线服务。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { WorkDetailPage } from '../../src/renderer/features/work/WorkDetailPage';
import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { resetDemoState } from '../../src/renderer/mock/demo-store';
import { createMockMediaService } from '../../src/renderer/mock/service';
import { ServiceProvider } from '../../src/renderer/shared/api/service-context';
import type { MediaService, WorkDeletePreview } from '../../src/renderer/shared/api/service';

const catalog = buildMockCatalog();
const work = catalog.works[0]!;

function renderDetail(service: MediaService) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ServiceProvider service={service}>
        <MemoryRouter initialEntries={[`/work/${work.id}`]}>
          <Routes>
            <Route path="/work/:workId" element={<WorkDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ServiceProvider>
    </QueryClientProvider>,
  );
}

/** 打开「更多操作」菜单：Radix 下拉菜单在方向键 ArrowDown 上切换到打开状态。 */
async function openActionsMenu() {
  const trigger = await screen.findByRole('button', { name: '更多操作' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' });
  return trigger;
}

async function clickMenuItem(name: string) {
  await openActionsMenu();
  const item = await screen.findByRole('menuitem', { name });
  fireEvent.click(item);
}

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
});

beforeEach(() => {
  resetDemoState();
});

afterEach(() => {
  resetDemoState();
});

describe('作品详情真实操作（任务 A）', () => {
  it('重新刮削调用真实服务并显示后端作业号', async () => {
    const scrapeWork = vi.fn(async () => ({ jobId: 'job_42', status: 'queued' }));
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, scrapeWork });

    await clickMenuItem('重新刮削资料');

    await waitFor(() => expect(scrapeWork).toHaveBeenCalledWith(work.id));
    expect(await screen.findByText('已排队重新刮削，作业 job_42')).toBeTruthy();
  });

  it('重新刮削失败显示后端真实原因，绝不显示成功', async () => {
    const scrapeWork = vi.fn(async () => {
      throw new Error('远端 TMDB 暂时不可用');
    });
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, scrapeWork });

    await clickMenuItem('重新刮削资料');

    expect(await screen.findByText('远端 TMDB 暂时不可用')).toBeTruthy();
    expect(screen.queryByText(/已排队重新刮削/)).toBeNull();
  });

  it('演示模式（无真实能力）明确说明不执行真实操作', async () => {
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail(base);

    await clickMenuItem('重新刮削资料');

    expect(await screen.findByText('演示模式不执行真实操作：当前服务没有重新刮削能力。')).toBeTruthy();
  });

  it('编辑标题失败保留输入，并在对话框内显示后端原因', async () => {
    const setManualTitle = vi.fn(async () => {
      throw new Error('标题不能改为空');
    });
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, setManualTitle });

    await clickMenuItem('编辑标题');
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('展示标题');
    fireEvent.change(input, { target: { value: '手动标题 X' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(setManualTitle).toHaveBeenCalledWith(work.id, '手动标题 X'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('标题不能改为空');
    // 对话框不关闭，输入也不被清空或回填成成功状态。
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(within(dialog).getByLabelText('展示标题')).toHaveValue('手动标题 X');
  });

  it('编辑标题成功后关闭对话框并提示已保存', async () => {
    const setManualTitle = vi.fn(async () => ({ manualTitle: '手动标题 X' }));
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, setManualTitle });

    await clickMenuItem('编辑标题');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('展示标题'), { target: { value: '手动标题 X' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('已保存手动标题：手动标题 X')).toBeTruthy();
  });

  it('恢复自动标题调用 resetManualTitle', async () => {
    const resetManualTitle = vi.fn(async () => ({}));
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, resetManualTitle });

    await clickMenuItem('编辑标题');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复自动标题' }));

    await waitFor(() => expect(resetManualTitle).toHaveBeenCalledWith(work.id));
    expect(await screen.findByText('已恢复自动标题。')).toBeTruthy();
  });

  it('打开所在位置如实报告后端未打开窗口', async () => {
    const folderPath = 'D:\\Media\\Anime\\CLANNAD';
    const openWorkFolder = vi.fn(async () => ({ opened: false, exists: true, folderPath }));
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, openWorkFolder });

    await clickMenuItem('打开所在位置');

    await waitFor(() => expect(openWorkFolder).toHaveBeenCalledWith({ workId: work.id }));
    expect(
      await screen.findByText((text) => text.includes('后端未打开窗口') && text.includes(folderPath)),
    ).toBeTruthy();
  });

  it('打开所在位置成功时报告已打开的真实目录', async () => {
    const folderPath = 'D:\\Media\\Anime\\CLANNAD';
    const openWorkFolder = vi.fn(async () => ({ opened: true, exists: true, folderPath }));
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, openWorkFolder });

    await clickMenuItem('打开所在位置');

    expect(await screen.findByText(`已在资源管理器中打开：${folderPath}`)).toBeTruthy();
  });

  it('打开所在位置失败显示后端 detail 原文', async () => {
    const openWorkFolder = vi.fn(async () => {
      throw new Error('该作品没有可打开的已确认媒体文件');
    });
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, openWorkFolder });

    await clickMenuItem('打开所在位置');

    expect(await screen.findByText('该作品没有可打开的已确认媒体文件')).toBeTruthy();
  });

  it('从媒体库移除先预览再按 previewId/digest 确认', async () => {
    const preview: WorkDeletePreview = {
      previewId: 'prev_1',
      digest: 'a'.repeat(64),
      revisionId: 'rev_1',
      artifactCount: 3,
      playbackCount: 2,
      trackingCount: 1,
      blocked: false,
      blockedJobCount: 0,
      blockedJobTypes: [],
    };
    const previewWorkDelete = vi.fn(async () => preview);
    const confirmWorkDelete = vi.fn(async () => ({
      status: 'completed',
      projectionStatus: 'rebuilt',
      removedArtifacts: 3,
      blockedArtifacts: 0,
      failedArtifacts: 0,
    }));
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, previewWorkDelete, confirmWorkDelete });

    await clickMenuItem('从媒体库移除');

    await waitFor(() => expect(previewWorkDelete).toHaveBeenCalledWith(work.id));
    expect(await screen.findByText('受控生成物：3 项')).toBeTruthy();
    expect(screen.getByText('播放记录：2 条')).toBeTruthy();
    expect(screen.getByText('追更记录：1 条')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确认移除' }));

    await waitFor(() =>
      expect(confirmWorkDelete).toHaveBeenCalledWith(work.id, {
        previewId: 'prev_1',
        digest: 'a'.repeat(64),
      }),
    );
  });

  it('预览报告存在后台任务时禁用确认按钮', async () => {
    const previewWorkDelete = vi.fn(async (): Promise<WorkDeletePreview> => ({
      previewId: 'prev_2',
      digest: 'b'.repeat(64),
      revisionId: 'rev_2',
      artifactCount: 0,
      playbackCount: 0,
      trackingCount: 0,
      blocked: true,
      blockedJobCount: 2,
      blockedJobTypes: ['scrape', 'import'],
    }));
    const confirmWorkDelete = vi.fn(async () => ({
      status: 'completed',
      projectionStatus: 'rebuilt',
      removedArtifacts: 0,
      blockedArtifacts: 0,
      failedArtifacts: 0,
    }));
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, previewWorkDelete, confirmWorkDelete });

    await clickMenuItem('从媒体库移除');

    expect(await screen.findByText((text) => text.includes('存在后台任务：2 个'))).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认移除' })).toBeDisabled();
    expect(confirmWorkDelete).not.toHaveBeenCalled();
  });

  it('删除确认失败（digest 变化）提示重新生成预览且允许重新预览', async () => {
    const previewWorkDelete = vi.fn(async (): Promise<WorkDeletePreview> => ({
      previewId: 'prev_3',
      digest: 'c'.repeat(64),
      revisionId: 'rev_3',
      artifactCount: 1,
      playbackCount: 0,
      trackingCount: 0,
      blocked: false,
      blockedJobCount: 0,
      blockedJobTypes: [],
    }));
    const confirmWorkDelete = vi.fn(async () => {
      throw new Error('作品状态已变化，请重新生成删除预览');
    });
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderDetail({ ...base, previewWorkDelete, confirmWorkDelete });

    await clickMenuItem('从媒体库移除');
    await waitFor(() => expect(screen.getByRole('button', { name: '确认移除' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }));

    expect(await screen.findByText('作品状态已变化，请重新生成删除预览')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新生成预览' })).toBeTruthy();

    // 允许重新预览：再次点击会重新调用删除预览端点。
    fireEvent.click(screen.getByRole('button', { name: '重新生成预览' }));
    await waitFor(() => expect(previewWorkDelete).toHaveBeenCalledTimes(2));
  });
});
