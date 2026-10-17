/**
 * 真实后端服务：`MediaService` 的浏览器 HTTP 实现。
 *
 * - 所有请求都经过具名操作白名单（`@shared/contracts/operations`）与
 *   唯一 HTTP 传输层；页面不各自 `fetch`。
 * - 读取路径响应在唯一入口做运行时校验；缺字段或未知结构不会进入 UI。
 * - 后端没有对应能力的项在这里显式失败（`ServiceCapabilityError`），
 *   由界面显示真实原因；绝不回退到演示数据，也不伪造成功。
 */

import type { WorkCard } from '@shared/contracts/dto';
import {
  parseLibrarySnapshot,
  parseTask,
  parseTaskList,
  parseWorkCard,
  parseWorkDetail,
} from '@shared/contracts/dto';
import type { GatewayError } from '@shared/contracts/errors';

import type {
  ArtworkCachePreview,
  BackupFileEntry,
  BackupList,
  ImportConfirmResult,
  ImportPreviewSummary,
  LibrarySnapshot,
  LibrarySearchHit,
  MediaService,
  MetadataCandidate,
  PlaybackSession,
  ProgressSnapshot,
  ReviewIssue,
  RestoreApplied,
  RestorePreview,
  ScanProgress,
  SettingsSection,
  SettingsSnapshot,
  SourceCard,
  SourceScanRequest,
  SourceScanSchedule,
  SourceStatus,
  TaskEntry,
  TaskStatus,
  WorkDetail,
  WorkOverride,
  WorkSummary,
} from '../../shared/api/service';
import { createBrowserTransport, type BrowserTransport } from '../../transport/http';
import { toProgressSnapshot, toWorkDetail, toWorkSummary, type BackendWorkDetailDto } from './adapters';

/** 后端尚无该能力或该能力需要桌面宿主时使用；界面据实展示，不用演示数据顶替。 */
export class ServiceCapabilityError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ServiceCapabilityError';
  }
}

export interface RealServiceOptions {
  readonly transport?: BrowserTransport;
}

function describe(error: GatewayError): string {
  return error.message;
}

