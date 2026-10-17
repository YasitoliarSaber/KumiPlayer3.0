/**
 * 后端真实响应 DTO 的 TypeScript 形状 + 运行时校验。
 *
 * 证据来源：`backend/app/api/library_v4.py`、`tasks_v4.py`、`playback_v4.py`、
 * `config.py`、`main.py` 的当前实现，以及本轮在隔离数据目录下实际抓取的响应夹具
 * （见 `tests/desktop/fixtures/`）。FastAPI 路由没有显式 response_model，
 * 所以这里的形状只能由真实响应与源码共同证明，不允许用 any 或断言掩盖缺口。
 */

import {
  arrayOf,
  boolean,
  field,
  isRecord,
  nullable,
  number,
  objectWith,
  recordOf,
  string,
  type Reader,
  type Validation,
  invalid,
  valid,
} from './validate';

/* ------------------------------------------------------------------ */
/* /api/health                                                         */
/* ------------------------------------------------------------------ */

export interface HealthResponse {
  readonly status: string;
  readonly app: string;
  readonly runtime_kind: string;
  readonly runtime_id: string;
  readonly instance_id: string;
}

export const parseHealth: Reader<HealthResponse> = objectWith<HealthResponse>({
  status: field(string()),
  app: field(string()),
  runtime_kind: field(string(), true),
  runtime_id: field(string(), true),
  instance_id: field(string(), true),
});

/* ------------------------------------------------------------------ */
/* /api/library                                                        */
/* ------------------------------------------------------------------ */

export type MediaType = 'tv' | 'movie' | 'unknown';

/**
 * 后端 `_card_payload` 只产出 tv / movie / unknown。
 * 其它取值属于契约破坏，直接判为无效，避免未知值进入展示逻辑。
 */
const parseMediaType: Reader<MediaType> = (value) => {
  if (value === 'tv' || value === 'movie' || value === 'unknown') {
    return valid(value);
  }
  return invalid('期望 tv / movie / unknown');
};

/** 详情子结构当前只验证"是数组"，不伪造未验证的元素形状。 */
const parseUnknownArray: Reader<readonly unknown[]> = (value) =>
  Array.isArray(value) ? valid(value) : invalid('期望数组');

export interface WatchStatus {
  readonly work_id: string;
  readonly status: string;
  readonly note: string;
  readonly favorite: boolean;
  readonly updated_at: string | null;
}

export const parseWatchStatus: Reader<WatchStatus> = objectWith<WatchStatus>({
  work_id: field(string()),
  status: field(string(), true),
  note: field(string(), true),
  favorite: field(boolean(), true),
  updated_at: field(nullable(string()), true),
});

/**
 * 已发布 artwork 的单个角色图片：尺寸表在 `variants` 里，URL 只指向本地派生资源。
 *
 * 事实来源：`backend/app/media_v4/assets/catalog.py:421-426`
 * （`_get_subject_artwork_many` 产出 `{resource_id, content_version, variants, state}`，
 * `variants` 才是"宽度 → 派生 URL"）；消费方见 `backend/app/api/library_v4.py:35,201`、
 * `backend/app/media_v4/projection/collections.py:123`、`backend/app/api/playback_v4.py:186`。
 * 旧契约把角色直接当成"宽度 → URL"，少了图片对象这一层，于是把 `variants`（对象）
 * 当作宽度值去要求字符串，报出 "artwork.clearlogo.variants 期望字符串"。
 */
export interface ArtworkImage {
  readonly resource_id: string;
  readonly content_version: string;
  readonly variants: Readonly<Record<string, string>>;
  readonly state: string;
}

/** 角色（poster / fanart / clearlogo / episode_thumb…）→ 图片对象。 */
export type WorkArtwork = Readonly<Record<string, ArtworkImage>>;

/** 四个字段都由后端固定产出（证据见上方注释），缺一即是契约破坏，不做兜底。 */
const parseArtworkImage: Reader<ArtworkImage> = objectWith<ArtworkImage>({
  resource_id: field(string()),
  content_version: field(string()),
  variants: field(recordOf(string())),
  state: field(string()),
});

