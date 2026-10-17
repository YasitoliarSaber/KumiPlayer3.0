/**
 * 具名操作白名单（B §5.1，ADR-04）。
 *
 * 这是 Renderer 能触达后端的**全部**能力面。Main 只按本表映射到既有 Python HTTP
 * 端点；Renderer 不能提供 URL、method、channel，也不能执行任意命令。
 * 新增能力必须在此登记，并同时补契约测试。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpOperationSpec {
  readonly transport: 'http';
  readonly kind: 'read' | 'mutation';
  readonly method: HttpMethod;
  /** 用 `:name` 表示路径参数；参数值不得包含分隔符。 */
  readonly path: string;
  /** 允许转发的查询参数名；未登记的参数一律拒绝。 */
  readonly query: readonly string[];
  /** 允许转发的 JSON 请求体字段；未登记的字段一律拒绝。 */
  readonly body: readonly string[];
  /** 该操作接受 multipart 上传（只有浏览器传输实现会用到）。 */
  readonly upload?: boolean;
  /** 该操作返回二进制产物（备份导出等）。 */
  readonly download?: boolean;
  readonly timeoutMs: number;
}

export interface LocalCommandSpec {
  readonly transport: 'local';
  readonly kind: 'command' | 'read';
  readonly timeoutMs: number;
}

export type OperationSpec = HttpOperationSpec | LocalCommandSpec;

/** 读取类操作的默认期限；确认、播放等 mutation 由调用方显式给出更长期限。 */
const READ_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 60_000;