function unwrapOrThrow<T>(outcome: { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: GatewayError }): T {
  if (outcome.ok) {
    return outcome.data;
  }
  throw new Error(describe(outcome.error));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 校验工作卡片；形状不符合契约时抛出真实原因，不让未知结构进入界面。 */
function parseCards(payload: unknown): readonly WorkCard[] {
  const snapshot = parseLibrarySnapshot(payload);
  if (snapshot.ok) {
    return snapshot.value.works;
  }
  // `/api/library/cards` 只返回 `{works:[...]}`：复用同一张卡片的校验规则。
  const works = asRecord(payload).works;
  if (!Array.isArray(works)) {
    throw new Error(`媒体库响应结构不符合契约：${snapshot.issues.join('; ')}`);
  }
  const checked = works.map((entry) => {
    const result = parseWorkCard(asRecord(entry));
    if (!result.ok) {
      throw new Error(`作品卡片缺少必需字段：${result.issues.join('; ')}`);
    }
    return result.value;
  });
  return checked;
}

/** durable SourceScan 读状态 → 视图模型；后端不提供连续百分比时保持 null。 */
function toScanProgress(payload: unknown): ScanProgress {
  const record = asRecord(payload);
  const status = str(record.status);
  return {
    scanId: str(record.scan_id),
    rootId: str(record.root_id),
    status,
    stage: str(record.stage),
    stageLabel: str(record.stage_label),
    processedCount: num(record.processed_count),
    totalCount: num(record.total_count),
    discoveredCount: num(record.discovered_count),
    currentDirectory: str(record.current_directory),
    error: str(record.error),
    resumable: record.resumable === true,
    cancelRequested: record.cancel_requested === true,
    canCancel: record.can_cancel === true || status === 'running' || status === 'queued' || status === 'paused',
    progress: typeof record.progress === 'number' ? record.progress : null,
  };
}

function scanToTaskEntry(scan: ScanProgress): TaskEntry {
  const running = scan.status === 'running' || scan.status === 'queued';
  const failed = scan.status === 'failed';
  const cancelled = scan.status === 'cancelled';
  const status: TaskStatus = running
    ? scan.status === 'queued'
      ? 'queued'
      : 'running'
    : failed
      ? 'failed'
      : cancelled
        ? 'cancelled'
        : 'succeeded';
  return {
    id: scan.scanId,
    type: 'source_scan',
    title: scan.stageLabel || '来源扫描',
    sourceId: scan.rootId,
    sourceName: scan.rootId,
    status,
    // 后端只给出已处理/总数量级，没有连续百分比时保持 0/1，不拟合曲线。
    progress: running ? 0 : 1,
    message: scan.error || scan.stageLabel,
    createdAt: '',
    startedAt: '',
    finishedAt: '',
    error: scan.error,
    scope: scan.rootId,
    cancellable: running,
  };
}

function toSourceStatus(overall: string): SourceStatus {
  switch (overall) {
    case 'running':
      return 'scanning';
    case 'needs_attention':
      return 'needs_attention';
    case 'queued':
      return 'scanning';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

function toSourceCard(payload: unknown): SourceCard {
  const record = asRecord(payload);
  const rootId = str(record.root_id);
  const scan = asRecord(record.scan);
  const progress = asRecord(record.progress);
  const active = asRecord(record.active_task);
  const sourceMode = str(record.source_mode);
  const ingestMethod = str(record.ingest_method);
  const provider = str(record.provider);
  const overall = str(record.overall_status, 'completed');
  const status = toSourceStatus(overall);
  const phaseRaw = str(record.phase);
  const phase: SourceCard['phase'] =
    phaseRaw === 'scan' || phaseRaw === 'review' || phaseRaw === 'execute' ? phaseRaw : 'maintenance';
  return {
    id: rootId,
    name: str(record.display_name) || str(record.provider),
    kind: (str(record.provider) || 'local') as SourceCard['kind'],
    providerLabel: sourceMode.includes('tree_openlist') ? 'TXT + OpenList'
      : ingestMethod.includes('openlist') || sourceMode.includes('openlist') ? 'OpenList'
      : provider === 'local' ? '本地目录'
      : ({ pan115: '115 目录树', baidu: '百度目录树', quark: '夸克目录树' } as Record<string, string>)[provider] ?? '目录树 TXT',
    location: str(record.display_path) || str(record.source_locator),
    contentScope: record.content_scope === 'ongoing' ? 'ongoing' : 'library',
    workCount: typeof record.work_count === 'number' ? record.work_count : 0,
    workCountKnown: typeof record.work_count === 'number',
    hasConfirmedBaseline: record.has_confirmed_baseline === true,
    scanPath: str(record.source_locator),
    connectionId: str(record.connection_id),
    lastScanAt: str(record.updated_at),
    status,
    statusLabel: ({ completed: record.has_confirmed_baseline === false ? '扫描完成' : '已完成', running: phase === 'scan' ? '扫描中' : '处理中', queued: '等待中',
      needs_attention: phase === 'review' ? '待确认' : '需要处理', cancelled: '已取消', failed: '失败',
      draft: '待确认', paused: '已暂停' } as Record<string, string>)[overall] ?? '待处理',
    phase,
    message: str(record.last_error) || str(progress.message),
    activeTaskId: Object.keys(active).length ? str(active.scan_id) || str(active.revision_id) || str(scan.scan_id) || null : null,
    canResume: record.can_resume === true,
  };
}

function toTaskEntry(payload: unknown): TaskEntry {
  const parsed = parseTask(payload);
  if (!parsed.ok) {
    throw new Error(`任务响应结构不符合契约：${parsed.issues.join('; ')}`);
  }
  const record = parsed.value;
  const status = record.status as TaskStatus;
  return {
    id: record.task_id,
    type: record.task_type,
    title: record.task_type,
    sourceId: record.source,
    sourceName: record.source,
    status,
    progress: record.progress > 0 ? 1 : 0,
    message: record.message,
    createdAt: record.created_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    error: record.error,
    scope: record.result?.revision_id ?? '',
    cancellable: status === 'running' || status === 'queued',
  };
}

function toStrArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function toOpenListConnections(value: unknown): SettingsSnapshot['openlist']['connections'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const serverUrl = str(record.server_url);
    const remoteRoot = str(record.remote_root);
    return {
      id: str(record.connection_id) || str(record.id) || `conn-${index}`,
      name: str(record.name) || `连接 ${index + 1}`,
      serverUrl,
      remoteRoot,
      mountRoot: str(record.mount_root),
      // "已配置"只表示地址与远端根齐全，不代表连接可用（可用性由测试连接给出）。
      configured: serverUrl.length > 0 && remoteRoot.length > 0,
    };
  });
}

function toOpenListRoutes(value: unknown): SettingsSnapshot['openlist']['routes'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const remote = str(record.remote_prefix);
    return {
      id: str(record.route_id) || `route-${index}`,
      label: str(record.label) || remote || `路由 ${index + 1}`,
      remote,
      local: str(record.local_path) || str(record.local_root),
    };
  });
}

/** 视图模型的请求 → `/api/v4/sources/scans` 的请求字段（后端固定集合）。 */
function scanBody(request: SourceScanRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (request.source) {
    body.source = request.source;
  }
  if (request.rootPath) {
    body.root_path = request.rootPath;
  }
  if (request.treeFile) {
    body.tree_file = request.treeFile;
  }
  if (request.contentScope) {
    body.content_scope = request.contentScope === 'ongoing' ? 'ongoing' : 'completed';
  }
  if (request.provider) body.provider = request.provider;
  if (request.scanMode) {
    body.scan_mode = request.scanMode;
  }
  if (request.targetRootId) {
    body.target_root_id = request.targetRootId;
  }
  if (request.revisionId) {
    body.revision_id = request.revisionId;
  }
  if (request.sourceDisplayName) {
    body.source_display_name = request.sourceDisplayName;
  }
  if (request.resumeScanId) {
    body.resume_scan_id = request.resumeScanId;
  }
  if (request.connectionId) {
    body.connection_id = request.connectionId;
  }
  return body;
}