export const parseWorkArtwork: Reader<WorkArtwork> = recordOf(parseArtworkImage);

export interface WorkCard {
  readonly work_id: string;
  readonly title: string;
  readonly original_title: string;
  readonly year: number | null;
  readonly title_provenance: string;
  readonly rating: number;
  readonly plot: string;
  readonly genres: readonly string[];
  readonly studios: readonly string[];
  readonly media_type: MediaType;
  readonly show_type: string;
  readonly card_type: string;
  readonly source: string;
  readonly sources: readonly string[];
  readonly episode_count: number;
  readonly asset_count: number;
  readonly season_count: number;
  readonly special_season_count: number;
  readonly metadata_state: string;
  /** 后端发布门槛保证：卡片只读取已发布的本地图片 URL。 */
  readonly poster_path: string;
  readonly fanart_path: string;
  readonly clearlogo_path: string;
  readonly content_scope: string;
  /** 详情投影在没有本地观看记录时返回 null；不能把未观看当成响应损坏。 */
  readonly watch_status: WatchStatus | null;
  readonly artwork: WorkArtwork;
}

const WORK_CARD_SCHEMA = {
  work_id: field(string()),
  title: field(string()),
  original_title: field(string(), true),
  year: field(nullable(number()), true),
  title_provenance: field(string(), true),
  rating: field(number(), true),
  plot: field(string(), true),
  genres: field(arrayOf(string()), true),
  studios: field(arrayOf(string()), true),
  media_type: field(parseMediaType, true),
  show_type: field(string(), true),
  card_type: field(string(), true),
  source: field(string(), true),
  sources: field(arrayOf(string()), true),
  episode_count: field(number(), true),
  asset_count: field(number(), true),
  season_count: field(number(), true),
  special_season_count: field(number(), true),
  metadata_state: field(string(), true),
  poster_path: field(string(), true),
  fanart_path: field(string(), true),
  clearlogo_path: field(string(), true),
  content_scope: field(string(), true),
  watch_status: field(nullable(parseWatchStatus), true),
  artwork: field(parseWorkArtwork, true),
} as const;

export const parseWorkCard: Reader<WorkCard> = objectWith<WorkCard>(WORK_CARD_SCHEMA);

export interface Collection {
  readonly collection_id: string;
  readonly name: string;
  readonly work_ids: readonly string[];
}

export const parseCollection: Reader<Collection> = objectWith<Collection>({
  collection_id: field(string()),
  name: field(string(), true),
  work_ids: field(arrayOf(string()), true),
});

export interface LibrarySummary {
  readonly work_count: number;
  readonly episode_count: number;
}

export interface LibrarySnapshot {
  readonly change_sequence: number;
  readonly works: readonly WorkCard[];
  readonly collections: readonly Collection[];
  readonly summary: LibrarySummary;
  readonly generation_id: string;
  readonly updating: boolean;
  readonly background_active: boolean;
  readonly digest: string;
}

export const parseLibrarySnapshot: Reader<LibrarySnapshot> = objectWith<LibrarySnapshot>({
  change_sequence: field(number()),
  works: field(arrayOf(parseWorkCard)),
  collections: field(arrayOf(parseCollection), true),
  summary: field(
    objectWith<LibrarySummary>({
      work_count: field(number()),
      episode_count: field(number()),
    }),
  ),
  generation_id: field(string(), true),
  updating: field(boolean(), true),
  background_active: field(boolean(), true),
  digest: field(string(), true),
});

export interface WorkDetail extends WorkCard {
  readonly seasons: readonly unknown[];
  readonly episodes: readonly unknown[];
  readonly cast: readonly unknown[];
  readonly related_works: readonly unknown[];
}

/**
 * 详情额外字段当前只校验“是数组”。它们的完整形状在接入详情业务时
 * 再按真实响应补齐，这里不伪造未验证的子结构。
 */
