/**
 * Bangumi 真实联动：详情次级面板的匹配/同步摘要，以及设置页的账号会话。
 * 全部使用桩 MediaService：不连接后端、不读写真实凭据，也不访问在线服务。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { SettingsPage } from '../../src/renderer/features/settings/SettingsPage';
import { BangumiPanel } from '../../src/renderer/features/work/WorkMetadataPanels';
import { buildMockCatalog, buildMockDetail } from '../../src/renderer/mock/catalog';
import { resetDemoState } from '../../src/renderer/mock/demo-store';
import { createMockMediaService } from '../../src/renderer/mock/service';
import { ServiceProvider } from '../../src/renderer/shared/api/service-context';
import type { BangumiAccountSession, MediaService } from '../../src/renderer/shared/api/service';

const catalog = buildMockCatalog();
const work = catalog.works[0]!;
const detail = buildMockDetail(work, catalog);

function renderNode(service: MediaService, node: ReactNode) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ServiceProvider service={service}>
        <MemoryRouter>{node}</MemoryRouter>
      </ServiceProvider>
    </QueryClientProvider>,
  );
}

const SESSION: BangumiAccountSession = {
  credentialState: 'found',
  authStatus: 'valid',
  connectivity: 'online',
  status: 'connected',
  nickname: 'KumiNick',
  username: 'kumi_username',
  avatarUrl: '',
  lastVerifiedAt: '2026-10-17T10:00:00+08:00',
  lastErrorCode: '',
  lastErrorMessage: '',
};

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
  // jsdom 没有实现 Element.scrollTo；设置页分类切换会调用它。
  if (typeof Element.prototype.scrollTo !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollTo', {
      writable: true,
      value: () => undefined,
    });
  }
});

beforeEach(() => {
  resetDemoState();
});

afterEach(() => {
  resetDemoState();
});

describe('Bangumi 匹配面板（任务 B）', () => {
  it('条目已保存但剧集映射为 0 时如实提示，并按 pulled/pushed 展示同步摘要', async () => {
    const bangumiMatch = vi.fn(async () => ({
      subjectId: '2024',
      title: 'CLANNAD',
      seasonNumber: 1,
      mappedEpisodeCount: 0,
      updatedAt: '2026-10-17T10:00:00+08:00',
    }));
    const bangumiSync = vi.fn(async () => ({
      status: 'synchronized',
      subjectId: '2024',
      remoteDoneBefore: 1,
      localDoneBefore: 2,
      pulled: 3,
      pushed: 4,
    }));
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderNode({ ...base, bangumiMatch, bangumiSync }, <BangumiPanel work={detail} />);

    await waitFor(() => expect(bangumiMatch).toHaveBeenCalledWith(work.id));
    expect(await screen.findByText('条目已保存，剧集映射待同步：远端条目尚未建立起本地剧集映射。')).toBeTruthy();
    expect(screen.getByText(/#2024 · 已映射 0 集/)).toBeTruthy();
    // 不得宣布完全同步成功。
    expect(screen.queryByText(/已完全同步/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '同步观看进度' }));

    await waitFor(() => expect(bangumiSync).toHaveBeenCalledWith(work.id));
    expect(await screen.findByText(/拉取 3 集、推送 4 集/)).toBeTruthy();
  });
});

describe('设置页 Bangumi 会话（任务 B）', () => {
  it('展示会话昵称，且 bangumiSignIn 只在提交时被调用一次', async () => {
    const bangumiSignIn = vi.fn(async () => SESSION);
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderNode(
      {
        ...base,
        bangumiSession: async () => SESSION,
        bangumiSignIn,
        bangumiVerify: async () => SESSION,
        bangumiSignOut: async () => undefined,
      },
      <SettingsPage />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '账户与同步' }));

    // 账号名来自 bangumiSession（昵称优先）；状态用人话呈现，不回显后端枚举。
    expect((await screen.findAllByText('KumiNick')).length).toBeGreaterThan(0);
    expect(screen.getByText('已登录')).toBeTruthy();
    expect(screen.getByText('2026-10-17 10:00:00 · 验证通过')).toBeTruthy();
    expect(screen.queryByText(/found|valid|online|connected/)).toBeNull();

    const input = screen.getByLabelText('Bangumi 访问令牌') as HTMLInputElement;
    // 只输入、未提交时不得调用登录端点。
    fireEvent.change(input, { target: { value: 'bgm-secret-token' } });
    expect(bangumiSignIn).not.toHaveBeenCalled();

    const tokenRow = input.closest('div') as HTMLElement;
    fireEvent.click(within(tokenRow).getByRole('button', { name: '保存令牌' }));

    await waitFor(() => expect(bangumiSignIn).toHaveBeenCalledTimes(1));
    expect(bangumiSignIn).toHaveBeenCalledWith('bgm-secret-token');
    // 成功后清空输入且不回显令牌。
    await waitFor(() => expect((screen.getByLabelText('Bangumi 访问令牌') as HTMLInputElement).value).toBe(''));
    expect(screen.queryByText(/bgm-secret-token/)).toBeNull();
  });

  it('上次验证超时时说清原因，仍显示账号已登录而不是让用户看到离线枚举', async () => {
    // 快照语义：凭据与账号仍然有效（status=connected），只是上一次远程验证超时。
    const offline: BangumiAccountSession = {
      ...SESSION,
      connectivity: 'offline',
      lastVerifiedAt: '2026-10-17T09:35:56+08:00',
      lastErrorCode: 'timeout',
      lastErrorMessage: 'Bangumi 请求超时',
    };
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderNode(
      { ...base, bangumiSession: async () => offline, bangumiVerify: async () => offline },
      <SettingsPage />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '账户与同步' }));

    expect(await screen.findByText('已登录')).toBeTruthy();
    expect(screen.getByText('2026-10-17 09:35:56 · 未通过')).toBeTruthy();
    expect(
      screen.getByText('上次验证没连上 Bangumi：Bangumi 请求超时。网络或代理恢复后重新验证即可。'),
    ).toBeTruthy();
    expect(screen.queryByText('offline')).toBeNull();
    expect(screen.queryByText(/timeout/)).toBeNull();
  });

  it('登录失败保留输入并显示后端 detail', async () => {
    const bangumiSignIn = vi.fn(async () => {
      throw new Error('访问令牌无效，Bangumi 拒绝了这次验证');
    });
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderNode(
      {
        ...base,
        bangumiSession: async () => SESSION,
        bangumiSignIn,
      },
      <SettingsPage />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '账户与同步' }));
    await screen.findAllByText('KumiNick');

    const input = screen.getByLabelText('Bangumi 访问令牌') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad-token' } });
    fireEvent.click(within(input.closest('div') as HTMLElement).getByRole('button', { name: '保存令牌' }));

    expect(
      await screen.findByText('未保存：访问令牌无效，Bangumi 拒绝了这次验证'),
    ).toBeTruthy();
    expect((screen.getByLabelText('Bangumi 访问令牌') as HTMLInputElement).value).toBe('bad-token');
  });

  it('演示模式（无会话能力）明确说明不提供真实 Bangumi 会话', async () => {
    const base = createMockMediaService({ latencyMs: 0, catalog });
    renderNode(base, <SettingsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '账户与同步' }));

    expect((await screen.findAllByText('演示模式不提供真实 Bangumi 会话')).length).toBeGreaterThan(0);
  });
});