function toImportPreview(payload: Record<string, unknown>): ImportPreviewSummary {
  const works = Array.isArray(payload.works) ? payload.works : [];
  const episodes = Array.isArray(payload.episodes) ? payload.episodes : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  return {
    revisionId: str(payload.revision_id),
    status: str(payload.status),
    workCount: works.length,
    episodeCount: episodes.length,
    // 现行后端固定返回 blocking_issue_count；缺失时按 0 处理（不阻断提示类 issue）。
    blockingIssueCount: num(payload.blocking_issue_count),
    issues: issues.map((entry) => {
      const record = asRecord(entry);
      const blocking = str(record.severity) === 'blocking';
      return {
        id: str(record.issue_id) || str(record.id),
        severity: blocking ? 'blocking' : 'notice',
        title: str(record.title) || str(record.kind),
        detail: str(record.detail) || str(record.message),
        candidates: Array.isArray(record.candidates)
          ? record.candidates.map((candidate) => {
              const option = asRecord(candidate);
              return { id: str(option.id) || str(option.candidate_id), label: str(option.label) || str(option.title) };
            })
          : [],
      };
    }),
  };
}

function toSourceScanSchedule(payload: unknown): SourceScanSchedule {
  const record = asRecord(payload);
  const schedule = asRecord(record.schedule);
  const scan = asRecord(record.scan);
  const revision = asRecord(record.revision);
  const jobs = asRecord(record.jobs);
  return {
    rootId: str(record.root_id),
    displayName: str(record.display_name) || str(record.provider),
    provider: str(record.provider),
    ingestMethod: str(record.ingest_method),
    sourceMode: str(record.source_mode),
    contentScope: str(record.content_scope),
    enabled: record.enabled !== false,
    schedule: {
      enabled: schedule.enabled === true,
      intervalMinutes: num(schedule.interval_minutes),
      lastRunAt: str(schedule.last_run_at),
      nextRunAt: str(schedule.next_run_at),
    },
    status: str(record.status, 'idle'),
    reason: str(record.reason),
    taskId: str(record.task_id),
    activityKind: str(record.activity_kind),
    canCancel: record.can_cancel === true,
    scan: {
      scanId: str(scan.scan_id),
      status: str(scan.status),
      startedAt: str(scan.started_at),
      finishedAt: str(scan.finished_at),
      canResume: scan.can_resume === true,
      canCancel: scan.can_cancel === true,
      message: str(scan.message),
    },
    revision: {
      latestRevisionId: str(revision.latest_revision_id),
      draftRevisionId: str(revision.draft_revision_id),
      status: str(revision.status),
      reason: str(revision.reason),
    },
    jobs: {
      queued: num(jobs.queued),
      running: num(jobs.running),
      failed: num(jobs.failed),
      cancelled: num(jobs.cancelled),
      latestJobId: str(jobs.latest_job_id),
    },
  };
}

function toBackupFile(payload: unknown): BackupFileEntry {
  const record = asRecord(payload);
  return {
    fileId: str(record.file_id),
    fileName: str(record.file_name),
    kind: str(record.kind, 'manual'),
    sizeBytes: num(record.size_bytes),
    createdAt: str(record.created_at),
    downloadUrl: str(record.download_url),
  };
}

function toBackupAuto(payload: unknown): BackupList['auto'] {
  const record = asRecord(payload);
  return {
    enabled: record.enabled === true,
    time: str(record.time, '03:00'),
    keep: num(record.keep, 7),
    lastRunAt: str(record.last_run_at),
    nextRunAt: str(record.next_run_at),
    lastStatus: str(record.last_status),
    lastError: str(record.last_error),
    lastFileId: str(record.last_file_id),
  };
}

function toBackupScope(payload: unknown): BackupList['scope'] {
  const record = asRecord(payload);
  return { includes: toStrArray(record.includes), excludes: toStrArray(record.excludes) };
}