export const parseWorkDetail: Reader<WorkDetail> = objectWith<WorkDetail>({
  ...WORK_CARD_SCHEMA,
  seasons: field(parseUnknownArray, true),
  episodes: field(parseUnknownArray, true),
  cast: field(parseUnknownArray, true),
  related_works: field(parseUnknownArray, true),
});

/* ------------------------------------------------------------------ */
/* /api/library/changes                                                */
/* ------------------------------------------------------------------ */

export interface LibraryChange {
  readonly sequence: number;
  readonly work_id: string;
  /** 取值来自 `progression/changes.record_change`：work_upsert / work_remove / artwork / watch / reset。 */
  readonly kind: LibraryChangeKind;
}

export type LibraryChangeKind =
  | 'work_upsert'
  | 'work_remove'
  | 'artwork'
  | 'watch'
  | 'reset'
  | 'unknown';

export interface LibraryChanges {
  /** 只推进到实际返回的末项；失败时不得用它覆盖有效游标。 */
  readonly next_sequence: number;
  readonly has_more: boolean;
  readonly reset_required: boolean;
  readonly changes: readonly LibraryChange[];
  readonly generation_id: string;
  readonly updating: boolean;
  readonly background_active: boolean;
}

const parseChange: Reader<LibraryChange> = objectWith<LibraryChange>({
  sequence: field(number()),
  work_id: field(string(), true),
  kind: field((value) => {
    const result = string()(value);
    if (!result.ok) {
      return result;
    }
    const known: readonly string[] = ['work_upsert', 'work_remove', 'artwork', 'watch', 'reset'];
    return valid(known.includes(result.value) ? (result.value as LibraryChangeKind) : 'unknown');
  }, true),
});

export const parseLibraryChanges: Reader<LibraryChanges> = objectWith<LibraryChanges>({
  next_sequence: field(number(), true),
  has_more: field(boolean(), true),
  reset_required: field(boolean(), true),
  changes: field(arrayOf(parseChange), true),
  generation_id: field(string(), true),
  updating: field(boolean(), true),
  background_active: field(boolean(), true),
});

/* ------------------------------------------------------------------ */
/* /api/tasks                                                          */
/* ------------------------------------------------------------------ */

export interface TaskResult {
  readonly revision_id: string;
  readonly work_id: string;
}

export interface TaskRecord {
  readonly task_id: string;
  readonly task_type: string;
  readonly source: string;
  readonly status: string;
  /** 后端只提供 0/1，不是连续百分比；前端不得据此拟合进度。 */
  readonly progress: number;
  readonly message: string;
  readonly created_at: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly error: string;
  readonly cancel_requested: boolean;
  readonly result: TaskResult | null;
}

export const parseTask: Reader<TaskRecord> = objectWith<TaskRecord>({
  task_id: field(string()),
  task_type: field(string(), true),
  source: field(string(), true),
  status: field(string()),
  progress: field(number(), true),
  message: field(string(), true),
  created_at: field(string(), true),
  started_at: field(string(), true),
  finished_at: field(string(), true),
  error: field(string(), true),
  cancel_requested: field(boolean(), true),
  result: field(
    nullable(
      objectWith<TaskResult>({
        revision_id: field(string(), true),
        work_id: field(string(), true),
      }),
    ),
    true,
  ),
});

export interface TaskList {
  readonly tasks: readonly TaskRecord[];
}

export const parseTaskList: Reader<TaskList> = objectWith<TaskList>({
  tasks: field(arrayOf(parseTask)),
});

/* ------------------------------------------------------------------ */
/* /api/playback/status                                                */
/* ------------------------------------------------------------------ */

/**
 * 真实响应证据：`tests/desktop/fixtures/playback-status.json`（隔离空库）。
 * 形状为 `{status, session}`；`session` 的内部字段只在有活动会话时可观测。
 *
 * 契约缺口（如实登记，不猜测）：本轮没有取得带活动会话的真实 `session` 样本，
 * 因此这里只声明它为不透明对象，未验证的字段一律不进入 UI 类型。
 * 需要真实媒体与 mpv 才能补齐，属于 P03 的验证项。
 */
