/**
 * 首次引导的写通道与写结果传播（LINK-01 / LINK-02）。
 * 只使用桩传输与演示存储：不发起真实网络请求，不接触真实数据、真实配置或真实凭据。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveHttpTarget, type OperationId } from '@shared/contracts/operations';
import type { GatewayError, OperationOutcome } from '@shared/contracts/errors';
import { ServiceCapabilityError, createHttpMediaService } from '@/services/real/service';
import type { BrowserTransport, CallOptions } from '@/transport/http';
import { getDemoState, resetDemoState } from '@/mock/demo-store';
import { createMockMediaService } from '@/mock/service';

interface Recorded {
  readonly operation: OperationId;
  readonly options: CallOptions;
}

/** 桩传输：成功响应、显式失败消息都由用例提供，未定义的操作按"后端没有"处理。 */
function stubTransport(
  responses: Partial<Record<OperationId, unknown>> = {},
  recorded: Recorded[] = [],
  failures: Partial<Record<OperationId, string>> = {},
): BrowserTransport {
  const failureFor = (operation: OperationId): { ok: false; error: GatewayError; epoch: number } => {
    const message = failures[operation] ?? '桩未定义该操作';
    const error: GatewayError = {
      kind: failures[operation] ? 'validation' : 'unavailable',
      message,
      retryable: false,
    };
    return { ok: false, error, epoch: 0 };
  };
  return {
    async call<T>(operation: OperationId, options: CallOptions = {}): Promise<OperationOutcome<T>> {
      recorded.push({ operation, options });
      if (failures[operation]) {
        return failureFor(operation);
      }
      if (!(operation in responses)) {
        return failureFor(operation);
      }
      return { ok: true, data: responses[operation] as T, epoch: 0 };
    },
    async upload<T>(operation: OperationId, form: FormData, options: CallOptions = {}): Promise<OperationOutcome<T>> {
      recorded.push({ operation, options });
      void form;
      return { ok: true, data: (responses[operation] ?? {}) as T, epoch: 0 };
    },
    async download(operation: OperationId) {
      recorded.push({ operation, options: {} });
      return { ok: true, blob: new Blob(['zip']), filename: 'kumiplayer-backup.kumibak' };
    },
  };
}

/** 与 GET /api/config 同形的公开配置（字段名取自后端 to_public_dict）。 */
const PUBLIC_CONFIG: Record<string, unknown> = {
  setup_completed: false,
  setup_deferred: false,
  setup_version: 0,
  player_mode: 'internal',
  external_mpv_path: '',
  local_root: '',
  local_roots: [],
  heartbeat_enabled: true,
  tmdb_language: 'zh-CN',
  tmdb_configured: false,
  bangumi_configured: false,
};

describe('引导写入通道（真实服务）', () => {
  it('引导端点路径与方法由具名操作固定', () => {
    expect(resolveHttpTarget({ operation: 'config.setupDefer', requestId: 'r' })).toEqual({
      ok: true,
      target: { method: 'POST', path: '/api/config/setup/defer', query: [] },
    });
    expect(resolveHttpTarget({
      operation: 'config.setupComplete',
      body: { local_root: 'D:\\Media', player_mode: 'internal' },
      requestId: 'r',
    })).toEqual({
      ok: true,
      target: { method: 'POST', path: '/api/config/setup/complete', query: [] },
    });
    expect(resolveHttpTarget({
      operation: 'config.setupTmdbCredential',
      body: { tmdb_bearer_token: 'x' },
      requestId: 'r',
    })).toEqual({
      ok: true,
      target: { method: 'POST', path: '/api/config/setup/credentials/tmdb', query: [] },
    });
  });

  it('完成引导只提交用户真正填写的字段，并直接采用后端返回的配置', async () => {
    const recorded: Recorded[] = [];
    const service = createHttpMediaService({
      transport: stubTransport(
        { 'config.setupComplete': { ...PUBLIC_CONFIG, setup_completed: true, local_root: 'D:\\Media' } },
        recorded,
      ),
    });

    const settings = await service.completeSetup!({
      playerMode: 'internal',
      localRoot: '  D:\\Media  ',
      baiduRoot: '',
    });

    expect(recorded[0]?.operation).toBe('config.setupComplete');
    expect(recorded[0]?.options.body).toEqual({ local_root: 'D:\\Media', player_mode: 'internal' });
    // 空字符串不是"清空来源"：后端按 exclude_unset 合并，空值不能进请求体。
    expect(recorded[0]?.options.body).not.toHaveProperty('baidu_root');
    expect(settings.application.setupCompleted).toBe(true);
    // 响应本身就是最新后端事实，后续读取直接命中，不需要再发一次 GET。
    expect(await service.getSettings()).toBe(settings);
  });

  it('完成引导失败时抛出后端原因，不写成本地成功', async () => {
    const service = createHttpMediaService({
      transport: stubTransport({}, [], {
        'config.setupComplete': '请至少配置一个可访问的媒体来源',
      }),
    });

    await expect(service.completeSetup!({ playerMode: 'internal' })).rejects.toThrow(
      '请至少配置一个可访问的媒体来源',
    );
  });

  it('稍后设置只走推迟端点，不解锁完成状态', async () => {
    const recorded: Recorded[] = [];
    const service = createHttpMediaService({
      transport: stubTransport(
        { 'config.setupDefer': { ...PUBLIC_CONFIG, setup_deferred: true } },
        recorded,
      ),
    });

    const settings = await service.deferSetup!();

    expect(recorded[0]?.operation).toBe('config.setupDefer');
    expect(recorded[0]?.options.body).toBeUndefined();
    expect(settings.application.setupDeferred).toBe(true);
    expect(settings.application.setupCompleted).toBe(false);
  });

  it('TMDB 令牌经验证端点写入；空值不发请求', async () => {
    const recorded: Recorded[] = [];
    const service = createHttpMediaService({
      transport: stubTransport(
        { 'config.setupTmdbCredential': { ...PUBLIC_CONFIG, tmdb_configured: true } },
        recorded,
      ),
    });

    const settings = await service.saveTmdbCredential!('  token-abc  ');
    expect(recorded[0]?.options.body).toEqual({ tmdb_bearer_token: 'token-abc' });
    expect(settings.scrape.tmdbConfigured).toBe(true);

    await expect(service.saveTmdbCredential!('   ')).rejects.toThrow(/请填写 TMDB/);
    expect(recorded).toHaveLength(1);
  });

  it('引导状态不能通过普通配置 PATCH 伪造完成', async () => {
    const service = createHttpMediaService({ transport: stubTransport({}) });
    await expect(service.updateSettings('application', { setupCompleted: true })).rejects.toBeInstanceOf(
      ServiceCapabilityError,
    );
  });

  it('设置模型读取后端公开键，不再读不存在的配置字段', async () => {
    const service = createHttpMediaService({
      transport: stubTransport({
        'config.get': { ...PUBLIC_CONFIG, tmdb_configured: true, bangumi_configured: true, tmdb_language: 'ja-JP' },
      }),
    });
    const settings = await service.getSettings();
    expect(settings.scrape.tmdbConfigured).toBe(true);
    expect(settings.bangumi.configured).toBe(true);
    expect(settings.scrape.tmdbLanguage).toBe('ja-JP');
  });
});