function toRestorePreview(payload: Record<string, unknown>): RestorePreview {
  const backup = asRecord(payload.backup);
  const config = asRecord(payload.config);
  const watch = asRecord(payload.watch_records);
  const credentials = asRecord(payload.credentials);
  return {
    previewId: str(payload.preview_id),
    digest: str(payload.digest),
    backup: {
      createdAt: str(backup.created_at),
      appVersion: str(backup.app_version),
      schemaVersion: num(backup.schema_version),
      formatVersion: num(backup.format_version),
      scope: toStrArray(backup.scope),
    },
    config: {
      changedFields: toStrArray(config.changed_fields),
      sourceChanges: Array.isArray(config.source_changes)
        ? config.source_changes.map((entry) => {
            const record = asRecord(entry);
            return { field: str(record.field), action: str(record.action) };
          })
        : [],
    },
    watchRecords: {
      progress: num(watch.progress),
      history: num(watch.history),
      watchStatus: num(watch.watch_status),
      overrides: num(watch.overrides),
      matched: num(watch.matched),
      orphans: num(watch.orphans),
    },
    orphans: Array.isArray(payload.orphans)
      ? payload.orphans.map((entry) => {
          const record = asRecord(entry);
          return { kind: str(record.kind), workId: str(record.work_id), episodeId: str(record.episode_id) };
        })
      : [],
    credentials: { included: credentials.included === true, note: str(credentials.note) },
    expiresAt: str(payload.expires_at),
  };
}

function toRestoreApplied(payload: Record<string, unknown>): RestoreApplied {
  const applied = asRecord(payload.applied);
  const watch = asRecord(applied.watch_records);
  return {
    configFields: toStrArray(applied.config_fields),
    watchRecords: {
      progress: num(watch.progress),
      history: num(watch.history),
      watchStatus: num(watch.watch_status),
      overrides: num(watch.overrides),
    },
    orphans: Array.isArray(applied.orphans)
      ? applied.orphans.map((entry) => {
          const record = asRecord(entry);
          return { kind: str(record.kind), workId: str(record.work_id), episodeId: str(record.episode_id) };
        })
      : [],
    message: str(payload.message),
  };
}

