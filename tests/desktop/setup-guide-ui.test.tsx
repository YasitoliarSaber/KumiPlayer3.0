/**
 * 首次引导的界面行为（LINK-01）：真实模式读后端事实、失败保留输入；
 * 演示模式仍用本机演示存储。用桩服务提供能力位，不连接真实后端与真实配置。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { useUiStore } from '../../src/renderer/app/ui-store';
import { HomePage } from '../../src/renderer/features/home/HomePage';
import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { DEFAULT_SETTINGS, getDemoState, resetDemoState, updateDemoState } from '../../src/renderer/mock/demo-store';
import { createMockMediaService } from '../../src/renderer/mock/service';
import { demoQueryKeys, ServiceProvider } from '../../src/renderer/shared/api/service-context';
import { AppShell } from '../../src/renderer/shell/AppShell';
import type { MediaService, SettingsSnapshot } from '../../src/renderer/shared/api/service';

const catalog = buildMockCatalog();

/** 真实模式下的设置事实：默认已完成引导，用例按需要覆盖。 */
function realSettings(overrides: Partial<SettingsSnapshot['application']> = {}): SettingsSnapshot {
  return {
    ...DEFAULT_SETTINGS,
    application: { ...DEFAULT_SETTINGS.application, setupCompleted: true, setupDeferred: false, ...overrides },
  };
}

interface RealLikeOptions {
  readonly settings?: SettingsSnapshot;
  readonly settingsError?: string;
  readonly completeSetup?: MediaService['completeSetup'];
  readonly deferSetup?: MediaService['deferSetup'];
  readonly saveTmdbCredential?: MediaService['saveTmdbCredential'];
}

/**
 * "真实模式"桩：复用演示目录提供读取数据，但实现来源标识、设置读取与引导写入
 * 都按真实服务的契约表述，便于断言真实模式的分支。
 */
function realLikeService(options: RealLikeOptions = {}): MediaService {
  const base = createMockMediaService({ latencyMs: 0, catalog });
  return {
    ...base,
    serviceMode: 'real',
    getSettings: async () => {
      if (options.settingsError) {
        throw new Error(options.settingsError);
      }
      return options.settings ?? realSettings();
    },
    completeSetup: options.completeSetup ?? (async () => {
      throw new Error('本用例不应调用完成端点');
    }),
    deferSetup: options.deferSetup ?? (async () => {
      throw new Error('本用例不应调用推迟端点');
    }),
    saveTmdbCredential: options.saveTmdbCredential ?? (async () => {
      throw new Error('本用例不应调用 TMDB 端点');
    }),
  };
}

function renderShell(service: MediaService) {
  const queryClient = createAppQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ServiceProvider service={service}>
        <MemoryRouter initialEntries={['/']}>
          <AppShell>
            <HomePage />
          </AppShell>
        </MemoryRouter>
      </ServiceProvider>
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

/** 走到最后一屏：可填本地目录（第 2 步），再进入资料账号（第 3 步）。 */
function walkToLastStep(dialog: HTMLElement, localRoot?: string) {
  fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));
  if (localRoot !== undefined) {
    // 演示模式标签带「（演示）」后缀，这里只锚定公共前缀。
    fireEvent.change(within(dialog).getByLabelText(/^本地目录/), { target: { value: localRoot } });
  }
  fireEvent.click(within(dialog).getByRole('button', { name: '下一步' }));
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
  useUiStore.setState({ setupOpen: false, sidebarMode: 'expanded', source: 'all' });
});

afterEach(() => {
  // 显式卸载，避免用例之间互相影响对话框与订阅。
  cleanup();
  resetDemoState();
});

