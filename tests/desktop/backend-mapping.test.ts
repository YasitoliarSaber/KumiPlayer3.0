/**
 * 真实服务的后端字段映射回归（F2/F3/F6/F7/U5）。
 *
 * 断言的是"前端读后端真实返回的键"，因此每个载荷都按后端源码的实际字段构造：
 * 任务状态（tasks_v4.py:12-21）、识别 issue（domain/models.py:146-152）、
 * 播放历史上界（playback_v4.py:147）、搜索截断（library_v4.py:336,385）、
 * 恢复预览忽略字段（core/backup.py:834-838）。
 * 只使用桩传输，不连接真实后端，也不接触真实数据与凭据。
 */

import { describe, expect, it } from 'vitest';

import { createHttpMediaService } from '@/services/real/service';
import { createStubTransport, type RecordedCall } from './stub-transport';

function serviceWith(
  responses: Parameters<typeof createStubTransport>[0],
  recorded: RecordedCall[] = [],
) {
  return createHttpMediaService({ transport: createStubTransport(responses, recorded) });
}

/** 后端 `tasks_v4.py:_task_payload` 的返回形状。 */
function taskPayload(status: string, extra: Record<string, unknown> = {}) {
  return {
    task_id: 'job_1',
    task_type: 'scrape',
    source: 'openlist',
    status,
    progress: 0,
    message: '等待任务执行',
    created_at: '2026-10-17T00:00:00+00:00',
    started_at: '',
    finished_at: '',
    error: '',
    cancel_requested: false,
    result: null,
    ...extra,
  };
}

describe('任务状态枚举（F2）', () => {
  it('后端 pending 归入当前任务并可取消，不再被当成历史终态', async () => {
    const service = serviceWith({ 'tasks.list': { tasks: [taskPayload('pending')] } });
    const tasks = await service.listTasks();
    expect(tasks[0]).toMatchObject({ status: 'pending', rawStatus: 'pending', cancellable: true });
    expect(tasks[0]?.progress).toBe(0);
  });

  it('运行中的任务可取消；已请求终止的任务不再重复提供取消', async () => {
    const running = serviceWith({ 'tasks.list': { tasks: [taskPayload('running')] } });
    expect((await running.listTasks())[0]?.cancellable).toBe(true);

    const cancelling = serviceWith({
      'tasks.list': { tasks: [taskPayload('running', { cancel_requested: true })] },
    });
    expect((await cancelling.listTasks())[0]?.cancellable).toBe(false);
  });

  it('未登记的状态如实标为 unknown 并保留原文，不冒充成功', async () => {
    const service = serviceWith({ 'tasks.list': { tasks: [taskPayload('paused_v2')] } });
    const task = (await service.listTasks())[0];
    expect(task?.status).toBe('unknown');
    expect(task?.rawStatus).toBe('paused_v2');
    expect(task?.cancellable).toBe(false);
  });

  it('终态任务保持原状态且不可取消', async () => {
    const service = serviceWith({
      'tasks.list': { tasks: [taskPayload('succeeded', { progress: 1 }), taskPayload('failed', { error: '磁盘不可写' })] },
    });
    const tasks = await service.listTasks();
    expect(tasks.map((task) => task.status)).toEqual(['succeeded', 'failed']);
    expect(tasks.every((task) => !task.cancellable)).toBe(true);
    expect(tasks[1]?.error).toBe('磁盘不可写');
  });
});

describe('识别问题字段映射（F3）', () => {
  const SCAN = {
    scan_id: 'scan_1',
    root_id: 'root_1',
    status: 'completed',
    entries: [{ evidence_id: 'ev_1' }],
  };

  it('读后端真实键 code/evidence_id/message/severity，标题与编号不再为空', async () => {
    const service = serviceWith({
      'sources.durableScan.get': SCAN,
      'imports.preview': {
        revision_id: 'rev_1',
        status: 'draft',
        works: [],
        episodes: [],
        blocking_issue_count: 0,
        issues: [
          {
            code: 'episode_number_unresolved',
            evidence_id: 'ev_1',
            message: '已归入本作品的正片序列，但文件名与目录都没有可用的集号',
            severity: 'warning',
            relative_path: '动画/第 1 季/SP01.mkv',
          },
        ],
      },
    });

    const preview = await service.previewImport!('scan_1');
    const issue = preview.issues[0];
    expect(issue?.id).toBe('ev_1');
    expect(issue?.title).toBe('集号无法确定');
    expect(issue?.detail).toContain('没有可用的集号');
    expect(issue?.detail).toContain('动画/第 1 季/SP01.mkv');
    // severity=warning 只是提示：不允许被自定义映射成阻断。
    expect(issue?.severity).toBe('notice');
    expect(preview.blockingIssueCount).toBe(0);
  });

  it('只有后端明确的 blocking 才算阻断；未登记的代码原样展示', async () => {
    const service = serviceWith({
      'sources.durableScan.get': SCAN,
      'imports.preview': {
        revision_id: 'rev_1',
        status: 'draft',
        works: [],
        episodes: [],
        blocking_issue_count: 1,
        issues: [
          { code: 'something_new', evidence_id: 'ev_2', message: '新的后端提示', severity: 'blocking' },
          { code: 'other_new', evidence_id: '', message: '另一条提示', severity: 'info' },
        ],
      },
    });

    const preview = await service.previewImport!('scan_1');
    expect(preview.blockingIssueCount).toBe(1);
    expect(preview.issues[0]?.severity).toBe('blocking');
    expect(preview.issues[0]?.title).toBe('something_new');
    expect(preview.issues[1]?.severity).toBe('notice');
    // evidence_id 缺失时退回 code，不产生空编号。
    expect(preview.issues[1]?.id).toBe('other_new');
  });
});

