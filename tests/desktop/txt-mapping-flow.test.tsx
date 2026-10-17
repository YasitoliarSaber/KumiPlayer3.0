/**
 * TXT / OpenList 路径多解的映射选择流程（台账 F8）。
 *
 * 后端在 `backend/app/api/media_v4.py:541-549` 用 HTTP 200 + 空 `scan_id` +
 * `status='mapping_required'` 返回候选，这次调用**没有登记任何扫描**（return 发生在
 * `_register_durable_source_scan` 之前，`backend/app/api/media_v4.py:1865-1867`）。
 * 界面必须让用户先选映射，不能报"已开始扫描"，也不能轮询空编号。
 *
 * 全部数据来自桩服务，不连接真实后端、不读写真实数据。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { RealSourceImportView } from '../../src/renderer/features/manage/RealSourceImportView';
import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { resetDemoState } from '../../src/renderer/mock/demo-store';
import { createMockMediaService } from '../../src/renderer/mock/service';
import { ServiceProvider } from '../../src/renderer/shared/api/service-context';
import type {
  MediaService,
  ScanMappingChoice,
  ScanPathValidation,
  ScanProgress,
  SourceScanRequest,
} from '../../src/renderer/shared/api/service';

const catalog = buildMockCatalog();
const TREE_FILE = 'D:\\Trees\\115-anime.txt';
const MAPPING_NOTICE = '需要选择目录映射后才能开始扫描';
const STALE_NOTICE = '路径选择已过期，请核对当前候选';

const CHOICES: readonly ScanMappingChoice[] = [
  {
    id: 'choice_disk_e',
    root: 'E:\\Anime\\115',
    mappingScope: 'mounted_subdir',
    pathSamples: ['E:\\Anime\\115\\作品 A\\01.mkv', 'E:\\Anime\\115\\作品 A\\02.mkv'],
    selectedCount: 24,
    skippedCount: 1,
  },
  {
    id: 'choice_disk_f',
    root: 'F:\\Media\\115',
    mappingScope: 'mounted_subdir',
    pathSamples: ['F:\\Media\\115\\作品 A\\01.mkv', 'F:\\Media\\115\\作品 B\\01.mkv'],
    selectedCount: 12,
    skippedCount: 13,
  },
];

function progress(overrides: Partial<ScanProgress>): ScanProgress {
  return {
    scanId: '', rootId: '', status: '', stage: '', stageLabel: '', processedCount: 0, totalCount: 0,
    discoveredCount: 0, currentDirectory: '', error: '', resumable: false, cancelRequested: false,
    interrupted: false, evidenceCount: 0, parsedCount: 0, directoriesCompleted: 0, directoriesPending: 0,
    heartbeatAt: '', canCancel: false, progress: null, mapping: null,
    ...overrides,
  };
}

function pathValidation(
  choices: readonly ScanMappingChoice[] = CHOICES,
  reason = '导出范围与挂载范围存在多个对应关系',
): ScanPathValidation {
  return {
    ok: false, root: '', reason, state: 'ambiguous', mappingMode: 'direct', mappingScope: '',
    selectedCount: 0, skippedCount: 0, pathSamples: [], requiresConfirmation: true, choices,
  };
}

/** 后端多解响应：空 `scan_id`、`mapping_required`、只有候选。 */
function mappingProgress(choices: readonly ScanMappingChoice[] = CHOICES, reason?: string): ScanProgress {
  return progress({ status: 'mapping_required', mapping: pathValidation(choices, reason) });
}

function serviceStub(startSourceScan: (request: SourceScanRequest) => Promise<ScanProgress>) {
  const base = createMockMediaService({ latencyMs: 0, catalog });
  const getSourceScan = vi.fn(async (scanId: string) => progress({ scanId, status: 'completed' }));
  const service: MediaService = {
    ...base,
    listSources: async () => [],
    listScanSchedules: async () => [],
    startSourceScan,
    getSourceScan,
    cancelSourceScan: async (scanId: string) => progress({ scanId, status: 'cancelled' }),
    previewImport: async () => ({
      revisionId: 'rev_1', status: 'draft', workCount: 0, episodeCount: 0, blockingIssueCount: 0, issues: [],
    }),
  };
  return { service, getSourceScan };
}

function renderImport(service: MediaService) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ServiceProvider service={service}>
        <MemoryRouter initialEntries={['/manage?view=import']}>
          <RealSourceImportView view="import" rootId="" onOpenTasks={() => undefined} />
        </MemoryRouter>
      </ServiceProvider>
    </QueryClientProvider>,
  );
}