describe('真实模式的首次引导', () => {
  it('后端事实未完成且未推迟时自动打开，且不出现演示文案', async () => {
    renderShell(realLikeService({
      settings: realSettings({ setupCompleted: false, setupDeferred: false }),
    }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('欢迎使用 KumiPlayer')).toBeTruthy();
    expect(within(dialog).queryByText(/演示/)).toBeNull();
    // 引导状态不来自演示存储：真实模式不会写本机演示设置。
    expect(getDemoState().settings.application.setupCompleted).toBe(false);
  });

  it('后端事实已完成时不自动弹出引导', async () => {
    const { queryClient } = renderShell(realLikeService({ settings: realSettings() }));

    await waitFor(() => expect(queryClient.getQueryState(demoQueryKeys.settings)?.status).toBe('success'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('设置读取失败时不弹引导，也不假装已完成', async () => {
    const { queryClient } = renderShell(realLikeService({ settingsError: '后端不可用' }));

    await waitFor(
      () => expect(queryClient.getQueryState(demoQueryKeys.settings)?.status).toBe('error'),
      { timeout: 5000 },
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('完成后端校验失败时显示真实原因、保留输入且不关闭对话框', async () => {
    const completeSetup = vi.fn(async () => {
      throw new Error('请至少配置一个可访问的媒体来源');
    });
    renderShell(realLikeService({
      settings: realSettings({ setupCompleted: false, setupDeferred: false }),
      completeSetup,
    }));

    const dialog = await screen.findByRole('dialog');
    walkToLastStep(dialog, 'D:\\Media\\Anime');
    fireEvent.click(within(dialog).getByRole('button', { name: '完成设置' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('请至少配置一个可访问的媒体来源');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(completeSetup).toHaveBeenCalledWith({ playerMode: 'internal', localRoot: 'D:\\Media\\Anime' });

    // 输入保留：返回第 2 步仍能看到刚才填写的目录。
    fireEvent.click(within(dialog).getByRole('button', { name: '上一步' }));
    expect((within(dialog).getByLabelText('本地目录') as HTMLInputElement).value).toBe('D:\\Media\\Anime');
  });

  it('TMDB 令牌验证失败时不会调用完成端点，并显示验证错误', async () => {
    const order: string[] = [];
    const saveTmdbCredential = vi.fn(async (token: string) => {
      order.push(`tmdb:${token}`);
      throw new Error('TMDB Token 验证失败: 无效令牌');
    });
    const completeSetup = vi.fn(async () => {
      order.push('complete');
      return realSettings();
    });
    renderShell(realLikeService({
      settings: realSettings({ setupCompleted: false, setupDeferred: false }),
      saveTmdbCredential,
      completeSetup,
    }));

    const dialog = await screen.findByRole('dialog');
    walkToLastStep(dialog);
    fireEvent.change(within(dialog).getByLabelText('TMDB 读取访问令牌'), {
      target: { value: 'bad-token' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '完成设置' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain('TMDB Token 验证失败');
    expect(saveTmdbCredential).toHaveBeenCalledWith('bad-token');
    expect(completeSetup).not.toHaveBeenCalled();
    expect(order).toEqual(['tmdb:bad-token']);
    // 验证失败不丢输入，用户可以直接改。
    expect((within(dialog).getByLabelText('TMDB 读取访问令牌') as HTMLInputElement).value).toBe('bad-token');
  });

  it('令牌验证通过后才完成设置，并在完成后关闭对话框', async () => {
    const order: string[] = [];
    const saveTmdbCredential = vi.fn(async (token: string) => {
      order.push(`tmdb:${token}`);
      return realSettings({ setupCompleted: false, setupDeferred: false });
    });
    const completeSetup = vi.fn(async () => {
      order.push('complete');
      return realSettings({ setupCompleted: true, setupDeferred: false });
    });
    renderShell(realLikeService({
      settings: realSettings({ setupCompleted: false, setupDeferred: false }),
      saveTmdbCredential,
      completeSetup,
    }));

    const dialog = await screen.findByRole('dialog');
    walkToLastStep(dialog, 'D:\\Media\\Anime');
    fireEvent.change(within(dialog).getByLabelText('TMDB 读取访问令牌'), {
      target: { value: 'good-token' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '完成设置' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(order).toEqual(['tmdb:good-token', 'complete']);
    expect(completeSetup).toHaveBeenCalledWith({ playerMode: 'internal', localRoot: 'D:\\Media\\Anime' });
  });

  it('稍后设置走后端推迟端点，不写演示存储也不标记完成', async () => {
    const deferSetup = vi.fn(async () => realSettings({ setupCompleted: false, setupDeferred: true }));
    renderShell(realLikeService({
      settings: realSettings({ setupCompleted: false, setupDeferred: false }),
      deferSetup,
    }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '稍后设置' }));

    await waitFor(() => expect(deferSetup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getDemoState().settings.application.setupDeferred).toBe(false);
    expect(getDemoState().settings.application.setupCompleted).toBe(false);
  });
});

describe('演示模式的首次引导', () => {
  beforeEach(() => {
    updateDemoState(() => ({
      settings: {
        ...DEFAULT_SETTINGS,
        application: { ...DEFAULT_SETTINGS.application, setupCompleted: false, setupDeferred: false },
      },
    }));
  });

  it('继续使用演示存储：完成写入本机演示设置并提升第一条本地来源', async () => {
    renderShell(createMockMediaService({ latencyMs: 0, catalog }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('欢迎使用 KumiPlayer（演示）')).toBeTruthy();
    walkToLastStep(dialog, 'E:\\演示动画库');
    fireEvent.click(within(dialog).getByRole('button', { name: '完成设置' }));

    // 等到引导流程真正结束（对话框关闭）：否则残留的收尾 Promise 会泄到下一个用例。
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getDemoState().settings.application.setupCompleted).toBe(true);
    expect(getDemoState().settings.application.setupDeferred).toBe(false);
    expect(getDemoState().settings.sources.localRoots[0]?.path).toBe('E:\\演示动画库');
  });

  it('稍后设置只记录推迟，完成状态保持未完成', async () => {
    renderShell(createMockMediaService({ latencyMs: 0, catalog }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '稍后设置' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(getDemoState().settings.application.setupDeferred).toBe(true);
    expect(getDemoState().settings.application.setupCompleted).toBe(false);
  });
});
