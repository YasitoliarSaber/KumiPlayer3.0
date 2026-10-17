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
  BangumiAccountSession,
  BangumiCollectionState,
  BangumiMatchState,
  BangumiSubject,
  BangumiSyncResult,
  BackupFileEntry,
  BackupList,
  ImportConfirmResult,
  ImportPreviewSummary,
  LibrarySearchResult,
  LibrarySnapshot,
  MediaService,
  MetadataCandidate,
  PlaybackSession,
  ProgressSnapshot,
  ReviewIssue,
  RestoreApplied,
  RestorePreview,
  ScanMappingChoice,
  ScanPathValidation,
  ScanProgress,
  SetupCompletionInput,
  SettingsSection,
  SettingsSnapshot,
  SourceCard,
  SourceScanRequest,
  SourceScanSchedule,
  SourceStatus,
  TaskEntry,
  TaskStatus,
  WorkDeleteConfirmInput,
  WorkDeletePreview,
  WorkDeleteResult,
  WorkDetail,
  WorkFolderInfo,
  WorkFolderOpenInput,
  WorkFolderOpenResult,
  WorkOverride,
  WorkScrapeResult,
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

/**
 * `GET /api/playback/history` 的后端上界（`backend/app/api/playback_v4.py:147` 夹在 1..200）。
 * 传更大的值只会被静默截断，这里按最大页读取进度快照；后端没有按作品批量读进度的端点。
 */
const PLAYBACK_HISTORY_LIMIT = 200;

/** 后端可能返回的任务状态（`backend/app/api/tasks_v4.py:12-21`）。 */
const KNOWN_TASK_STATUSES: ReadonlySet<string> = new Set<string>([
  'pending',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'cancelling',
]);

/** 识别问题的中文标签；键是后端真实 issue 代码。 */
const ISSUE_LABELS: Readonly<Record<string, string>> = {
  sidecar_nfo_ambiguous: '目录级 NFO 归属不明确',
  candidate_ambiguous: '线上候选不确定',
  parsed_facts_review_hint: '解析结果需要核对',
  parsed_facts_need_review: '解析结果需要人工复核',
  generic_container_title: '目录名过于笼统',
  work_identity_missing: '缺少作品身份线索',
  episode_number_unresolved: '集号无法确定',
  absolute_episode_conflict: '绝对集号冲突',
  ambiguous_work_identity: '作品身份存在歧义',
  independent_title_candidate: '异名无编号文件',
  media_type_unresolved: '类型无法确定',
  manual_override_continuity_conflict: '人工修正与文件连续性冲突',
  work_owner_ambiguous: '既有作品归属不明确',
  cross_source_identity_ambiguous: '跨来源身份不明确',
};

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
    interrupted: record.interrupted === true,
    evidenceCount: num(record.evidence_count),
    parsedCount: num(record.parsed_count),
    directoriesCompleted: num(record.directories_completed),
    directoriesPending: num(record.directories_pending),
    heartbeatAt: str(record.heartbeat_at),
    // 后端从不返回 `can_cancel`（`backend/app/media_v4/sources/durable_scan.py:424-450`）；
    // 这里按状态派生，界面必须知道这是本端推断而不是后端事实。
    canCancel: record.can_cancel === true || status === 'running' || status === 'queued' || status === 'paused',
    progress: typeof record.progress === 'number' ? record.progress : null,
    mapping: toScanPathValidation(record.path_validation),
  };
}

/** `path_validation.choices[]` 的元素（`backend/app/api/media_v4.py:712` 只外发 6 个字段）。 */
function toScanMappingChoice(value: unknown): ScanMappingChoice | null {
  const record = asRecord(value);
  const id = str(record.id);
  if (id === '') {
    return null;
  }
  return {
    id,
    root: str(record.root),
    mappingScope: str(record.mapping_scope),
    pathSamples: toStrArray(record.path_samples),
    selectedCount: num(record.selected_count),
    skippedCount: num(record.skipped_count),
  };
}