export interface PlaybackStatus {
  readonly status: string;
  readonly session: Readonly<Record<string, unknown>> | null;
}

export const parsePlaybackStatus: Reader<PlaybackStatus> = objectWith<PlaybackStatus>({
  status: field(string()),
  session: field(nullable((value) => (isRecord(value) ? valid(value) : invalid('期望对象')))),
});

/* ------------------------------------------------------------------ */
/* /api/config                                                         */
/* ------------------------------------------------------------------ */

export type PublicConfig = Readonly<Record<string, unknown>>;

/** `/api/config` 是脱敏后的公开配置；这里只验证形状，不声明业务字段。 */
export const parsePublicConfig: Reader<PublicConfig> = (value) =>
  isRecord(value) ? valid(value) : invalid('期望对象');

/* ------------------------------------------------------------------ */
/* 通用错误体                                                          */
/* ------------------------------------------------------------------ */

export interface BackendErrorBody {
  readonly detail: string;
}

export const parseErrorBody: Reader<BackendErrorBody> = objectWith<BackendErrorBody>({
  detail: field(string(), true),
});

/* ------------------------------------------------------------------ */
/* /api/v4/works/{id}/folder 与 /api/system/open-folder                 */
/* ------------------------------------------------------------------ */

/** `GET /api/v4/works/{work_id}/folder` 的只读目录解析（`backend/app/api/media_v4.py:2335-2362`）。 */
export interface WorkFolderInfo {
  readonly folder: string;
  readonly exists: boolean;
}

export const parseWorkFolderInfo: Reader<WorkFolderInfo> = objectWith<WorkFolderInfo>({
  folder: field(string()),
  exists: field(boolean(), true),
});

/**
 * `POST /api/system/open-folder` 的响应（`backend/app/api/system.py:40-68`）。
 * 响应里的 `source_path` 是真实媒体文件的绝对路径，渲染进程不消费也不保留，
 * 因此这里不声明该字段，只取"是否真的打开 / 目录是否存在"。
 */
export interface OpenFolderResult {
  readonly ok: boolean;
  readonly opened: boolean;
  readonly exists: boolean;
  readonly folderPath: string;
}

export const parseOpenFolderResult: Reader<OpenFolderResult> = (value) => {
  const parsed = objectWith<{ ok: boolean; opened: boolean; exists: boolean; folder_path: string }>({
    ok: field(boolean(), true),
    opened: field(boolean(), true),
    exists: field(boolean(), true),
    folder_path: field(string(), true),
  })(value);
  if (!parsed.ok) {
    return parsed;
  }
  return valid({
    ok: parsed.value.ok === true,
    opened: parsed.value.opened === true,
    exists: parsed.value.exists === true,
    folderPath: parsed.value.folder_path ?? '',
  });
};

/* ------------------------------------------------------------------ */
/* /api/v4/works/{id}/scrape 与 delete-preview / delete-confirm         */
/* ------------------------------------------------------------------ */

/** `POST /api/v4/works/{work_id}/scrape`（`backend/app/api/media_v4.py:2365-2388`）。 */
export interface WorkScrapeResult {
  readonly work_id: string;
  readonly job_id: string;
  readonly status: string;
}

export const parseWorkScrapeResult: Reader<WorkScrapeResult> = objectWith<WorkScrapeResult>({
  work_id: field(string(), true),
  job_id: field(string()),
  status: field(string(), true),
});

/**
 * `POST /api/v4/works/{work_id}/delete-preview`（只读影响预览）。
 * 后端还会回传 `artifact_paths` 等绝对路径；渲染进程只需要计数与类型，
 * 因此这里不声明路径字段，避免把本机绝对路径带进界面层。
 */
export interface WorkDeletePreview {
  readonly preview_id: string;
  readonly work_id: string;
  readonly revision_id: string;
  readonly artifact_count: number;
  readonly playback_count: number;
  readonly tracking_count: number;
  readonly blocked: boolean;
  readonly blocked_job_count: number;
  readonly blocked_job_types: readonly string[];
  readonly digest: string;
}