export function createHttpMediaService(options: RealServiceOptions = {}): MediaService {
  const transport = options.transport ?? createBrowserTransport();

  let settingsCache: SettingsSnapshot | null = null;
  const overrideCache = new Map<string, WorkOverride>();

  async function library(
    signal?: AbortSignal,
  ): Promise<{ works: readonly WorkCard[]; progress: ReadonlyMap<string, ProgressSnapshot> }> {
    const payload = unwrapOrThrow(
      await transport.call<unknown>('library.list', signal ? { signal } : {}),
    );
    const works = parseCards(payload);
    const progress = new Map<string, ProgressSnapshot>();
    const history = await transport.call<unknown>('playback.history', {
      query: { limit: 500 },
      ...(signal ? { signal } : {}),
    });
    if (history.ok) {
      const items = asRecord(history.data).items;
      if (Array.isArray(items)) {
        for (const item of items) {
          const record = asRecord(item);
          const snapshot = toProgressSnapshot(record);
          if (snapshot) {
            progress.set(str(record.work_id), snapshot);
          }
        }
      }
    }
    return { works, progress };
  }

  async function detailDto(workId: string): Promise<BackendWorkDetailDto> {
    const payload = unwrapOrThrow(await transport.call<unknown>('work.detail', { params: { workId } }));
    const parsed = parseWorkDetail(payload);
    if (!parsed.ok) {
      throw new Error(`作品详情响应结构不符合契约：${parsed.issues.join('; ')}`);
    }
    return parsed.value as unknown as BackendWorkDetailDto;
  }

  async function loadSettings(): Promise<SettingsSnapshot> {
    if (settingsCache) {
      return settingsCache;
    }
    const record = asRecord(unwrapOrThrow(await transport.call<unknown>('config.get', {})));
    const localRoots = Array.isArray(record.local_roots)
      ? record.local_roots.map((entry, index) => {
          const root = asRecord(entry);
          return {
            id: str(root.root_id) || `local-${index}`,
            path: str(root.path),
            name: str(root.name) || str(root.path),
          };
        })
      : [];
    settingsCache = {
      application: {
        // 浏览器运行期没有托盘与自启能力：这些值只读展示真实配置，不提供假开关。
        minimizeToTray: record.minimize_to_tray === true,
        closeToTray: record.close_to_tray === true,
        connectionMonitor: record.heartbeat_enabled !== false,
        setupCompleted: record.setup_completed === true,
        setupDeferred: record.setup_deferred === true,
      },
      appearance: {
        theme: record.theme === 'cinema' ? 'cinema' : record.theme === 'system' ? 'system' : 'mica',
        material:
          record.material === 'solid' || record.material === 'acrylic' ? record.material : 'mica',
        motion: record.reduce_motion === true ? 'reduced' : 'full',
        posterSize: num(record.poster_size, 6),
        cardImageMode: record.series_card_image_mode === 'fanart' ? 'fanart' : 'poster',
      },
      sources: {
        localRoots,
        ongoingOnStartup: record.ongoing_update_on_startup === true,
        ongoingIntervalMinutes: num(record.ongoing_update_interval_minutes, 0),
      },
      openlist: {
        connections: toOpenListConnections(record.openlist_connections),
        routes: toOpenListRoutes(record.openlist_routes),
      },
      scrape: {
        tmdbLanguage: str(record.tmdb_language, 'zh-CN'),
        tmdbConfigured: record.tmdb_token_configured === true,
        bangumiAliasEnabled: record.bangumi_alias_enabled !== false,
        anilistEnabled: record.anilist_enabled !== false,
        imageStorageMode: str(record.artwork_storage_mode, 'auto'),
      },
      player: {
        mode: record.player_mode === 'external' ? 'external' : 'internal',
        externalPath: str(record.external_mpv_path),
        autoPlayNext: record.auto_play_next_episode !== false,
        anime4kMode: str(record.mpv_anime4k_mode, 'off'),
        anime4kQuality: str(record.mpv_anime4k_quality, 'balanced'),
        completedThresholdPercent: num(record.completed_threshold_percent, 90),
      },
      bangumi: {
        configured: record.bangumi_token_configured === true,
        username: str(record.bangumi_username),
        nickname: str(record.bangumi_nickname),
        syncEnabled: false,
      },
      backup: {
        autoDailyEnabled: record.backup_auto_daily_enabled === true,
        autoDailyTime: str(record.backup_auto_daily_time, '03:00'),
      },
    };
    return settingsCache;
  }

  function invalidateSettings(): void {
    settingsCache = null;
  }

  return {
    async listLibrary(signal): Promise<LibrarySnapshot> {
      const { works, progress } = await withSignal(signal, () => library(signal));
      const sources = await withSignal(signal, async () => {
        const payload = unwrapOrThrow(await transport.call<unknown>('sources.libraries', {}));
        const cards = asRecord(payload).cards;
        return Array.isArray(cards) ? cards.map(toSourceCard) : [];
      });
      return {
        works: works.map((card) => toWorkSummary(card, progress.get(card.work_id) ?? null)),
        sources,
        ongoingCategoryName: '新番',
      };
    },

    async getWorkDetail(workId): Promise<WorkDetail> {
      const dto = await detailDto(workId);
      const history = await transport.call<unknown>('playback.history', { query: { work_id: workId, limit: 1 } });
      let progress: ProgressSnapshot | null = null;
      if (history.ok) {
        const items = asRecord(history.data).items;
        if (Array.isArray(items) && items.length > 0) {
          progress = toProgressSnapshot(asRecord(items[0]));
        }
      }
      const cached = new Map<string, WorkSummary>();
      return toWorkDetail(dto, progress, (relatedId) => cached.get(relatedId) ?? null);
    },

    async listSources(signal): Promise<readonly SourceCard[]> {
      return withSignal(signal, async () => {
        const payload = unwrapOrThrow(await transport.call<unknown>('sources.libraries', {}));
        const cards = asRecord(payload).cards;
        return Array.isArray(cards) ? cards.map(toSourceCard) : [];
      });
    },

    async getReviewIssues(): Promise<readonly ReviewIssue[]> {
      throw new ServiceCapabilityError(
        '识别复核入口需要按 revision 读取导入预览；请先在来源卡开始扫描并进入识别复核。',
      );
    },

    async startScan(sourceId): Promise<TaskEntry> {
      const payload = unwrapOrThrow(
        await transport.call<unknown>('sources.durableScan.start', {
          body: { target_root_id: sourceId, scan_mode: 'incremental' },
        }),
      );
      return scanToTaskEntry(toScanProgress(payload));
    },

    async confirmRevision(): Promise<TaskEntry> {
      throw new ServiceCapabilityError('确认导入需要使用识别复核返回的 revision_id，不能按来源直接确认。');
    },

    async listTasks(signal): Promise<readonly TaskEntry[]> {
      return withSignal(signal, async () => {
        const payload = unwrapOrThrow(await transport.call<unknown>('tasks.list', { query: { limit: 50 } }));
        const parsed = parseTaskList(payload);
        if (!parsed.ok) {
          throw new Error(`任务列表响应结构不符合契约：${parsed.issues.join('; ')}`);
        }
        return parsed.value.tasks.map((task) => toTaskEntry(task));
      });
    },

    async cancelTask(taskId): Promise<TaskEntry> {
      return toTaskEntry(unwrapOrThrow(await transport.call<unknown>('tasks.cancel', { params: { taskId } })));
    },

    async retryTask(taskId): Promise<TaskEntry> {
      return toTaskEntry(unwrapOrThrow(await transport.call<unknown>('tasks.retry', { params: { taskId } })));
    },

    async setFavorite(workId, favorite): Promise<WorkSummary> {
      await transport.call<unknown>('library.watchStatus', {
        params: { workId },
        body: { favorite },
      });
      return refreshWork(workId);
    },

    async setWatchStatus(workId, status): Promise<WorkSummary> {
      await transport.call<unknown>('library.watchStatus', {
        params: { workId },
        body: { status },
      });
      return refreshWork(workId);
    },

    async saveProgress(workId, episodeId, position, duration): Promise<void> {
      const outcome = await transport.call<unknown>('playback.progress', {
        body: { work_id: workId, episode_id: episodeId, position, duration },
      });
      if (!outcome.ok) {
        throw new Error(describe(outcome.error));
      }
    },

    getSettings: loadSettings,

    async updateSettings(section: SettingsSection, patch: Record<string, unknown>): Promise<SettingsSnapshot> {
      const body = toConfigPatch(section, patch);
      const outcome = await transport.call<unknown>('config.update', { body });
      if (!outcome.ok) {
        // 保存失败保留草稿：这里不刷新缓存，调用方仍能看到用户输入。
        throw new Error(describe(outcome.error));
      }
      invalidateSettings();
      settingsCache = null;
      return loadSettings();
    },

    async play(workId, episodeId, assetId): Promise<PlaybackSession> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('playback.play', {
            body: { work_id: workId, episode_id: episodeId, asset_id: assetId },
          }),
        ),
      );
      return {
        workId: str(payload.work_id, workId),
        workTitle: '',
        episodeId: str(payload.episode_id, episodeId),
        episodeCode: '',
        episodeTitle: '',
        assetId: str(payload.asset_id, assetId),
        position: 0,
        // 后端会话不返回时长；界面用它计算进度时必须先判断 0。
        duration: 0,
        paused: false,
      };
    },

    async stopPlayback(): Promise<PlaybackSession | null> {
      const outcome = await transport.call<unknown>('playback.stop', {});
      if (!outcome.ok) {
        throw new Error(describe(outcome.error));
      }
      return null;
    },

    async getPlayback(): Promise<PlaybackSession | null> {
      const payload = asRecord(unwrapOrThrow(await transport.call<unknown>('playback.status', {})));
      const session = payload.session;
      if (typeof session !== 'object' || session === null) {
        return null;
      }
      const record = asRecord(session);
      return {
        workId: str(record.work_id),
        workTitle: '',
        episodeId: str(record.episode_id),
        episodeCode: '',
        episodeTitle: '',
        assetId: str(record.asset_id),
        position: 0,
        duration: 0,
        paused: false,
      };
    },

    async metadataCandidates(workId, query): Promise<readonly MetadataCandidate[]> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('metadata.search', {
            body: { work_id: workId, ...(query ? { query } : {}) },
          }),
        ),
      );
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      return candidates.map((entry) => {
        const record = asRecord(entry);
        return {
          id: str(record.candidate_id),
          title: str(record.title),
          year: typeof record.year === 'number' ? record.year : 0,
          mediaType: str(record.media_type) === 'movie' ? 'movie' : 'tv',
          provider: str(record.provider_id),
          providerId: str(record.provider_id),
          confidence: 0,
        };
      });
    },

    async confirmCandidate(workId, candidateId): Promise<WorkOverride> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('metadata.confirm', {
            body: { work_id: workId, candidate_id: candidateId },
          }),
        ),
      );
      const override: WorkOverride = {
        metadataCandidateId: str(payload.candidate_id, candidateId),
        metadataProvenance: 'manual',
      };
      overrideCache.set(workId, override);
      return override;
    },

    async setManualTitle(workId, title): Promise<WorkOverride> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('work.title.set', { params: { workId }, body: { title } })),
      );
      const override: WorkOverride = { manualTitle: str(payload.title, title) };
      overrideCache.set(workId, override);
      return override;
    },

    async resetManualTitle(workId): Promise<WorkOverride> {
      unwrapOrThrow(await transport.call<unknown>('work.title.restore', { params: { workId } }));
      const override: WorkOverride = {};
      overrideCache.set(workId, override);
      return override;
    },

    async setManualArtwork(workId, role, artwork): Promise<WorkOverride> {
      // 后端只接受 base64 上传。浏览器没有任意路径读取能力，
      // 因此这里只接受调用方已经取得的本地图片数据（data URL），
      // 不代为下载任意 URL（避免变成通用代理）。
      const dataMatch = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(artwork.url);
      if (!dataMatch) {
        throw new ServiceCapabilityError('请先通过文件选择取得图片数据，再上传为作品图片。');
      }
      unwrapOrThrow(
        await transport.call<unknown>('work.artwork.set', {
          params: { workId },
          body: { kind: role, data_base64: dataMatch[1]! },
        }),
      );
      const override: WorkOverride = { manualArtwork: { ...artwork, role } };
      overrideCache.set(workId, override);
      return override;
    },

    async resetManualArtwork(workId): Promise<WorkOverride> {
      unwrapOrThrow(
        await transport.call<unknown>('work.artwork.restore', {
          params: { workId, kind: 'poster' },
        }),
      );
      return {};
    },

    async bangumiSearch(): Promise<never> {
      throw new ServiceCapabilityError('Bangumi 账号会话由后端提供；浏览器版本尚未接入该端点的响应契约。');
    },

    async bangumiBind(workId): Promise<WorkOverride> {
      throw new ServiceCapabilityError(`Bangumi 匹配尚未接入：${workId}`);
    },

    async bangumiUnbind(): Promise<WorkOverride> {
      throw new ServiceCapabilityError('Bangumi 解绑尚未接入。');
    },

    async bangumiSync(): Promise<TaskEntry> {
      throw new ServiceCapabilityError('Bangumi 同步尚未接入。');
    },

    async resetDemoData(): Promise<void> {
      throw new ServiceCapabilityError('真实后端不提供演示数据重置。');
    },

    /* ------------------------- 搜索轻量索引 ------------------------- */

    async searchLibrary(query, limit = 30): Promise<readonly LibrarySearchHit[]> {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return [];
      }
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('library.search', {
            query: { q: trimmed, limit: Math.min(100, Math.max(1, Math.round(limit))) },
          }),
        ),
      );
      const items = Array.isArray(payload.items) ? payload.items : [];
      return items.map((entry) => {
        const record = asRecord(entry);
        return {
          workId: str(record.work_id),
          title: str(record.title),
          originalTitle: str(record.original_title),
          year: typeof record.year === 'number' ? record.year : null,
          mediaType: str(record.media_type),
          matchedFields: toStrArray(record.matched_fields),
          aliases: toStrArray(record.aliases),
          tags: toStrArray(record.tags),
          studios: toStrArray(record.studios),
        };
      });
    },

    /* ------------------------- 来源扫描（持久、可恢复） ------------------------- */

    async startSourceScan(request): Promise<ScanProgress> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('sources.durableScan.start', { body: scanBody(request) })),
      );
      return toScanProgress(payload);
    },

    async getSourceScan(scanId): Promise<ScanProgress> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('sources.durableScan.get', {
            params: { scanId },
            query: { include_entries: 'false' },
          }),
        ),
      );
      return toScanProgress(payload);
    },

    async cancelSourceScan(scanId): Promise<ScanProgress> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('sources.durableScan.cancel', { params: { scanId } })),
      );
      return toScanProgress(payload);
    },

    /**
     * 识别预览：先读回扫描证据（唯一权威在服务端），再提交同一批证据生成 draft revision。
     * 不在前端重新识别，也不改写任何证据。
     */
    async previewImport(scanId): Promise<ImportPreviewSummary> {
      const scanPayload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('sources.durableScan.get', {
            params: { scanId },
            query: { include_entries: 'true' },
          }),
        ),
      );
      const entries = scanPayload.entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('这次扫描没有可用的来源证据，无法生成识别预览。');
      }
      const preview = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('imports.preview', {
            body: {
              revision_id: str(scanPayload.revision_id) || `rev-${scanId}`,
              root_id: str(scanPayload.root_id),
              scan_id: scanId,
              entries,
              source_mode: str(scanPayload.source_mode),
            },
          }),
        ),
      );
      return toImportPreview(preview);
    },

    async confirmImport(revisionId): Promise<ImportConfirmResult> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('imports.confirm', { params: { revisionId } })),
      );
      const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      return {
        revisionId: str(payload.revision_id, revisionId),
        status: str(payload.status),
        jobCount: jobs.length,
      };
    },

    async cancelImport(revisionId): Promise<{ cancelled: number; running: number }> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('imports.cancel', { params: { revisionId } })),
      );
      return { cancelled: num(payload.cancelled), running: num(payload.running) };
    },

    /* ------------------------- 按来源扫描调度 ------------------------- */

    async listScanSchedules(): Promise<readonly SourceScanSchedule[]> {
      const payload = asRecord(unwrapOrThrow(await transport.call<unknown>('sources.scanSchedules', {})));
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      return sources.map(toSourceScanSchedule);
    },

    async setScanSchedule(rootId, input): Promise<SourceScanSchedule> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('sources.scanSchedule.set', {
            params: { rootId },
            body: { enabled: input.enabled, interval_minutes: input.intervalMinutes },
          }),
        ),
      );
      return toSourceScanSchedule(payload);
    },

    /* ------------------------- 备份与恢复（.kumibak） ------------------------- */

    async listBackups(): Promise<BackupList> {
      const payload = asRecord(unwrapOrThrow(await transport.call<unknown>('backup.files', {})));
      const files = Array.isArray(payload.files) ? payload.files : [];
      return {
        files: files.map(toBackupFile),
        auto: toBackupAuto(payload.auto),
        scope: toBackupScope(payload.scope),
      };
    },

    async exportBackup(): Promise<BackupFileEntry> {
      const payload = asRecord(unwrapOrThrow(await transport.call<unknown>('backup.export', {})));
      return toBackupFile(payload.file);
    },

    async downloadBackup(fileId): Promise<{ blob: Blob; filename: string }> {
      const outcome = await transport.download('backup.download', { params: { fileId } });
      if (!outcome.ok) {
        throw new Error(outcome.error.message);
      }
      return { blob: outcome.blob, filename: outcome.filename };
    },

    async previewRestore(file): Promise<RestorePreview> {
      const form = new FormData();
      form.append('file', file, file.name);
      const payload = asRecord(
        unwrapOrThrow(await transport.upload<unknown>('backup.restorePreview', form)),
      );
      return toRestorePreview(payload);
    },

    async confirmRestore(previewId, digest): Promise<RestoreApplied> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('backup.restoreConfirm', {
            body: { preview_id: previewId, digest },
          }),
        ),
      );
      return toRestoreApplied(payload);
    },

    /* ------------------------- 受管图片缓存清理 ------------------------- */

    async previewArtworkCache(retentionDays): Promise<ArtworkCachePreview> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('artwork.cache.preview', {
            body: { retention_days: Math.min(3650, Math.max(1, Math.round(retentionDays))) },
          }),
        ),
      );
      return {
        previewId: str(payload.preview_id),
        digest: str(payload.digest),
        removableFiles: num(payload.removable_files) || num(payload.files),
        freedBytes: num(payload.freed_bytes) || num(payload.bytes),
        retentionDays: num(payload.retention_days, retentionDays),
        expiresAt: str(payload.expires_at),
      };
    },

    async confirmArtworkCache(previewId, digest): Promise<{ removedFiles: number; freedBytes: number }> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('artwork.cache.confirm', {
            body: { preview_id: previewId, digest, confirm: true },
          }),
        ),
      );
      return {
        removedFiles: num(payload.removed_files) || num(payload.files),
        freedBytes: num(payload.freed_bytes) || num(payload.bytes),
      };
    },

    async testOpenListConnection(input) {
      const body: Record<string, unknown> = {};
      if (input.connectionId) {
        body.connection_id = input.connectionId;
      }
      if (input.serverUrl) {
        body.server_url = input.serverUrl;
      }
      if (input.remoteRoot) {
        body.remote_root = input.remoteRoot;
      }
      if (input.username) {
        body.username = input.username;
      }
      if (input.password) {
        body.password = input.password;
      }
      const payload = asRecord(unwrapOrThrow(await transport.call<unknown>('openlist.test', { body })));
      return {
        ok: payload.ok === true,
        code: str(payload.code),
        message: str(payload.message) || (payload.ok === true ? '连接正常' : '连接未通过'),
        phase: str(payload.phase),
      };
    },
  };

  async function refreshWork(workId: string): Promise<WorkSummary> {
    const dto = await detailDto(workId);
    return toWorkSummary(dto, null);
  }
}

