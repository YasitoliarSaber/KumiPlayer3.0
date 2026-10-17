/**
 * 真实服务与具名操作契约：路径解析、请求字段映射、响应适配与能力边界。
 * 只使用桩传输，不发起真实网络请求，也不接触真实数据或凭据。
 */

import { describe, expect, it } from 'vitest';

import { resolveHttpTarget } from '@shared/contracts/operations';
import { ServiceCapabilityError, createHttpMediaService } from '@/services/real/service';
import type { BrowserTransport, CallOptions } from '@/transport/http';
import type { OperationId } from '@shared/contracts/operations';
import type { GatewayError, OperationOutcome } from '@shared/contracts/errors';

interface Recorded {
  readonly operation: OperationId;
  readonly options: CallOptions;
}

function stubTransport(
  responses: Partial<Record<OperationId, unknown>>,
  recorded: Recorded[] = [],
): BrowserTransport {
  return {
    async call<T>(operation: OperationId, options: CallOptions = {}): Promise<OperationOutcome<T>> {
      recorded.push({ operation, options });
      if (!(operation in responses)) {
        const error: GatewayError = { kind: 'unavailable', message: '桩未定义该操作', retryable: false };
        return { ok: false, error, epoch: 0 };
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

describe('新端点的具名操作解析', () => {
  it('扫描按真实后端枚举提交 content_scope，并保留 TXT 提供方', async () => {
    const recorded: Recorded[] = [];
    const service = createHttpMediaService({ transport: stubTransport({
      'sources.durableScan.start': { scan_id: 'scan_1', root_id: 'root_1', status: 'queued' },
    }, recorded) });
    await service.startSourceScan!({ source: 'tree', contentScope: 'library', scanMode: 'full',
      treeFile: 'C:/fixtures/tree.txt', provider: 'baidu' });
    expect(recorded[0]?.options.body).toEqual({ source: 'tree', content_scope: 'completed', scan_mode: 'full',
      tree_file: 'C:/fixtures/tree.txt', provider: 'baidu' });
    await service.startSourceScan!({ source: 'local', contentScope: 'ongoing' });
    expect(recorded[1]?.options.body?.content_scope).toBe('ongoing');
  });

  it('已完成扫描不会被映射成仍有活动任务，状态不暴露英文内部枚举', async () => {
    const service = createHttpMediaService({ transport: stubTransport({ 'sources.libraries': { cards: [{
      root_id: 'root_1', provider: 'local', display_name: '动画', overall_status: 'completed',
      phase: 'execute', work_count: 4, scan: { scan_id: 'old_scan', status: 'completed' },
      progress: { stage: 'metadata' }, active_task: null, can_resume: false,
    }] } }) });
    const cards = await service.listSources();
    expect(cards[0]).toMatchObject({ activeTaskId: null, statusLabel: '已完成', canResume: false, workCount: 4 });
  });
  it('备份导出 / 下载 / 恢复确认指向固定路径', () => {
    expect(resolveHttpTarget({ operation: 'backup.export', requestId: 'r' })).toEqual({
      ok: true,
      target: { method: 'POST', path: '/api/backup/export', query: [] },
    });
    expect(resolveHttpTarget({ operation: 'backup.download', params: { fileId: 'bkp_1' }, requestId: 'r' })).toEqual({
      ok: true,
      target: { method: 'GET', path: '/api/backup/files/bkp_1/download', query: [] },
    });
    const confirm = resolveHttpTarget({
      operation: 'backup.restoreConfirm',
      body: { preview_id: 'prev_1', digest: 'a'.repeat(64) },
      requestId: 'r',
    });
    expect(confirm.ok).toBe(true);
  });

  it('恢复预览只允许 multipart 上传，不接受未登记字段', () => {
    const upload = resolveHttpTarget({ operation: 'backup.restorePreview', requestId: 'r' });
    expect(upload.ok).toBe(true);
    const extra = resolveHttpTarget({
      operation: 'backup.restoreConfirm',
      body: { preview_id: 'prev_1', tampered: true },
      requestId: 'r',
    });
    expect(extra.ok).toBe(false);
  });

  it('搜索与按来源调度使用登记好的查询与请求体字段', () => {
    expect(resolveHttpTarget({ operation: 'library.search', query: { q: '露营', limit: 30 }, requestId: 'r' })).toEqual({
      ok: true,
      target: { method: 'GET', path: '/api/library/search', query: [['q', '露营'], ['limit', '30']] },
    });
    const schedule = resolveHttpTarget({
      operation: 'sources.scanSchedule.set',
      params: { rootId: 'root_1' },
      body: { enabled: true, interval_minutes: 720 },
      requestId: 'r',
    });
    expect(schedule).toEqual({
      ok: true,
      target: { method: 'PUT', path: '/api/v4/sources/root_1/scan-schedule', query: [] },
    });
    const invalidInterval = resolveHttpTarget({
      operation: 'sources.scanSchedule.set',
      params: { rootId: 'root_1' },
      body: { enabled: true, cron: '* * * * *' },
      requestId: 'r',
    });
    expect(invalidInterval.ok).toBe(false);
  });
});

describe('真实服务的响应适配与能力边界', () => {
  it('搜索索引命中按字段换算，空查询不发请求', async () => {
    const recorded: Recorded[] = [];
    const service = createHttpMediaService({
      transport: stubTransport(
        {
          'library.search': {
            query: '悠',
            limit: 30,
            truncated: false,
            items: [
              {
                work_id: 'work_1',
                title: '悠哉日常大王',
                original_title: 'のんのんびより',
                year: 2013,
                media_type: 'tv',
                matched_fields: ['title', 'aliases'],
                aliases: ['Non Non Biyori'],
                tags: ['日常'],
                studios: ['SILVER LINK.'],
              },
            ],
          },
        },
        recorded,
      ),
    });

    expect(await service.searchLibrary!('   ', 30)).toEqual({ hits: [], truncated: false });
    expect(recorded).toHaveLength(0);

    const result = await service.searchLibrary!('悠', 30);
    expect(result.hits).toHaveLength(1);
    // 后端命中超过 limit 时必须如实上报截断，不能静默少列。
    expect(result.truncated).toBe(false);
    expect(result.hits[0]).toMatchObject({
      workId: 'work_1',
      title: '悠哉日常大王',
      aliases: ['Non Non Biyori'],
      matchedFields: ['title', 'aliases'],
    });
    expect(recorded[0]?.options.query).toEqual({ q: '悠', limit: 30 });
  });

  it('识别预览复用同一批扫描证据，确认返回真实作业数', async () => {
    const recorded: Recorded[] = [];
    const service = createHttpMediaService({
      transport: stubTransport(
        {
          'sources.durableScan.get': {
            scan_id: 'scan_1',
            root_id: 'root_1',
            status: 'completed',
            stage_label: '扫描完成',
            entries: [{ evidence_id: 'ev_1' }],
          },
          'imports.preview': {
            revision_id: 'rev_1',
            status: 'draft',
            works: [{ work_id: 'w1' }],
            episodes: [{ episode_id: 'e1' }],
            issues: [{ issue_id: 'i1', severity: 'notice', title: '疑似特别篇', detail: '请确认' }],
            blocking_issue_count: 0,
          },
          'imports.confirm': { revision_id: 'rev_1', status: 'confirmed', jobs: [{ job_id: 'j1' }, { job_id: 'j2' }] },
        },
        recorded,
      ),
    });

    const preview = await service.previewImport!('scan_1');
    expect(preview).toMatchObject({
      revisionId: 'rev_1',
      workCount: 1,
      episodeCount: 1,
      blockingIssueCount: 0,
    });
    expect(preview.issues[0]?.severity).toBe('notice');
    expect(recorded[0]?.options.query).toEqual({ include_entries: 'true' });

    const confirmed = await service.confirmImport!('rev_1');
    expect(confirmed.jobCount).toBe(2);
  });

  it('扫描在没有任何证据时不伪造预览', async () => {
    const service = createHttpMediaService({
      transport: stubTransport({
        'sources.durableScan.get': { scan_id: 'scan_2', root_id: 'root_2', status: 'completed', entries: [] },
      }),
    });
    await expect(service.previewImport!('scan_2')).rejects.toThrow(/没有可用的来源证据/);
  });

  it('备份清单与调度读取按后端字段换算', async () => {
    const service = createHttpMediaService({
      transport: stubTransport({
        'backup.files': {
          files: [
            {
              file_id: 'bkp_1',
              file_name: 'kumiplayer-backup-20261017.kumibak',
              kind: 'manual',
              size_bytes: 20480,
              created_at: '2026-10-17T03:00:00+00:00',
              download_url: '/api/backup/files/bkp_1/download',
            },
          ],
          auto: { enabled: false, time: '03:00', keep: 7, last_run_at: '', next_run_at: '', last_status: '', last_error: '', last_file_id: '' },
          scope: { includes: ['config', 'sources', 'watch_records'], excludes: ['credentials', 'media_files'] },
        },
        'sources.scanSchedules': {
          sources: [
            {
              root_id: 'root_1',
              display_name: '动画',
              provider: 'openlist',
              content_scope: 'ongoing',
              schedule: { enabled: true, interval_minutes: 720, last_run_at: '', next_run_at: '' },
              status: 'idle',
              can_cancel: false,
              scan: { scan_id: '', status: '', can_resume: false, can_cancel: false, message: '' },
              revision: { latest_revision_id: 'rev_9', draft_revision_id: '', status: '', reason: '' },
              jobs: { queued: 0, running: 1, failed: 2, cancelled: 0, latest_job_id: 'j9' },
            },
          ],
        },
      }),
    });

    const backups = await service.listBackups!();
    expect(backups.files[0]).toMatchObject({ fileId: 'bkp_1', kind: 'manual', sizeBytes: 20480 });
    expect(backups.auto.keep).toBe(7);
    expect(backups.scope.excludes).toContain('credentials');

    const schedules = await service.listScanSchedules!();
    expect(schedules[0]).toMatchObject({
      rootId: 'root_1',
      displayName: '动画',
      contentScope: 'ongoing',
    });
    expect(schedules[0]?.jobs.failed).toBe(2);
    expect(schedules[0]?.schedule.intervalMinutes).toBe(720);
  });

  it('调度写入发送后端字段名，没有可写字段时明确失败', async () => {
    const recorded: Recorded[] = [];
    const service = createHttpMediaService({
      transport: stubTransport(
        {
          'sources.scanSchedule.set': {
            root_id: 'root_1',
            display_name: '动画',
            schedule: { enabled: true, interval_minutes: 720 },
            jobs: {},
          },
        },
        recorded,
      ),
    });
    const updated = await service.setScanSchedule!('root_1', { enabled: true, intervalMinutes: 720 });
    expect(updated.schedule.intervalMinutes).toBe(720);
    expect(recorded[0]?.options.body).toEqual({ enabled: true, interval_minutes: 720 });

    // 应用分组的托盘 / 自启没有后端字段：不能返回"已保存"。
    await expect(service.updateSettings('application', { minimizeToTray: true })).rejects.toBeInstanceOf(
      ServiceCapabilityError,
    );
  });

  it('恢复预览与确认使用服务端保存的预览身份', async () => {
    const recorded: Recorded[] = [];
    const service = createHttpMediaService({
      transport: stubTransport(
        {
          'backup.restorePreview': {
            ok: true,
            preview_id: 'prev_1',
            digest: 'd'.repeat(64),
            backup: { created_at: '2026-10-17T03:00:00+00:00', app_version: '2.0.0', schema_version: 27, format_version: 1, scope: ['config'] },
            config: { changed_fields: ['local_root'], source_changes: [{ field: 'openlist_connections', action: 'replace' }] },
            watch_records: { progress: 12, history: 34, watch_status: 5, overrides: 3, matched: 40, orphans: 11 },
            orphans: [{ kind: 'progress', work_id: 'work_x', episode_id: 'ep_x' }],
            credentials: { included: false, note: '备份不含凭据' },
            expires_at: '2026-10-17T03:15:00+00:00',
          },
          'backup.restoreConfirm': {
            ok: true,
            applied: { config_fields: ['local_root'], watch_records: { progress: 40, history: 30, watch_status: 5, overrides: 3 }, orphans: [] },
            message: '备份已恢复',
          },
        },
        recorded,
      ),
    });

    const preview = await service.previewRestore!(new File(['zip'], 'x.kumibak'));
    expect(preview.previewId).toBe('prev_1');
    expect(preview.watchRecords.orphans).toBe(11);
    expect(preview.credentials.included).toBe(false);

    const applied = await service.confirmRestore!('prev_1', preview.digest);
    expect(applied.message).toBe('备份已恢复');
    expect(recorded[1]?.options.body).toEqual({ preview_id: 'prev_1', digest: 'd'.repeat(64) });
  });

  it('浏览/播放等未接入的后端能力显式失败，不用演示数据顶替', async () => {
    const service = createHttpMediaService({ transport: stubTransport({}) });
    await expect(service.getReviewIssues('root_1')).rejects.toBeInstanceOf(ServiceCapabilityError);
    await expect(service.bangumiSync('work_1')).rejects.toBeInstanceOf(ServiceCapabilityError);
  });
});