describe('写操作结果传播（真实服务）', () => {
  it('收藏与观看状态写入失败时抛出可读错误，不再当成成功', async () => {
    const service = createHttpMediaService({
      transport: stubTransport({}, [], { 'library.watchStatus': '作品不存在' }),
    });

    await expect(service.setFavorite('work_1', true)).rejects.toThrow('作品不存在');
    await expect(service.setWatchStatus('work_1', 'watched')).rejects.toThrow('作品不存在');
  });

  it('观看状态请求体字段与后端 WatchStatusRequest 一致', () => {
    expect(resolveHttpTarget({
      operation: 'library.watchStatus',
      params: { workId: 'work_1' },
      body: { status: 'watched', note: '', favorite: true },
      requestId: 'r',
    })).toEqual({
      ok: true,
      target: { method: 'PATCH', path: '/api/library/watch-status/work_1', query: [] },
    });
    // 未登记的字段必须在传输层之前被拒绝。
    expect(resolveHttpTarget({
      operation: 'library.watchStatus',
      params: { workId: 'work_1' },
      body: { watched: true },
      requestId: 'r',
    }).ok).toBe(false);
  });
});

describe('引导与写结果（演示实现）', () => {
  beforeEach(() => {
    resetDemoState();
  });

  afterEach(() => {
    resetDemoState();
  });

  it('实现来源标识区分真实与演示', () => {
    expect(createMockMediaService({ latencyMs: 0 }).serviceMode).toBe('demo');
    expect(createHttpMediaService({ transport: stubTransport() }).serviceMode).toBe('real');
  });

  it('完成引导写入演示存储，并把新目录提升为第一条本地来源', async () => {
    const service = createMockMediaService({ latencyMs: 0 });
    const before = getDemoState().settings.sources.localRoots;

    const updated = await service.completeSetup!({
      playerMode: 'external',
      externalMpvPath: 'C:\\mpv\\mpv.exe',
      localRoot: 'E:\\新动画库',
    });

    expect(updated.application).toMatchObject({ setupCompleted: true, setupDeferred: false });
    expect(updated.player).toMatchObject({ mode: 'external', externalPath: 'C:\\mpv\\mpv.exe' });
    expect(updated.sources.localRoots[0]?.path).toBe('E:\\新动画库');
    // 等价后端单值 local_root 的语义：提升为第一条，不丢弃其它已登记目录。
    expect(updated.sources.localRoots).toHaveLength(before.length + 1);
    expect(updated.sources.localRoots.slice(1).map((root) => root.path)).toEqual(
      before.map((root) => root.path),
    );
  });

  it('稍后设置只记录推迟，不标记完成', async () => {
    const service = createMockMediaService({ latencyMs: 0 });
    const updated = await service.deferSetup!();
    expect(updated.application.setupDeferred).toBe(true);
    expect(updated.application.setupCompleted).toBe(false);
    expect(getDemoState().settings.application.setupDeferred).toBe(true);
  });

  it('演示只记录 TMDB"已填写"，不保存令牌内容，空值拒绝', async () => {
    const service = createMockMediaService({ latencyMs: 0 });
    const updated = await service.saveTmdbCredential!('secret-token');
    expect(updated.scrape.tmdbConfigured).toBe(true);
    expect(JSON.stringify(getDemoState().settings)).not.toContain('secret-token');
    await expect(service.saveTmdbCredential!('   ')).rejects.toThrow(/请填写 TMDB/);
  });
});