/** `path_validation` 只做形状换算；缺少 `choices` 时返回空数组，不伪造候选。 */
function toScanPathValidation(value: unknown): ScanPathValidation | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = asRecord(value);
  const choices = Array.isArray(record.choices)
    ? record.choices.map(toScanMappingChoice).filter((entry): entry is ScanMappingChoice => entry !== null)
    : [];
  if (choices.length === 0 && Object.keys(record).length === 0) {
    return null;
  }
  return {
    ok: record.ok === true,
    root: str(record.root),
    reason: str(record.reason),
    state: str(record.state),
    mappingMode: str(record.mapping_mode),
    mappingScope: str(record.mapping_scope),
    selectedCount: num(record.selected_count),
    skippedCount: num(record.skipped_count),
    pathSamples: toStrArray(record.path_samples),
    requiresConfirmation: record.requires_confirmation === true,
    choices,
  };
}

function scanToTaskEntry(scan: ScanProgress): TaskEntry {
  // durable scan 的真实状态集合（queued/running/cancelling/paused/completed/failed/cancelled）；
  // 未登记的值按 unknown 如实展示，绝不默认成"已完成"。
  const statusByScan: Readonly<Record<string, TaskStatus>> = {
    queued: 'queued',
    running: 'running',
    cancelling: 'cancelling',
    paused: 'paused',
    completed: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  const status: TaskStatus = statusByScan[scan.status] ?? 'unknown';
  const active = status === 'queued' || status === 'running' || status === 'cancelling' || status === 'paused';
  return {
    id: scan.scanId,
    type: 'source_scan',
    title: scan.stageLabel || '来源扫描',
    sourceId: scan.rootId,
    sourceName: scan.rootId,
    status,
    rawStatus: scan.status,
    // 后端只给出已处理/总数量级，没有连续百分比时保持 0/1，不拟合曲线。
    progress: status === 'succeeded' ? 1 : 0,
    message: scan.error || scan.stageLabel,
    createdAt: '',
    startedAt: '',
    finishedAt: '',
    error: scan.error,
    scope: scan.rootId,
    cancellable: active,
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
  // 后端状态：pending（等待执行）/ running / succeeded / failed / cancelled（tasks_v4.py:21）。
  // 未登记的值归到 unknown 并保留原文，既不当作成功，也不隐藏。
  const rawStatus = record.status;
  const status: TaskStatus = KNOWN_TASK_STATUSES.has(rawStatus)
    ? (rawStatus as TaskStatus)
    : 'unknown';
  const active = status === 'pending' || status === 'running' || status === 'cancelling';
  return {
    id: record.task_id,
    type: record.task_type,
    title: record.task_type,
    sourceId: record.source,
    sourceName: record.source,
    status,
    rawStatus,
    progress: record.progress > 0 ? 1 : 0,
    message: record.message,
    createdAt: record.created_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    error: record.error,
    scope: record.result?.revision_id ?? '',
    cancellable: active && !record.cancel_requested && status !== 'cancelling',
  };
}

function toStrArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Bangumi 收藏状态 → 后端 `SUBJECT_COLLECTION_*` 数值（`backend/app/integrations/bangumi.py:25-29`）。 */
const BANGUMI_COLLECTION_TYPES: Readonly<Record<BangumiCollectionState, number>> = {
  wish: 1,
  collect: 2,
  doing: 3,
  on_hold: 4,
  dropped: 5,
};

/** 会话响应的账号名只来自 `user.nickname` / `user.username`，`/api/config` 不提供账号名。 */
function toBangumiSession(payload: unknown): BangumiAccountSession {
  const record = asRecord(payload);
  const rawState = str(record.credential_state);
  const credentialState: BangumiAccountSession['credentialState'] =
    rawState === 'found' || rawState === 'unavailable' ? rawState : 'not_found';
  const user = asRecord(record.user);
  return {
    credentialState,
    authStatus: str(record.auth_status, 'unknown') || 'unknown',
    connectivity: str(record.connectivity, 'unknown') || 'unknown',
    status: str(record.status),
    nickname: str(user.nickname),
    username: str(user.username),
    avatarUrl: str(user.avatar),
    lastVerifiedAt: str(record.last_verified_at),
    lastErrorCode: str(record.last_error_code),
    lastErrorMessage: str(record.last_error_message),
  };
}

/** `Bangumi` 条目的年份只能从上游 `date`（`YYYY-MM-DD`）前缀取得，没有独立 year 字段。 */
function parseBangumiYear(date: string): number {
  const match = /^(\d{4})/.exec(date.trim());
  return match ? Number(match[1]) : 0;
}

/** 匹配响应 → 视图模型；`subject_id` 缺失即不是有效匹配。 */
function toBangumiMatchState(payload: unknown): BangumiMatchState | null {
  const record = asRecord(payload);
  const subjectId = record.subject_id;
  if (typeof subjectId !== 'number' || !Number.isFinite(subjectId)) {
    return null;
  }
  return {
    subjectId: String(subjectId),
    title: str(record.subject_name_cn) || str(record.subject_name),
    seasonNumber: typeof record.season_number === 'number' ? record.season_number : null,
    mappedEpisodeCount: Object.keys(asRecord(record.episode_map)).length,
    updatedAt: str(record.updated_at),
  };
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
  // 路径多解：只有用户显式选择后才提交映射，禁止在前端静默取第一个候选。
  if (request.treeMappingChoice) {
    body.tree_mapping_choice = request.treeMappingChoice;
  }
  if (request.treeMappingMode) {
    body.tree_mapping_mode = request.treeMappingMode;
  }
  if (request.treeMappingScope) {
    body.tree_mapping_scope = request.treeMappingScope;
  }
  if (request.treeVerifyPaths !== undefined) {
    body.tree_verify_paths = request.treeVerifyPaths;
  }
  if (request.openlistMappingChoice) {
    body.openlist_mapping_choice = request.openlistMappingChoice;
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
      // 后端 ResolutionIssue 的公开字段是 code / evidence_id / message / severity
      // （`backend/app/media_v4/domain/models.py:146-152`）；severity 现行取值是 warning，
      // 阻断与否只按后端真实值判定，不做自定义映射。
      const code = str(record.code);
      const blocking = str(record.severity) === 'blocking';
      const location = str(record.relative_path) || str(record.file_name);
      return {
        id: str(record.evidence_id) || code,
        severity: blocking ? 'blocking' : 'notice',
        title: ISSUE_LABELS[code] ?? code,
        detail: [str(record.message), location].filter((part) => part.length > 0).join(' · '),
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
      // 备份里存在、但当前版本不恢复的字段：如实展示，不假装恢复成功。
      ignoredFields: toStrArray(config.ignored_fields),
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

/**
 * 公开配置字典 → 设置视图模型。
 * `/api/config` 与 `/api/config/setup/*` 返回同一份 `to_public_dict()`，
 * 这里只读取后端真实存在的字段：读不到的键保持默认，不假装"已配置"。
 */
function toSettingsSnapshot(record: Record<string, unknown>): SettingsSnapshot {
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
  return {
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
      // 后端只公开脱敏后的"是否已配置"布尔值，不返回令牌本身。
      tmdbConfigured: record.tmdb_configured === true,
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
      // `/api/config` 只返回 `bangumi_configured`；账号显示名不在这里，
      // 它只来自 `GET /api/integrations/bangumi/session` 的 `user.nickname` / `user.username`。
      configured: record.bangumi_configured === true,
      syncEnabled: false,
    },
    backup: {
      autoDailyEnabled: record.backup_auto_daily_enabled === true,
      autoDailyTime: str(record.backup_auto_daily_time, '03:00'),
    },
  };
}

/** 视图字段 → `/api/config/setup/complete` 的请求字段（后端 `SetupCompleteRequest`）。 */
const SETUP_COMPLETE_FIELDS: ReadonlyArray<readonly [keyof SetupCompletionInput, string]> = [
  ['localRoot', 'local_root'],
  ['pan115Root', 'pan115_root'],
  ['baiduRoot', 'baidu_root'],
  ['directoryTreeDir', 'directory_tree_dir'],
  ['playerMode', 'player_mode'],
  ['externalMpvPath', 'external_mpv_path'],
  ['mpvPath', 'mpv_path'],
];

/**
 * 完成引导的请求体：后端用 `exclude_unset` 合并已保存配置，
 * 因此未填写的目录必须整键省略——传空字符串会被当成"清空该来源"。
 */
function setupCompleteBody(input: SetupCompletionInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [viewKey, configKey] of SETUP_COMPLETE_FIELDS) {
    const value = input[viewKey];
    if (viewKey === 'playerMode') {
      if (value === 'internal' || value === 'external') {
        body[configKey] = value;
      }
      continue;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      body[configKey] = value.trim();
    }
  }
  return body;
}

export function createHttpMediaService(options: RealServiceOptions = {}): MediaService {
  const transport = options.transport ?? createBrowserTransport();

  let settingsCache: SettingsSnapshot | null = null;
  const overrideCache = new Map<string, WorkOverride>();
  /**
   * 本次搜索的条目名：后端 `POST /matches` 会保存 `subject_name` / `subject_name_cn`，
   * 而绑定调用只传条目 ID；这里复用同一次搜索的结果，避免显示名丢失。
   */
  const bangumiSubjectNames = new Map<string, { readonly title: string; readonly originalName: string }>();

  async function loadBangumiSession(): Promise<BangumiAccountSession> {
    return toBangumiSession(unwrapOrThrow(await transport.call<unknown>('bangumi.session', {})));
  }

  async function library(
    signal?: AbortSignal,
  ): Promise<{ works: readonly WorkCard[]; progress: ReadonlyMap<string, ProgressSnapshot> }> {
    const payload = unwrapOrThrow(
      await transport.call<unknown>('library.list', signal ? { signal } : {}),
    );
    const works = parseCards(payload);
    const progress = new Map<string, ProgressSnapshot>();
    // 后端把 limit 夹在 1..200（`backend/app/api/playback_v4.py:147`）：
    // 传更大的值只会被静默截断，这里按后端上界取最大页，避免大库缺进度。
    const history = await transport.call<unknown>('playback.history', {
      query: { limit: PLAYBACK_HISTORY_LIMIT },
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
    // `/api/config` 与 `/api/config/setup/*` 返回同一份 `to_public_dict()`，
    // 因此完成引导后可以直接用响应更新视图模型，不需要再发一次读取。
    settingsCache = toSettingsSnapshot(asRecord(unwrapOrThrow(await transport.call<unknown>('config.get', {}))));
    return settingsCache;
  }

  /** 保存完成/推迟引导的响应状态，同时也让后续读取命中最新事实。 */
  function applySettingsPayload(payload: unknown): SettingsSnapshot {
    settingsCache = toSettingsSnapshot(asRecord(payload));
    return settingsCache;
  }

  function invalidateSettings(): void {
    settingsCache = null;
  }

  return {
    serviceMode: 'real',

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
      // 写失败必须如实抛出：未检查结果的实现会把失败当成"已收藏"。
      const outcome = await transport.call<unknown>('library.watchStatus', {
        params: { workId },
        body: { favorite },
      });
      if (!outcome.ok) {
        throw new Error(describe(outcome.error));
      }
      return refreshWork(workId);
    },

    async setWatchStatus(workId, status): Promise<WorkSummary> {
      const outcome = await transport.call<unknown>('library.watchStatus', {
        params: { workId },
        body: { status },
      });
      if (!outcome.ok) {
        throw new Error(describe(outcome.error));
      }
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

    /* ------------------------- 首次使用引导（独立于普通配置写入） ------------------------- */

    /**
     * 完成引导：由后端校验播放器与至少一个可访问来源后才写入 `setup_completed`。
     * 校验失败（例如没有可访问来源、内置 MPV 未就绪）如实抛出后端原因，
     * 界面保留输入并显示错误，不把失败当成已完成。
     */
    async completeSetup(input: SetupCompletionInput): Promise<SettingsSnapshot> {
      const outcome = await transport.call<unknown>('config.setupComplete', {
        body: setupCompleteBody(input),
      });
      if (!outcome.ok) {
        throw new Error(describe(outcome.error));
      }
      return applySettingsPayload(outcome.data);
    },

    /** 「稍后设置」只记录推迟，不校验也不标记完成。 */
    async deferSetup(): Promise<SettingsSnapshot> {
      const outcome = await transport.call<unknown>('config.setupDefer', {});
      if (!outcome.ok) {
        throw new Error(describe(outcome.error));
      }
      return applySettingsPayload(outcome.data);
    },

    /** TMDB 令牌先经后端验证再写入；失败抛出真实原因，输入不落任何本地存储。 */
    async saveTmdbCredential(token: string): Promise<SettingsSnapshot> {
      const value = token.trim();
      if (value.length === 0) {
        throw new ServiceCapabilityError('请填写 TMDB API 读取访问令牌；空值不会保存。');
      }
      const outcome = await transport.call<unknown>('config.setupTmdbCredential', {
        body: { tmdb_bearer_token: value },
      });
      if (!outcome.ok) {
        throw new Error(describe(outcome.error));
      }
      return applySettingsPayload(outcome.data);
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

    async resetManualArtwork(workId, role = 'poster'): Promise<WorkOverride> {
      // 恢复按角色逐个处理（`backend/app/api/media_v4.py:2313-2332`）；
      // 固定传 poster 会把 fanart / clearlogo 的恢复打到错误角色上。
      unwrapOrThrow(
        await transport.call<unknown>('work.artwork.restore', {
          params: { workId, kind: role },
        }),
      );
      return {};
    },

    /* ------------------------- 作品详情真实操作 ------------------------- */

    async scrapeWork(workId): Promise<WorkScrapeResult> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('work.scrape', { params: { workId } })),
      );
      return { jobId: str(payload.job_id), status: str(payload.status) };
    },

    async getWorkFolder(workId): Promise<WorkFolderInfo> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('work.folder', { params: { workId } })),
      );
      return { folder: str(payload.folder), exists: payload.exists === true };
    },

    async openWorkFolder(input: WorkFolderOpenInput): Promise<WorkFolderOpenResult> {
      // 只提交身份 ID：后端自己解析当前确认 Asset 的本地路径并执行真实打开动作
      // （`backend/app/api/system.py:40-105`），前端不传、不猜任何文件系统路径。
      const body: Record<string, unknown> = { work_id: input.workId };
      if (input.episodeId) {
        body.episode_id = input.episodeId;
      }
      if (input.assetId) {
        body.asset_id = input.assetId;
      }
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('system.openFolder', { body })),
      );
      return {
        opened: payload.opened === true,
        exists: payload.exists === true,
        folderPath: str(payload.folder_path),
      };
    },

    async previewWorkDelete(workId): Promise<WorkDeletePreview> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('work.deletePreview', { params: { workId } })),
      );
      return {
        previewId: str(payload.preview_id),
        digest: str(payload.digest),
        revisionId: str(payload.revision_id),
        artifactCount: num(payload.artifact_count),
        playbackCount: num(payload.playback_count),
        trackingCount: num(payload.tracking_count),
        blocked: payload.blocked === true,
        blockedJobCount: num(payload.blocked_job_count),
        blockedJobTypes: toStrArray(payload.blocked_job_types),
      };
    },

    async confirmWorkDelete(workId: string, input: WorkDeleteConfirmInput): Promise<WorkDeleteResult> {
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('work.deleteConfirm', {
            params: { workId },
            body: { preview_id: input.previewId, digest: input.digest },
          }),
        ),
      );
      const statuses = Array.isArray(payload.artifact_results)
        ? payload.artifact_results.map((entry) => str(asRecord(entry).status))
        : [];
      return {
        status: str(payload.status),
        projectionStatus: str(payload.projection_status),
        removedArtifacts: statuses.filter((entry) => entry === 'removed').length,
        blockedArtifacts: statuses.filter((entry) => entry === 'blocked').length,
        failedArtifacts: statuses.filter((entry) => entry === 'failed').length,
      };
    },

    /* ------------------------- Bangumi 账号与同步 ------------------------- */

    bangumiSession: loadBangumiSession,
    bangumiVerify: async (): Promise<BangumiAccountSession> =>
      toBangumiSession(unwrapOrThrow(await transport.call<unknown>('bangumi.sessionVerify', {}))),

    async bangumiSignIn(accessToken: string): Promise<BangumiAccountSession> {
      const token = accessToken.trim();
      if (token.length === 0) {
        throw new ServiceCapabilityError('请填写 Bangumi 访问令牌；空值不会保存。');
      }
      // 令牌只出现在这一条请求体里；后端先验证再落 Windows 凭据存储，
      // 前端不写 VITE_*、URL、localStorage 或日志，也不回显令牌。
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('bangumi.token.set', { body: { access_token: token } })),
      );
      if (payload.config !== undefined && payload.config !== null) {
        settingsCache = toSettingsSnapshot(asRecord(payload.config));
      }
      return loadBangumiSession();
    },

    async bangumiSignOut(): Promise<void> {
      unwrapOrThrow(await transport.call<unknown>('bangumi.token.clear', {}));
      invalidateSettings();
    },

    async bangumiMatch(workId: string): Promise<BangumiMatchState | null> {
      const outcome = await transport.call<unknown>('bangumi.match.get', { params: { workId } });
      if (!outcome.ok) {
        // 后端用 404 + 「尚未确认 Bangumi 匹配」表达"未匹配"，这不是故障。
        if (outcome.error.status === 404) {
          return null;
        }
        throw new Error(describe(outcome.error));
      }
      return toBangumiMatchState(outcome.data);
    },

    async bangumiSearch(query: string): Promise<readonly BangumiSubject[]> {
      const keyword = query.trim();
      if (keyword.length === 0) {
        return [];
      }
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('bangumi.search', {
            body: { keyword, limit: 20 },
          }),
        ),
      );
      const items = Array.isArray(payload.data) ? payload.data : [];
      const subjects: BangumiSubject[] = [];
      for (const entry of items) {
        const record = asRecord(entry);
        const rawId = record.id;
        if (typeof rawId !== 'number' || !Number.isFinite(rawId)) {
          continue;
        }
        const id = String(rawId);
        const title = str(record.name_cn) || str(record.name);
        // 后端 `POST /matches` 会保存 subject_name / subject_name_cn：
        // 这里记住本次搜索的条目名，绑定成功后才不会丢掉显示名。
        bangumiSubjectNames.set(id, { title, originalName: str(record.name) });
        subjects.push({
          id,
          title,
          year: parseBangumiYear(str(record.date)),
          episodes: num(record.eps) || num(record.total_episodes),
        });
      }
      return subjects;
    },

    async bangumiBind(workId: string, subjectId: string): Promise<void> {
      const numeric = Number(subjectId);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new Error('Bangumi 条目 ID 无效，请重新搜索后选择条目。');
      }
      const known = bangumiSubjectNames.get(subjectId);
      const body: Record<string, unknown> = { subject_id: numeric };
      if (known) {
        body.subject_name = known.originalName;
        body.subject_name_cn = known.title;
      }
      // 后端在远端剧集查询失败时仍保存匹配并返回 200（`backend/app/api/bangumi.py:542-545`），
      // 因此这里不再断言"剧集映射已建立"；界面以 bangumiMatch 的真实计数为准。
      unwrapOrThrow(
        await transport.call<unknown>('bangumi.match.set', { params: { workId }, body }),
      );
    },

    async bangumiUnbind(workId: string): Promise<void> {
      unwrapOrThrow(await transport.call<unknown>('bangumi.match.remove', { params: { workId } }));
    },

    async bangumiSync(workId: string): Promise<BangumiSyncResult> {
      // 后端 `ProgressSyncRequest` 是必填 body（`extra="forbid"`，只有 season_number），
      // 而传输层只在 body 非空时才发送，所以这里显式带上 season_number（未知为 null）。
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('bangumi.progress.sync', {
            params: { workId },
            body: { season_number: null },
          }),
        ),
      );
      return {
        status: str(payload.status),
        subjectId: String(num(payload.subject_id)),
        remoteDoneBefore: num(payload.remote_done_before),
        localDoneBefore: num(payload.local_done_before),
        pulled: num(payload.pulled),
        pushed: num(payload.pushed),
      };
    },

    async bangumiSetCollection(workId: string, state: BangumiCollectionState): Promise<void> {
      const type = BANGUMI_COLLECTION_TYPES[state];
      unwrapOrThrow(
        await transport.call<unknown>('bangumi.collection.set', {
          params: { workId },
          body: { type },
        }),
      );
    },

    async resetDemoData(): Promise<void> {
      throw new ServiceCapabilityError('真实后端不提供演示数据重置。');
    },

    /* ------------------------- 搜索轻量索引 ------------------------- */

    async searchLibrary(query, limit = 30): Promise<LibrarySearchResult> {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return { hits: [], truncated: false };
      }
      const payload = asRecord(
        unwrapOrThrow(
          await transport.call<unknown>('library.search', {
            query: { q: trimmed, limit: Math.min(100, Math.max(1, Math.round(limit))) },
          }),
        ),
      );
      const items = Array.isArray(payload.items) ? payload.items : [];
      return {
        hits: items.map((entry) => {
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
        }),
        // 后端命中数超过 limit 时为 true（`backend/app/api/library_v4.py:336,385`）。
        truncated: payload.truncated === true,
      };
    },

    /* ------------------------- 来源扫描（持久、可恢复） ------------------------- */

    async startSourceScan(request): Promise<ScanProgress> {
      const payload = asRecord(
        unwrapOrThrow(await transport.call<unknown>('sources.durableScan.start', { body: scanBody(request) })),
      );
      const progress = toScanProgress(payload);
      // 路径多解：后端 200 返回 `status='mapping_required'` + 空 `scan_id` +
      // `path_validation.choices`（`backend/app/api/media_v4.py:541-549`），
      // 这次调用**没有创建任何扫描**。调用方必须展示候选并等用户选择，
      // 不能当成"已开始扫描"。
      if (progress.status === 'mapping_required' && (progress.mapping?.choices.length ?? 0) === 0) {
        throw new Error('后端要求选择目录映射，但没有返回可选候选；请核对 TXT 导出范围后重试。');
      }
      return progress;
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
    // Bangumi 令牌**不**走普通 PATCH：`PATCH /api/config` 既不验证令牌也不写账户快照，
    // 昵称会永远为空。登录必须走 `POST /api/integrations/bangumi/token`（见 bangumiSignIn）。
    bangumi: {},
    backup: {
      autoDailyEnabled: 'backup_auto_daily_enabled',
      autoDailyTime: 'backup_auto_daily_time',
    },
  };
  if (section === 'bangumi') {
    throw new ServiceCapabilityError(
      'Bangumi 登录必须经后端验证端点保存令牌，普通配置写入不会验证也不会保存账号资料。',
    );
  }
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
