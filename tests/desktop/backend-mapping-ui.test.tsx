/**
 * 后端字段映射在界面上的可见结果（F2 任务状态、F7 搜索截断）。
 * 用桩服务提供数据，不连接真实后端、不读写真实数据。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { useUiStore } from '../../src/renderer/app/ui-store';
import { PosterWallPage } from '../../src/renderer/features/library/PosterWallPage';
import { TaskCenter } from '../../src/renderer/features/tasks/TaskCenter';
import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { resetDemoState } from '../../src/renderer/mock/demo-store';
import { createMockMediaService } from '../../src/renderer/mock/service';
import { ServiceProvider } from '../../src/renderer/shared/api/service-context';
import type { MediaService, TaskEntry } from '../../src/renderer/shared/api/service';

const catalog = buildMockCatalog();

function renderWithService(service: MediaService, element: ReactNode, entry = '/') {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ServiceProvider service={service}>
        <MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter>
      </ServiceProvider>
    </QueryClientProvider>,
  );
}

function task(overrides: Partial<TaskEntry>): TaskEntry {
  return {
    id: 'job_1',
    type: 'scrape',
    title: '刮削资料',
    sourceId: 'root_1',
    sourceName: '动画来源',
    status: 'pending',
    progress: 0,
    message: '等待任务执行',
    createdAt: '',
    startedAt: '',
    finishedAt: '',
    error: '',
    scope: '',
    cancellable: true,
    ...overrides,
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
  useUiStore.setState({ source: 'all', sidebarMode: 'expanded', posterColumns: 6 });
});

afterEach(() => {
  resetDemoState();
});

describe('任务中心的未知与未开始状态（F2）', () => {
  it('后端 pending 任务出现在「当前任务」并给出终止入口', async () => {
    const base = createMockMediaService({ latencyMs: 0, catalog });
    const service: MediaService = {
      ...base,
      listTasks: async () => [task({ status: 'pending', rawStatus: 'pending' })],
    };
    renderWithService(service, <TaskCenter />, '/tasks');

    // 汇总区与任务行都会出现该标签。
    expect((await screen.findAllByText('等待执行')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '终止任务' })).toBeTruthy();
    // 未开始的任务不属于历史记录：切到历史视图后不再列出。
    fireEvent.click(screen.getByRole('radio', { name: '历史记录' }));
    expect(await screen.findByText('还没有历史记录')).toBeTruthy();
  });

  it('未登记的状态如实展示后端原文，不显示成已完成', async () => {
    const base = createMockMediaService({ latencyMs: 0, catalog });
    const service: MediaService = {
      ...base,
      listTasks: async () => [task({ status: 'unknown', rawStatus: 'paused_v2', cancellable: false })],
    };
    renderWithService(service, <TaskCenter />, '/tasks');

    expect((await screen.findAllByText('状态未知')).length).toBeGreaterThan(0);
    expect(screen.getByText(/paused_v2/)).toBeTruthy();
    expect(screen.queryByText('已完成')).toBeNull();
  });
});

describe('搜索截断提示（F7）', () => {
  it('后端报告命中被截断时显示如实提示', async () => {
    const base = createMockMediaService({ latencyMs: 0, catalog });
    const service: MediaService = {
      ...base,
      searchLibrary: async () => ({
        hits: [
          {
            workId: catalog.works[0]!.id,
            title: catalog.works[0]!.title,
            originalTitle: '',
            year: 2026,
            mediaType: 'tv',
            matchedFields: ['title'],
            aliases: [],
            tags: [],
            studios: [],
          },
        ],
        truncated: true,
      }),
    };
    renderWithService(
      service,
      <PosterWallPage mode={{ kind: 'search' }} />,
      '/search?q=%E5%8A%A8%E7%94%BB',
    );

    const notice = await screen.findByText(/命中过多/);
    expect(notice.textContent).toContain('仅显示前 1 条');
  });

  it('未截断时不显示该提示', async () => {
    const base = createMockMediaService({ latencyMs: 0, catalog });
    const service: MediaService = {
      ...base,
      searchLibrary: async () => ({ hits: [], truncated: false }),
    };
    renderWithService(
      service,
      <PosterWallPage mode={{ kind: 'search' }} />,
      '/search?q=%E5%8A%A8%E7%94%BB',
    );

    await waitFor(() => expect(screen.getByText('搜索：动画')).toBeTruthy());
    expect(screen.queryByText(/命中过多/)).toBeNull();
  });
});