/** 切到「目录树 TXT」并填好 TXT 路径，再点「开始扫描」。 */
async function startTreeScan() {
  fireEvent.click(await screen.findByRole('radio', { name: '目录树 TXT' }));
  fireEvent.change(screen.getByLabelText('目录树 TXT 路径'), { target: { value: TREE_FILE } });
  fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
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

describe('TXT 路径多解的映射选择（F8）', () => {
  it('多解响应不报"已开始扫描"，而是列出候选并保留输入', async () => {
    const start = vi.fn(async () => mappingProgress());
    const { service, getSourceScan } = serviceStub(start);
    renderImport(service);
    await startTreeScan();

    expect(await screen.findByRole('region', { name: '目录映射选择' })).toBeTruthy();
    expect(screen.queryByText(/已开始扫描/)).toBeNull();
    expect((await screen.findByRole('status')).textContent).toContain(MAPPING_NOTICE);

    // 两个候选都要出现，并带上范围与样本。
    expect(screen.getByRole('radio', { name: /E:\\Anime\\115/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /F:\\Media\\115/ })).toBeTruthy();
    expect(screen.getByText('E:\\Anime\\115\\作品 A\\01.mkv')).toBeTruthy();
    expect(screen.getByText('F:\\Media\\115\\作品 B\\01.mkv')).toBeTruthy();

    // 没有登记扫描：不轮询、不显示扫描进度，表单输入原样保留。
    expect(getSourceScan).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '扫描进度' })).toBeNull();
    expect(screen.getByLabelText('目录树 TXT 路径')).toHaveProperty('value', TREE_FILE);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('选定候选后用同一份请求快照重发，拿到非空 scan_id 才开始扫描', async () => {
    const requests: SourceScanRequest[] = [];
    const start = vi.fn(async (request: SourceScanRequest) => {
      requests.push(request);
      return request.treeMappingChoice
        ? progress({ scanId: 'scan_9', rootId: 'root_9', status: 'running', stageLabel: '正在读取目录', canCancel: true, progress: 30 })
        : mappingProgress();
    });
    const { service, getSourceScan } = serviceStub(start);
    renderImport(service);
    await startTreeScan();

    await screen.findByRole('region', { name: '目录映射选择' });
    expect(screen.queryByText(/已开始扫描/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /F:\\Media\\115/ }));
    fireEvent.click(screen.getByRole('button', { name: '使用这个映射继续扫描' }));

    await waitFor(() => expect(screen.getByText(/已开始扫描。/)).toBeTruthy());
    expect(requests).toHaveLength(2);
    // 第二次是同一份快照 + 用户选定的候选，没有多带任何未登记字段。
    expect(requests[1]).toEqual({ ...requests[0], treeMappingChoice: 'choice_disk_f' });
    expect(Object.keys(requests[1]!).sort()).toEqual(
      ['contentScope', 'provider', 'scanMode', 'source', 'treeFile', 'treeMappingChoice'],
    );
    expect(screen.queryByRole('region', { name: '目录映射选择' })).toBeNull();

    // 只有拿到真实 scan_id 后才进入扫描状态并开始轮询。
    expect(await screen.findByRole('region', { name: '扫描进度' })).toBeTruthy();
    await waitFor(() => expect(getSourceScan).toHaveBeenCalledWith('scan_9'));
  });

  it('第二次仍要求映射时保留最新候选并提示过期，不自动重发', async () => {
    const refreshed: readonly ScanMappingChoice[] = [{
      id: 'choice_disk_g', root: 'G:\\NewRoot', mappingScope: 'direct',
      pathSamples: ['G:\\NewRoot\\作品 A\\01.mkv'], selectedCount: 5, skippedCount: 0,
    }];
    const start = vi.fn(async (request: SourceScanRequest) => (
      request.treeMappingChoice ? mappingProgress(refreshed, STALE_NOTICE) : mappingProgress()
    ));
    const { service, getSourceScan } = serviceStub(start);
    renderImport(service);
    await startTreeScan();

    await screen.findByRole('region', { name: '目录映射选择' });
    fireEvent.click(screen.getByRole('radio', { name: /E:\\Anime\\115/ }));
    fireEvent.click(screen.getByRole('button', { name: '使用这个映射继续扫描' }));

    expect((await screen.findByRole('status')).textContent).toBe(STALE_NOTICE);
    expect(screen.getByRole('radio', { name: /G:\\NewRoot/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /E:\\Anime\\115/ })).toBeNull();
    expect(screen.queryByText(/已开始扫描/)).toBeNull();
    expect(screen.queryByRole('region', { name: '扫描进度' })).toBeNull();
    expect(getSourceScan).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('目录树 TXT 路径')).toHaveProperty('value', TREE_FILE);
  });

  it('取消映射选择后清空候选、保留输入且不再发请求', async () => {
    const start = vi.fn(async (_request: SourceScanRequest) => mappingProgress());
    const { service, getSourceScan } = serviceStub(start);
    renderImport(service);
    await startTreeScan();

    await screen.findByRole('region', { name: '目录映射选择' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(await screen.findByText('已取消映射选择，输入已保留。')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '目录映射选择' })).toBeNull();
    expect(screen.getByLabelText('目录树 TXT 路径')).toHaveProperty('value', TREE_FILE);
    expect(start).toHaveBeenCalledTimes(1);
    expect(getSourceScan).not.toHaveBeenCalled();
  });
});
