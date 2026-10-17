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

function renderManage(service: MediaService) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ServiceProvider service={service}>
        <MemoryRouter initialEntries={['/manage']}>
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
  it('展示状态摘要、来源卡与任务表，而不是演示流程', async () => {
    renderManage(realService(0));

    expect(await screen.findByText('状态摘要')).toBeTruthy();
    expect(await screen.findByText('动画来源')).toBeTruthy();
    expect(screen.getByText(/作业 排队 0 · 运行 1 · 失败 0/)).toBeTruthy();
    // 真实模式不再渲染演示用的「新建导入」按钮。
    expect(screen.queryByRole('button', { name: '新建导入' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /开始扫描/ }).length).toBeGreaterThan(0);
  });

  it('扫描 → 识别预览 → 确认导入按后端能力真实推进', async () => {
    renderManage(realService(0));
    await screen.findByText('动画来源');

    fireEvent.click(screen.getAllByRole('button', { name: /开始扫描/ })[0]!);
    await waitFor(() => expect(screen.getByText(/扫描已创建：/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '生成识别预览' }));
    await waitFor(() => expect(screen.getByText('审核识别结果')).toBeTruthy());
    expect(screen.getByText(/作品 2 · 剧集 24/)).toBeTruthy();

    const confirm = screen.getByRole('button', { name: /确认并执行/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText(/派生 2 个后台作业/)).toBeTruthy());
  });

  it('存在阻断识别问题时不允许确认导入', async () => {
    renderManage(realService(1));
    await screen.findByText('动画来源');

    fireEvent.click(screen.getAllByRole('button', { name: /开始扫描/ })[0]!);
    await waitFor(() => expect(screen.getByRole('button', { name: '生成识别预览' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '生成识别预览' }));

    await waitFor(() => expect(screen.getByText(/1 个阻断问题/)).toBeTruthy());
    const confirm = screen.getByRole('button', { name: /确认并执行/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