export const parseWorkDeletePreview: Reader<WorkDeletePreview> = objectWith<WorkDeletePreview>({
  preview_id: field(string()),
  work_id: field(string(), true),
  revision_id: field(string(), true),
  artifact_count: field(number(), true),
  playback_count: field(number(), true),
  tracking_count: field(number(), true),
  blocked: field(boolean(), true),
  blocked_job_count: field(number(), true),
  blocked_job_types: field(arrayOf(string()), true),
  digest: field(string()),
});

/** `POST /api/v4/works/{work_id}/delete-confirm`；`artifact_results` 只取处置状态，不取路径。 */
export interface WorkDeleteResult {
  readonly preview_id: string;
  readonly work_id: string;
  readonly status: string;
  readonly projection_status: string;
  readonly artifact_statuses: readonly string[];
}

export const parseWorkDeleteResult: Reader<WorkDeleteResult> = (value) => {
  const parsed = objectWith<{
    preview_id: string;
    work_id: string;
    status: string;
    projection_status: string;
    artifact_results: readonly { status: string }[];
  }>({
    preview_id: field(string(), true),
    work_id: field(string(), true),
    status: field(string()),
    projection_status: field(string(), true),
    artifact_results: field(arrayOf(objectWith<{ status: string }>({ status: field(string()) })), true),
  })(value);
  if (!parsed.ok) {
    return parsed;
  }
  return valid({
    preview_id: parsed.value.preview_id ?? '',
    work_id: parsed.value.work_id ?? '',
    status: parsed.value.status,
    projection_status: parsed.value.projection_status ?? '',
    artifact_statuses: (parsed.value.artifact_results ?? []).map((entry) => entry.status),
  });
};

/* ------------------------------------------------------------------ */
/* /api/integrations/bangumi                                            */
/* ------------------------------------------------------------------ */

export interface BangumiPublicUser {
  readonly id: number | null;
  readonly username: string;
  readonly nickname: string;
  readonly avatar: string;
  readonly sign: string;
}

const parseBangumiUser: Reader<BangumiPublicUser> = objectWith<BangumiPublicUser>({
  id: field(nullable(number()), true),
  username: field(string(), true),
  nickname: field(string(), true),
  avatar: field(string(), true),
  sign: field(string(), true),
});

/**
 * `GET /api/integrations/bangumi/session`（0 个远程请求）与
 * `POST /api/integrations/bangumi/session/verify` 的同一响应形状
 * （`backend/app/api/bangumi.py:116-164,220-298`）。
 *
 * 账号显示名的唯一真实来源是 `user.nickname` / `user.username`：
 * `GET /api/config` 从不返回 `bangumi_username` / `bangumi_nickname`。
 */
export interface BangumiSession {
  readonly credential_state: string;
  readonly credential_saved: boolean;
  readonly auth_status: string;
  readonly connectivity: string;
  readonly status: string;
  readonly user: BangumiPublicUser | null;
  readonly last_verified_at: string;
  readonly last_success_at: string;
  readonly last_failure_at: string;
  readonly last_http_status: number | null;
  readonly last_error_code: string;
  readonly last_error_message: string;
}

export const parseBangumiSession: Reader<BangumiSession> = objectWith<BangumiSession>({
  credential_state: field(string()),
  credential_saved: field(boolean(), true),
  auth_status: field(string(), true),
  connectivity: field(string(), true),
  status: field(string(), true),
  user: field(nullable(parseBangumiUser), true),
  last_verified_at: field(string(), true),
  last_success_at: field(string(), true),
  last_failure_at: field(string(), true),
  last_http_status: field(nullable(number()), true),
  last_error_code: field(string(), true),
  last_error_message: field(string(), true),
});

/** `POST /api/integrations/bangumi/search` 的条目（上游 Subject；只有 `id` 必填）。 */
export interface BangumiSubjectItem {
  readonly id: number;
  readonly name: string;
  readonly name_cn: string;
  readonly date: string;
  readonly eps: number;
  readonly total_episodes: number;
  readonly type: number;
}