async function withSignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (signal?.aborted) {
    throw new Error('读取已取消');
  }
  return run();
}

/** 视图模型字段 → `PATCH /api/config` 的字段名（后端 ConfigPatch 固定集合）。 */
function toConfigPatch(section: SettingsSection, patch: Record<string, unknown>): Record<string, unknown> {
  /** 视图字段 → 后端 `ConfigPatch` 字段。未登记的组合意味着没有后端实现。 */
  const MAP: Record<string, Record<string, string>> = {
    application: { connectionMonitor: 'heartbeat_enabled' },
    appearance: { posterSize: 'poster_size', cardImageMode: 'series_card_image_mode' },
    sources: {
      localRoots: 'local_roots',
      ongoingOnStartup: 'ongoing_update_on_startup',
      ongoingIntervalMinutes: 'ongoing_update_interval_minutes',
      ongoingScheduleMode: 'ongoing_update_schedule_mode',
    },
    openlist: {
      serverUrl: 'openlist_server_url',
      remoteRoot: 'openlist_remote_root',
      mountRoot: 'openlist_mount_root',
      username: 'openlist_username',
      password: 'openlist_password',
    },
    scrape: {
      tmdbToken: 'tmdb_bearer_token',
      tmdbLanguage: 'tmdb_language',
      anilistEnabled: 'anilist_enabled',
      bangumiAliasEnabled: 'bangumi_alias_enabled',
      imageStorageMode: 'artwork_storage_mode',
    },
    player: {
      mode: 'player_mode',
      externalPath: 'external_mpv_path',
      autoPlayNext: 'auto_play_next_episode',
      anime4kMode: 'mpv_anime4k_mode',
      anime4kQuality: 'mpv_anime4k_quality',
      completedThresholdPercent: 'completed_threshold_percent',
    },
    bangumi: { token: 'bangumi_access_token' },
    backup: {
      autoDailyEnabled: 'backup_auto_daily_enabled',
      autoDailyTime: 'backup_auto_daily_time',
    },
  };
  const mapping = MAP[section] ?? {};
  const body: Record<string, unknown> = {};
  for (const [viewKey, configKey] of Object.entries(mapping)) {
    if (patch[viewKey] !== undefined) {
      body[configKey] = patch[viewKey];
    }
  }
  if (Object.keys(body).length === 0) {
    // 明确失败：没有可写的后端字段时不能返回"已保存"。
    throw new ServiceCapabilityError(`「${section}」的这项设置没有对应的后端配置字段，未保存任何内容。`);
  }
  return body;
}

export type { ScanProgress };
