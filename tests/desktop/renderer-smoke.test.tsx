/**
 * Renderer 装配冒烟测试：Provider、路由与恢复边界可在无桌面壳时挂载。
 * 这里不验证视觉，只验证装配、状态展示与关键交互存在。
 */

import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DesktopBridge, DesktopStatus } from '@shared/contracts/desktop';

import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { useDesktopStore } from '../../src/renderer/app/desktop-store';
import { ControlsFixturePage } from '../../src/renderer/features/dev/ControlsFixturePage';
import { SessionPage } from '../../src/renderer/features/session/SessionPage';
import { ServiceProvider } from '../../src/renderer/shared/api/service-context';

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

const readyStatus: DesktopStatus = {
  epoch: 3,
  phase: 'ready',
  protection: 'job-object-helper',
  runtimeKind: 'source',
  authenticated: true,
  port: 37899,
  dataDir: 'C:/tmp/kumi',
};

function renderWithProviders(node: React.ReactNode) {
  return render(
    <MantineProvider>
      <QueryClientProvider client={createAppQueryClient()}>
        <ServiceProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </ServiceProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('新 Renderer 装配', () => {
  it('会话页展示后端就绪状态与进程保护模式', async () => {
    useDesktopStore.setState({ status: readyStatus });
    const bridge: Partial<DesktopBridge> = {
      invoke: vi.fn(async () => ({
        ok: true as const,
        epoch: 3,
        data: { status: 'ok', app: 'KumiPlayer', runtime_kind: 'source', runtime_id: 'r', instance_id: 'i' },
      })),
    };
    vi.stubGlobal('kumiplayer', bridge);

    renderWithProviders(<SessionPage />);

    expect(screen.getByText('KumiPlayer 基础切片')).toBeTruthy();
    expect(screen.getByText(/进程保护/)).toBeTruthy();
    expect(screen.getByText('job-object-helper')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/health.app/)).toBeTruthy());
  });

  it('后端失败时恢复动作仍可用，不出现空白界面', async () => {
    useDesktopStore.setState({
      status: { ...readyStatus, phase: 'failed', authenticated: false, lastError: { kind: 'unavailable', message: '本地后端未就绪', retryable: true } },
    });
    const invoke = vi.fn(async () => ({ ok: true as const, epoch: 3, data: { opened: true } }));
    vi.stubGlobal('kumiplayer', { invoke, cancel: vi.fn(), onStatus: () => () => undefined });

    renderWithProviders(<SessionPage />);
    fireEvent.click(screen.getByText('重启本地后端'));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
  });

  it('控件夹具的对话框可打开并在 Esc 后关闭（portal 焦点路径可用）', async () => {
    renderWithProviders(<ControlsFixturePage />);
    fireEvent.click(screen.getByText('打开对话框'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // 在对话框元素上派发 Escape，让它冒泡到 Mantine 的 window 监听器。
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