const parseBangumiSubjectItem: Reader<BangumiSubjectItem> = objectWith<BangumiSubjectItem>({
  id: field(number()),
  name: field(string(), true),
  name_cn: field(string(), true),
  date: field(string(), true),
  eps: field(number(), true),
  total_episodes: field(number(), true),
  type: field(number(), true),
});

export interface BangumiSubjectSearch {
  readonly data: readonly BangumiSubjectItem[];
}

/** 上游分页体是 `{total,limit,offset,data}`；`_public_subject_search` 也兼容 `items` / `results`。 */
export const parseBangumiSubjectSearch: Reader<BangumiSubjectSearch> = (value) => {
  if (!isRecord(value)) {
    return invalid('期望对象');
  }
  const raw = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.items)
      ? value.items
      : Array.isArray(value.results)
        ? value.results
        : undefined;
  if (raw === undefined) {
    return invalid('data 期望数组');
  }
  const items = arrayOf(parseBangumiSubjectItem)(raw);
  return items.ok ? valid({ data: items.value }) : items;
};

/**
 * `GET|POST /api/integrations/bangumi/matches/{work_id}` 的匹配身份。
 * `episode_map` 是「本地 episode_id → Bangumi 剧集 ID」；远端不可用时后端保存空映射并返回 200，
 * 因此空映射不等于失败，界面必须如实显示"剧集映射待同步"。
 */
export interface BangumiMatch {
  readonly work_id: string;
  readonly season_number: number | null;
  readonly subject_id: number;
  readonly subject_name: string;
  readonly subject_name_cn: string;
  readonly confirmed_at: string;
  readonly updated_at: string;
  readonly episode_map: Readonly<Record<string, number>>;
}

export const parseBangumiMatch: Reader<BangumiMatch> = objectWith<BangumiMatch>({
  work_id: field(string(), true),
  season_number: field(nullable(number()), true),
  subject_id: field(number()),
  subject_name: field(string(), true),
  subject_name_cn: field(string(), true),
  confirmed_at: field(string(), true),
  updated_at: field(string(), true),
  episode_map: field(recordOf(number()), true),
});

/** `DELETE /api/integrations/bangumi/matches/{work_id}`；未命中返回 `{ok:false}` 而不是 404。 */
export interface BangumiMatchRemoved {
  readonly ok: boolean;
}

export const parseBangumiMatchRemoved: Reader<BangumiMatchRemoved> = objectWith<BangumiMatchRemoved>({
  ok: field(boolean(), true),
});

/** `POST /api/integrations/bangumi/progress/{work_id}/sync` 的整季双向同步摘要。 */
export interface BangumiProgressSync {
  readonly status: string;
  readonly subject_id: number;
  readonly remote_done_before: number;
  readonly local_done_before: number;
  readonly pulled: number;
  readonly pushed: number;
}

export const parseBangumiProgressSync: Reader<BangumiProgressSync> = objectWith<BangumiProgressSync>({
  status: field(string(), true),
  subject_id: field(number(), true),
  remote_done_before: field(number(), true),
  local_done_before: field(number(), true),
  pulled: field(number(), true),
  pushed: field(number(), true),
});

/** `PATCH /api/integrations/bangumi/collections/{work_id}`；上游对写入返回空体。 */
export interface BangumiCollectionSet {
  readonly ok: boolean;
  readonly subject_id: number;
  readonly type: number;
}

export const parseBangumiCollectionSet: Reader<BangumiCollectionSet> = objectWith<BangumiCollectionSet>({
  ok: field(boolean(), true),
  subject_id: field(number(), true),
  type: field(number(), true),
});

/** `POST|DELETE /api/integrations/bangumi/token`：令牌只在请求体出现，响应不回显任何凭据。 */
export interface BangumiTokenResult {
  readonly ok: boolean;
}

export const parseBangumiTokenResult: Reader<BangumiTokenResult> = objectWith<BangumiTokenResult>({
  ok: field(boolean(), true),
});

export type { Validation };
