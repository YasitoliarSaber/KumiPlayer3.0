/**
 * 真实后端模式下的媒体管理：四段式导入链与任务展示。
 * 用桩服务提供真实能力位，不连接任何后端、也不触碰真实数据。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaManagementPage } from '../../src/renderer/features/manage/MediaManagementPage';
import { AppShell } from '../../src/renderer/shell/AppShell';
import {
  ServiceProvider,
} from '../../src/renderer/shared/api/service-context';
import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { useUiStore } from '../../src/renderer/app/ui-store';
import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { DEFAULT_SETTINGS, resetDemoState, updateDemoState } from '../../src/renderer/mock/demo-store';
import { createMockMediaService } from '../../src/renderer/mock/service';
import type {
  ImportPreviewSummary,
  MediaService,
  ScanProgress,
  SourceScanSchedule,
} from '../../src/renderer/shared/api/service';

const catalog = buildMockCatalog();

const SCAN: ScanProgress = {
  scanId: 'scan_1',
  rootId: 'root_1',
  status: 'completed',
  stage: 'done',
  stageLabel: '扫描完成',
  processedCount: 12,
  totalCount: 12,
  discoveredCount: 12,
  currentDirectory: '',
  error: '',
  resumable: false,
  cancelRequested: false,
  canCancel: false,
  progress: null,
};

const SCHEDULE: SourceScanSchedule = {
  rootId: 'root_1',
  displayName: '动画来源',
  provider: 'openlist',
  ingestMethod: 'openlist_scan',
  sourceMode: 'openlist_full',
  contentScope: 'ongoing',
  enabled: true,
  schedule: { enabled: true, intervalMinutes: 720, lastRunAt: '', nextRunAt: '' },
  status: 'idle',
  reason: '',
  taskId: '',
  activityKind: '',
  canCancel: false,
  scan: { scanId: 'scan_1', status: 'completed', startedAt: '', finishedAt: '', canResume: false, canCancel: false, message: '' },
  revision: { latestRevisionId: 'rev_1', draftRevisionId: '', status: '', reason: '' },
  jobs: { queued: 0, running: 1, failed: 0, cancelled: 0, latestJobId: 'job_1' },
};

function realService(blockingIssues: number): MediaService {
  const base = createMockMediaService({ latencyMs: 0, catalog });
  const preview: ImportPreviewSummary = {
    revisionId: 'rev_1',
    status: 'draft',
    workCount: 2,
    episodeCount: 24,
    blockingIssueCount: blockingIssues,
    issues: [
      {
        id: 'issue_1',
        severity: blockingIssues > 0 ? 'blocking' : 'notice',
        title: '疑似特别篇',
        detail: '请确认这一集是否属于正片',
        candidates: [],
      },
    ],
  };
  return {
    ...base,
    listSources: async () => [{
      id: 'root_1', name: '动画导入', kind: 'openlist', providerLabel: 'OpenList', location: '/anime',
      contentScope: 'ongoing', workCount: 2, lastScanAt: '', status: 'idle', statusLabel: '已完成',
      phase: 'execute', message: '', activeTaskId: null, canResume: false,
    }],
    listScanSchedules: async () => [SCHEDULE],
    startSourceScan: async () => SCAN,
    getSourceScan: async () => SCAN,
    cancelSourceScan: async () => ({ ...SCAN, status: 'cancelled', canCancel: false }),
    previewImport: async () => preview,
    confirmImport: async () => ({ revisionId: 'rev_1', status: 'confirmed', jobCount: 2 }),
    cancelImport: async () => ({ cancelled: 1, running: 0 }),
  };
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  resetDemoState();
  useUiStore.setState({ setupOpen: false, sidebarMode: 'expanded' });
  updateDemoState(() => ({
    settings: {
      ...DEFAULT_SETTINGS,
      application: { ...DEFAULT_SETTINGS.application, setupCompleted: true, setupDeferred: false },
    },
  }));
});

function renderManage(service: MediaService, entry = '/manage') {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ServiceProvider service={service}>
        <MemoryRouter initialEntries={[entry]}>
          <AppShell>
            <Routes>
              <Route path="/manage" element={<MediaManagementPage />} />
            </Routes>
          </AppShell>
        </MemoryRouter>
      </ServiceProvider>
    </QueryClientProvider>,
  );
}

describe('真实后端模式的媒体管理', () => {
  it('总览仅展示作品与导入卡，导入配置和任务表不混入首页', async () => {
    const service = realService(0);
    const listTasks = vi.spyOn(service, 'listTasks');
    renderManage(service);

    expect(await screen.findByRole('region', { name: '已入库作品' })).toBeTruthy();
    expect(await screen.findByRole('article', { name: '动画导入导入' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '导入' })).toBeTruthy();
    expect(screen.queryByText('内容来源')).toBeNull();
    expect(screen.queryByRole('region', { name: '导入配置' })).toBeNull();
    expect(screen.queryByText('扫描与任务')).toBeNull();
    expect(screen.queryByRole('button', { name: '新建导入' })).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '导入媒体' }));
    expect(await screen.findByRole('region', { name: '导入配置' })).toBeTruthy();
    expect(screen.getByLabelText('本地目录路径')).toBeTruthy();
  });

  it('扫描 → 识别预览 → 确认导入按后端能力真实推进', async () => {
    const service = realService(0);
    const start = vi.spyOn(service, 'startSourceScan');
    renderManage(service, '/manage?view=import');
    fireEvent.change(await screen.findByLabelText('本地目录路径'), { target: { value: 'D:\\Fixtures\\Anime' } });

    fireEvent.click(screen.getAllByRole('button', { name: /开始扫描/ })[0]!);
    await waitFor(() => expect(screen.getByText(/已开始扫描。/)).toBeTruthy());
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ source: 'local', rootPath: 'D:\\Fixtures\\Anime', contentScope: 'library', scanMode: 'full' }));

    fireEvent.click(screen.getByRole('button', { name: '生成识别预览' }));
    await waitFor(() => expect(screen.getByText('审核识别结果')).toBeTruthy());
    expect(screen.getByText(/作品 2 · 剧集 24/)).toBeTruthy();

    const confirm = screen.getByRole('button', { name: /确认并执行/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText(/派生 2 个后台作业/)).toBeTruthy());
  });

  it('存在阻断识别问题时不允许确认导入', async () => {
    renderManage(realService(1), '/manage?view=import');
    fireEvent.change(await screen.findByLabelText('本地目录路径'), { target: { value: 'D:\\Fixtures\\Anime' } });

    fireEvent.click(screen.getAllByRole('button', { name: /开始扫描/ })[0]!);
    await waitFor(() => expect(screen.getByRole('button', { name: '生成识别预览' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '生成识别预览' }));

    await waitFor(() => expect(screen.getByText(/1 个阻断问题/)).toBeTruthy());
    const confirm = screen.getByRole('button', { name: /确认并执行/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('从导入卡恢复扫描，返回总览不取消后端任务', async () => {
    const service = realService(0);
    const get = vi.spyOn(service, 'getSourceScan');
    const start = vi.spyOn(service, 'startSourceScan');
    const cancel = vi.spyOn(service, 'cancelSourceScan');
    renderManage(service);
    fireEvent.click(await screen.findByRole('button', { name: '查看导入' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('scan_1'));
    expect(await screen.findByText('扫描完成')).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回媒体管理' }));
    expect(await screen.findByRole('region', { name: '导入' })).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('首次 OpenList 导入使用完整扫描，代理失败保留输入且不跳到假成功', async () => {
    const service = realService(0);
    const start = vi.spyOn(service, 'startSourceScan').mockRejectedValue(new Error('网页未接通本机后端'));
    renderManage(service, '/manage?view=import');
    fireEvent.click(await screen.findByRole('radio', { name: 'OpenList', exact: true }));
    fireEvent.change(screen.getByLabelText('远端目录'), { target: { value: '/anime' } });
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '网页未接通本机后端');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ source: 'openlist', rootPath: '/anime', scanMode: 'full' }));
    expect(screen.getByLabelText('远端目录')).toHaveProperty('value', '/anime');
    expect(screen.queryByText(/已开始扫描。/)).toBeNull();
  });
});