export const OPERATION_SPECS = {
  /** 桌面自身状态：后端代次、就绪状态、保护模式。不经 HTTP。 */
  'desktop.status': { transport: 'local', kind: 'read', timeoutMs: 5_000 },
  /** 重启本地后端；串行化，不取消已受理任务。 */
  'desktop.restartBackend': { transport: 'local', kind: 'command', timeoutMs: 45_000 },
  /** 打开诊断日志目录。 */
  'desktop.openLogs': { transport: 'local', kind: 'command', timeoutMs: 5_000 },
  /** 收集脱敏诊断快照（不含 Token、凭据与私人路径）。 */
  'desktop.diagnostics': { transport: 'local', kind: 'read', timeoutMs: 10_000 },

  /** 公开健康检查：只用于身份匹配，不携带令牌，也不代表业务就绪。 */
  'health.get': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/health',
    query: [],
    body: [],
    timeoutMs: 5_000,
  },
  'config.get': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/config',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'library.list': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library',
    query: ['source', 'work_ids'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'library.changes': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library/changes',
    query: ['after', 'limit'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'library.cards': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library/cards',
    query: ['work_ids'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'work.detail': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library/works/:workId',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'tasks.list': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/tasks',
    query: ['source', 'task_type', 'type_prefix', 'limit'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'tasks.get': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/tasks/:taskId',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'tasks.cancel': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/tasks/:taskId/cancel',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'playback.status': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/playback/status',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },

  /* ------------------------- 配置写入 ------------------------- */

  /**
   * `PATCH /api/config` 的后端请求模型是 `ConfigPatch`，字段由它固定。
   * 这里逐一登记，未登记的字段（例如任意凭据键）不会进入传输层；
   * 凭据字段传空字符串表示"不修改"，与后端语义一致。
   */
  'config.update': {
    transport: 'http',
    kind: 'mutation',
    method: 'PATCH',
    path: '/api/config',
    query: [],
    body: [
      'mpv_path',
      'player_mode',
      'external_mpv_path',
      'server_port',
      'mirror_dir',
      'pan115_root',
      'baidu_root',
      'quark_root',
      'local_root',
      'local_roots',
      'directory_tree_dir',
      'openlist_server_url',
      'openlist_remote_root',
      'openlist_mount_root',
      'openlist_username',
      'openlist_password',
      'openlist_cache_ttl_minutes',
      'openlist_prefetch_limit',
      'tmdb_bearer_token',
      'tmdb_language',
      'tmdb_certification_regions',
      'anilist_enabled',
      'anilist_rate_limit',
      'anilist_timeout',
      'alias_web_recovery_enabled',
      'tmdb_rate_limit',
      'tmdb_max_retries',
      'tmdb_timeout',
      'bangumi_access_token',
      'bangumi_user_agent',
      'auto_play_next_episode',
      'mpv_anime4k_mode',
      'mpv_anime4k_quality',
      'series_card_image_mode',
      'poster_size',
      'ongoing_update_on_startup',
      'ongoing_update_interval_minutes',
      'ongoing_update_schedule_mode',
      'ongoing_update_time',
      'ongoing_update_weekday',
      'artwork_storage_mode',
      'proxy_url',
      'bangumi_alias_enabled',
      'completed_threshold_percent',
      'source_scan_schedules',
      'backup_auto_daily_enabled',
      'backup_auto_daily_time',
      'heartbeat_enabled',
    ],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },

  /**
   * 首次引导不是普通配置字段：后端用独立端点分别记录"稍后设置"与"验证后完成"，
   * 避免把未验证的播放器/来源写成已完成。这里只登记既有端点，不改后端校验。
   */
  'config.setupDefer': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/config/setup/defer',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'config.setupComplete': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/config/setup/complete',
    query: [],
    body: [
      'local_root',
      'pan115_root',
      'baidu_root',
      'directory_tree_dir',
      'player_mode',
      'external_mpv_path',
      'mpv_path',
    ],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  /** TMDB 凭据走验证端点：验证失败不写入，凭据值只经此请求体，不落本地配置。 */
  'config.setupTmdbCredential': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/config/setup/credentials/tmdb',
    query: [],
    body: ['tmdb_bearer_token'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },

  /* ------------------------- 媒体库写入 ------------------------- */

  'library.watchStatus': {
    transport: 'http',
    kind: 'mutation',
    method: 'PATCH',
    path: '/api/library/watch-status/:workId',
    query: [],
    body: ['status', 'note', 'favorite'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'library.rescan': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/library/rescan',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },

  /* ------------------------- 任务 ------------------------- */

  'tasks.retry': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/tasks/:taskId/retry',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },

  /* ------------------------- 播放 ------------------------- */

  'playback.play': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/playback/play',
    query: [],
    body: ['work_id', 'episode_id', 'asset_id'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'playback.stop': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/playback/stop',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'playback.history': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/playback/history',
    query: ['limit', 'work_id'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'playback.progress': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/playback/progress',
    query: [],
    body: ['work_id', 'episode_id', 'asset_id', 'position', 'duration', 'completed'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },

  /* ------------------------- 来源与导入 ------------------------- */

  'sources.libraries': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/v4/sources/libraries',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'sources.drafts': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/v4/sources/drafts',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'sources.scan': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/sources/scan',
    query: [],
    body: [
      'content_scope',
      'source',
      'root_path',
      'tree_file',
      'provider',
      'source_root',
      'tree_mapping_choice',
      'tree_verify_paths',
      'scan_mode',
    ],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'sources.durableScan.start': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/sources/scans',
    query: [],
    body: [
      'openlist_mapping_choice',
      'content_scope',
      'target_root_id',
      'connection_id',
      'source',
      'root_path',
      'tree_file',
      'provider',
      'source_root',
      'tree_mapping_choice',
      'tree_verify_paths',
      'scan_mode',
      'revision_id',
      'source_display_name',
      'resume_scan_id',
    ],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'sources.durableScan.get': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/v4/sources/scans/:scanId',
    query: ['include_entries'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'sources.durableScan.cancel': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/sources/scans/:scanId/cancel',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'imports.preview': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/imports/preview',
    query: [],
    body: [
      'revision_id',
      'root_id',
      'scan_id',
      'entries',
      'allow_empty',
      'source_display_name',
      'source_locator',
      'playback_locator',
      'source_route_id',
      'source_mode',
    ],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'imports.get': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/v4/imports/:revisionId',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'imports.confirm': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/imports/:revisionId/confirm',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'imports.cancel': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/imports/:revisionId/cancel',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'imports.evidence': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/v4/imports/:revisionId/evidence',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'imports.overrideEvidence': {
    transport: 'http',
    kind: 'mutation',
    method: 'PATCH',
    path: '/api/v4/imports/:revisionId/evidence/:evidenceId',
    query: [],
    body: ['changes'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },

  /* ------------------------- 作品维护 ------------------------- */

  'work.title.set': {
    transport: 'http',
    kind: 'mutation',
    method: 'PATCH',
    path: '/api/v4/works/:workId/title',
    query: [],
    body: ['title'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'work.title.restore': {
    transport: 'http',
    kind: 'mutation',
    method: 'DELETE',
    path: '/api/v4/works/:workId/title',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'work.artwork.set': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/works/:workId/artwork',
    query: [],
    body: ['kind', 'data_base64'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'work.artwork.restore': {
    transport: 'http',
    kind: 'mutation',
    method: 'DELETE',
    path: '/api/v4/works/:workId/artwork/:kind',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'work.scrape': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/works/:workId/scrape',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'work.deletePreview': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/works/:workId/delete-preview',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'work.deleteConfirm': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/works/:workId/delete-confirm',
    query: [],
    body: ['preview_id', 'digest'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'metadata.search': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/metadata/search',
    query: [],
    body: ['work_id', 'query', 'media_type', 'year'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'metadata.confirm': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/metadata/confirm',
    query: [],
    body: ['work_id', 'candidate_id', 'scope', 'season_number'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'metadata.retry': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/metadata/retry',
    query: [],
    body: ['work_id'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'metadata.artifactsRetry': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/metadata/artifacts/retry',
    query: [],
    body: ['work_id'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },

  /* ------------------------- 图片缓存维护 ------------------------- */

  'artwork.cache.preview': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/artwork-cache/preview',
    query: [],
    body: ['retention_days'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'artwork.cache.confirm': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/v4/artwork-cache/confirm',
    query: [],
    body: ['preview_id', 'digest', 'confirm'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },

  /* ------------------------- 全局搜索轻量索引 ------------------------- */

  'library.search': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/library/search',
    query: ['q', 'limit'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },

  /* ------------------------- 来源扫描调度 ------------------------- */

  'sources.scanSchedules': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/v4/sources/scan-schedules',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'sources.scanSchedule.set': {
    transport: 'http',
    kind: 'mutation',
    method: 'PUT',
    path: '/api/v4/sources/:rootId/scan-schedule',
    query: [],
    body: ['enabled', 'interval_minutes'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  /** OpenList 连接测试：不传密码时后端使用已保存凭据；响应不返回任何凭据。 */
  'openlist.test': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/openlist/test-connection',
    query: [],
    body: ['server_url', 'remote_root', 'username', 'password', 'allow_insecure_http', 'connection_id'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'jobs.list': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/v4/jobs',
    query: ['revision_id', 'status', 'limit'],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },

  /* ------------------------- 备份与恢复（.kumibak） ------------------------- */

  'backup.export': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/backup/export',
    query: [],
    body: [],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'backup.files': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/backup/files',
    query: [],
    body: [],
    timeoutMs: READ_TIMEOUT_MS,
  },
  'backup.download': {
    transport: 'http',
    kind: 'read',
    method: 'GET',
    path: '/api/backup/files/:fileId/download',
    query: [],
    body: [],
    download: true,
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  /** 恢复预览：multipart 上传用户选择的 .kumibak；只读校验，不修改数据。 */
  'backup.restorePreview': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/backup/restore/preview',
    query: [],
    body: [],
    upload: true,
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
  'backup.restoreConfirm': {
    transport: 'http',
    kind: 'mutation',
    method: 'POST',
    path: '/api/backup/restore/confirm',
    query: [],
    body: ['preview_id', 'digest'],
    timeoutMs: MUTATION_TIMEOUT_MS,
  },
} as const satisfies Record<string, OperationSpec>;

export type OperationId = keyof typeof OPERATION_SPECS;

export interface OperationRequest {
  readonly operation: OperationId;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: Readonly<Record<string, unknown>>;
  /** Renderer 生成的请求标识，用于取消与旧结果隔离。 */
  readonly requestId: string;
}

const PATH_PARAM_PATTERN = /^:[A-Za-z][A-Za-z0-9]*$/;
const PARAM_VALUE_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface ResolvedHttpTarget {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
}

export type TargetResolution =
  | { readonly ok: true; readonly target: ResolvedHttpTarget }
  | { readonly ok: false; readonly reason: string };

/**
 * 把已登记的具名操作解析成固定 HTTP 目标。
 * 任何未登记的操作、参数或取值都会在这里被拒绝，不进入 HTTP 层。
 */
export function resolveHttpTarget(
  request: OperationRequest,
): TargetResolution {
  const spec: OperationSpec | undefined = OPERATION_SPECS[request.operation];
  if (!spec) {
    return { ok: false, reason: `未登记的操作：${String(request.operation)}` };
  }
  if (spec.transport !== 'http') {
    return { ok: false, reason: `${request.operation} 不是 HTTP 操作` };
  }

  const params = request.params ?? {};
  const segments = spec.path.split('/').map((segment) => {
    if (!PATH_PARAM_PATTERN.test(segment)) {
      return segment;
    }
    const name = segment.slice(1);
    const value = params[name];
    return value ?? '';
  });
  const missing = spec.path
    .split('/')
    .filter((segment) => PATH_PARAM_PATTERN.test(segment))
    .map((segment) => segment.slice(1))
    .filter((name) => !PARAM_VALUE_PATTERN.test(params[name] ?? ''));
  if (missing.length > 0) {
    return { ok: false, reason: `路径参数非法或缺失：${missing.join(', ')}` };
  }
  const knownParams = new Set(
    spec.path
      .split('/')
      .filter((segment) => PATH_PARAM_PATTERN.test(segment))
      .map((segment) => segment.slice(1)),
  );
  for (const name of Object.keys(params)) {
    if (!knownParams.has(name)) {
      return { ok: false, reason: `未登记的路径参数：${name}` };
    }
  }

  const query: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (!spec.query.includes(name)) {
      return { ok: false, reason: `未登记的查询参数：${name}` };
    }
    const text = String(value);
    if (text.length > 4096) {
      return { ok: false, reason: `查询参数过长：${name}` };
    }
    query.push([name, text]);
  }
  for (const name of Object.keys(request.body ?? {})) {
    if (!spec.body.includes(name)) {
      return { ok: false, reason: `未登记的请求字段：${name}` };
    }
  }
  if (spec.method === 'GET' && request.body && Object.keys(request.body).length > 0) {
    return { ok: false, reason: `${request.operation} 不接受请求体` };
  }

  return { ok: true, target: { method: spec.method, path: segments.join('/'), query } };
}

export function operationSpec(operation: OperationId): OperationSpec {
  return OPERATION_SPECS[operation];
}

export const OPERATION_IDS = Object.keys(OPERATION_SPECS) as readonly OperationId[];