describe('播放历史读取上界（F6）', () => {
  it('来源扫描状态按后端真实值映射，paused/未知都不当作成功', async () => {
    const paused = serviceWith({
      'sources.durableScan.start': { scan_id: 'scan_1', root_id: 'root_1', status: 'paused', stage_label: '已达预算' },
    });
    const pausedTask = await paused.startScan('root_1');
    expect(pausedTask).toMatchObject({ status: 'paused', rawStatus: 'paused', progress: 0, cancellable: true });

    const unknown = serviceWith({
      'sources.durableScan.start': { scan_id: 'scan_2', root_id: 'root_1', status: 'half_done' },
    });
    expect(await unknown.startScan('root_1')).toMatchObject({ status: 'unknown', rawStatus: 'half_done', progress: 0 });

    const completed = serviceWith({
      'sources.durableScan.start': { scan_id: 'scan_3', root_id: 'root_1', status: 'completed' },
    });
    expect(await completed.startScan('root_1')).toMatchObject({ status: 'succeeded', progress: 1, cancellable: false });
  });

  it('进度读取按后端允许的上界请求，不再传会被夹掉的 500', async () => {
    const recorded: RecordedCall[] = [];
    const service = serviceWith({
      'library.list': { works: [] },
      'playback.history': { items: [] },
      'sources.libraries': { cards: [] },
    }, recorded);

    await service.listLibrary();
    const historyCall = recorded.find((call) => call.operation === 'playback.history');
    expect(historyCall?.options.query).toEqual({ limit: 200 });
  });
});

describe('搜索截断上报（F7）', () => {
  it('后端 truncated 进入视图模型，界面可如实提示结果过多', async () => {
    const recorded: RecordedCall[] = [];
    const service = serviceWith({
      'library.search': {
        query: '动画',
        limit: 30,
        truncated: true,
        items: [
          {
            work_id: 'w1',
            title: '动画',
            original_title: '',
            year: 2026,
            media_type: 'tv',
            matched_fields: ['title'],
            aliases: [],
            tags: [],
            studios: [],
          },
        ],
      },
    }, recorded);

    const result = await service.searchLibrary!('动画', 30);
    expect(result.truncated).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(recorded[0]?.options.query).toEqual({ q: '动画', limit: 30 });
  });

  it('缺少 truncated 字段时按未截断处理，不猜测', async () => {
    const service = serviceWith({ 'library.search': { items: [] } });
    expect(await service.searchLibrary!('x', 10)).toEqual({ hits: [], truncated: false });
  });
});

describe('恢复预览忽略字段（U5）', () => {
  it('读取后端 ignored_fields 并保留空数组语义', async () => {
    const service = serviceWith({
      'backup.restorePreview': {
        ok: true,
        preview_id: 'prev_1',
        digest: 'd'.repeat(64),
        backup: { created_at: '', app_version: '2.0.0', schema_version: 27, format_version: 1, scope: ['config'] },
        config: {
          changed_fields: ['local_root'],
          ignored_fields: ['tmdb_certification_regions', 'deepseek_api_key'],
          source_changes: [],
        },
        watch_records: { progress: 0, history: 0, watch_status: 0, overrides: 0, matched: 0, orphans: 0 },
        orphans: [],
        credentials: { included: false, note: '备份不含凭据' },
        expires_at: '',
      },
    });

    const preview = await service.previewRestore!(new File(['zip'], 'x.kumibak'));
    expect(preview.config.ignoredFields).toEqual(['tmdb_certification_regions', 'deepseek_api_key']);
  });

  it('后端没有该字段时保持空数组，不显示伪装的忽略列表', async () => {
    const service = serviceWith({
      'backup.restorePreview': {
        ok: true,
        preview_id: 'prev_2',
        digest: 'e'.repeat(64),
        backup: { created_at: '', app_version: '2.0.0', schema_version: 27, format_version: 1, scope: [] },
        config: { changed_fields: [], source_changes: [] },
        watch_records: { progress: 0, history: 0, watch_status: 0, overrides: 0, matched: 0, orphans: 0 },
        orphans: [],
        credentials: { included: false, note: '' },
        expires_at: '',
      },
    });

    const preview = await service.previewRestore!(new File(['zip'], 'x.kumibak'));
    expect(preview.config.ignoredFields).toEqual([]);
  });
});
